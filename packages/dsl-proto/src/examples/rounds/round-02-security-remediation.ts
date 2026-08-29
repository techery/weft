import {
  type ArtifactRefOf,
  defineAgent,
  defineArtifact,
  defineCheck,
  defineCheckSuite,
  defineGoal,
  defineObserver,
  defineOperation,
  definePathPolicy,
  definePrompt,
  defineWorkflow,
  type GateResult,
  type HumanReviewResult,
  type WorkflowNode,
  z,
} from "../../index.ts";

/** Why: Makes compile-time contract assertions visible without adding a test-only runtime helper. Use: Pass inferred DSL values to it in this typechecked example. */
declare function expectType<T>(value: T): void;

const SecurityRemediationInput = z.object({
  caseToken: z.string().min(1),
});

const securityRemediationWritePolicy = definePathPolicy({
  name: "round-02-security-remediation-writes",
  description: "Restricts remediation edits to canonical host-proposed repository paths.",
  revision: "v1",
  roots: ["."],
  deny: [".git/**", ".weft/**"],
  grantTtl: "2h",
});

const ArtifactPointer = z.object({
  ref: z.string().min(1),
  sha256: z.string().min(1),
});

const SecurityCase = z.object({
  provenance: z.literal("host-attested"),
  caseId: z.string().min(1),
  repository: z.string().min(1),
  advisory: z.object({
    id: z.string().min(1),
    packageName: z.string().min(1),
    currentVersion: z.string().min(1),
    affectedRange: z.string().min(1),
    fixedVersion: z.string().min(1),
    severity: z.enum(["high", "critical"]),
    summary: z.string().min(1),
  }),
  evidence: z.object({
    provider: z.string().min(1),
    ref: z.string().min(1),
    sha256: z.string().min(1),
    observedAt: z.string().datetime(),
    attestation: z.string().min(1),
  }),
  authorization: z.object({
    policyId: z.string().min(1),
    editablePaths: z.array(z.string().min(1)).min(1),
    packageFilter: z.string().min(1),
    lockfilePath: z.string().min(1),
    deliveryBase: z.string().min(1),
  }),
});

/** Why: Names evidence returned by the host boundary separately from model-authored conclusions. Use: Require it wherever remediation depends on authenticated advisory data and policy. */
type SecurityCaseValue = z.infer<typeof SecurityCase>;

const SecurityCaseLookup = z.object({ caseToken: z.string().min(1) });

const resolveSecurityCase = defineOperation({
  name: "resolve-attested-security-case",
  description: "Resolves authenticated scanner evidence and repository policy without exposing credentials.",
  input: SecurityCaseLookup,
  output: SecurityCase,
  binding: "security.case.resolve",
  capabilities: ["network", "workspace:read", "integration:security-case"],
  defaults: { timeout: "2m", attempts: 2 },
  authorization: { mode: "none" },
});

const RemediationAssessment = z.object({
  provenance: z.literal("agent-derived"),
  strategy: z.enum(["direct-upgrade", "override", "replace-dependency"]),
  filesToInspect: z.array(z.string().min(1)),
  compatibilityRisks: z.array(z.string()),
  testFocus: z.array(z.string().min(1)).min(1),
  rationale: z.string().min(1),
});

/** Why: Keeps an agent proposal visibly distinct from attested source evidence. Use: Review it as advice, never as authorization or proof that a vulnerability exists. */
type RemediationAssessmentValue = z.infer<typeof RemediationAssessment>;

const AssessmentInput = z.object({ securityCase: SecurityCase });

const assessmentPrompt = definePrompt({
  name: "assess-security-remediation",
  input: AssessmentInput,
  render: ({ securityCase }) => [
    `Analyze ${securityCase.advisory.id} in ${securityCase.repository}.`,
    `Upgrade ${securityCase.advisory.packageName} from ${securityCase.advisory.currentVersion} to the host-attested fixed version ${securityCase.advisory.fixedVersion}.`,
    `Only inspect paths allowed by policy ${securityCase.authorization.policyId}.`,
    "Return compatibility risks and focused verification advice. Do not edit files or reinterpret the advisory evidence.",
  ],
});

const remediationAnalyst = defineAgent({
  name: "security-remediation-analyst",
  description: "Produces a read-only remediation proposal from host-attested evidence.",
  prompt: assessmentPrompt,
  schema: RemediationAssessment,
  defaults: {
    provider: {
      id: "codex",
      effort: "high",
      options: { sandboxMode: "read-only", networkAccess: false, webSearch: "disabled" },
    },
    maxTurns: 12,
    timeout: "15m",
  },
});

const RemediationPlanContent = z.object({
  securityCase: SecurityCase,
  assessment: RemediationAssessment,
});

const RemediationPlanMetadata = z.object({
  workflowRunId: z.string().min(1),
  advisoryEvidence: ArtifactPointer,
  policyId: z.string().min(1),
});

const remediationPlan = defineArtifact({
  name: "security-remediation-plan",
  mediaType: "application/json",
  extension: ".json",
  content: RemediationPlanContent,
  metadata: RemediationPlanMetadata,
});

/** Why: Names the immutable plan reference needed to bind human review to exact bytes. Use: Validate review output before allowing mutation. */
type RemediationPlanRef = ArtifactRefOf<typeof remediationPlan>;

const PlanReviewAnswer = z.discriminatedUnion("decision", [
  z.object({ decision: z.literal("approve"), note: z.string(), conditions: z.array(z.string()) }),
  z.object({ decision: z.literal("reject"), note: z.string().min(1) }),
]);

/** Why: Names the human decision returned for the exact plan artifact. Use: Convert only an approved, hash-matching review into delivery evidence. */
type PlanReviewAnswerValue = z.infer<typeof PlanReviewAnswer>;

const ApprovedPlanReview = z.object({
  decision: z.literal("approve"),
  reviewerId: z.string().min(1),
  submittedAt: z.string().min(1),
  planRef: z.string().min(1),
  planSha256: z.string().min(1),
  reviewedRef: z.string().min(1),
  reviewedSha256: z.string().min(1),
  conditions: z.array(z.string()),
});

/** Why: Carries only a positively approved review whose observed hash matches the captured plan. Use: Include it in implementation evidence and the delivery handoff. */
type ApprovedPlanReviewValue = z.infer<typeof ApprovedPlanReview>;

/** Why: Prevents a stale or different reviewed artifact from authorizing this remediation. Use: Call after human review and before any writer receives the plan. */
function requireApprovedPlanReview(
  review: HumanReviewResult<PlanReviewAnswerValue>,
  plan: RemediationPlanRef,
): ApprovedPlanReviewValue {
  if (review.answer.decision !== "approve") {
    throw new Error("A rejected remediation plan cannot authorize edits");
  }
  if (review.subject.kind !== "artifact" || review.subject.sha256 !== plan.sha256) {
    throw new Error("Human review is not bound to the captured remediation plan");
  }
  return {
    decision: "approve",
    reviewerId: review.reviewer.id,
    submittedAt: review.submittedAt,
    planRef: plan.ref,
    planSha256: plan.sha256,
    reviewedRef: review.subject.ref,
    reviewedSha256: review.subject.sha256,
    conditions: review.answer.conditions,
  };
}

const ImplementationInput = z.object({
  securityCase: SecurityCase,
  approvedAssessment: RemediationAssessment,
  approval: ApprovedPlanReview,
});

const ImplementationReport = z.object({
  summary: z.string().min(1),
  changedFiles: z.array(z.string().min(1)),
  dependencyVersion: z.string().min(1),
  testsAddedOrUpdated: z.array(z.string()),
  residualRisks: z.array(z.string()),
});

const implementationPrompt = definePrompt({
  name: "implement-security-remediation",
  input: ImplementationInput,
  render: ({ securityCase, approvedAssessment, approval }) => [
    `Remediate ${securityCase.advisory.id} by installing exactly ${securityCase.advisory.packageName}@${securityCase.advisory.fixedVersion}.`,
    `Approved strategy: ${approvedAssessment.strategy}.`,
    `Human approval: ${approval.reviewerId} reviewed ${approval.planSha256}.`,
    `Authorized paths: ${securityCase.authorization.editablePaths.join(", ")}.`,
    "Do not commit, push, use the network, weaken checks, or edit outside the strict write scope.",
  ],
});

const remediationDeveloper = defineAgent({
  name: "security-remediation-developer",
  description: "Applies the reviewed dependency fix inside the workflow-owned workspace.",
  prompt: implementationPrompt,
  schema: ImplementationReport,
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

const LocalVerificationInput = z.object({
  packageFilter: z.string().min(1),
  policyId: z.string().min(1),
  lockfilePath: z.string().min(1),
});

const authorizedPaths = defineCheck({
  name: "security-authorized-paths",
  description: "Asks the host policy tool to reject changed paths outside the attested write grant.",
  input: LocalVerificationInput,
  policy: "required",
  command: ({ policyId }) => ["weft-policy", "verify-changed-paths", "--policy", policyId],
});

const frozenLockfile = defineCheck({
  name: "security-frozen-lockfile",
  description: "Verifies that manifests and the existing lockfile agree without network access.",
  input: LocalVerificationInput,
  policy: "required",
  command: ({ lockfilePath }) => [
    "pnpm",
    "install",
    "--offline",
    "--frozen-lockfile",
    "--lockfile-dir",
    lockfilePath,
  ],
});

const focusedTests = defineCheck({
  name: "security-focused-tests",
  description: "Runs the affected package's tests on the exact candidate workspace generation.",
  input: LocalVerificationInput,
  policy: "required",
  command: ({ packageFilter }) => ["pnpm", "--filter", packageFilter, "test"],
});

const packageTypecheck = defineCheck({
  name: "security-package-typecheck",
  description: "Rejects type regressions introduced by the dependency remediation.",
  input: LocalVerificationInput,
  policy: "required",
  command: ({ packageFilter }) => ["pnpm", "--filter", packageFilter, "typecheck"],
});

const localSecurityQuality = defineCheckSuite({
  name: "security-local-quality",
  description: "Requires policy, lockfile, tests, and type checks before external rescanning.",
  input: LocalVerificationInput,
  checks: (input, use) => ({
    authorizedPaths: use(authorizedPaths, input),
    frozenLockfile: use(frozenLockfile, input),
    focusedTests: use(focusedTests, input),
    packageTypecheck: use(packageTypecheck, input),
  }),
  concurrency: 3,
});

const remediationGoal = defineGoal({
  name: "security-remediation-locally-verified",
  check: localSecurityQuality,
  defaults: { attempts: 3 },
});

const CandidateScanRequest = z.object({
  caseId: z.string().min(1),
  head: z.string().min(1),
  workspaceId: z.string().min(1),
  generation: z.number().int().nonnegative(),
  treeHash: z.string().min(1),
});

const CandidateScanHandle = CandidateScanRequest.extend({
  jobId: z.string().min(1),
});

const startCandidateScan = defineOperation({
  name: "start-candidate-security-scan",
  description: "Submits the exact locally verified workspace subject to the authorized scanner.",
  input: CandidateScanRequest,
  output: CandidateScanHandle,
  binding: "security.scan.start",
  capabilities: ["network", "git:read", "integration:security-scanner"],
  defaults: { timeout: "2m", attempts: 2 },
  authorization: {
    mode: "required",
    action: "Submit an exact candidate workspace to the external security scanner",
    risk: "medium",
    timeout: "30m",
  },
});

const CandidateScanState = z.discriminatedUnion("status", [
  z.object({ status: z.literal("pending"), jobId: z.string(), head: z.string() }),
  z.object({
    status: z.literal("complete"),
    jobId: z.string(),
    head: z.string(),
    runRef: z.string().min(1),
    runSha256: z.string().min(1),
    attestation: z.string().min(1),
    remainingFindings: z.array(z.string()),
  }),
]);

const CandidateScanResult = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("passed"),
    jobId: z.string(),
    head: z.string(),
    runRef: z.string(),
    runSha256: z.string(),
    attestation: z.string(),
    remainingFindings: z.array(z.string()).max(0),
  }),
  z.object({
    status: z.literal("failed"),
    jobId: z.string(),
    head: z.string(),
    runRef: z.string(),
    runSha256: z.string(),
    attestation: z.string(),
    remainingFindings: z.array(z.string()).min(1),
  }),
  z.object({ status: z.literal("invalid"), jobId: z.string(), head: z.string(), reason: z.string() }),
]);

/** Why: Gives observer completion an explicit raw-output contract so discriminants do not widen. Use: Annotate the completion mapper returned to `defineObserver`. */
type CandidateScanResultInput = z.input<typeof CandidateScanResult>;

const awaitCandidateScan = defineObserver({
  name: "await-candidate-security-scan",
  description: "Waits for a host-authenticated scanner signal and rejects mismatched job or commit identity.",
  input: CandidateScanHandle,
  state: CandidateScanState,
  output: CandidateScanResult,
  source: {
    kind: "signal",
    binding: "security.scan.signal",
    signal: ({ jobId }) => `security-scan.${jobId}`,
    trust: { minimum: "authoritative", authorities: ["security-scanner"] },
  },
  defaults: { timeout: "30m" },
  complete: (state, input): CandidateScanResultInput | null => {
    if (state.status === "pending") return null;
    if (state.jobId !== input.jobId || state.head !== input.head) {
      return { status: "invalid", jobId: state.jobId, head: state.head, reason: "Signal identity mismatch" };
    }
    const common = {
      jobId: state.jobId,
      head: state.head,
      runRef: state.runRef,
      runSha256: state.runSha256,
      attestation: state.attestation,
      remainingFindings: state.remainingFindings,
    };
    return state.remainingFindings.length === 0
      ? { status: "passed", ...common }
      : { status: "failed", ...common };
  },
});

const WorkspaceSubject = z.object({
  workspaceId: z.string(),
  generation: z.number().int().nonnegative(),
  treeHash: z.string(),
});

const RemediationDossierContent = z.object({
  securityCase: SecurityCase,
  plan: ArtifactPointer,
  approval: ApprovedPlanReview,
  implementation: ImplementationReport,
  localVerification: z.object({ evidence: z.string(), subject: WorkspaceSubject }),
  candidateScan: CandidateScanResult,
});

const RemediationDossierMetadata = z.object({
  branch: z.string().min(1),
  head: z.string().min(1),
  workspaceId: z.string().min(1),
  generation: z.number().int().nonnegative(),
});

const remediationDossier = defineArtifact({
  name: "security-remediation-dossier",
  mediaType: "application/json",
  extension: ".json",
  content: RemediationDossierContent,
  metadata: RemediationDossierMetadata,
});

const ApprovedPublicationGate = z.object({
  approved: z.literal(true),
  answeredBy: z.enum(["human", "policy"]),
  note: z.string().optional(),
});

/** Why: Excludes denial and timeout states from the delivery operation's input. Use: Build it only after checking a gate result in workflow control flow. */
type ApprovedPublicationGateValue = z.infer<typeof ApprovedPublicationGate>;

/** Why: Converts a general gate result into a literal-approved handoff while preserving exact optional properties. Use: Call only on the delivery path. */
function requireApprovedPublicationGate(gate: GateResult): ApprovedPublicationGateValue {
  if (!gate.approved || gate.answeredBy === "timeout") {
    throw new Error("Publication was not authorized");
  }
  return gate.note === undefined
    ? { approved: true, answeredBy: gate.answeredBy }
    : { approved: true, answeredBy: gate.answeredBy, note: gate.note };
}

const DeliveryInput = z.object({
  caseId: z.string().min(1),
  repository: z.string().min(1),
  branch: z.string().min(1),
  base: z.string().min(1),
  head: z.string().min(1),
  title: z.string().min(1),
  dossier: ArtifactPointer,
  planApproval: ApprovedPlanReview,
  publicationGate: ApprovedPublicationGate,
  scan: CandidateScanResult.and(z.object({ status: z.literal("passed") })),
});

const DeliveryResult = z.object({
  kind: z.literal("pull-request"),
  number: z.number().int().positive(),
  url: z.string().url(),
  head: z.string().min(1),
});

const publishSecurityRemediation = defineOperation({
  name: "publish-security-remediation",
  description: "Pushes the authorized exact head and opens a pull request without merging it.",
  input: DeliveryInput,
  output: DeliveryResult,
  binding: "github.security-remediation.publish",
  capabilities: ["git:read", "git:write", "network", "integration:github"],
  defaults: { timeout: "5m", attempts: 1 },
  authorization: {
    mode: "required",
    action: "Push an exact security remediation head and create its pull request",
    risk: "high",
    timeout: "24h",
  },
});

const SecurityRemediationOutput = z.discriminatedUnion("status", [
  z.object({ status: z.literal("rejected"), caseId: z.string(), plan: ArtifactPointer, reason: z.string() }),
  z.object({
    status: z.literal("scan-failed"),
    caseId: z.string(),
    head: z.string(),
    findings: z.array(z.string()),
  }),
  z.object({
    status: z.literal("delivery-denied"),
    caseId: z.string(),
    dossier: ArtifactPointer,
    reason: z.string(),
  }),
  z.object({
    status: z.literal("delivered"),
    caseId: z.string(),
    dossier: ArtifactPointer,
    pullRequest: DeliveryResult,
  }),
]);

/** Why: Keeps every early-exit and delivery branch inside the declared workflow output union. Use: Annotate the workflow body to prevent literal status widening. */
type SecurityRemediationOutputValue = z.input<typeof SecurityRemediationOutput>;

/** Why: Demonstrates a provenance-aware vulnerability remediation from authenticated case to unmerged PR handoff. Use: Launch it with a host-issued security case token. */
const securityRemediationWorkflow = defineWorkflow(
  {
    id: "round-02-security-remediation",
    name: "Security remediation",
    description: "Review, implement, verify, rescan, and hand off one attested dependency vulnerability.",
    input: SecurityRemediationInput,
    output: SecurityRemediationOutput,
    workspace: true,
  },
  async (ctx, input): Promise<SecurityRemediationOutputValue> => {
    const securityCase = await ctx.operation(
      resolveSecurityCase,
      { caseToken: input.caseToken },
      { key: "resolve-security-case" },
    );

    expectType<SecurityCaseValue>(securityCase);

    const assessment = await ctx.agent({
      key: "assess-remediation",
      agent: remediationAnalyst,
      input: { securityCase },
    });

    expectType<RemediationAssessmentValue>(assessment.value);
    // @ts-expect-error Agent-derived advice cannot be passed where this workflow requires host-attested evidence.
    expectType<SecurityCaseValue>(assessment.value);

    const plan = await ctx.artifact(
      remediationPlan,
      {
        content: { securityCase, assessment: assessment.value },
        metadata: {
          workflowRunId: ctx.run.id,
          advisoryEvidence: { ref: securityCase.evidence.ref, sha256: securityCase.evidence.sha256 },
          policyId: securityCase.authorization.policyId,
        },
      },
      { key: "remediation-plan" },
    );

    const review = await ctx.human.review({
      key: "review-remediation-plan",
      question: "Approve this exact security remediation plan before repository mutation?",
      subject: { kind: "artifact", path: plan.ref, mediaType: plan.mediaType, label: plan.name },
      schema: PlanReviewAnswer,
      timeout: "24h",
      onTimeout: "deny",
    });

    if (review.answer.decision === "reject") {
      return {
        status: "rejected",
        caseId: securityCase.caseId,
        plan: { ref: plan.ref, sha256: plan.sha256 },
        reason: review.answer.note,
      };
    }

    const approvedPlan = requireApprovedPlanReview(review, plan);
    const verificationInput = {
      packageFilter: securityCase.authorization.packageFilter,
      policyId: securityCase.authorization.policyId,
      lockfilePath: securityCase.authorization.lockfilePath,
    };

    const writeScope = await ctx.paths.resolve(
      securityRemediationWritePolicy,
      { proposedPaths: securityCase.authorization.editablePaths },
      { key: "resolve-remediation-write-paths", label: "Resolve authorized remediation paths" },
    );
    const implementation = await ctx.agent({
      key: "implement-remediation",
      agent: remediationDeveloper,
      input: { securityCase, approvedAssessment: assessment.value, approval: approvedPlan },
      write: writeScope,
      goal: { definition: remediationGoal, input: verificationInput, attempts: 3 },
    });

    const head = await ctx.git.head();
    const scanCandidate = await ctx.operation.prepare(
      startCandidateScan,
      {
        caseId: securityCase.caseId,
        head: head.sha,
        workspaceId: implementation.goal.subject.workspaceId,
        generation: implementation.goal.subject.generation,
        treeHash: implementation.goal.subject.treeHash,
      },
      { key: "prepare-candidate-scan", label: "Freeze exact security scan request" },
    );
    const scanAuthorization = await ctx.operation.authorize(startCandidateScan, scanCandidate, {
      key: "authorize-candidate-scan",
      detail: `Submit ${head.sha} from workspace generation ${implementation.goal.subject.generation}.`,
    });
    const scanHandle = await ctx.operation.execute(
      startCandidateScan,
      { candidate: scanCandidate, authorization: scanAuthorization },
      { key: "start-candidate-scan" },
    );
    const scan = await ctx.observe(awaitCandidateScan, scanHandle, {
      key: "await-candidate-scan",
      timeout: "30m",
    });

    if (scan.status !== "passed") {
      return {
        status: "scan-failed",
        caseId: securityCase.caseId,
        head: scan.head,
        findings: scan.status === "failed" ? scan.remainingFindings : [scan.reason],
      };
    }

    const dossier = await ctx.artifact(
      remediationDossier,
      {
        content: {
          securityCase,
          plan: { ref: plan.ref, sha256: plan.sha256 },
          approval: approvedPlan,
          implementation: implementation.value,
          localVerification: {
            evidence: implementation.goal.evidence,
            subject: implementation.goal.subject,
          },
          candidateScan: scan,
        },
        metadata: {
          branch: ctx.workspace.branch,
          head: head.sha,
          workspaceId: ctx.workspace.id,
          generation: ctx.workspace.generation,
        },
      },
      { key: "remediation-dossier" },
    );

    const publicationGate = await ctx.gate({
      key: "publish-security-remediation",
      action: `Push ${ctx.workspace.branch} and open a pull request for ${securityCase.advisory.id}`,
      risk: "high",
      detail: `Exact head ${head.sha}; evidence ${dossier.ref} (${dossier.sha256}). No merge is requested.`,
    });

    if (!publicationGate.approved || publicationGate.answeredBy === "timeout") {
      return {
        status: "delivery-denied",
        caseId: securityCase.caseId,
        dossier: { ref: dossier.ref, sha256: dossier.sha256 },
        reason: publicationGate.note ?? `Publication ${publicationGate.answeredBy}`,
      };
    }

    const deliveryCandidate = await ctx.operation.prepare(
      publishSecurityRemediation,
      {
        caseId: securityCase.caseId,
        repository: securityCase.repository,
        branch: ctx.workspace.branch,
        base: securityCase.authorization.deliveryBase,
        head: head.sha,
        title: `security: remediate ${securityCase.advisory.id}`,
        dossier: { ref: dossier.ref, sha256: dossier.sha256 },
        planApproval: approvedPlan,
        publicationGate: requireApprovedPublicationGate(publicationGate),
        scan,
      },
      { key: "prepare-remediation-publication", label: "Freeze exact remediation publication" },
    );
    const deliveryAuthorization = await ctx.operation.authorize(
      publishSecurityRemediation,
      deliveryCandidate,
      {
        key: "authorize-remediation-publication",
        detail: `Push ${head.sha} and open an unmerged pull request from dossier ${dossier.sha256}.`,
      },
    );
    const delivery = await ctx.operation.execute(
      publishSecurityRemediation,
      { candidate: deliveryCandidate, authorization: deliveryAuthorization },
      { key: "publish-remediation", attempts: 1 },
    );

    return {
      status: "delivered",
      caseId: securityCase.caseId,
      dossier: { ref: dossier.ref, sha256: dossier.sha256 },
      pullRequest: delivery,
    };
  },
);

declare const uncheckedGate: GateResult;
// @ts-expect-error A general gate result is not literal proof of an approved, non-timeout publication decision.
expectType<ApprovedPublicationGateValue>(uncheckedGate);

expectType<WorkflowNode<"weft.workflow">>(securityRemediationWorkflow);

// Human review and gate evidence remain inspectable business proof, while the nominal operation candidate
// and authorization make bypassing prepare -> authorize -> execute unrepresentable at the DSL call site.
