import { z } from "zod";

import {
  type ArtifactRefOf,
  type CheckInvocationOptions,
  type CheckResult,
  type CheckResultOf,
  type CheckWaiverRef,
  type DeliveryInputOf,
  type DeliveryOutputOf,
  defineArtifact,
  defineCheck,
  defineContextSource,
  defineDelivery,
  defineReview,
  defineWorkflow,
  type HumanReviewResult,
  type ReviewEvaluation,
  type WorkflowNode,
  type WorkspaceSnapshotRef,
} from "../../core/index.ts";

/** Why: Makes compile-time contract assertions readable without adding runtime behavior. Use: Pass inferred DSL values to it in this typechecked example. */
declare function expectType<Type>(value: Type): void;

const INTEGRITY_CHECK_NAME = "round-06-release-artifact-integrity";
const INTEGRITY_CHECK_REVISION = "release-integrity-v2";
const FREEZE_CHECK_NAME = "round-06-production-change-freeze";
const FREEZE_CHECK_REVISION = "production-freeze-v4";
const FREEZE_WAIVER_BINDING = "policy.check-waiver.authorize";
const FREEZE_WAIVER_ACTION = "Authorize one exact production-freeze waiver";
const FREEZE_WAIVER_MAX_TTL = "30m";
const MAX_WAIVER_TTL_MS = 30 * 60 * 1_000;

const WorkspaceSnapshotSchema = z.object({
  workspaceId: z.string().min(1),
  generation: z.number().int().nonnegative(),
  treeHash: z.string().min(1),
});

/** Why: Names the serializable projection of engine-minted workspace identity used across host schemas. Use: Correlate stored evidence without reconstructing authority from it. */
type WorkspaceSnapshotValue = z.infer<typeof WorkspaceSnapshotSchema>;

const ArtifactPointer = z.object({
  ref: z.string().min(1),
  sha256: z.string().min(1),
});

/** Why: Projects nominal workspace identity into schema-safe evidence without claiming to mint new authority. Use: Persist it beside the engine-owned check and delivery attestations. */
function projectSnapshot(snapshot: WorkspaceSnapshotRef): WorkspaceSnapshotValue {
  return {
    workspaceId: snapshot.workspaceId,
    generation: snapshot.generation,
    treeHash: snapshot.treeHash,
  };
}

// ---------------------------------------------------------------------------
// Authoritative release scope and check definitions
// ---------------------------------------------------------------------------

const ReleaseWorkflowInput = z.object({
  releaseToken: z.string().min(1),
  branch: z.string().min(1),
  baseRef: z.string().min(1),
});

const ReleaseCaseLookup = z.object({
  releaseToken: z.string().min(1),
});

const ReleaseCase = z.object({
  provenance: z.literal("host-attested"),
  releaseId: z.string().min(1),
  repository: z.string().min(1),
  environment: z.literal("production"),
  branch: z.string().min(1),
  baseRef: z.string().min(1),
  authorizedHead: z.string().min(1),
  waiverPolicy: z.object({
    policyId: z.string().min(1),
    eligibleCheck: z.literal(FREEZE_CHECK_NAME),
    eligibleRevision: z.literal(FREEZE_CHECK_REVISION),
    maximumTtlSeconds: z.literal(1_800),
  }),
});

/** Why: Keeps caller routing hints separate from the host-authoritative release and waiver policy. Use: Re-resolve it after workspace launch and before any consequential check or delivery. */
type ReleaseCaseValue = z.infer<typeof ReleaseCase>;

const releaseCaseSource = defineContextSource({
  name: "round-06-authorized-release-case",
  description: "Resolves current release scope and narrowly eligible waiver policy from an opaque token.",
  input: ReleaseCaseLookup,
  output: ReleaseCase,
  binding: "release.case.resolve",
  freshness: { maxAge: "5m", stale: "reject" },
  trust: { minimum: "authoritative", authorities: ["release-control"] },
});

const IntegrityCheckInput = z.object({
  releaseId: z.string().min(1),
  repository: z.string().min(1),
  expectedHead: z.string().min(1),
});

const artifactIntegrity = defineCheck({
  name: INTEGRITY_CHECK_NAME,
  description: "Verifies release artifact provenance and signatures; policy treats this check as unwaivable.",
  input: IntegrityCheckInput,
  policy: "required",
  revision: INTEGRITY_CHECK_REVISION,
  defaults: { timeout: "10m" },
  command: ({ releaseId, repository, expectedHead }) => [
    "weft-release",
    "verify-artifact-integrity",
    "--release",
    releaseId,
    "--repository",
    repository,
    "--head",
    expectedHead,
  ],
});

const ChangeFreezeCheckInput = z.object({
  releaseId: z.string().min(1),
  policyId: z.string().min(1),
  environment: z.literal("production"),
  expectedHead: z.string().min(1),
});

const productionChangeFreeze = defineCheck({
  name: FREEZE_CHECK_NAME,
  description:
    "Checks the production freeze; only a human-requested, host-authorized, exact-candidate grant may waive it.",
  input: ChangeFreezeCheckInput,
  policy: "required",
  revision: FREEZE_CHECK_REVISION,
  waiver: {
    mode: "eligible",
    binding: FREEZE_WAIVER_BINDING,
    action: FREEZE_WAIVER_ACTION,
    risk: "high",
    maxTtl: FREEZE_WAIVER_MAX_TTL,
  },
  defaults: { timeout: "2m" },
  command: ({ releaseId, policyId, environment, expectedHead }) => [
    "weft-release",
    "check-change-freeze",
    "--release",
    releaseId,
    "--policy",
    policyId,
    "--environment",
    environment,
    "--head",
    expectedHead,
  ],
});

const CheckProofBase = z.object({
  name: z.string().min(1),
  revision: z.string().min(1),
  snapshot: WorkspaceSnapshotSchema,
  attestationRef: z.string().min(1),
  summary: z.string().optional(),
  evidence: z.string().optional(),
});

const ExecutedPassProof = CheckProofBase.extend({
  status: z.literal("pass"),
  disposition: z.literal("executed"),
});

const ExecutedFailureProof = CheckProofBase.extend({
  status: z.literal("fail"),
  disposition: z.literal("executed"),
});

const WaivedCheckProof = CheckProofBase.extend({
  status: z.literal("fail"),
  disposition: z.literal("waived"),
});

/** Why: Names proof that an unwaivable check actually executed and passed on one exact candidate. Use: Require it before human review or promotion. */
type ExecutedPassProofValue = z.infer<typeof ExecutedPassProof>;

/** Why: Names the eligible failure a person may request to waive without treating that request as authority. Use: Bind it to the exact candidate review and nominal authorization request. */
type ExecutedFailureProofValue = z.infer<typeof ExecutedFailureProof>;

/** Why: Names the engine-recorded failed result carrying nominal waiver authority for the eligible check. Use: Retain it beside a serializable projection of the same ref in delivery evidence. */
type WaivedCheckProofValue = z.infer<typeof WaivedCheckProof>;

/** Why: Preserves optional check evidence fields without introducing `undefined` into exact optional properties. Use: Share it among the three proof refinements. */
function optionalCheckEvidence(result: CheckResult): { summary?: string; evidence?: string } {
  return {
    ...(result.summary === undefined ? {} : { summary: result.summary }),
    ...(result.evidence === undefined ? {} : { evidence: result.evidence }),
  };
}

/** Why: Converts a broad result into positive, executed proof only after exact-candidate validation. Use: Enforce the unwaivable integrity invariant. */
function requireExecutedPass(
  name: string,
  revision: string,
  result: CheckResult,
): ExecutedPassProofValue {
  if (result.status !== "pass" || result.disposition !== "executed") {
    throw new Error(`${name} must execute and pass; trusted or waived evidence is insufficient`);
  }
  return {
    name,
    revision,
    status: "pass",
    disposition: "executed",
    snapshot: projectSnapshot(result.candidate),
    attestationRef: result.attestation.ref,
    ...optionalCheckEvidence(result),
  };
}

/** Why: Converts only an actually executed eligible failure into waiver-request evidence. Use: Refuse requests for checks that passed, were trusted, or were already waived. */
function requireExecutedFailure(
  name: typeof FREEZE_CHECK_NAME,
  revision: typeof FREEZE_CHECK_REVISION,
  result: CheckResult,
): ExecutedFailureProofValue {
  if (result.status !== "fail" || result.disposition !== "executed") {
    throw new Error(`${name} is waiver-eligible only after an executed failure`);
  }
  return {
    name,
    revision,
    status: "fail",
    disposition: "executed",
    snapshot: projectSnapshot(result.candidate),
    attestationRef: result.attestation.ref,
    ...optionalCheckEvidence(result),
  };
}

/** Why: Accepts the exceptional path only when the failed result retained the exact nominal waiver ref. Use: Refine the waived result before projecting evidence. */
function requireWaivedCheck(
  result: CheckResultOf<typeof productionChangeFreeze>,
  waiver: CheckWaiverRef<typeof productionChangeFreeze>,
): WaivedCheckProofValue {
  if (result.disposition !== "waived") {
    throw new Error("The eligible check did not record the authorized waiver disposition");
  }
  if (result.waiver.ref !== waiver.ref) {
    throw new Error("The waived check result did not retain the exact authorization ref");
  }
  return {
    name: FREEZE_CHECK_NAME,
    revision: FREEZE_CHECK_REVISION,
    status: "fail",
    disposition: "waived",
    snapshot: projectSnapshot(result.candidate),
    attestationRef: result.attestation.ref,
    ...optionalCheckEvidence(result),
  };
}

// ---------------------------------------------------------------------------
// Human request and host-authorized nominal waiver
// ---------------------------------------------------------------------------

const HumanWaiverRequest = z.object({
  checkName: z.literal(FREEZE_CHECK_NAME),
  checkRevision: z.literal(FREEZE_CHECK_REVISION),
  reason: z.string().min(20),
  expiresAt: z.string().datetime(),
});

/** Why: Names a person's requested exception before policy authorization. Use: Never pass it directly to `ctx.check`. */
type HumanWaiverRequestValue = z.infer<typeof HumanWaiverRequest>;

const WaiverReviewAnswer = z.discriminatedUnion("decision", [
  z.object({
    decision: z.literal("request-waiver"),
    request: HumanWaiverRequest,
  }),
  z.object({
    decision: z.literal("reject"),
    reason: z.string().min(1),
  }),
]);

/** Why: Names the answer before its reviewed artifact and reviewer identity are validated. Use: Refine it with `requireHumanWaiverRequest`. */
type WaiverReviewAnswerValue = z.infer<typeof WaiverReviewAnswer>;

const WaiverReviewContent = z.object({
  release: z.object({
    releaseId: z.string().min(1),
    repository: z.string().min(1),
    environment: z.literal("production"),
    head: z.string().min(1),
    snapshot: WorkspaceSnapshotSchema,
  }),
  integrity: ExecutedPassProof,
  failedCheck: ExecutedFailureProof,
  waiverPolicy: ReleaseCase.shape.waiverPolicy,
});

const WaiverReviewMetadata = z.object({
  workflowRunId: z.string().min(1),
  releaseId: z.string().min(1),
  head: z.string().min(1),
  treeHash: z.string().min(1),
});

const waiverReviewArtifactDefinition = defineArtifact({
  name: "round-06-waiver-review-request",
  mediaType: "application/json",
  extension: ".json",
  content: WaiverReviewContent,
  metadata: WaiverReviewMetadata,
});

/** Why: Names immutable bytes that show the exact failed check, candidate, and policy to a person. Use: Require the returned human review to preserve this reference and digest. */
type WaiverReviewArtifactRef = ArtifactRefOf<typeof waiverReviewArtifactDefinition>;

const HumanWaiverRequestProof = z.object({
  checkName: z.literal(FREEZE_CHECK_NAME),
  checkRevision: z.literal(FREEZE_CHECK_REVISION),
  reason: z.string().min(20),
  requestedExpiresAt: z.string().datetime(),
  reviewerId: z.string().min(1),
  submittedAt: z.string().min(1),
  reviewedArtifact: ArtifactPointer,
});

/** Why: Carries an attributable request bound to exact immutable review bytes without turning it into waiver authority. Use: Send it to the protected host policy operation. */
type HumanWaiverRequestProofValue = z.infer<typeof HumanWaiverRequestProof>;

/** Why: Rejects a request about different bytes or a generic approval without an explicit waiver request. Use: Call only on the request branch of exact-artifact human review. */
function requireHumanWaiverRequest(
  review: HumanReviewResult<WaiverReviewAnswerValue, WaiverReviewArtifactRef>,
  artifact: WaiverReviewArtifactRef,
): HumanWaiverRequestProofValue {
  if (review.answer.decision !== "request-waiver") {
    throw new Error("The reviewer did not request a waiver");
  }
  if (review.subject.ref !== artifact.ref || review.subject.sha256 !== artifact.sha256) {
    throw new Error("The human waiver request is not bound to the exact review artifact");
  }
  return {
    checkName: review.answer.request.checkName,
    checkRevision: review.answer.request.checkRevision,
    reason: review.answer.request.reason,
    requestedExpiresAt: review.answer.request.expiresAt,
    reviewerId: review.reviewer.id,
    submittedAt: review.submittedAt,
    reviewedArtifact: { ref: artifact.ref, sha256: artifact.sha256 },
  };
}

const CheckWaiverEvidence = z.object({
  ref: z.string().min(1),
  check: z.literal(FREEZE_CHECK_NAME),
  revision: z.literal(FREEZE_CHECK_REVISION),
  definitionDigest: z.string().min(1),
  binding: z.literal(FREEZE_WAIVER_BINDING),
  action: z.literal(FREEZE_WAIVER_ACTION),
  risk: z.literal("high"),
  maxTtl: z.literal(FREEZE_WAIVER_MAX_TTL),
  snapshot: WorkspaceSnapshotSchema,
  failureAttestationRef: z.string().min(1),
  reason: z.string().min(20),
  issue: z.string().min(1).optional(),
  authorizedBy: z.object({
    kind: z.enum(["human", "policy"]),
    id: z.string().min(1),
  }),
  authorizedAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
  attestationRef: z.string().min(1),
});

/** Why: Names a serializable projection of the nominal waiver ref without making artifact data executable authority. Use: Retain it beside the human request and waived check result. */
type CheckWaiverEvidenceValue = z.infer<typeof CheckWaiverEvidence>;

/** Why: Projects the nominal ref through artifact schemas while preserving every auditable policy and provenance field. Use: Never pass this projection back to `ctx.check`. */
function projectCheckWaiver(waiver: CheckWaiverRef<typeof productionChangeFreeze>): CheckWaiverEvidenceValue {
  if (waiver.revision !== FREEZE_CHECK_REVISION) {
    throw new Error("The waiver ref names an unexpected production-freeze revision");
  }
  return {
    ref: waiver.ref,
    check: waiver.check,
    revision: FREEZE_CHECK_REVISION,
    definitionDigest: waiver.definitionDigest,
    binding: waiver.binding,
    action: waiver.action,
    risk: waiver.risk,
    maxTtl: waiver.maxTtl,
    snapshot: projectSnapshot(waiver.candidate),
    failureAttestationRef: waiver.failure.ref,
    reason: waiver.reason,
    ...(waiver.issue === undefined ? {} : { issue: waiver.issue }),
    authorizedBy: waiver.authorizedBy,
    authorizedAt: waiver.authorizedAt,
    expiresAt: waiver.expiresAt,
    attestationRef: waiver.attestation.ref,
  };
}

/** Why: Verifies that nominal host authority preserved the failed check, human request, release identity, and expiry bound. Use: Call immediately after `ctx.check.authorizeWaiver`. */
function requireExactUnexpiredWaiver(
  waiver: CheckWaiverRef<typeof productionChangeFreeze>,
  release: ReleaseCaseValue,
  failure: ExecutedFailureProofValue,
  request: HumanWaiverRequestProofValue,
  nowMs: number,
): void {
  if (
    waiver.check !== release.waiverPolicy.eligibleCheck ||
    waiver.revision !== release.waiverPolicy.eligibleRevision ||
    waiver.binding !== FREEZE_WAIVER_BINDING ||
    waiver.action !== FREEZE_WAIVER_ACTION ||
    waiver.risk !== "high" ||
    waiver.maxTtl !== FREEZE_WAIVER_MAX_TTL ||
    waiver.failure.ref !== failure.attestationRef ||
    waiver.issue !== release.releaseId ||
    waiver.reason !== request.reason
  ) {
    throw new Error("The nominal waiver does not authorize this exact request and failed check");
  }

  const authorizedAtMs = Date.parse(waiver.authorizedAt);
  const expiresAtMs = Date.parse(waiver.expiresAt);
  const requestedExpiresAtMs = Date.parse(request.requestedExpiresAt);
  if (
    !Number.isFinite(authorizedAtMs) ||
    !Number.isFinite(expiresAtMs) ||
    !Number.isFinite(requestedExpiresAtMs) ||
    authorizedAtMs > nowMs ||
    expiresAtMs <= nowMs ||
    expiresAtMs > requestedExpiresAtMs ||
    expiresAtMs - authorizedAtMs > MAX_WAIVER_TTL_MS
  ) {
    throw new Error("The waiver is expired, future-issued, or broader than the requested policy TTL");
  }
}

// ---------------------------------------------------------------------------
// Reviewable delivery evidence and verified delivery
// ---------------------------------------------------------------------------

const ReleaseFreezeAcceptance = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("passed"),
    result: ExecutedPassProof,
  }),
  z.object({
    kind: z.literal("waived"),
    initialFailure: ExecutedFailureProof,
    request: HumanWaiverRequestProof,
    waiver: CheckWaiverEvidence,
    result: WaivedCheckProof,
  }),
]);

/** Why: Keeps normal passage and exceptional waiver evidence explicit at the delivery boundary. Use: Never infer authorization from `CheckResult.disposition` alone. */
type ReleaseFreezeAcceptanceValue = z.infer<typeof ReleaseFreezeAcceptance>;

const DeliveryEvidenceContent = z.object({
  release: z.object({
    releaseId: z.string().min(1),
    repository: z.string().min(1),
    environment: z.literal("production"),
    branch: z.string().min(1),
    head: z.string().min(1),
    snapshot: WorkspaceSnapshotSchema,
  }),
  integrity: ExecutedPassProof,
  freeze: ReleaseFreezeAcceptance,
  waiverReviewArtifact: ArtifactPointer.optional(),
});

const DeliveryEvidenceMetadata = z.object({
  workflowRunId: z.string().min(1),
  releaseId: z.string().min(1),
  head: z.string().min(1),
  treeHash: z.string().min(1),
});

const deliveryEvidenceArtifactDefinition = defineArtifact({
  name: "round-06-check-waiver-delivery-evidence",
  mediaType: "application/json",
  extension: ".json",
  content: DeliveryEvidenceContent,
  metadata: DeliveryEvidenceMetadata,
});

/** Why: Names the immutable dossier retained by authorization and delivery. Use: Attach it to the promotion candidate together with nominal attestations. */
type DeliveryEvidenceArtifactRef = ArtifactRefOf<typeof deliveryEvidenceArtifactDefinition>;

const EvidenceReviewInput = z.object({
  releaseId: z.string().min(1),
  snapshot: WorkspaceSnapshotSchema,
  integrity: ExecutedPassProof,
  freeze: ReleaseFreezeAcceptance,
  dossier: ArtifactPointer,
});

const EvidenceReviewFinding = z.object({
  code: z.enum(["snapshot-mismatch", "integrity-not-executed", "waiver-chain-incomplete"]),
  message: z.string().min(1),
});

/** Why: Names deterministic review findings separately from their blocking disposition. Use: Return them from the exact-candidate delivery evidence review. */
type EvidenceReviewFindingValue = z.infer<typeof EvidenceReviewFinding>;

/** Why: Compares serialized workspace snapshots inside review input without treating them as authority. Use: Flag inconsistent evidence before engine-bound promotion preparation. */
function sameProjectedSnapshot(left: WorkspaceSnapshotValue, right: WorkspaceSnapshotValue): boolean {
  return (
    left.workspaceId === right.workspaceId &&
    left.generation === right.generation &&
    left.treeHash === right.treeHash
  );
}

const deliveryEvidenceReview = defineReview({
  name: "round-06-review-check-waiver-evidence",
  description:
    "Reviews the complete normal or exceptional check chain while the engine binds it to one workspace candidate.",
  input: EvidenceReviewInput,
  finding: EvidenceReviewFinding,
  evaluate: (_ctx, input): ReviewEvaluation<EvidenceReviewFindingValue> => {
    const findings: EvidenceReviewFindingValue[] = [];
    if (!sameProjectedSnapshot(input.integrity.snapshot, input.snapshot)) {
      findings.push({
        code: "snapshot-mismatch",
        message: "Integrity proof describes another workspace snapshot.",
      });
    }
    if (input.integrity.status !== "pass" || input.integrity.disposition !== "executed") {
      findings.push({
        code: "integrity-not-executed",
        message: "Unwaivable integrity proof must execute and pass.",
      });
    }
    if (!sameProjectedSnapshot(input.freeze.result.snapshot, input.snapshot)) {
      findings.push({
        code: "snapshot-mismatch",
        message: "Freeze acceptance describes another workspace snapshot.",
      });
    }
    if (
      input.freeze.kind === "waived" &&
      (!sameProjectedSnapshot(input.freeze.initialFailure.snapshot, input.snapshot) ||
        !sameProjectedSnapshot(input.freeze.waiver.snapshot, input.snapshot) ||
        input.freeze.initialFailure.attestationRef !== input.freeze.waiver.failureAttestationRef ||
        input.freeze.request.reason !== input.freeze.waiver.reason ||
        input.freeze.waiver.issue !== input.releaseId ||
        Date.parse(input.freeze.waiver.expiresAt) > Date.parse(input.freeze.request.requestedExpiresAt))
    ) {
      findings.push({
        code: "waiver-chain-incomplete",
        message: "Waiver authority is detached from its failed check or reviewed request.",
      });
    }
    return {
      assessments: findings.map((finding) => ({
        finding,
        disposition: "blocking" as const,
        sources: ["round-06-delivery-evidence"],
        rationale: finding.message,
      })),
    };
  },
  accept: ({ assessments }) => assessments.every(({ disposition }) => disposition !== "blocking"),
});

const PublishReleaseInput = z.object({
  releaseId: z.string().min(1),
  repository: z.string().min(1),
  environment: z.literal("production"),
  branch: z.string().min(1),
  head: z.string().min(1),
  evidenceDossier: ArtifactPointer,
  integrity: ExecutedPassProof,
  freeze: ReleaseFreezeAcceptance,
  evidenceReviewRef: z.string().min(1),
});

const PublishReleaseOutput = z.object({
  status: z.literal("published"),
  releaseId: z.string().min(1),
  environment: z.literal("production"),
  head: z.string().min(1),
  deploymentId: z.string().min(1),
  url: z.string().url(),
  providerEvidence: z.string().min(1),
});

const publishProductionRelease = defineDelivery({
  name: "round-06-publish-production-release",
  description:
    "Publishes one exact workspace generation with nominal checks, reviewed waiver evidence, and host authorization.",
  binding: "release.production.publish",
  input: PublishReleaseInput,
  output: PublishReleaseOutput,
  capabilities: ["git:read", "network", "secrets:read", "integration:deployment"],
  defaults: {
    timeout: "20m",
    attempts: 1,
    authorization: {
      action: "Publish an exact production release candidate",
      risk: "irreversible",
      timeout: "30m",
    },
  },
});

const ReleaseWorkflowOutput = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("blocked"),
    releaseId: z.string().min(1),
    stage: z.enum(["integrity", "waiver-request", "evidence-review"]),
    reason: z.string().min(1),
    evidenceRef: z.string().optional(),
  }),
  z.object({
    status: z.literal("delivered"),
    releaseId: z.string().min(1),
    head: z.string().min(1),
    evidence: ArtifactPointer,
    delivery: PublishReleaseOutput,
  }),
]);

/** Why: Prevents terminal status literals from widening inside the long exceptional workflow. Use: Annotate the workflow callback. */
type ReleaseWorkflowOutputValue = z.input<typeof ReleaseWorkflowOutput>;

const checkWaiverWorkflow = defineWorkflow(
  {
    id: "round-06-check-waiver",
    name: "Authorize and evidence one exact check waiver",
    description:
      "Fails closed on an unwaivable integrity check and permits one expiring production-freeze waiver only after exact human review and host authorization.",
    input: ReleaseWorkflowInput,
    output: ReleaseWorkflowOutput,
    workspace: ({ input }) => ({ branch: input.branch, from: input.baseRef }),
  },
  async (ctx, input): Promise<ReleaseWorkflowOutputValue> => {
    const releaseSnapshot = await ctx.context(
      releaseCaseSource,
      { releaseToken: input.releaseToken },
      { key: "resolve-release-case", label: "Resolve current release and waiver policy" },
    );
    const release = releaseSnapshot.value;
    expectType<ReleaseCaseValue>(release);

    if (release.branch !== input.branch || release.baseRef !== input.baseRef) {
      throw new Error("Workflow workspace routing does not match the authoritative release case");
    }
    const head = await ctx.git.head({ key: "read-authorized-release-head" });
    const status = await ctx.git.status({ key: "read-authorized-release-status" });
    if (head.sha !== release.authorizedHead || status.branch !== release.branch || !status.clean) {
      throw new Error("Release checks require the authorized clean branch and exact head");
    }
    const candidate = ctx.workspace.snapshot;

    const integrityResult = await ctx.check(
      artifactIntegrity,
      {
        releaseId: release.releaseId,
        repository: release.repository,
        expectedHead: release.authorizedHead,
      },
      { key: "unwaivable-artifact-integrity", policy: "required" },
    );
    let integrity: ExecutedPassProofValue;
    try {
      integrity = requireExecutedPass(
        INTEGRITY_CHECK_NAME,
        INTEGRITY_CHECK_REVISION,
        integrityResult,
      );
    } catch (error) {
      return {
        status: "blocked",
        releaseId: release.releaseId,
        stage: "integrity",
        reason: error instanceof Error ? error.message : "Unwaivable integrity check failed",
      };
    }

    const freezeInput = {
      releaseId: release.releaseId,
      policyId: release.waiverPolicy.policyId,
      environment: release.environment,
      expectedHead: release.authorizedHead,
    };
    const initialFreezeResult = await ctx.check(productionChangeFreeze, freezeInput, {
      key: "initial-production-change-freeze",
      policy: "required",
    });
    let freezeAcceptance: ReleaseFreezeAcceptanceValue;
    let acceptedFreezeResult: CheckResultOf<typeof productionChangeFreeze> = initialFreezeResult;
    let waiverReviewArtifact: WaiverReviewArtifactRef | undefined;

    if (initialFreezeResult.status === "pass" && initialFreezeResult.disposition === "executed") {
      freezeAcceptance = {
        kind: "passed",
        result: requireExecutedPass(
          FREEZE_CHECK_NAME,
          FREEZE_CHECK_REVISION,
          initialFreezeResult,
        ),
      };
    } else {
      if (initialFreezeResult.status !== "fail" || initialFreezeResult.disposition !== "executed") {
        return {
          status: "blocked",
          releaseId: release.releaseId,
          stage: "waiver-request",
          reason: "Only an executed production-freeze failure is eligible for waiver authorization",
        };
      }
      const failedCheck = requireExecutedFailure(
        FREEZE_CHECK_NAME,
        FREEZE_CHECK_REVISION,
        initialFreezeResult,
      );
      waiverReviewArtifact = await ctx.artifact(
        waiverReviewArtifactDefinition,
        {
          content: {
            release: {
              releaseId: release.releaseId,
              repository: release.repository,
              environment: release.environment,
              head: release.authorizedHead,
              snapshot: projectSnapshot(candidate),
            },
            integrity,
            failedCheck,
            waiverPolicy: release.waiverPolicy,
          },
          metadata: {
            workflowRunId: ctx.run.id,
            releaseId: release.releaseId,
            head: release.authorizedHead,
            treeHash: candidate.treeHash,
          },
        },
        {
          key: "waiver-review-artifact",
          label: `Waiver request for ${release.releaseId}`,
          candidate,
          sources: [releaseSnapshot.evidence, integrityResult.attestation, initialFreezeResult.attestation],
        },
      );

      const humanReview = await ctx.human.review({
        key: "request-exact-check-waiver",
        question: `Request a short-lived waiver for failed ${FREEZE_CHECK_NAME}?`,
        subject: waiverReviewArtifact,
        schema: WaiverReviewAnswer,
        timeout: "30m",
        onTimeout: "deny",
      });
      if (humanReview.answer.decision === "reject") {
        return {
          status: "blocked",
          releaseId: release.releaseId,
          stage: "waiver-request",
          reason: humanReview.answer.reason,
          evidenceRef: waiverReviewArtifact.ref,
        };
      }
      const waiverRequest = requireHumanWaiverRequest(humanReview, waiverReviewArtifact);

      const requestedExpiresAtMs = Date.parse(waiverRequest.requestedExpiresAt);
      const requestedAtMs = await ctx.now({ key: "freeze-waiver-requested-at" });
      const requestedTtlMs = Math.floor(requestedExpiresAtMs - requestedAtMs);
      if (
        !Number.isFinite(requestedExpiresAtMs) ||
        requestedTtlMs <= 0 ||
        requestedTtlMs > MAX_WAIVER_TTL_MS
      ) {
        return {
          status: "blocked",
          releaseId: release.releaseId,
          stage: "waiver-request",
          reason: "The requested waiver expiry is past or exceeds the 30-minute policy maximum",
          evidenceRef: waiverReviewArtifact.ref,
        };
      }

      const waiver = await ctx.check.authorizeWaiver(productionChangeFreeze, initialFreezeResult, {
        key: "authorize-production-freeze-waiver",
        reason: waiverRequest.reason,
        issue: release.releaseId,
        ttl: requestedTtlMs,
        detail: `Reviewer ${waiverRequest.reviewerId} requested ${FREEZE_CHECK_REVISION} for exact snapshot ${candidate.treeHash} and artifact ${waiverRequest.reviewedArtifact.sha256}.`,
      });
      requireExactUnexpiredWaiver(
        waiver,
        release,
        failedCheck,
        waiverRequest,
        await ctx.now({ key: "freeze-waiver-observed-at" }),
      );

      const waivedFreezeResult = await ctx.check(productionChangeFreeze, freezeInput, {
        key: "authorized-production-change-freeze-waiver",
        policy: "required",
        waive: waiver,
      });
      const waivedResult = requireWaivedCheck(waivedFreezeResult, waiver);
      acceptedFreezeResult = waivedFreezeResult;
      freezeAcceptance = {
        kind: "waived",
        initialFailure: failedCheck,
        request: waiverRequest,
        waiver: projectCheckWaiver(waiver),
        result: waivedResult,
      };
    }

    const dossier = await ctx.artifact(
      deliveryEvidenceArtifactDefinition,
      {
        content: {
          release: {
            releaseId: release.releaseId,
            repository: release.repository,
            environment: release.environment,
            branch: release.branch,
            head: release.authorizedHead,
            snapshot: projectSnapshot(candidate),
          },
          integrity,
          freeze: freezeAcceptance,
          ...(waiverReviewArtifact === undefined
            ? {}
            : {
                waiverReviewArtifact: {
                  ref: waiverReviewArtifact.ref,
                  sha256: waiverReviewArtifact.sha256,
                },
              }),
        },
        metadata: {
          workflowRunId: ctx.run.id,
          releaseId: release.releaseId,
          head: release.authorizedHead,
          treeHash: candidate.treeHash,
        },
      },
      {
        key: "release-delivery-evidence",
        label: `Release evidence for ${release.releaseId}`,
        candidate,
        sources: [releaseSnapshot.evidence, integrityResult.attestation, acceptedFreezeResult.attestation],
      },
    );
    expectType<DeliveryEvidenceArtifactRef>(dossier);

    const evidenceReview = await ctx.review(
      deliveryEvidenceReview,
      {
        releaseId: release.releaseId,
        snapshot: projectSnapshot(candidate),
        integrity,
        freeze: freezeAcceptance,
        dossier: { ref: dossier.ref, sha256: dossier.sha256 },
      },
      { key: "review-delivery-evidence", candidate },
    );
    if (evidenceReview.status !== "accepted") {
      return {
        status: "blocked",
        releaseId: release.releaseId,
        stage: "evidence-review",
        reason: "Delivery evidence review found an incomplete or mismatched waiver chain",
        evidenceRef: dossier.ref,
      };
    }

    const deliveryCandidate = await ctx.delivery.prepare(
      publishProductionRelease,
      {
        snapshot: candidate,
        input: {
          releaseId: release.releaseId,
          repository: release.repository,
          environment: release.environment,
          branch: release.branch,
          head: release.authorizedHead,
          evidenceDossier: { ref: dossier.ref, sha256: dossier.sha256 },
          integrity,
          freeze: freezeAcceptance,
          evidenceReviewRef: evidenceReview.evidence,
        },
        proofs: [evidenceReview.proof],
        artifacts: waiverReviewArtifact === undefined ? [dossier] : [waiverReviewArtifact, dossier],
      },
      { key: "prepare-production-release", label: "Freeze verified production release" },
    );
    const deliveryAuthorization = await ctx.delivery.authorize(publishProductionRelease, deliveryCandidate, {
      key: "authorize-production-release",
      detail: `Publish ${release.authorizedHead} with evidence ${dossier.sha256}.`,
    });
    const delivery = await ctx.delivery(
      publishProductionRelease,
      { candidate: deliveryCandidate, authorization: deliveryAuthorization },
      { key: "publish-production-release", attempts: 1 },
    );
    if (
      delivery.value.releaseId !== release.releaseId ||
      delivery.value.head !== release.authorizedHead ||
      delivery.value.environment !== release.environment
    ) {
      throw new Error("Delivery receipt does not attest the authorized exact release");
    }

    await ctx.note({
      key: "record-production-release",
      kind: "claim",
      text: `Published ${release.releaseId} from ${release.authorizedHead}.`,
      evidence: dossier.ref,
    });
    return {
      status: "delivered",
      releaseId: release.releaseId,
      head: release.authorizedHead,
      evidence: { ref: dossier.ref, sha256: dossier.sha256 },
      delivery: delivery.value,
    };
  },
);

expectType<WorkflowNode<"weft.check">>(artifactIntegrity);
expectType<WorkflowNode<"weft.check">>(productionChangeFreeze);
expectType<WorkflowNode<"weft.review">>(deliveryEvidenceReview);
expectType<WorkflowNode<"weft.delivery">>(publishProductionRelease);
expectType<WorkflowNode<"weft.workflow">>(checkWaiverWorkflow);
expectType<DeliveryInputOf<typeof publishProductionRelease>>({
  releaseId: "release-123",
  repository: "example/repository",
  environment: "production",
  branch: "release/123",
  head: "abc123",
  evidenceDossier: { ref: "artifact:evidence", sha256: "sha256:evidence" },
  integrity: {
    name: INTEGRITY_CHECK_NAME,
    revision: INTEGRITY_CHECK_REVISION,
    status: "pass",
    disposition: "executed",
    snapshot: { workspaceId: "workspace-1", generation: 1, treeHash: "tree-1" },
    attestationRef: "evidence:integrity",
  },
  freeze: {
    kind: "passed",
    result: {
      name: FREEZE_CHECK_NAME,
      revision: FREEZE_CHECK_REVISION,
      status: "pass",
      disposition: "executed",
      snapshot: { workspaceId: "workspace-1", generation: 1, treeHash: "tree-1" },
      attestationRef: "evidence:freeze",
    },
  },
  evidenceReviewRef: "evidence:review",
});
declare const deliveryOutput: DeliveryOutputOf<typeof publishProductionRelease>;
expectType<DeliveryOutputOf<typeof publishProductionRelease>>(deliveryOutput);

// Negative type and soundness cases:
const incompleteStructuralWaiver = {
  reason: "No snapshot, check, authorization, or expiry.",
};
// @ts-expect-error A structural object cannot masquerade as engine-minted waiver authority.
expectType<CheckWaiverRef<typeof productionChangeFreeze>>(incompleteStructuralWaiver);

declare const rawHumanRequest: HumanWaiverRequestValue;
// @ts-expect-error A human request is evidence for authorization, not waiver authority itself.
expectType<CheckWaiverRef<typeof productionChangeFreeze>>(rawHumanRequest);

declare const eligibleFreezeWaiver: CheckWaiverRef<typeof productionChangeFreeze>;
expectType<CheckInvocationOptions<typeof artifactIntegrity>>({
  policy: "required",
  // @ts-expect-error An unwaivable check definition has no invocation branch accepting a waiver ref.
  waive: eligibleFreezeWaiver,
});

type EligibleWaiverCheckName = CheckWaiverRef<typeof productionChangeFreeze>["check"];
// @ts-expect-error The integrity check is intentionally excluded from the host grant schema.
const invalidWaiverTarget: EligibleWaiverCheckName = INTEGRITY_CHECK_NAME;
expectType<EligibleWaiverCheckName>(invalidWaiverTarget);

// Round 6 DX findings (maximum three):
// 1. The new definition policy and nominal ref close the unwaivable-check, cross-definition, and structural forgery paths.
// 2. `CheckWaiverRef.revision` is still typed as `string`, so artifact projections need one redundant runtime literal check.
// 3. Authorization cannot accept the exact human-review artifact as typed evidence, so workflows must preserve that
//    request alongside the nominal ref and cross-check their reason and expiry in delivery evidence.
