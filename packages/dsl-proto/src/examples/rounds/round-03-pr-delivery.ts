import {
  type ArtifactRefOf,
  type CheckResult,
  defineAgent,
  defineArtifact,
  defineCheck,
  defineCheckSuite,
  defineObserver,
  defineOperation,
  definePathPolicy,
  definePrompt,
  defineWorkflow,
  type GateResult,
  type HumanReviewResult,
  type WorkspaceSnapshotRef,
  z,
} from "../../index.ts";

const DeliveryRequestSchema = z.object({
  repository: z.string().min(1),
  ticket: z.string().min(1),
  title: z.string().min(1),
  pullRequestBody: z.string().min(1),
  base: z.string().min(1),
  branch: z.string().min(1),
  remote: z.string().min(1).default("origin"),
  packageFilter: z.string().min(1),
  allowedPaths: z.array(z.string().min(1)).min(1),
  acceptanceCriteria: z.array(z.string().min(1)).min(1),
});

const pullRequestWritePolicy = definePathPolicy({
  name: "round-03-pull-request-writes",
  description: "Restricts candidate construction to canonical caller-proposed repository paths.",
  revision: "v1",
  roots: ["."],
  deny: [".git/**", ".weft/**"],
  grantTtl: "2h",
});

const ImplementationInputSchema = z.object({
  ticket: z.string().min(1),
  title: z.string().min(1),
  allowedPaths: z.array(z.string().min(1)).min(1),
  acceptanceCriteria: z.array(z.string().min(1)).min(1),
});

const ImplementationReportSchema = z.object({
  summary: z.string().min(1),
  changedFiles: z.array(z.string().min(1)).min(1),
  testsChanged: z.array(z.string().min(1)),
});

const implementationPrompt = definePrompt({
  name: "implement-pr-delivery-candidate",
  input: ImplementationInputSchema,
  render: ({ ticket, title, allowedPaths, acceptanceCriteria }) => [
    `Implement ${ticket}: ${title}.`,
    `Change only these paths:\n${allowedPaths.map((path) => `- ${path}`).join("\n")}`,
    `Acceptance criteria:\n${acceptanceCriteria.map((criterion) => `- ${criterion}`).join("\n")}`,
    "Do not commit, push, open a pull request, or claim that checks passed.",
  ],
});

const implementationAgent = defineAgent({
  name: "pr-delivery-implementer",
  description: "Builds a bounded candidate while leaving Git delivery under workflow control.",
  prompt: implementationPrompt,
  schema: ImplementationReportSchema,
  defaults: {
    maxTurns: 24,
    timeout: "40m",
    repair: 1,
    provider: {
      id: "codex",
      model: "gpt-5.6-sol",
      effort: "high",
      options: { sandboxMode: "workspace-write", networkAccess: false, webSearch: "disabled" },
    },
  },
});

const VerificationInputSchema = z.object({
  packageFilter: z.string().min(1),
});

const typecheck = defineCheck({
  name: "delivery-typecheck",
  description: "Typechecks the exact committed workspace generation proposed for promotion.",
  input: VerificationInputSchema,
  command: ({ packageFilter }) => ["pnpm", "--filter", packageFilter, "typecheck"],
  policy: "required",
  defaults: { timeout: "10m" },
});

const tests = defineCheck({
  name: "delivery-tests",
  description: "Runs focused tests against the exact committed workspace generation proposed for promotion.",
  input: VerificationInputSchema,
  command: ({ packageFilter }) => ["pnpm", "--filter", packageFilter, "test"],
  policy: "required",
  defaults: { timeout: "20m" },
});

const lint = defineCheck({
  name: "delivery-lint",
  description:
    "Runs static analysis against the exact committed workspace generation proposed for promotion.",
  input: VerificationInputSchema,
  command: ({ packageFilter }) => ["pnpm", "--filter", packageFilter, "lint"],
  policy: "required",
  defaults: { timeout: "10m" },
});

const deliveryChecks = defineCheckSuite({
  name: "delivery-required-checks",
  description: "Preserves each required local verdict and its engine-minted workspace subject.",
  input: VerificationInputSchema,
  checks: (input, use) => ({
    typecheck: use(typecheck, input),
    tests: use(tests, input),
    lint: use(lint, input),
  }),
  concurrency: 3,
});

const WorkspaceSnapshotSchema = z.object({
  workspaceId: z.string().min(1),
  generation: z.number().int().nonnegative(),
  treeHash: z.string().min(1),
});

const CheckProofSchema = z.object({
  name: z.string().min(1),
  status: z.literal("pass"),
  disposition: z.literal("executed"),
  subject: WorkspaceSnapshotSchema,
});

const PromotionCandidateSchema = z.object({
  workflowRunId: z.string().min(1),
  repository: z.string().min(1),
  base: z.string().min(1),
  branch: z.string().min(1),
  remote: z.string().min(1),
  head: z.string().min(1),
  subject: WorkspaceSnapshotSchema,
  changedFiles: z.array(z.string().min(1)).min(1),
  acceptanceCriteria: z.array(z.string().min(1)).min(1),
  checks: z.object({
    typecheck: CheckProofSchema,
    tests: CheckProofSchema,
    lint: CheckProofSchema,
  }),
  pullRequest: z.object({
    title: z.string().min(1),
    body: z.string().min(1),
  }),
});

const PromotionCandidateMetadataSchema = z.object({
  repository: z.string().min(1),
  branch: z.string().min(1),
  head: z.string().min(1),
  treeHash: z.string().min(1),
  generation: z.number().int().nonnegative(),
});

const promotionCandidateArtifact = defineArtifact({
  name: "pull-request-promotion-candidate",
  mediaType: "application/json",
  extension: ".json",
  content: PromotionCandidateSchema,
  metadata: PromotionCandidateMetadataSchema,
});

const CandidateReviewDecisionSchema = z.discriminatedUnion("decision", [
  z.object({
    decision: z.literal("approve"),
    note: z.string(),
  }),
  z.object({
    decision: z.literal("reject"),
    note: z.string().min(1),
  }),
]);

const ArtifactPointerSchema = z.object({
  ref: z.string().min(1),
  sha256: z.string().min(1),
});

const ReviewProofSchema = z.object({
  decision: z.literal("approve"),
  candidate: ArtifactPointerSchema,
  reviewerId: z.string().min(1),
  submittedAt: z.string().min(1),
});

const ExecutionAuthorizationSchema = z.object({
  action: z.string().min(1),
  approved: z.literal(true),
  answeredBy: z.enum(["human", "policy"]),
  note: z.string().optional(),
});

const ExecuteDeliveryInputSchema = z.object({
  idempotencyKey: z.string().min(1),
  candidate: PromotionCandidateSchema,
  candidateArtifact: ArtifactPointerSchema,
  review: ReviewProofSchema,
  authorization: ExecutionAuthorizationSchema,
});

const ExecuteDeliveryResultSchema = z.object({
  candidateArtifact: ArtifactPointerSchema,
  subject: WorkspaceSnapshotSchema,
  pushedHead: z.string().min(1),
  remoteRef: z.string().min(1),
  pullRequest: z.object({
    number: z.number().int().positive(),
    url: z.string().url(),
    base: z.string().min(1),
    head: z.string().min(1),
  }),
});

const executePullRequestDelivery = defineOperation({
  name: "execute-pull-request-delivery",
  description:
    "Under a host workspace lease, revalidates authorization and exact candidate identity, pushes its head, and creates or reuses its PR idempotently.",
  input: ExecuteDeliveryInputSchema,
  output: ExecuteDeliveryResultSchema,
  binding: "github.delivery.execute",
  capabilities: ["workspace:read", "git:read", "git:write", "network", "integration:github"],
  defaults: { timeout: "5m", attempts: 2 },
  authorization: {
    mode: "required",
    action: "Push an exact reviewed workspace head and create its pull request",
    risk: "high",
    timeout: "24h",
  },
});

const CiLookupSchema = z.object({
  repository: z.string().min(1),
  pullRequestNumber: z.number().int().positive(),
  head: z.string().min(1),
});

const CiStateSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.enum(["queued", "running"]),
    runId: z.string().min(1),
    pullRequestNumber: z.number().int().positive(),
    head: z.string().min(1),
    url: z.string().url(),
  }),
  z.object({
    status: z.enum(["passed", "failed"]),
    runId: z.string().min(1),
    pullRequestNumber: z.number().int().positive(),
    head: z.string().min(1),
    url: z.string().url(),
  }),
]);

const CiResultSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.enum(["passed", "failed"]),
    runId: z.string().min(1),
    pullRequestNumber: z.number().int().positive(),
    head: z.string().min(1),
    url: z.string().url(),
  }),
  z.object({
    status: z.literal("invalid"),
    runId: z.string().min(1),
    pullRequestNumber: z.number().int().positive(),
    head: z.string().min(1),
    url: z.string().url(),
    reason: z.string().min(1),
  }),
]);

/** Why: Prevents observer completion branches from widening the CI discriminant. Use: Annotate the terminal mapper supplied to `defineObserver`. */
type CiResultInput = z.input<typeof CiResultSchema>;

const waitForExactHeadCi = defineObserver({
  name: "wait-for-exact-delivery-head-ci",
  description: "Waits durably for CI while rejecting terminal evidence from another PR or commit.",
  input: CiLookupSchema,
  state: CiStateSchema,
  output: CiResultSchema,
  source: {
    kind: "poll",
    every: "30s",
    binding: "github.actions.pull-request-status",
  },
  defaults: { timeout: "2h" },
  complete: (state, input): CiResultInput | null => {
    if (state.status === "queued" || state.status === "running") return null;
    if (state.pullRequestNumber !== input.pullRequestNumber || state.head !== input.head) {
      return { ...state, status: "invalid", reason: "CI terminal evidence targeted another PR or head" };
    }
    return {
      status: state.status,
      runId: state.runId,
      pullRequestNumber: state.pullRequestNumber,
      head: state.head,
      url: state.url,
    };
  },
});

const DeliveryEvidenceSchema = z.object({
  candidate: ArtifactPointerSchema,
  review: ReviewProofSchema,
  authorization: ExecutionAuthorizationSchema,
  execution: ExecuteDeliveryResultSchema,
  ci: CiResultSchema,
});

const DeliveryEvidenceMetadataSchema = z.object({
  workflowRunId: z.string().min(1),
  repository: z.string().min(1),
  branch: z.string().min(1),
  head: z.string().min(1),
  recordedAt: z.number(),
});

const deliveryEvidenceArtifact = defineArtifact({
  name: "pull-request-delivery-evidence",
  mediaType: "application/json",
  extension: ".json",
  content: DeliveryEvidenceSchema,
  metadata: DeliveryEvidenceMetadataSchema,
});

const DeliveryOutputSchema = z.object({
  branch: z.string().min(1),
  head: z.string().min(1),
  candidateRef: z.string().min(1),
  pullRequestNumber: z.number().int().positive(),
  pullRequestUrl: z.string().url(),
  ciUrl: z.string().url(),
  evidenceRef: z.string().min(1),
});

/** Why: Names the serializable candidate snapshot stored in immutable artifacts and operation inputs. Use: Convert only from an engine-minted `WorkspaceSnapshotRef`. */
type WorkspaceSnapshotValue = z.infer<typeof WorkspaceSnapshotSchema>;

/** Why: Names one required, executed, exact-generation verification claim. Use: Store it in the promotion candidate reviewed before delivery. */
type CheckProof = z.infer<typeof CheckProofSchema>;

/** Why: Names the immutable candidate reference that a human review must match byte-for-byte. Use: Pass it to `requireApprovedReview`. */
type PromotionCandidateRef = ArtifactRefOf<typeof promotionCandidateArtifact>;

/** Why: Names the decision schema returned by review of the immutable promotion candidate. Use: Reject unless its approved subject matches the candidate reference and digest. */
type CandidateReviewDecision = z.infer<typeof CandidateReviewDecisionSchema>;

/** Why: Names the positive, exact-artifact review proof supplied to delivery execution. Use: Derive it only through `requireApprovedReview`. */
type ReviewProof = z.infer<typeof ReviewProofSchema>;

/** Why: Names a positive authorization separately from the later delivery execution result. Use: Derive it only through `requireExecutionAuthorization`. */
type ExecutionAuthorization = z.infer<typeof ExecutionAuthorizationSchema>;

/** Why: Converts nominal engine provenance into a serializable artifact field without pretending the field is engine-minted. Use: Store it beside the immutable candidate and compare live subjects using `requireSameSubject`. */
function snapshotValue(subject: WorkspaceSnapshotRef): WorkspaceSnapshotValue {
  return {
    workspaceId: subject.workspaceId,
    generation: subject.generation,
    treeHash: subject.treeHash,
  };
}

/** Why: Makes stale-evidence handling fail closed across workspace identity, generation, and tree hash. Use: Call after every check or authorization wait and immediately before delivery execution. */
function requireSameSubject(
  actual: WorkspaceSnapshotRef,
  expected: WorkspaceSnapshotRef,
  evidence: string,
): void {
  if (
    actual.workspaceId !== expected.workspaceId ||
    actual.generation !== expected.generation ||
    actual.treeHash !== expected.treeHash
  ) {
    throw new Error(`${evidence} is stale for the current workspace generation`);
  }
}

/** Why: Excludes failed, trusted, waived, or stale verdicts from a promotion candidate. Use: Convert every required suite member before requesting review. */
function requireExecutedCheck(name: string, result: CheckResult, expected: WorkspaceSnapshotRef): CheckProof {
  requireSameSubject(result.subject, expected, `${name} check`);
  if (result.status !== "pass" || result.disposition !== "executed") {
    throw new Error(`${name} must execute and pass for the exact promotion candidate`);
  }
  return {
    name,
    status: "pass",
    disposition: "executed",
    subject: snapshotValue(result.subject),
  };
}

/** Why: Converts an attributable review into proof only when it approved the exact immutable candidate bytes. Use: Run it after `ctx.human.review` and before requesting execution authorization. */
function requireApprovedReview(
  review: HumanReviewResult<CandidateReviewDecision>,
  candidate: PromotionCandidateRef,
): ReviewProof {
  if (review.answer.decision !== "approve") {
    throw new Error(review.answer.note);
  }
  if (
    review.subject.kind !== "artifact" ||
    review.subject.ref !== candidate.ref ||
    review.subject.sha256 !== candidate.sha256
  ) {
    throw new Error("Review did not approve the exact promotion candidate artifact");
  }
  return {
    decision: "approve",
    candidate: { ref: candidate.ref, sha256: candidate.sha256 },
    reviewerId: review.reviewer.id,
    submittedAt: review.submittedAt,
  };
}

/** Why: Keeps the business gate as inspectable evidence rather than confusing it with nominal operation authority. Use: Embed it before preparing the exact input; then authorize and execute that frozen candidate. */
function requireExecutionAuthorization(action: string, gate: GateResult): ExecutionAuthorization {
  if (!gate.approved || gate.answeredBy === "timeout") {
    throw new Error(gate.note ?? "Pull request delivery was not authorized");
  }
  return gate.note === undefined
    ? { action, approved: true, answeredBy: gate.answeredBy }
    : { action, approved: true, answeredBy: gate.answeredBy, note: gate.note };
}

defineWorkflow(
  {
    id: "round-03-pr-delivery",
    name: "Deliver an exact workspace generation through a pull request",
    description:
      "Creates a branch-owned candidate, binds checks and review to its exact generation, authorizes separately, publishes, and verifies exact-head CI.",
    input: DeliveryRequestSchema,
    output: DeliveryOutputSchema,
    workspace: ({ input }) => ({ branch: input.branch, from: input.base }),
  },
  async (ctx, input) => {
    const implementation = await ctx.phase("Build", async (buildCtx) => {
      const writeScope = await buildCtx.paths.resolve(
        pullRequestWritePolicy,
        { proposedPaths: input.allowedPaths },
        { key: "resolve-build-write-paths", label: "Resolve candidate write paths" },
      );
      return buildCtx.agent({
        key: "implement",
        agent: implementationAgent,
        input: {
          ticket: input.ticket,
          title: input.title,
          allowedPaths: input.allowedPaths,
          acceptanceCriteria: input.acceptanceCriteria,
        },
        write: writeScope,
      });
    });

    if (implementation.files.length === 0) {
      throw new Error("Implementation produced no files to commit");
    }

    await ctx.phase("Commit", async (commitCtx) => {
      await commitCtx.git.add({ paths: implementation.files });
      return commitCtx.git.commit({
        message: `feat: ${input.title}`,
        paths: implementation.files,
      });
    });

    const committedHead = await ctx.git.head();
    const committedStatus = await ctx.git.status();
    if (!committedStatus.clean || committedStatus.branch !== input.branch) {
      throw new Error("Promotion requires the expected clean workflow-owned branch");
    }

    const candidateSubject = ctx.workspace.subject;
    const checks = await ctx.phase("Verify exact candidate", (verifyCtx) =>
      verifyCtx.check(
        deliveryChecks,
        { packageFilter: input.packageFilter },
        { keyPrefix: "candidate", policy: "required" },
      ),
    );

    requireSameSubject(checks.subject, candidateSubject, "Check suite");
    requireSameSubject(ctx.workspace.subject, candidateSubject, "Workspace after checks");
    if (!checks.passed) throw new Error("Required delivery checks failed");

    const candidateContent = {
      workflowRunId: ctx.run.id,
      repository: input.repository,
      base: input.base,
      branch: input.branch,
      remote: input.remote,
      head: committedHead.sha,
      subject: snapshotValue(candidateSubject),
      changedFiles: implementation.files,
      acceptanceCriteria: input.acceptanceCriteria,
      checks: {
        typecheck: requireExecutedCheck("typecheck", checks.results.typecheck, candidateSubject),
        tests: requireExecutedCheck("tests", checks.results.tests, candidateSubject),
        lint: requireExecutedCheck("lint", checks.results.lint, candidateSubject),
      },
      pullRequest: {
        title: input.title,
        body: input.pullRequestBody,
      },
    };

    const candidate = await ctx.artifact(
      promotionCandidateArtifact,
      {
        content: candidateContent,
        metadata: {
          repository: input.repository,
          branch: input.branch,
          head: committedHead.sha,
          treeHash: candidateSubject.treeHash,
          generation: candidateSubject.generation,
        },
      },
      { key: "promotion-candidate", label: `Candidate ${committedHead.sha}` },
    );

    const review = await ctx.human.review({
      key: "review-promotion-candidate",
      question: "Approve this exact checked commit for pull request delivery?",
      subject: {
        kind: "artifact",
        path: candidate.ref,
        mediaType: candidate.mediaType,
        label: candidate.name,
      },
      schema: CandidateReviewDecisionSchema,
      timeout: "24h",
      onTimeout: "deny",
    });
    const reviewProof = requireApprovedReview(review, candidate);
    requireSameSubject(ctx.workspace.subject, candidateSubject, "Review");

    const action = `deliver:${input.repository}:${input.branch}:${committedHead.sha}:${candidate.sha256}`;
    const gate = await ctx.gate({
      key: "authorize-pull-request-delivery",
      action,
      risk: "high",
      detail: `Authorize pushing ${committedHead.sha} and opening its pull request from reviewed candidate ${candidate.sha256}.`,
    });
    const authorization = requireExecutionAuthorization(action, gate);

    requireSameSubject(ctx.workspace.subject, candidateSubject, "Execution authorization");
    const executionHead = await ctx.git.head();
    const executionStatus = await ctx.git.status();
    if (
      executionHead.sha !== committedHead.sha ||
      executionStatus.branch !== input.branch ||
      !executionStatus.clean
    ) {
      throw new Error("Workspace changed after checks or review; refusing delivery execution");
    }

    const deliveryCandidate = await ctx.operation.prepare(
      executePullRequestDelivery,
      {
        idempotencyKey: `${ctx.run.id}:${candidate.sha256}`,
        candidate: candidateContent,
        candidateArtifact: { ref: candidate.ref, sha256: candidate.sha256 },
        review: reviewProof,
        authorization,
      },
      { key: "prepare-delivery", label: "Freeze exact pull request delivery" },
    );
    const deliveryAuthorization = await ctx.operation.authorize(
      executePullRequestDelivery,
      deliveryCandidate,
      {
        key: "authorize-delivery",
        label: "Authorize exact pull request delivery",
        detail: `Push ${committedHead.sha} and create its pull request from candidate ${candidate.sha256}.`,
      },
    );
    const execution = await ctx.operation.execute(
      executePullRequestDelivery,
      { candidate: deliveryCandidate, authorization: deliveryAuthorization },
      { key: "execute-delivery", label: "Push exact head and open pull request" },
    );

    if (
      execution.candidateArtifact.ref !== candidate.ref ||
      execution.candidateArtifact.sha256 !== candidate.sha256 ||
      execution.pushedHead !== committedHead.sha ||
      execution.pullRequest.head !== committedHead.sha ||
      execution.pullRequest.base !== input.base ||
      execution.subject.workspaceId !== candidateSubject.workspaceId ||
      execution.subject.generation !== candidateSubject.generation ||
      execution.subject.treeHash !== candidateSubject.treeHash
    ) {
      throw new Error("Delivery execution did not attest the authorized promotion candidate");
    }

    const ci = await ctx.observe(
      waitForExactHeadCi,
      {
        repository: input.repository,
        pullRequestNumber: execution.pullRequest.number,
        head: committedHead.sha,
      },
      { key: "wait-for-ci", timeout: "2h", every: "30s" },
    );
    if (
      ci.status !== "passed" ||
      ci.head !== committedHead.sha ||
      ci.pullRequestNumber !== execution.pullRequest.number
    ) {
      throw new Error("CI did not pass for the exact promoted commit");
    }

    const recordedAt = await ctx.now();
    const evidence = await ctx.artifact(
      deliveryEvidenceArtifact,
      {
        content: {
          candidate: { ref: candidate.ref, sha256: candidate.sha256 },
          review: reviewProof,
          authorization,
          execution,
          ci,
        },
        metadata: {
          workflowRunId: ctx.run.id,
          repository: input.repository,
          branch: input.branch,
          head: committedHead.sha,
          recordedAt,
        },
      },
      { key: "delivery-evidence", label: "Pull request delivery evidence" },
    );

    return {
      branch: input.branch,
      head: committedHead.sha,
      candidateRef: candidate.ref,
      pullRequestNumber: execution.pullRequest.number,
      pullRequestUrl: execution.pullRequest.url,
      ciUrl: ci.url,
      evidenceRef: evidence.ref,
    };
  },
);
