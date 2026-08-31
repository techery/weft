import { z } from "zod";

import {
  type ArtifactRefOf,
  type CheckResult,
  type CheckWaiverRef,
  defineAgent,
  defineArtifact,
  defineCheck,
  defineCheckSuite,
  defineGoal,
  defineOperation,
  definePathPolicy,
  definePrompt,
  defineWorkflow,
  type GateResult,
  type HumanReviewResult,
  type WorkflowNode,
  type WorkspaceSnapshotRef,
} from "../../core/index.ts";

/** Why: Makes compile-time contract assertions visible without adding a runtime test helper. Use: Pass inferred DSL values to it in this typechecked example. */
declare function expectType<T>(value: T): void;

const ArtifactPointer = z.object({
  ref: z.string().min(1),
  sha256: z.string().min(1),
});

const WorkspaceSnapshotSchema = z.object({
  workspaceId: z.string().min(1),
  generation: z.number().int().nonnegative(),
  treeHash: z.string().min(1),
});

const ExactCandidate = z.object({
  branch: z.string().min(1),
  head: z.string().min(1),
  snapshot: WorkspaceSnapshotSchema,
});

/** Why: Names the exact branch, commit, and workspace generation that every proof must describe. Use: Carry it unchanged from final verification through review and production delivery. */
type ExactCandidateValue = z.infer<typeof ExactCandidate>;

const HotfixWorkflowInput = z.object({
  incidentToken: z.string().min(1),
  branch: z.string().min(1),
  baseRef: z.string().min(1),
});

const hotfixWritePolicy = definePathPolicy({
  name: "round-03-hotfix-writes",
  description: "Restricts emergency edits to canonical host-proposed repository paths.",
  revision: "v1",
  roots: ["."],
  deny: [".git/**", ".weft/**"],
  grantTtl: "2h",
});

const HotfixCaseLookup = z.object({
  incidentToken: z.string().min(1),
  requestedBaseRef: z.string().min(1),
});

const HotfixCase = z.object({
  provenance: z.literal("host-attested"),
  incidentId: z.string().min(1),
  repository: z.string().min(1),
  service: z.string().min(1),
  environment: z.literal("production"),
  severity: z.enum(["sev-1", "sev-2"]),
  symptom: z.string().min(1),
  productionHead: z.string().min(1),
  authorization: z.object({
    policyId: z.string().min(1),
    writePolicyId: z.string().min(1),
    editablePaths: z.array(z.string().min(1)).min(1),
    packageFilter: z.string().min(1),
    reviewerGroup: z.string().min(1),
    deliveryBinding: z.string().min(1),
  }),
  waiverPolicy: z.object({
    policyId: z.string().min(1),
    eligibleCheck: z.literal("round-03-production-change-window"),
    maximumWaivers: z.literal(1),
  }),
});

/** Why: Keeps host-attested incident facts and authority distinct from agent-authored analysis. Use: Pass it to every stage that needs to prove the hotfix remains within incident scope. */
type HotfixCaseValue = z.infer<typeof HotfixCase>;

const resolveHotfixCase = defineOperation({
  name: "resolve-authorized-hotfix-case",
  description:
    "Resolves the incident, current production state, and bounded emergency authority from a host token.",
  input: HotfixCaseLookup,
  output: HotfixCase,
  binding: "incident.hotfix.resolve",
  capabilities: ["network", "workspace:read", "integration:incident-management"],
  defaults: { timeout: "2m", attempts: 2 },
  authorization: { mode: "none" },
});

const HotfixImplementationInput = z.object({
  hotfixCase: HotfixCase,
});

const HotfixImplementation = z.object({
  summary: z.string().min(1),
  rootCause: z.string().min(1),
  changedFiles: z.array(z.string().min(1)).min(1),
  testsAddedOrChanged: z.array(z.string().min(1)),
  residualRisks: z.array(z.string().min(1)),
});

/** Why: Names the agent's schema-validated explanation separately from engine-owned patch and goal evidence. Use: Include it in the exact candidate dossier reviewed by the incident commander. */
type HotfixImplementationValue = z.infer<typeof HotfixImplementation>;

const hotfixPrompt = definePrompt({
  name: "implement-emergency-hotfix",
  input: HotfixImplementationInput,
  render: ({ hotfixCase }) => [
    `Implement the smallest safe fix for ${hotfixCase.incidentId}: ${hotfixCase.symptom}.`,
    `Production currently runs ${hotfixCase.productionHead}.`,
    `You may edit only: ${hotfixCase.authorization.editablePaths.join(", ")}.`,
    "Do not commit, push, deploy, access the network, weaken checks, or invent production evidence.",
  ],
});

const hotfixDeveloper = defineAgent({
  name: "emergency-hotfix-developer",
  description: "Produces one minimal in-place hotfix inside the workflow-owned workspace.",
  prompt: hotfixPrompt,
  schema: HotfixImplementation,
  defaults: {
    provider: {
      id: "codex",
      effort: "high",
      options: { sandboxMode: "workspace-write", networkAccess: false, webSearch: "disabled" },
    },
    maxTurns: 24,
    timeout: "30m",
    repair: 1,
  },
});

const RequiredVerificationInput = z.object({
  packageFilter: z.string().min(1),
  writePolicyId: z.string().min(1),
});

const authorizedDiff = defineCheck({
  name: "round-03-authorized-diff",
  description: "Rejects every changed path outside the host-attested emergency write scope.",
  input: RequiredVerificationInput,
  policy: "required",
  revision: "hotfix-write-policy-v1",
  defaults: { timeout: "2m" },
  command: ({ writePolicyId }) => ["weft-policy", "verify-changed-paths", "--policy", writePolicyId],
});

const focusedTests = defineCheck({
  name: "round-03-focused-tests",
  description: "Runs the affected package tests on the candidate workspace generation.",
  input: RequiredVerificationInput,
  policy: "required",
  revision: "hotfix-tests-v1",
  defaults: { timeout: "15m" },
  command: ({ packageFilter }) => ["pnpm", "--filter", packageFilter, "test"],
});

const packageTypecheck = defineCheck({
  name: "round-03-package-typecheck",
  description: "Rejects type regressions in the package changed by the hotfix.",
  input: RequiredVerificationInput,
  policy: "required",
  revision: "hotfix-typecheck-v1",
  defaults: { timeout: "10m" },
  command: ({ packageFilter }) => ["pnpm", "--filter", packageFilter, "typecheck"],
});

const requiredHotfixChecks = defineCheckSuite({
  name: "round-03-required-hotfix-checks",
  description: "Groups the unwaivable local safety checks needed for every hotfix candidate.",
  input: RequiredVerificationInput,
  checks: (input, use) => ({
    authorizedDiff: use(authorizedDiff, input),
    focusedTests: use(focusedTests, input),
    packageTypecheck: use(packageTypecheck, input),
  }),
  concurrency: 3,
});

const hotfixImplementationGoal = defineGoal({
  name: "round-03-locally-safe-hotfix",
  check: requiredHotfixChecks,
  defaults: { attempts: 3 },
});

const ChangeWindowInput = z.object({
  incidentId: z.string().min(1),
  environment: z.literal("production"),
  policyId: z.string().min(1),
});

const CHANGE_WINDOW_CHECK_NAME = "round-03-production-change-window";
const CHANGE_WINDOW_CHECK_REVISION = "production-window-policy-v1";
const CHANGE_WINDOW_WAIVER_BINDING = "policy.check-waiver.authorize";
const CHANGE_WINDOW_WAIVER_ACTION = "Waive one exact production change-window failure";
const CHANGE_WINDOW_WAIVER_MAX_TTL = "30m";
const CHANGE_WINDOW_WAIVER_MAX_TTL_MS = 30 * 60 * 1_000;

const productionChangeWindow = defineCheck({
  name: CHANGE_WINDOW_CHECK_NAME,
  description: "Checks whether production delivery is currently permitted without an emergency waiver.",
  input: ChangeWindowInput,
  policy: "required",
  revision: CHANGE_WINDOW_CHECK_REVISION,
  waiver: {
    mode: "eligible",
    binding: CHANGE_WINDOW_WAIVER_BINDING,
    action: CHANGE_WINDOW_WAIVER_ACTION,
    risk: "high",
    maxTtl: CHANGE_WINDOW_WAIVER_MAX_TTL,
  },
  defaults: { timeout: "2m" },
  command: ({ incidentId, policyId }) => [
    "weft-release-policy",
    "check-window",
    "--incident",
    incidentId,
    "--policy",
    policyId,
  ],
});

const SerializableCheckResult = z.object({
  status: z.enum(["pass", "fail"]),
  disposition: z.enum(["executed", "trusted", "waived"]),
  summary: z.string().optional(),
  evidence: z.string().optional(),
  candidate: WorkspaceSnapshotSchema,
});

/** Why: Names the persisted subset of a check result without pretending its nominal candidate can be reconstructed. Use: Store it inside immutable review and delivery artifacts. */
type SerializableCheckResultValue = z.input<typeof SerializableCheckResult>;

/** Why: Converts an engine check result into schema-safe evidence while preserving exact optional properties. Use: Call it only when crossing an artifact boundary. */
function serializeCheckResult(result: CheckResult): SerializableCheckResultValue {
  return {
    status: result.status,
    disposition: result.disposition,
    candidate: result.candidate,
    ...(result.summary === undefined ? {} : { summary: result.summary }),
    ...(result.evidence === undefined ? {} : { evidence: result.evidence }),
  };
}

const RequiredVerification = z.object({
  passed: z.literal(true),
  candidate: WorkspaceSnapshotSchema,
  implementationGoalEvidence: z.string().min(1),
  results: z.object({
    authorizedDiff: SerializableCheckResult,
    focusedTests: SerializableCheckResult,
    packageTypecheck: SerializableCheckResult,
  }),
});

/** Why: Names the final post-commit verification proof separately from the repair loop's earlier attempts. Use: Require it in review evidence and final delivery input. */
type RequiredVerificationValue = z.input<typeof RequiredVerification>;

const RollbackPreparationInput = z.object({
  incidentId: z.string().min(1),
  repository: z.string().min(1),
  environment: z.literal("production"),
  productionHead: z.string().min(1),
  candidate: ExactCandidate,
});

const RollbackRehearsal = z.object({
  provenance: z.literal("host-attested"),
  rollbackId: z.string().min(1),
  incidentId: z.string().min(1),
  environment: z.literal("production"),
  candidateHead: z.string().min(1),
  restoreHead: z.string().min(1),
  snapshot: WorkspaceSnapshotSchema,
  dryRun: z.object({
    status: z.literal("passed"),
    runRef: z.string().min(1),
    sha256: z.string().min(1),
  }),
  expiresAt: z.string().datetime(),
  attestation: z.string().min(1),
});

/** Why: Names host-attested rollback readiness rather than treating a prose rollback plan as executable proof. Use: Bind it to the candidate generation and require it at production delivery. */
type RollbackRehearsalValue = z.infer<typeof RollbackRehearsal>;

const prepareRollback = defineOperation({
  name: "prepare-exact-hotfix-rollback",
  description: "Rehearses restoration of the current production revision for one exact candidate generation.",
  input: RollbackPreparationInput,
  output: RollbackRehearsal,
  binding: "delivery.rollback.prepare",
  capabilities: ["git:read", "network", "integration:deployment"],
  defaults: { timeout: "10m", attempts: 1 },
  authorization: {
    mode: "required",
    action: "Rehearse an exact production rollback in the external deployment system",
    risk: "high",
    timeout: "30m",
  },
});

const RollbackArtifactMetadata = z.object({
  workflowRunId: z.string().min(1),
  incidentId: z.string().min(1),
  candidate: ExactCandidate,
});

const rollbackEvidenceArtifact = defineArtifact({
  name: "round-03-rollback-evidence",
  mediaType: "application/json",
  extension: ".json",
  content: RollbackRehearsal,
  metadata: RollbackArtifactMetadata,
});

/** Why: Names the immutable rollback evidence reference used as a human-review attachment and delivery prerequisite. Use: Ensure its hash is retained inside the primary candidate dossier. */
type RollbackArtifactRef = ArtifactRefOf<typeof rollbackEvidenceArtifact>;

const HotfixReviewDossierContent = z.object({
  hotfixCase: HotfixCase,
  implementation: HotfixImplementation,
  candidate: ExactCandidate,
  requiredVerification: RequiredVerification,
  changeWindow: SerializableCheckResult,
  rollback: RollbackRehearsal,
  rollbackArtifact: ArtifactPointer,
});

const HotfixReviewDossierMetadata = z.object({
  workflowRunId: z.string().min(1),
  incidentId: z.string().min(1),
  candidate: ExactCandidate,
});

const hotfixReviewDossier = defineArtifact({
  name: "round-03-hotfix-review-dossier",
  mediaType: "application/json",
  extension: ".json",
  content: HotfixReviewDossierContent,
  metadata: HotfixReviewDossierMetadata,
});

/** Why: Names the immutable primary artifact whose exact hash is approved or rejected by a human. Use: Validate the returned review subject before accepting any decision. */
type HotfixReviewDossierRef = ArtifactRefOf<typeof hotfixReviewDossier>;

const WaiverRequest = z.object({
  checkName: z.literal("round-03-production-change-window"),
  checkRevision: z.literal("production-window-policy-v1"),
  reason: z.string().min(1),
  expiresAt: z.string().datetime(),
});

const HotfixReviewAnswer = z.discriminatedUnion("decision", [
  z.object({
    decision: z.literal("approve"),
    note: z.string().min(1),
    waiver: WaiverRequest.optional(),
  }),
  z.object({
    decision: z.literal("reject"),
    reason: z.string().min(1),
  }),
]);

/** Why: Names the reviewer answer before it is proven to belong to the exact candidate artifact. Use: Accept it from `ctx.human.review` and refine it with `requireApprovedReview`. */
type HotfixReviewAnswerValue = z.infer<typeof HotfixReviewAnswer>;

const ApprovedHotfixReview = z.object({
  decision: z.literal("approve"),
  reviewerId: z.string().min(1),
  submittedAt: z.string().min(1),
  candidateRef: z.string().min(1),
  candidateSha256: z.string().min(1),
  reviewedRef: z.string().min(1),
  reviewedSha256: z.string().min(1),
  note: z.string().min(1),
  waiverRequest: WaiverRequest.optional(),
});

/** Why: Carries only a positive human decision bound to the exact immutable candidate dossier. Use: Pass it to waiver authorization and production delivery. */
type ApprovedHotfixReviewValue = z.infer<typeof ApprovedHotfixReview>;

/** Why: Prevents a decision about stale or different bytes from authorizing this candidate. Use: Call after the approval branch and before requesting a waiver or delivery gate. */
function requireApprovedReview(
  review: HumanReviewResult<HotfixReviewAnswerValue>,
  dossier: HotfixReviewDossierRef,
): ApprovedHotfixReviewValue {
  if (review.answer.decision !== "approve") {
    throw new Error("A rejected hotfix dossier cannot authorize production delivery");
  }
  if (
    review.subject.kind !== "artifact" ||
    review.subject.ref !== dossier.ref ||
    review.subject.sha256 !== dossier.sha256
  ) {
    throw new Error("The human decision is not bound to the exact hotfix dossier");
  }
  return {
    decision: "approve",
    reviewerId: review.reviewer.id,
    submittedAt: review.submittedAt,
    candidateRef: dossier.ref,
    candidateSha256: dossier.sha256,
    reviewedRef: review.subject.ref,
    reviewedSha256: review.subject.sha256,
    note: review.answer.note,
    ...(review.answer.waiver === undefined ? {} : { waiverRequest: review.answer.waiver }),
  };
}

const ChangeWindowWaiverEvidence = z.object({
  ref: z.string().min(1),
  check: z.literal(CHANGE_WINDOW_CHECK_NAME),
  revision: z.literal(CHANGE_WINDOW_CHECK_REVISION),
  definitionDigest: z.string().min(1),
  binding: z.literal(CHANGE_WINDOW_WAIVER_BINDING),
  action: z.literal(CHANGE_WINDOW_WAIVER_ACTION),
  risk: z.literal("high"),
  maxTtl: z.literal(CHANGE_WINDOW_WAIVER_MAX_TTL),
  candidate: WorkspaceSnapshotSchema,
  failureAttestationRef: z.string().min(1),
  reason: z.string().min(1),
  issue: z.string().min(1).optional(),
  authorizedBy: z.object({
    kind: z.enum(["human", "policy"]),
    id: z.string().min(1),
  }),
  authorizedAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
  attestationRef: z.string().min(1),
});

/** Why: Names the serializable projection of nominal waiver authority retained in delivery evidence. Use: Never pass this projection back to `ctx.check`; only the engine-minted ref is executable authority. */
type ChangeWindowWaiverEvidenceValue = z.infer<typeof ChangeWindowWaiverEvidence>;

/** Why: Projects an engine-minted waiver ref across a schema boundary without pretending the projection remains authority. Use: Store it in review and delivery artifacts after the waived invocation retains the original ref. */
function serializeChangeWindowWaiver(
  waiver: CheckWaiverRef<typeof productionChangeWindow>,
): ChangeWindowWaiverEvidenceValue {
  if (waiver.revision !== CHANGE_WINDOW_CHECK_REVISION) {
    throw new Error("The waiver ref names an unexpected change-window check revision");
  }
  return {
    ref: waiver.ref,
    check: waiver.check,
    revision: CHANGE_WINDOW_CHECK_REVISION,
    definitionDigest: waiver.definitionDigest,
    binding: waiver.binding,
    action: waiver.action,
    risk: waiver.risk,
    maxTtl: waiver.maxTtl,
    candidate: waiver.candidate,
    failureAttestationRef: waiver.failure.ref,
    reason: waiver.reason,
    ...(waiver.issue === undefined ? {} : { issue: waiver.issue }),
    authorizedBy: waiver.authorizedBy,
    authorizedAt: waiver.authorizedAt,
    expiresAt: waiver.expiresAt,
    attestationRef: waiver.attestation.ref,
  };
}

const ChangeWindowAcceptance = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("passed"),
    result: SerializableCheckResult,
  }),
  z.object({
    kind: z.literal("waived"),
    result: SerializableCheckResult,
    authorization: ChangeWindowWaiverEvidence,
  }),
]);

/** Why: Makes the normal and exceptional policy paths explicit in the production delivery contract. Use: Require one accepted branch instead of inferring acceptance from a generic check status. */
type ChangeWindowAcceptanceValue = z.infer<typeof ChangeWindowAcceptance>;

const ApprovedDeliveryGate = z.object({
  approved: z.literal(true),
  answeredBy: z.enum(["human", "policy"]),
  note: z.string().optional(),
});

/** Why: Excludes denial and timeout states from the production operation's schema. Use: Construct it only after checking the gate result. */
type ApprovedDeliveryGateValue = z.infer<typeof ApprovedDeliveryGate>;

/** Why: Narrows a general gate response to the positive handoff accepted by the delivery adapter. Use: Call only after returning from every denial and timeout branch. */
function requireApprovedDeliveryGate(gate: GateResult): ApprovedDeliveryGateValue {
  if (!gate.approved || gate.answeredBy === "timeout") {
    throw new Error("Production delivery was not authorized");
  }
  return gate.note === undefined
    ? { approved: true, answeredBy: gate.answeredBy }
    : { approved: true, answeredBy: gate.answeredBy, note: gate.note };
}

const DeliveryDossierContent = z.object({
  hotfixCase: HotfixCase,
  candidate: ExactCandidate,
  reviewArtifact: ArtifactPointer,
  review: ApprovedHotfixReview,
  requiredVerification: RequiredVerification,
  changeWindow: ChangeWindowAcceptance,
  rollbackArtifact: ArtifactPointer,
  rollback: RollbackRehearsal,
});

const DeliveryDossierMetadata = z.object({
  workflowRunId: z.string().min(1),
  incidentId: z.string().min(1),
  candidate: ExactCandidate,
});

const deliveryDossierArtifact = defineArtifact({
  name: "round-03-hotfix-delivery-dossier",
  mediaType: "application/json",
  extension: ".json",
  content: DeliveryDossierContent,
  metadata: DeliveryDossierMetadata,
});

/** Why: Names the final immutable collection of all review, waiver, verification, and rollback evidence. Use: Bind the production gate and host delivery adapter to its exact hash. */
type DeliveryDossierRef = ArtifactRefOf<typeof deliveryDossierArtifact>;

const ProductionDeliveryInput = z.object({
  incidentId: z.string().min(1),
  repository: z.string().min(1),
  environment: z.literal("production"),
  policyId: z.string().min(1),
  candidate: ExactCandidate,
  dossier: ArtifactPointer,
  review: ApprovedHotfixReview,
  requiredVerification: RequiredVerification,
  changeWindow: ChangeWindowAcceptance,
  rollback: RollbackRehearsal,
  authorization: ApprovedDeliveryGate,
});

const ProductionDeliveryResult = z.object({
  status: z.literal("deployed"),
  deploymentId: z.string().min(1),
  environment: z.literal("production"),
  deployedHead: z.string().min(1),
  snapshot: WorkspaceSnapshotSchema,
  rollbackId: z.string().min(1),
  attestation: z.string().min(1),
  url: z.string().url(),
});

/** Why: Names the host-attested delivery outcome used for exact-generation postcondition checks. Use: Return it only after matching it back to the requested candidate and rollback proof. */
type ProductionDeliveryResultValue = z.infer<typeof ProductionDeliveryResult>;

const deliverEmergencyHotfix = defineOperation({
  name: "deliver-exact-emergency-hotfix",
  description: "Deploys exactly one reviewed and verified workspace generation with a prepared rollback.",
  input: ProductionDeliveryInput,
  output: ProductionDeliveryResult,
  binding: "delivery.production.hotfix",
  capabilities: ["git:read", "network", "secrets:read", "integration:deployment"],
  defaults: { timeout: "20m", attempts: 1 },
  authorization: {
    mode: "required",
    action: "Deploy an exact reviewed hotfix candidate to production",
    risk: "irreversible",
    timeout: "30m",
  },
});

const HotfixWorkflowOutput = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("rejected"),
    incidentId: z.string().min(1),
    candidate: ExactCandidate,
    reviewArtifact: ArtifactPointer,
    reason: z.string().min(1),
  }),
  z.object({
    status: z.literal("waiver-required"),
    incidentId: z.string().min(1),
    candidate: ExactCandidate,
    reviewArtifact: ArtifactPointer,
    reason: z.string().min(1),
  }),
  z.object({
    status: z.literal("delivery-denied"),
    incidentId: z.string().min(1),
    candidate: ExactCandidate,
    dossier: ArtifactPointer,
    reason: z.string().min(1),
  }),
  z.object({
    status: z.literal("delivered"),
    incidentId: z.string().min(1),
    candidate: ExactCandidate,
    dossier: ArtifactPointer,
    delivery: ProductionDeliveryResult,
  }),
]);

/** Why: Keeps every review, policy, authorization, and delivery branch inside the declared output union. Use: Annotate the workflow callback so terminal status literals cannot widen. */
type HotfixWorkflowOutputValue = z.input<typeof HotfixWorkflowOutput>;

/** Why: Compares two engine-issued workspace snapshots without erasing their nominal provenance. Use: Reject stale verification, waiver, rollback, or delivery evidence. */
function sameWorkspaceSnapshot(left: WorkspaceSnapshotRef, right: WorkspaceSnapshotRef): boolean {
  return (
    left.workspaceId === right.workspaceId &&
    left.generation === right.generation &&
    left.treeHash === right.treeHash
  );
}

/** Why: Fails closed when an effect or proof refers to a different workspace generation. Use: Call at every transition whose current API cannot encode snapshot equality in its types. */
function requireWorkspaceSnapshot(
  expected: WorkspaceSnapshotRef,
  actual: WorkspaceSnapshotRef,
  evidenceName: string,
): void {
  if (!sameWorkspaceSnapshot(expected, actual)) {
    throw new Error(`${evidenceName} does not describe the exact hotfix candidate generation`);
  }
}

/** Why: Verifies that a host result preserved the requested exact candidate and rollback identity. Use: Call before reporting a successful production delivery. */
function requireExactDelivery(
  delivery: ProductionDeliveryResultValue,
  candidate: ExactCandidateValue,
  rollback: RollbackRehearsalValue,
): void {
  if (
    delivery.deployedHead !== candidate.head ||
    delivery.rollbackId !== rollback.rollbackId ||
    !sameWorkspaceSnapshot(
      delivery.snapshot as WorkspaceSnapshotRef,
      candidate.snapshot as WorkspaceSnapshotRef,
    )
  ) {
    throw new Error("The production result does not attest the requested candidate and rollback");
  }
}

/** Why: Demonstrates an emergency hotfix that remains evidence-bound despite human review and a narrow waiver path. Use: Launch it with a host-issued incident token and an isolated branch based on the requested production revision. */
const emergencyHotfixWorkflow = defineWorkflow(
  {
    id: "round-03-hotfix-release",
    name: "Emergency hotfix review and delivery",
    description:
      "Implements, verifies, reviews, authorizes, and deploys one exact hotfix with rollback proof.",
    input: HotfixWorkflowInput,
    output: HotfixWorkflowOutput,
    workspace: ({ input }) => ({ branch: input.branch, from: input.baseRef }),
  },
  async (ctx, input): Promise<HotfixWorkflowOutputValue> => {
    const hotfixCase = await ctx.operation(
      resolveHotfixCase,
      { incidentToken: input.incidentToken, requestedBaseRef: input.baseRef },
      { key: "resolve-hotfix-case" },
    );

    expectType<HotfixCaseValue>(hotfixCase);
    if (hotfixCase.productionHead !== input.baseRef) {
      throw new Error("The workflow workspace is not based on the attested production revision");
    }

    const verificationInput = {
      packageFilter: hotfixCase.authorization.packageFilter,
      writePolicyId: hotfixCase.authorization.writePolicyId,
    };

    const writeScope = await ctx.paths.resolve(
      hotfixWritePolicy,
      { proposedPaths: hotfixCase.authorization.editablePaths },
      { key: "resolve-hotfix-write-paths", label: "Resolve emergency edit paths" },
    );
    const implementation = await ctx.agent(
      hotfixDeveloper,
      { hotfixCase },
      {
        key: "implement-hotfix",
        write: writeScope,
        goal: { definition: hotfixImplementationGoal, input: verificationInput, attempts: 3 },
      },
    );

    expectType<HotfixImplementationValue>(implementation.value);
    if (implementation.files.length === 0) throw new Error("The hotfix produced no changed files");

    await ctx.git.add({ key: "stage-hotfix", paths: implementation.files });
    const commit = await ctx.git.commit({
      key: "commit-hotfix",
      message: `fix: emergency hotfix for ${hotfixCase.incidentId}`,
      paths: implementation.files,
    });

    const candidateSnapshot = ctx.workspace.snapshot;
    const finalChecks = await ctx.check(requiredHotfixChecks, verificationInput, {
      key: "final-required",
      policy: "required",
      concurrency: 3,
      candidate: candidateSnapshot,
    });
    if (!finalChecks.passed) throw new Error("An unwaivable hotfix check failed");

    const candidate: ExactCandidateValue = {
      branch: ctx.workspace.branch,
      head: commit.sha,
      snapshot: candidateSnapshot,
    };
    const requiredVerification: RequiredVerificationValue = {
      passed: true,
      candidate: candidateSnapshot,
      implementationGoalEvidence: implementation.goal.evidence,
      results: {
        authorizedDiff: serializeCheckResult(finalChecks.results.authorizedDiff),
        focusedTests: serializeCheckResult(finalChecks.results.focusedTests),
        packageTypecheck: serializeCheckResult(finalChecks.results.packageTypecheck),
      },
    };

    const rollbackCandidate = await ctx.operation.prepare(
      prepareRollback,
      {
        incidentId: hotfixCase.incidentId,
        repository: hotfixCase.repository,
        environment: hotfixCase.environment,
        productionHead: hotfixCase.productionHead,
        candidate,
      },
      { key: "freeze-rollback-rehearsal", label: "Freeze exact rollback rehearsal" },
    );
    const rollbackAuthorization = await ctx.operation.authorize(prepareRollback, rollbackCandidate, {
      key: "authorize-rollback-rehearsal",
      detail: `Rehearse restoring ${hotfixCase.productionHead} for candidate ${candidate.head}.`,
    });
    const rollback = await ctx.operation.execute(
      prepareRollback,
      { candidate: rollbackCandidate, authorization: rollbackAuthorization },
      { key: "prepare-rollback", attempts: 1 },
    );
    requireWorkspaceSnapshot(
      candidateSnapshot,
      rollback.snapshot as WorkspaceSnapshotRef,
      "Rollback",
    );
    if (rollback.candidateHead !== candidate.head || rollback.restoreHead !== hotfixCase.productionHead) {
      throw new Error("Rollback evidence does not restore the attested production revision");
    }

    const rollbackArtifact = await ctx.artifact(
      rollbackEvidenceArtifact,
      {
        content: rollback,
        metadata: { workflowRunId: ctx.run.id, incidentId: hotfixCase.incidentId, candidate },
      },
      {
        key: "rollback-evidence",
        label: "Attested rollback rehearsal",
        candidate: candidateSnapshot,
      },
    );
    expectType<RollbackArtifactRef>(rollbackArtifact);

    const changeWindowInput = {
      incidentId: hotfixCase.incidentId,
      environment: hotfixCase.environment,
      policyId: hotfixCase.waiverPolicy.policyId,
    };
    const initialWindow = await ctx.check(productionChangeWindow, changeWindowInput, {
      key: "production-change-window",
      policy: "required",
      candidate: candidateSnapshot,
    });

    const reviewArtifact = await ctx.artifact(
      hotfixReviewDossier,
      {
        content: {
          hotfixCase,
          implementation: implementation.value,
          candidate,
          requiredVerification,
          changeWindow: serializeCheckResult(initialWindow),
          rollback,
          rollbackArtifact: { ref: rollbackArtifact.ref, sha256: rollbackArtifact.sha256 },
        },
        metadata: { workflowRunId: ctx.run.id, incidentId: hotfixCase.incidentId, candidate },
      },
      {
        key: "hotfix-review-dossier",
        label: `Hotfix ${hotfixCase.incidentId} at ${candidate.head}`,
        candidate: candidateSnapshot,
      },
    );

    const review = await ctx.human.review({
      key: "review-exact-hotfix",
      question: `Approve exact hotfix ${candidate.head} for ${hotfixCase.environment}?`,
      subject: {
        kind: "artifact",
        path: reviewArtifact.ref,
        mediaType: reviewArtifact.mediaType,
        label: reviewArtifact.name,
      },
      attachments: [
        {
          kind: "artifact",
          path: rollbackArtifact.ref,
          mediaType: rollbackArtifact.mediaType,
          label: rollbackArtifact.name,
        },
      ],
      schema: HotfixReviewAnswer,
      timeout: "30m",
      onTimeout: "deny",
    });

    if (review.answer.decision === "reject") {
      return {
        status: "rejected",
        incidentId: hotfixCase.incidentId,
        candidate,
        reviewArtifact: { ref: reviewArtifact.ref, sha256: reviewArtifact.sha256 },
        reason: review.answer.reason,
      };
    }

    const approvedReview = requireApprovedReview(review, reviewArtifact);
    let changeWindow: ChangeWindowAcceptanceValue;

    if (initialWindow.status === "pass" && initialWindow.disposition === "executed") {
      if (approvedReview.waiverRequest !== undefined) {
        return {
          status: "waiver-required",
          incidentId: hotfixCase.incidentId,
          candidate,
          reviewArtifact: { ref: reviewArtifact.ref, sha256: reviewArtifact.sha256 },
          reason: "A waiver was requested for a check that already passed",
        };
      }
      changeWindow = { kind: "passed", result: serializeCheckResult(initialWindow) };
    } else {
      if (initialWindow.status !== "fail" || initialWindow.disposition !== "executed") {
        return {
          status: "waiver-required",
          incidentId: hotfixCase.incidentId,
          candidate,
          reviewArtifact: { ref: reviewArtifact.ref, sha256: reviewArtifact.sha256 },
          reason: "Only an executed change-window failure is eligible for waiver authorization",
        };
      }
      if (approvedReview.waiverRequest === undefined) {
        return {
          status: "waiver-required",
          incidentId: hotfixCase.incidentId,
          candidate,
          reviewArtifact: { ref: reviewArtifact.ref, sha256: reviewArtifact.sha256 },
          reason: "The production change window failed and no emergency waiver was requested",
        };
      }

      const requestedExpiresAtMs = Date.parse(approvedReview.waiverRequest.expiresAt);
      const requestedAtMs = await ctx.now({ key: "change-window-waiver-requested-at" });
      const requestedTtlMs = Math.floor(requestedExpiresAtMs - requestedAtMs);
      if (
        !Number.isFinite(requestedExpiresAtMs) ||
        requestedTtlMs <= 0 ||
        requestedTtlMs > CHANGE_WINDOW_WAIVER_MAX_TTL_MS
      ) {
        return {
          status: "waiver-required",
          incidentId: hotfixCase.incidentId,
          candidate,
          reviewArtifact: { ref: reviewArtifact.ref, sha256: reviewArtifact.sha256 },
          reason: "The requested waiver expiry is past or exceeds the check's 30-minute policy maximum",
        };
      }

      const waiver = await ctx.check.authorizeWaiver(productionChangeWindow, initialWindow, {
        key: "authorize-change-window-waiver",
        reason: approvedReview.waiverRequest.reason,
        issue: hotfixCase.incidentId,
        ttl: requestedTtlMs,
        detail: `Reviewer ${approvedReview.reviewerId} requested ${CHANGE_WINDOW_CHECK_REVISION} for exact candidate ${candidate.head} and dossier ${approvedReview.reviewedSha256}.`,
      });
      const waiverObservedAtMs = await ctx.now({ key: "change-window-waiver-observed-at" });
      if (
        waiver.failure.ref !== initialWindow.attestation.ref ||
        waiver.reason !== approvedReview.waiverRequest.reason ||
        waiver.issue !== hotfixCase.incidentId ||
        Date.parse(waiver.authorizedAt) > waiverObservedAtMs ||
        Date.parse(waiver.expiresAt) <= waiverObservedAtMs ||
        Date.parse(waiver.expiresAt) > requestedExpiresAtMs
      ) {
        throw new Error("The host waiver did not preserve the failed check, request, or expiry bound");
      }

      const waivedWindow = await ctx.check(productionChangeWindow, changeWindowInput, {
        key: "waived-production-change-window",
        policy: "required",
        waive: waiver,
      });
      if (waivedWindow.disposition !== "waived") {
        throw new Error("The change-window check was not recorded as waived");
      }
      if (waivedWindow.waiver.ref !== waiver.ref) {
        throw new Error("The waived check result did not retain the exact authorization ref");
      }
      changeWindow = {
        kind: "waived",
        result: serializeCheckResult(waivedWindow),
        authorization: serializeChangeWindowWaiver(waivedWindow.waiver),
      };
    }

    const deliveryDossier = await ctx.artifact(
      deliveryDossierArtifact,
      {
        content: {
          hotfixCase,
          candidate,
          reviewArtifact: { ref: reviewArtifact.ref, sha256: reviewArtifact.sha256 },
          review: approvedReview,
          requiredVerification,
          changeWindow,
          rollbackArtifact: { ref: rollbackArtifact.ref, sha256: rollbackArtifact.sha256 },
          rollback,
        },
        metadata: { workflowRunId: ctx.run.id, incidentId: hotfixCase.incidentId, candidate },
      },
      {
        key: "delivery-dossier",
        label: `Authorized delivery dossier for ${candidate.head}`,
        candidate: candidateSnapshot,
      },
    );
    expectType<DeliveryDossierRef>(deliveryDossier);

    const deliveryGate = await ctx.gate({
      key: "authorize-production-hotfix",
      action: `Deploy ${candidate.head} to production for ${hotfixCase.incidentId}`,
      risk: "irreversible",
      detail: `Exact workspace ${candidate.snapshot.workspaceId}:${candidate.snapshot.generation}:${candidate.snapshot.treeHash}; dossier ${deliveryDossier.ref} (${deliveryDossier.sha256}); rollback ${rollback.rollbackId}.`,
    });

    if (!deliveryGate.approved || deliveryGate.answeredBy === "timeout") {
      return {
        status: "delivery-denied",
        incidentId: hotfixCase.incidentId,
        candidate,
        dossier: { ref: deliveryDossier.ref, sha256: deliveryDossier.sha256 },
        reason: deliveryGate.note ?? `Production gate ${deliveryGate.answeredBy}`,
      };
    }

    requireWorkspaceSnapshot(
      candidateSnapshot,
      ctx.workspace.snapshot,
      "Current workspace",
    );
    const currentHead = await ctx.git.head({ key: "revalidate-hotfix-head" });
    if (currentHead.sha !== candidate.head)
      throw new Error("The reviewed candidate head changed before delivery");

    const deliveryCandidate = await ctx.operation.prepare(
      deliverEmergencyHotfix,
      {
        incidentId: hotfixCase.incidentId,
        repository: hotfixCase.repository,
        environment: hotfixCase.environment,
        policyId: hotfixCase.authorization.policyId,
        candidate,
        dossier: { ref: deliveryDossier.ref, sha256: deliveryDossier.sha256 },
        review: approvedReview,
        requiredVerification,
        changeWindow,
        rollback,
        authorization: requireApprovedDeliveryGate(deliveryGate),
      },
      { key: "prepare-emergency-hotfix-delivery", label: "Freeze exact production delivery" },
    );
    const deliveryAuthorization = await ctx.operation.authorize(deliverEmergencyHotfix, deliveryCandidate, {
      key: "authorize-emergency-hotfix-delivery",
      detail: `Deploy ${candidate.head} with dossier ${deliveryDossier.sha256} and rollback ${rollback.rollbackId}.`,
    });
    const delivery = await ctx.operation.execute(
      deliverEmergencyHotfix,
      { candidate: deliveryCandidate, authorization: deliveryAuthorization },
      { key: "deliver-emergency-hotfix", attempts: 1 },
    );
    requireExactDelivery(delivery, candidate, rollback);

    await ctx.note({
      key: "record-emergency-hotfix-delivery",
      kind: "claim",
      text: `Delivered ${candidate.head} to production with rollback ${rollback.rollbackId}.`,
      evidence: deliveryDossier.ref,
    });

    return {
      status: "delivered",
      incidentId: hotfixCase.incidentId,
      candidate,
      dossier: { ref: deliveryDossier.ref, sha256: deliveryDossier.sha256 },
      delivery,
    };
  },
);

expectType<WorkflowNode<"weft.workflow">>(emergencyHotfixWorkflow);

declare const unboundReview: HumanReviewResult<HotfixReviewAnswerValue>;
declare const unboundGate: GateResult;

// @ts-expect-error A general human answer is not proof that the exact dossier was approved.
expectType<ApprovedHotfixReviewValue>(unboundReview);
// @ts-expect-error A general gate response is not a positive, non-timeout production authorization.
expectType<ApprovedDeliveryGateValue>(unboundGate);

// DX boundary: a future review node should own the reviewer policy, immutable subject and attachment manifest,
// decision schema, timeout behavior, and a nominal subject-bound decision result. The workflow should still own
// ordinary TypeScript branching and domain-specific interpretation of an approve, reject, or waiver request.
//
// DX boundary: the protected operation owns binding, risk, capabilities, and candidate-bound authority. Exact-generation
// proof, rollback contracts, and outcome checks remain domain schemas; the three explicit transition calls are sound but
// make a compact delivery flow noticeably more verbose when a separate business gate must also remain inspectable.
//
// Round 6 reimplementation: waiver eligibility, host policy, maximum TTL, exact failed candidate, and authorization
// now remain nominal from `ctx.check.authorizeWaiver` through the waived result. Only the serializable evidence projection
// is structural, and it is never accepted back as executable waiver authority.
