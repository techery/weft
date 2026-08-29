import {
  type ContextSnapshotOf,
  defineAgent,
  defineCheck,
  defineCheckSuite,
  defineContextSource,
  defineDelivery,
  defineObserver,
  definePathPolicy,
  definePrompt,
  defineReview,
  defineTrigger,
  defineWorkflow,
  type ObserverInvocationOptionsOf,
  type WorkflowNode,
  type WorkspaceSnapshotRef,
  type WriteScope,
  z,
} from "../../index.ts";

declare function expectType<Type>(value: Type): void;
const FailureHint = z.object({
  deliveryId: z.string().min(1),
  repository: z.string().min(1),
  runId: z.string().min(1),
  jobId: z.string().min(1),
  attempt: z.number().int().positive(),
  failedHead: z.string().min(1),
});
/** Why: Names authenticated ingress data that routes a workspace but cannot authorize a repair. Use: Re-resolve it through the canonical CI source before mutation. */
type FailureHintValue = z.infer<typeof FailureHint>;
const CanonicalFailure = FailureHint.extend({
  caseId: z.string().min(1),
  revision: z.string().min(1),
  checkName: z.string().min(1),
  summary: z.string().min(1),
  repairPaths: z.array(z.string().min(1)).min(1),
});
/** Why: Separates current system-of-record failure data from trigger hints and model claims. Use: Feed only this value and its snapshot to the writer. */
type CanonicalFailureValue = z.infer<typeof CanonicalFailure>;

const ciFailureSource = defineContextSource({
  name: "round-10-canonical-ci-failure",
  input: FailureHint,
  output: CanonicalFailure,
  binding: "ci.failure.resolve",
  freshness: { maxAge: "30m", stale: "reject" },
  trust: { minimum: "authoritative", authorities: ["ci-control"] },
});
/** Why: Rejects forged, stale, or identity-shifted failure data. Use: Call after initial and review-time resolution. */
function requireCanonicalFailure(
  snapshot: ContextSnapshotOf<typeof ciFailureSource>,
  hint: FailureHintValue,
): CanonicalFailureValue {
  const value = snapshot.value;
  if (
    snapshot.trust.level !== "authoritative" ||
    snapshot.trust.authority !== "ci-control" ||
    value.deliveryId !== hint.deliveryId ||
    value.repository !== hint.repository ||
    value.runId !== hint.runId ||
    value.jobId !== hint.jobId ||
    value.attempt !== hint.attempt ||
    value.failedHead !== hint.failedHead
  ) {
    throw new Error("CI failure context is stale, untrusted, or identity-mismatched");
  }
  return value;
}

const repairPaths = definePathPolicy({
  name: "round-10-ci-repair-paths",
  revision: "ci-repair-v1",
  roots: ["src/", "packages/", "tests/", "package.json", "pnpm-lock.yaml"],
  deny: [".git/**", ".github/workflows/**", ".env*", "**/secrets/**"],
  grantTtl: "45m",
});
const RepairAgentInput = z.object({ failure: CanonicalFailure });
const RepairReport = z.object({ summary: z.string().min(1) });
const repairPrompt = definePrompt({
  name: "round-10-repair-failed-ci",
  input: RepairAgentInput,
  render: ({ failure }) => [
    `Repair ${failure.checkName} failure ${failure.caseId} at ${failure.failedHead}: ${failure.summary}.`,
    `Authorized paths: ${failure.repairPaths.join(", ")}.`,
    "Make the smallest causal fix. Do not suppress checks, edit CI policy, commit, push, or use the network.",
  ],
});
const ciRepairAgent = defineAgent({
  name: "round-10-ci-repair-agent",
  prompt: repairPrompt,
  schema: RepairReport,
  defaults: {
    provider: {
      id: "codex",
      effort: "high",
      options: { sandboxMode: "workspace-write", networkAccess: false, webSearch: "disabled" },
    },
    maxTurns: 24,
    timeout: "40m",
  },
});

const VerificationInput = z.object({
  caseId: z.string().min(1),
  candidateTree: z.string().min(1),
  pathGrantRef: z.string().min(1),
});
const failedCheckResolved = defineCheck({
  name: "round-10-failed-check-resolved",
  input: VerificationInput,
  policy: "required",
  waiver: { mode: "never" },
  command: ({ caseId, candidateTree }) => ["weft-ci", "verify-repair", caseId, candidateTree],
});
const repairIntegrity = defineCheck({
  name: "round-10-repair-integrity",
  input: VerificationInput,
  policy: "required",
  waiver: { mode: "never" },
  command: ({ caseId, candidateTree, pathGrantRef }) => [
    "weft-ci",
    "verify-integrity",
    caseId,
    candidateTree,
    pathGrantRef,
  ],
});
const repairVerification = defineCheckSuite({
  name: "round-10-ci-repair-verification",
  input: VerificationInput,
  checks: (input, use) => ({
    repaired: use(failedCheckResolved, input),
    integrity: use(repairIntegrity, input),
  }),
  concurrency: 2,
});

const ReviewFinding = z.object({
  severity: z.enum(["low", "medium", "high", "critical"]),
  code: z.string().min(1),
  message: z.string().min(1),
});
const ReviewReport = z.object({ findings: z.array(ReviewFinding) });
const RepairReviewInput = z.object({
  hint: FailureHint,
  failureRevision: z.string().min(1),
  candidateTree: z.string().min(1),
  changedFiles: z.array(z.string().min(1)).min(1),
  repairSummary: z.string().min(1),
});
const adversarialRepairReview = defineReview({
  name: "round-10-adversarial-ci-repair-review",
  input: RepairReviewInput,
  finding: ReviewFinding,
  evaluate: async (ctx, input) => {
    const snapshot = await ctx.context(ciFailureSource, input.hint, {
      key: "review:failure-context",
    });
    const failure = requireCanonicalFailure(snapshot, input.hint);
    if (failure.revision !== input.failureRevision) {
      throw new Error("Canonical CI failure changed after repair");
    }
    const report = await ctx.agent({
      key: "review:adversarial-agent",
      prompt: [
        `Try to disprove repair ${failure.caseId} on tree ${input.candidateTree}.`,
        `Changed files: ${input.changedFiles.join(", ")}. Claim: ${input.repairSummary}.`,
        "Inspect the diff for symptom masking, scope drift, regressions, and missing tests. Do not write or use network.",
      ],
      schema: ReviewReport,
      provider: { id: "codex", effort: "high", options: { sandboxMode: "read-only", networkAccess: false } },
      context: [snapshot],
      maxTurns: 14,
      timeout: "20m",
    });
    return {
      sourceEvidence: [snapshot.evidence],
      assessments: report.value.findings.map((finding) => ({
        finding,
        disposition: finding.severity === "high" || finding.severity === "critical" ? "blocking" : "advisory",
        sources: [snapshot.evidence.ref],
        rationale: finding.message,
      })),
    };
  },
  accept: ({ assessments }) => assessments.every(({ disposition }) => disposition !== "blocking"),
});

const SubmitRepairInput = z.object({
  caseId: z.string().min(1),
  repository: z.string().min(1),
  originalRunId: z.string().min(1),
  jobId: z.string().min(1),
  repairBranch: z.string().min(1),
  candidateTree: z.string().min(1),
  verificationRef: z.string().min(1),
  reviewRef: z.string().min(1),
  idempotencyKey: z.string().min(1),
});
const SubmitRepairOutput = z.object({
  rerunId: z.string().min(1),
  jobId: z.string().min(1),
  candidateTree: z.string().min(1),
  correlation: z.string().min(1),
});
const submitRepairRerun = defineDelivery({
  name: "round-10-submit-repair-rerun",
  description: "Publishes one exact verified repair tree and starts its replacement CI run atomically.",
  input: SubmitRepairInput,
  output: SubmitRepairOutput,
  binding: "ci.repair.submit",
  capabilities: ["workspace:read", "git:write", "network", "integration:ci"],
  defaults: {
    attempts: 1,
    timeout: "10m",
    authorization: {
      action: "Publish an exact CI repair candidate and start its replacement run",
      risk: "high",
      timeout: "30m",
    },
  },
});

const CiRunBase = z.object({
  rerunId: z.string().min(1),
  jobId: z.string().min(1),
  candidateTree: z.string().min(1),
  correlation: z.string().min(1),
  eventId: z.string().min(1),
  sequence: z.number().int().nonnegative(),
});
const CiRunState = z.discriminatedUnion("status", [
  CiRunBase.extend({ status: z.enum(["queued", "running"]) }),
  CiRunBase.extend({
    status: z.literal("completed"),
    conclusion: z.enum(["success", "failure", "cancelled"]),
  }),
]);
const CiRunTerminal = CiRunBase.extend({
  status: z.literal("completed"),
  conclusion: z.enum(["success", "failure", "cancelled"]),
});
const waitForRepairCi = defineObserver({
  name: "round-10-repair-ci-result",
  input: SubmitRepairOutput,
  state: CiRunState,
  output: CiRunTerminal,
  source: {
    kind: "signal",
    binding: "ci.run.signal",
    signal: ({ correlation }) => `ci.run.${correlation}`,
    trust: { minimum: "authoritative", authorities: ["ci-provider"] },
  },
  identity: {
    inputCorrelation: ({ correlation }) => correlation,
    stateCorrelation: ({ correlation }) => correlation,
    eventId: ({ eventId }) => eventId,
    sequence: ({ sequence }) => sequence,
  },
  defaults: { timeout: "1h" },
  complete: (state) => (state.status === "completed" ? state : null),
});

const RepairOutcome = z.object({
  status: z.enum(["passed", "failed"]),
  caseId: z.string().min(1),
  candidateTree: z.string().min(1),
  rerun: SubmitRepairOutput,
  conclusion: z.enum(["success", "failure", "cancelled"]),
  observation: z.object({ ref: z.string().min(1), sha256: z.string().min(1) }),
});
type RepairOutcomeValue = z.input<typeof RepairOutcome>;
function requireSameSubject(
  actual: WorkspaceSnapshotRef,
  expected: WorkspaceSnapshotRef,
  stage: string,
): void {
  if (
    actual.workspaceId !== expected.workspaceId ||
    actual.generation !== expected.generation ||
    actual.treeHash !== expected.treeHash
  ) {
    throw new Error(`${stage} observed another workspace generation`);
  }
}

const ciFailureRepairWorkflow = defineWorkflow(
  {
    id: "round-10-ci-failure-repair",
    name: "Repair an admitted CI failure",
    input: FailureHint,
    output: RepairOutcome,
    workspace: ({ input }) => ({
      branch: `ci-repair/${input.runId}`,
      from: input.failedHead,
      target: { binding: "workspace.ci-repair", repository: input.repository },
    }),
  },
  async (ctx, hint): Promise<RepairOutcomeValue> => {
    const ingress = ctx.run.trigger;
    if (
      ingress === undefined ||
      ingress.provenance.trigger !== "round-10-failed-ci" ||
      ingress.provenance.revision !== "failed-ci-v1" ||
      ingress.provenance.source !== "ci.webhook.authenticated" ||
      ingress.provenance.eventId !== hint.deliveryId
    ) {
      throw new Error("CI repair requires matching authenticated trigger admission");
    }
    const snapshot = await ctx.context(ciFailureSource, hint, { key: "canonical-failure" });
    const failure = requireCanonicalFailure(snapshot, hint);
    const head = await ctx.git.head();
    const status = await ctx.git.status();
    if (head.sha !== failure.failedHead || !status.clean) {
      throw new Error("Repair workspace must start clean at the canonical failed head");
    }
    const scope = await ctx.paths.resolve(
      repairPaths,
      { proposedPaths: failure.repairPaths },
      { key: "repair-paths" },
    );
    requireSameSubject(scope.grant.subject, ctx.workspace.subject, "Write grant");
    const repair = await ctx.agent({
      key: "repair",
      agent: ciRepairAgent,
      input: { failure },
      context: [snapshot],
      write: scope,
    });
    const changedFiles = [...new Set(repair.files)].sort();
    if (changedFiles.length === 0) throw new Error("Repair produced no candidate changes");
    const subject = ctx.workspace.subject;
    const verification = await ctx.check(
      repairVerification,
      { caseId: failure.caseId, candidateTree: subject.treeHash, pathGrantRef: scope.grant.ref },
      { keyPrefix: "verification", policy: "required", subject },
    );
    requireSameSubject(verification.subject, subject, "Verification");
    if (
      !verification.passed ||
      verification.results.repaired.disposition !== "executed" ||
      verification.results.integrity.disposition !== "executed"
    ) {
      throw new Error("Both non-waivable repair checks must execute and pass");
    }
    const review = await ctx.review(
      adversarialRepairReview,
      {
        hint,
        failureRevision: failure.revision,
        candidateTree: subject.treeHash,
        changedFiles,
        repairSummary: repair.value.summary,
      },
      { key: "adversarial-review", subject },
    );
    requireSameSubject(review.subject, subject, "Review");
    requireSameSubject(ctx.workspace.subject, subject, "Post-review workspace");
    if (review.status !== "accepted") throw new Error("Adversarial review rejected the repair");
    const rerunInput = {
      caseId: failure.caseId,
      repository: failure.repository,
      originalRunId: failure.runId,
      jobId: failure.jobId,
      repairBranch: ctx.workspace.branch,
      candidateTree: subject.treeHash,
      verificationRef: verification.attestation.ref,
      reviewRef: review.evidence,
      idempotencyKey: `${failure.caseId}:${subject.treeHash}`,
    };
    const candidate = await ctx.delivery.prepare(
      submitRepairRerun,
      {
        subject,
        input: rerunInput,
        evidence: [verification.attestation, review.attestation],
      },
      { key: "prepare-rerun" },
    );
    const authority = await ctx.delivery.authorize(submitRepairRerun, candidate, {
      key: "authorize-rerun",
      detail: `Submit verified tree ${subject.treeHash} for ${failure.caseId}.`,
    });
    const delivery = await ctx.delivery(
      submitRepairRerun,
      { candidate, authorization: authority },
      { key: "submit-rerun", attempts: 1 },
    );
    requireSameSubject(delivery.subject, subject, "CI submission");
    const rerun = delivery.value;
    if (rerun.candidateTree !== subject.treeHash || rerun.jobId !== failure.jobId) {
      throw new Error("CI submission receipt does not identify the repaired candidate");
    }
    const observed = await ctx.observe.detailed(waitForRepairCi, rerun, {
      key: "wait-for-repair-ci",
      timeout: "1h",
    });
    requireSameSubject(ctx.workspace.subject, subject, "CI observation");
    if (
      observed.output.rerunId !== rerun.rerunId ||
      observed.output.jobId !== rerun.jobId ||
      observed.output.candidateTree !== subject.treeHash ||
      observed.output.correlation !== rerun.correlation ||
      observed.provenance.binding !== "ci.run.signal" ||
      observed.provenance.trust?.level !== "authoritative" ||
      observed.provenance.trust.authority !== "ci-provider"
    ) {
      throw new Error("Observed CI result lacks exact authoritative correlation");
    }
    return {
      status: observed.output.conclusion === "success" ? "passed" : "failed",
      caseId: failure.caseId,
      candidateTree: subject.treeHash,
      rerun,
      conclusion: observed.output.conclusion,
      observation: { ref: observed.evidence.ref, sha256: observed.evidence.sha256 },
    };
  },
);

const FailedCiEvent = FailureHint.omit({ failedHead: true }).extend({
  head: z.string().min(1),
  status: z.literal("completed"),
  conclusion: z.enum(["success", "failure", "cancelled"]),
});
const failedCiTrigger = defineTrigger({
  name: "round-10-failed-ci",
  revision: "failed-ci-v1",
  source: { binding: "ci.webhook.authenticated" },
  event: FailedCiEvent,
  workflow: ciFailureRepairWorkflow,
  filter: ({ conclusion }) => conclusion === "failure",
  eventId: ({ deliveryId }) => deliveryId,
  dedupeKey: ({ repository, runId, jobId, attempt }) => `${repository}:${runId}:${jobId}:${attempt}`,
  map: ({ deliveryId, repository, runId, jobId, attempt, head }) => ({
    deliveryId,
    repository,
    runId,
    jobId,
    attempt,
    failedHead: head,
  }),
});

declare const plainPaths: readonly string[];
expectType<WorkflowNode<"weft.trigger">>(failedCiTrigger);
expectType<WorkflowNode<"weft.delivery">>(submitRepairRerun);
// @ts-expect-error Unvalidated paths cannot masquerade as the engine-minted repair grant.
expectType<WriteScope<typeof repairPaths>>(plainPaths);
expectType<ObserverInvocationOptionsOf<typeof waitForRepairCi>>({
  key: "signal-only",
  // @ts-expect-error A signal-only CI observer has no polling cadence.
  every: "30s",
});
// Round 10 findings (maximum five):
// 1. RESOLVED: CI submission is a delivery, so its candidate freezes the exact workspace subject together with nominal
//    suite and review attestations before authorization; a general operation is intentionally not expanded.
// 2. RESOLVED: review evaluation and results retain nominal sourceEvidence gathered during independent re-resolution.
// 3. NOT REDUNDANT: trigger admission authenticates and deduplicates ingress; context re-resolution establishes current
//    failure truth; the exact-subject delivery starts external work; the observer proves its terminal result.
