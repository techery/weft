import {
  type ContextSnapshotOf,
  defineAgent,
  defineArtifact,
  defineCheck,
  defineCheckSuite,
  defineContextSource,
  defineDelivery,
  definePathPolicy,
  definePrompt,
  defineReview,
  defineWorkflow,
  type WriteScope,
  z,
} from "../../index.ts";
import type { WaiverEligibleCheckDefinition } from "../../advanced.ts";

/** Why: Keeps compile-time security assertions readable without adding runtime behavior. Use: Pass inferred definitions or capabilities to it below. */
declare function expectType<Type>(value: Type): void;

const REPOSITORY = "techery/weft";

const SecurityRemediationInput = z.object({
  caseToken: z.string().min(1),
  branch: z.string().min(1),
  baseRef: z.string().min(1),
});

const SecurityCaseLookup = SecurityRemediationInput.pick({ caseToken: true });

const SecurityCase = z.object({
  caseId: z.string().min(1),
  revision: z.string().min(1),
  repository: z.literal(REPOSITORY),
  advisory: z.object({
    id: z.string().min(1),
    packageName: z.string().min(1),
    currentVersion: z.string().min(1),
    fixedVersion: z.string().min(1),
    severity: z.enum(["high", "critical"]),
  }),
  routing: z.object({
    branch: z.string().min(1),
    baseRef: z.string().min(1),
    authorizedHead: z.string().min(1),
  }),
  packageFilter: z.string().min(1),
  remediationPaths: z.array(z.string().min(1)).min(1),
  acceptanceCriteria: z.array(z.string().min(1)).min(1),
});

/** Why: Names the host-authoritative remediation case separately from caller routing hints and model output. Use: Revalidate it before granting writes and again inside review. */
type SecurityCaseValue = z.infer<typeof SecurityCase>;

const securityCaseSource = defineContextSource({
  name: "refined-security-remediation-case",
  description: "Resolves current scanner evidence and repository policy from an opaque case token.",
  input: SecurityCaseLookup,
  output: SecurityCase,
  binding: "security.case.resolve",
  freshness: { maxAge: "5m", stale: "reject" },
  trust: { minimum: "authoritative", authorities: ["security-control"] },
});

/** Why: Rejects stale, downgraded, or unexpectedly issued source data before it can influence mutation. Use: Call immediately after every security-case resolution. */
function requireAuthoritativeCase(snapshot: ContextSnapshotOf<typeof securityCaseSource>): SecurityCaseValue {
  if (
    snapshot.trust.level !== "authoritative" ||
    snapshot.trust.authority !== "security-control" ||
    snapshot.freshness.status !== "fresh"
  ) {
    throw new Error("Security remediation requires fresh security-control evidence");
  }
  return snapshot.value;
}

const remediationWritePolicy = definePathPolicy({
  name: "refined-security-remediation-writes",
  description:
    "Allows only dependency manifests, the lockfile, and affected package sources selected by policy.",
  revision: "security-remediation-v1",
  roots: ["package.json", "pnpm-lock.yaml", "packages/"],
  deny: [".git/**", ".github/**", ".weft/**", ".env*", "**/secrets/**"],
  grantTtl: "45m",
});

const RemediationAgentInput = z.object({
  securityCase: SecurityCase,
});

const RemediationReport = z.object({
  summary: z.string().min(1),
});

const remediationPrompt = definePrompt({
  name: "refined-implement-security-remediation",
  input: RemediationAgentInput,
  render: ({ securityCase }) => [
    `Remediate ${securityCase.advisory.id}: upgrade ${securityCase.advisory.packageName} from ${securityCase.advisory.currentVersion} to exactly ${securityCase.advisory.fixedVersion}.`,
    `Authorized paths: ${securityCase.remediationPaths.join(", ")}; criteria: ${securityCase.acceptanceCriteria.join("; ")}.`,
    "Make the smallest sound change. Do not suppress scanners or tests, edit policy files, commit, push, or use the network.",
  ],
});

const remediationDeveloper = defineAgent({
  name: "refined-security-remediation-developer",
  prompt: remediationPrompt,
  schema: RemediationReport,
  defaults: {
    provider: {
      id: "codex",
      effort: "high",
      options: { sandboxMode: "workspace-write", networkAccess: false, webSearch: "disabled" },
    },
    maxTurns: 24,
    timeout: "40m",
    repair: 1,
  },
});

const VerificationInput = z.object({
  caseId: z.string().min(1),
  packageFilter: z.string().min(1),
  candidateTree: z.string().min(1),
  pathGrantRef: z.string().min(1),
});

const securityRemediated = defineCheck({
  name: "refined-security-advisory-remediated",
  revision: "security-verification-v1",
  input: VerificationInput,
  policy: "required",
  waiver: { mode: "never" },
  defaults: { timeout: "15m" },
  command: ({ caseId, candidateTree }) => ["weft-security", "verify-remediation", caseId, candidateTree],
});

const repositoryIntegrity = defineCheck({
  name: "refined-security-repository-integrity",
  revision: "repository-integrity-v1",
  input: VerificationInput,
  policy: "required",
  waiver: { mode: "never" },
  defaults: { timeout: "20m" },
  command: ({ caseId, packageFilter, candidateTree, pathGrantRef }) => [
    "weft-security",
    "verify-repository",
    caseId,
    packageFilter,
    candidateTree,
    pathGrantRef,
  ],
});

const securityVerification = defineCheckSuite({
  name: "refined-security-remediation-verification",
  input: VerificationInput,
  checks: (input, use) => ({
    security: use(securityRemediated, input),
    integrity: use(repositoryIntegrity, input),
  }),
  concurrency: 2,
});

const ReviewFinding = z.object({
  severity: z.enum(["low", "medium", "high", "critical"]),
  code: z.string().min(1),
  message: z.string().min(1),
  file: z.string().min(1).optional(),
});

const AdversarialReviewReport = z.object({
  summary: z.string().min(1),
  findings: z.array(ReviewFinding),
});

const CandidateReviewInput = z.object({
  caseToken: z.string().min(1),
  caseId: z.string().min(1),
  caseRevision: z.string().min(1),
  candidateTree: z.string().min(1),
  changedFiles: z.array(z.string().min(1)).min(1),
  implementationSummary: z.string().min(1),
  verificationRefs: z.array(z.string().min(1)).length(2),
});

const adversarialSecurityReview = defineReview({
  name: "refined-adversarial-security-review",
  input: CandidateReviewInput,
  finding: ReviewFinding,
  evaluate: async (ctx, input) => {
    const currentSnapshot = await ctx.context(
      securityCaseSource,
      { caseToken: input.caseToken },
      { key: "adversarial-review:context", label: "Refresh security case for review" },
    );
    const current = requireAuthoritativeCase(currentSnapshot);
    if (current.caseId !== input.caseId || current.revision !== input.caseRevision) {
      const message = "The authoritative security case changed after implementation.";
      return {
        sourceEvidence: [currentSnapshot.evidence],
        assessments: [
          {
            finding: { severity: "critical" as const, code: "security-case-drift", message },
            disposition: "blocking" as const,
            sources: [currentSnapshot.evidence.ref],
            rationale: message,
          },
        ],
      };
    }

    const report = await ctx.agent({
      prompt: [
        `Try to refute case ${current.caseId} on exact tree ${input.candidateTree}.`,
        `Inspect the diff for ${input.changedFiles.join(", ")}.`,
        `Implementation claim: ${input.implementationSummary}.`,
        `Verification evidence: ${input.verificationRefs.join(", ")}.`,
        "Look for incomplete upgrades, lockfile drift, regressions, scope violations, and weakened tests.",
        "Report concrete findings only. Do not modify files, use the network, or trust the implementation claim.",
      ],
      schema: AdversarialReviewReport,
    }, {
      key: "adversarial-review:agent",
      provider: {
        id: "codex",
        effort: "high",
        options: { sandboxMode: "read-only", networkAccess: false, webSearch: "disabled" },
      },
      maxTurns: 16,
      timeout: "25m",
      context: [currentSnapshot],
    });
    return {
      summary: report.value.summary,
      sourceEvidence: [currentSnapshot.evidence],
      assessments: report.value.findings.map((finding) => ({
        finding,
        disposition: finding.severity === "high" || finding.severity === "critical" ? "blocking" : "advisory",
        sources: [currentSnapshot.evidence.ref, ...input.verificationRefs],
        rationale: finding.message,
      })),
    };
  },
  accept: ({ assessments }) => assessments.every(({ disposition }) => disposition !== "blocking"),
});

const RemediationEvidence = z.object({
  caseId: z.string().min(1),
  caseRevision: z.string().min(1),
  candidateTree: z.string().min(1),
  changedFiles: z.array(z.string().min(1)).min(1),
  implementationSummary: z.string().min(1),
  verificationRefs: z.array(z.string().min(1)).length(3),
  reviewEvidenceRef: z.string().min(1),
});

const remediationEvidence = defineArtifact({
  name: "refined-security-remediation-evidence",
  mediaType: "application/json",
  extension: ".json",
  content: RemediationEvidence,
});

const ArtifactPointer = z.object({
  ref: z.string().min(1),
  sha256: z.string().min(1),
});

const PublishRemediationInput = z.object({
  caseId: z.string().min(1),
  repository: z.literal(REPOSITORY),
  branch: z.string().min(1),
  baseRef: z.string().min(1),
  candidateTree: z.string().min(1),
  changedFiles: z.array(z.string().min(1)).min(1),
  evidence: ArtifactPointer,
});

const PublishRemediationOutput = z.object({
  status: z.literal("published"),
  caseId: z.string().min(1),
  branch: z.string().min(1),
  candidateTree: z.string().min(1),
  commitSha: z.string().min(1),
  pullRequestUrl: z.string().url(),
});

const publishSecurityRemediation = defineDelivery({
  name: "refined-publish-security-remediation",
  description: "Commits, pushes, and opens a pull request for one exact verified candidate generation.",
  binding: "security.remediation.publish",
  input: PublishRemediationInput,
  output: PublishRemediationOutput,
  capabilities: ["git:read", "git:write", "network", "integration:pull-request"],
  defaults: {
    timeout: "15m",
    attempts: 1,
    authorization: {
      action: "Publish a verified security remediation pull request",
      risk: "high",
      timeout: "30m",
    },
  },
});

const SecurityRemediationOutput = z.object({
  status: z.literal("delivered"),
  caseId: z.string().min(1),
  evidence: ArtifactPointer,
  delivery: PublishRemediationOutput,
});

/** Why: Keeps the workflow callback's terminal literal and schema boundary precise. Use: Return only after delivery receipt identity has been checked. */
type SecurityRemediationOutputValue = z.input<typeof SecurityRemediationOutput>;

const securityRemediationWorkflow = defineWorkflow(
  {
    id: "refined-security-remediation",
    name: "Security remediation",
    description:
      "Applies a bounded dependency fix, verifies and adversarially reviews one exact candidate, then publishes an authorized pull request.",
    input: SecurityRemediationInput,
    output: SecurityRemediationOutput,
    workspace: ({ input }) => ({
      branch: input.branch,
      from: input.baseRef,
      target: { binding: "workspace.security-remediation", repository: REPOSITORY },
    }),
  },
  async (ctx, input): Promise<SecurityRemediationOutputValue> => {
    const caseSnapshot = await ctx.context(
      securityCaseSource,
      { caseToken: input.caseToken },
      { key: "security-case", label: "Resolve authoritative security case" },
    );
    const securityCase = requireAuthoritativeCase(caseSnapshot);
    if (securityCase.routing.branch !== input.branch || securityCase.routing.baseRef !== input.baseRef) {
      throw new Error("Workspace routing does not match the authoritative security case");
    }

    const head = await ctx.git.head({ key: "authorized-git-head" });
    const status = await ctx.git.status({ key: "authorized-git-status" });
    if (
      head.sha !== securityCase.routing.authorizedHead ||
      status.branch !== securityCase.routing.branch ||
      !status.clean
    ) {
      throw new Error("Security remediation must start from the authorized clean head");
    }

    const writeScope = await ctx.paths.resolve(
      remediationWritePolicy,
      { proposedPaths: securityCase.remediationPaths },
      { key: "remediation-paths", label: `Resolve paths for ${securityCase.caseId}` },
    );
    const implementation = await ctx.agent(remediationDeveloper, {
      securityCase,
    }, {
      key: "implement-remediation",
      context: [caseSnapshot],
      write: writeScope,
    });
    const changedFiles = [...new Set(implementation.files)].sort();
    if (changedFiles.length === 0) throw new Error("Remediation agent produced no candidate changes");
    const candidate = ctx.workspace.snapshot;

    const verification = await ctx.check(
      securityVerification,
      {
        caseId: securityCase.caseId,
        packageFilter: securityCase.packageFilter,
        candidateTree: candidate.treeHash,
        pathGrantRef: writeScope.grant.ref,
      },
      {
        key: "verify-remediation",
        policy: "required",
        candidate,
      },
    );
    if (
      !verification.passed ||
      verification.results.security.status !== "pass" ||
      verification.results.security.disposition !== "executed" ||
      verification.results.integrity.status !== "pass" ||
      verification.results.integrity.disposition !== "executed"
    ) {
      throw new Error("Both non-waivable checks must execute and pass");
    }

    const securityAttestationRef = verification.results.security.attestation.ref;
    const integrityAttestationRef = verification.results.integrity.attestation.ref;
    const verificationRefs = [securityAttestationRef, integrityAttestationRef];
    const review = await ctx.review(
      adversarialSecurityReview,
      {
        caseToken: input.caseToken,
        caseId: securityCase.caseId,
        caseRevision: securityCase.revision,
        candidateTree: candidate.treeHash,
        changedFiles,
        implementationSummary: implementation.value.summary,
        verificationRefs,
      },
      { key: "adversarial-review", candidate },
    );
    if (review.status !== "accepted") {
      throw new Error("Adversarial review found a blocking security issue");
    }

    const evidence = await ctx.artifact(
      remediationEvidence,
      {
        content: {
          caseId: securityCase.caseId,
          caseRevision: securityCase.revision,
          candidateTree: candidate.treeHash,
          changedFiles,
          implementationSummary: implementation.value.summary,
          verificationRefs: [verification.attestation.ref, securityAttestationRef, integrityAttestationRef],
          reviewEvidenceRef: review.evidence,
        },
      },
      {
        key: "remediation-evidence",
        label: `Evidence for ${securityCase.caseId}`,
        candidate,
        sources: [
          caseSnapshot.evidence,
          ...review.sourceEvidence,
          verification.attestation,
          review.attestation,
        ],
      },
    );
    const delivery = await ctx.delivery.run(publishSecurityRemediation, {
      key: "publish-remediation",
      label: `Publish ${securityCase.caseId}`,
      candidate,
      input: {
        caseId: securityCase.caseId,
        repository: securityCase.repository,
        branch: securityCase.routing.branch,
        baseRef: securityCase.routing.baseRef,
        candidateTree: candidate.treeHash,
        changedFiles,
        evidence: { ref: evidence.ref, sha256: evidence.sha256 },
      },
      proofs: [verification.proof, review.proof],
      artifacts: [evidence],
      authorization: {
        detail: `Publish ${securityCase.caseId} from exact tree ${candidate.treeHash} with evidence ${evidence.sha256}.`,
      },
      attempts: 1,
    });
    if (
      delivery.value.caseId !== securityCase.caseId ||
      delivery.value.branch !== securityCase.routing.branch ||
      delivery.value.candidateTree !== candidate.treeHash
    ) {
      throw new Error("Delivery receipt does not identify the authorized remediation candidate");
    }

    return {
      status: "delivered",
      caseId: securityCase.caseId,
      evidence: { ref: evidence.ref, sha256: evidence.sha256 },
      delivery: delivery.value,
    };
  },
);

declare const ordinaryPaths: readonly string[];
// @ts-expect-error A path list is a proposal, not an engine-minted write capability.
expectType<WriteScope<typeof remediationWritePolicy>>(ordinaryPaths);
// @ts-expect-error A non-waivable security check cannot enter the host waiver-authorization path.
expectType<WaiverEligibleCheckDefinition>(securityRemediated);
expectType<"weft.workflow">(securityRemediationWorkflow.kind);
