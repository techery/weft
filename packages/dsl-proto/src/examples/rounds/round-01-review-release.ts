import { z } from "zod";

import {
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
  type Provider,
} from "../../core/index.ts";

// This example intentionally uses only public DSL declarations. The callbacks on operations and
// observers stand in for host-provided adapters; importing this declaration-only package does not
// provide an engine that executes them.

const ReviewFindingSchema = z.object({
  id: z.string(),
  file: z.string(),
  line: z.number().int().positive(),
  category: z.enum(["correctness", "security", "maintainability", "test-coverage"]),
  severity: z.enum(["low", "medium", "high", "critical"]),
  blocking: z.boolean(),
  claim: z.string(),
  evidence: z.string(),
  recommendation: z.string(),
});

/** Why: Gives each review and refutation stage the same schema-derived finding value. Use: Carry it between agents and into durable review artifacts. */
type ReviewFinding = z.infer<typeof ReviewFindingSchema>;

const ReviewTargetSchema = z.object({
  head: z.string(),
  lens: z.string(),
  acceptanceCriteria: z.array(z.string()),
});

const ReviewResultSchema = z.object({
  summary: z.string(),
  findings: z.array(ReviewFindingSchema),
});

/** Why: Preserves the validated result from every independent review lane. Use: Combine the lanes before refuting candidate findings. */
type ReviewResultValue = z.infer<typeof ReviewResultSchema>;

const FindingVerdictSchema = z.object({
  real: z.boolean(),
  reason: z.string(),
  confidence: z.number().min(0).max(1),
});

/** Why: Names the independently validated verdict attached to a candidate finding. Use: Keep only findings a separate provider could not refute. */
type FindingVerdict = z.infer<typeof FindingVerdictSchema>;

/** Why: Keeps an original finding adjacent to its independent verdict. Use: Construct it in the bounded refutation fan-out. */
interface RefutationRecord {
  finding: ReviewFinding;
  verdict: FindingVerdict;
}

const reviewPrompt = definePrompt({
  name: "review-release-candidate",
  input: ReviewTargetSchema,
  render: ({ head, lens, acceptanceCriteria }) =>
    [
      `Review commit ${head} using the ${lens} lens.`,
      "Report only repository-supported findings with precise file and line evidence.",
      `Acceptance criteria:\n${acceptanceCriteria.map((criterion) => `- ${criterion}`).join("\n")}`,
    ].join("\n\n"),
});

const codeReviewer = defineAgent({
  name: "release-candidate-reviewer",
  description: "Read-only specialist that returns structured, evidence-backed review findings.",
  prompt: reviewPrompt,
  schema: ReviewResultSchema,
  defaults: {
    maxTurns: 12,
    timeout: "20m",
  },
});

const refutationPrompt = definePrompt({
  name: "refute-review-finding",
  input: ReviewFindingSchema,
  render: (finding) =>
    [
      `Try to disprove finding ${finding.id}.`,
      `Location: ${finding.file}:${finding.line}`,
      `Claim: ${finding.claim}`,
      `Evidence: ${finding.evidence}`,
      "Set real=false when the repository does not support the claim.",
    ].join("\n"),
});

const findingRefuter = defineAgent({
  name: "release-finding-refuter",
  description: "Challenges findings through a provider independent from the original review lane.",
  prompt: refutationPrompt,
  schema: FindingVerdictSchema,
  defaults: {
    provider: {
      id: "codex",
      model: "gpt-5.6-sol",
      effort: "high",
      options: { sandboxMode: "read-only", networkAccess: false },
    },
    maxTurns: 8,
  },
});

const ImplementationRequestSchema = z.object({
  ticket: z.string(),
  title: z.string(),
  acceptanceCriteria: z.array(z.string()),
  allowedPaths: z.array(z.string()),
  priorFindings: z.array(ReviewFindingSchema),
});

const ImplementationResultSchema = z.object({
  summary: z.string(),
  addressedFindingIds: z.array(z.string()),
});

const implementationPrompt = definePrompt({
  name: "implement-reviewed-change",
  input: ImplementationRequestSchema,
  render: ({ ticket, title, acceptanceCriteria, allowedPaths, priorFindings }) =>
    [
      `Implement ${ticket}: ${title}.`,
      `Allowed paths:\n${allowedPaths.map((path) => `- ${path}`).join("\n")}`,
      `Acceptance criteria:\n${acceptanceCriteria.map((criterion) => `- ${criterion}`).join("\n")}`,
      priorFindings.length === 0
        ? "This is the initial implementation."
        : `Resolve these independently confirmed findings:\n${priorFindings
            .map((finding) => `- ${finding.id}: ${finding.claim}`)
            .join("\n")}`,
    ].join("\n\n"),
});

const implementationAgent = defineAgent({
  name: "review-driven-implementer",
  description: "Owns bounded changes in the workflow branch and responds to confirmed review findings.",
  prompt: implementationPrompt,
  schema: ImplementationResultSchema,
  defaults: {
    provider: {
      id: "codex",
      model: "gpt-5.6-sol",
      effort: "high",
      options: { sandboxMode: "workspace-write", networkAccess: false },
    },
    maxTurns: 24,
    timeout: "45m",
  },
});

const VerificationInputSchema = z.object({
  packageFilter: z.string(),
});

const typecheck = defineCheck({
  name: "release-typecheck",
  description: "Typechecks the exact candidate workspace generation.",
  input: VerificationInputSchema,
  command: ({ packageFilter }) => ["pnpm", "--filter", packageFilter, "typecheck"],
  policy: "required",
  defaults: { timeout: "10m" },
});

const tests = defineCheck({
  name: "release-tests",
  description: "Runs focused tests against the exact candidate workspace generation.",
  input: VerificationInputSchema,
  command: ({ packageFilter }) => ["pnpm", "--filter", packageFilter, "test"],
  policy: "required",
  defaults: { timeout: "20m" },
});

const lint = defineCheck({
  name: "release-lint",
  description: "Checks deterministic style and static-analysis policy before review or publication.",
  input: VerificationInputSchema,
  command: ({ packageFilter }) => ["pnpm", "--filter", packageFilter, "lint"],
  policy: "required",
  defaults: { timeout: "10m" },
});

const deliveryChecks = defineCheckSuite({
  name: "review-release-quality",
  description: "Keeps each required quality signal independently visible while producing one gate verdict.",
  input: VerificationInputSchema,
  checks: (input, use) => ({
    typecheck: use(typecheck, input),
    tests: use(tests, input),
    lint: use(lint, input),
  }),
  concurrency: 3,
});

const implementationGoal = defineGoal({
  name: "verified-review-release-candidate",
  check: deliveryChecks,
  defaults: { attempts: 3 },
});

const ReviewRoundEvidenceSchema = z.object({
  round: z.number().int().positive(),
  head: z.string(),
  reviews: z.array(ReviewResultSchema),
  refutations: z.array(
    z.object({
      finding: ReviewFindingSchema,
      verdict: FindingVerdictSchema,
    }),
  ),
  confirmed: z.array(ReviewFindingSchema),
});

const ReviewEvidenceMetadataSchema = z.object({
  branch: z.string(),
  base: z.string(),
  head: z.string(),
  round: z.number().int().positive(),
});

const reviewEvidenceArtifact = defineArtifact({
  name: "review-round-evidence",
  mediaType: "application/json",
  extension: ".json",
  content: ReviewRoundEvidenceSchema,
  metadata: ReviewEvidenceMetadataSchema,
});

const PullRequestInputSchema = z.object({
  branch: z.string(),
  base: z.string(),
  head: z.string(),
  title: z.string(),
  body: z.string(),
});

const PullRequestResultSchema = z.object({
  number: z.number().int().positive(),
  url: z.string().url(),
  head: z.string(),
});

const publishReviewedPullRequest = defineOperation({
  name: "publish-reviewed-pull-request",
  description:
    "Pushes one reviewed exact branch head and creates its pull request atomically in the code host.",
  input: PullRequestInputSchema,
  output: PullRequestResultSchema,
  capabilities: ["network", "git:read", "git:write", "integration:github"],
  defaults: { timeout: "2m", attempts: 2 },
  authorization: {
    mode: "required",
    action: "publish the reviewed branch and open its pull request",
    risk: "high",
    timeout: "24h",
  },
  binding: "github.pull-request.publish-reviewed-head",
});

const CiLookupSchema = z.object({
  pullRequest: z.number().int().positive(),
  head: z.string(),
});

const CiStateSchema = z.object({
  status: z.enum(["queued", "running", "passed", "failed"]),
  runId: z.string(),
  head: z.string(),
  url: z.string().url(),
});

const TerminalCiSchema = z.object({
  status: z.enum(["passed", "failed"]),
  runId: z.string(),
  head: z.string(),
  url: z.string().url(),
});

const waitForPullRequestCi = defineObserver({
  name: "wait-for-reviewed-pr-ci",
  description: "Waits durably for CI and preserves the exact PR head that the provider evaluated.",
  input: CiLookupSchema,
  state: CiStateSchema,
  output: TerminalCiSchema,
  source: {
    kind: "poll",
    every: "30s",
    binding: "github.actions.status",
  },
  defaults: { timeout: "2h" },
  complete: (state) =>
    state.status === "passed" || state.status === "failed"
      ? { status: state.status, runId: state.runId, head: state.head, url: state.url }
      : null,
});

const ReleaseEvidenceSchema = z.object({
  branch: z.string(),
  head: z.string(),
  pullRequest: PullRequestResultSchema,
  ci: TerminalCiSchema,
  finalChecksPassed: z.literal(true),
  reviewEvidenceRefs: z.array(z.string()),
});

const ReleaseEvidenceMetadataSchema = z.object({
  runId: z.string(),
  branch: z.string(),
  head: z.string(),
  recordedAt: z.number(),
});

const releaseEvidenceArtifact = defineArtifact({
  name: "reviewed-release-evidence",
  mediaType: "application/json",
  extension: ".json",
  content: ReleaseEvidenceSchema,
  metadata: ReleaseEvidenceMetadataSchema,
});

const WorkflowInputSchema = z.object({
  ticket: z.string(),
  title: z.string(),
  body: z.string(),
  base: z.string(),
  branch: z.string(),
  packageFilter: z.string(),
  allowedPaths: z.array(z.string()).min(1),
  acceptanceCriteria: z.array(z.string()).min(1),
});

const reviewedImplementationPaths = definePathPolicy({
  name: "reviewed-implementation-paths",
  description: "Canonicalizes requested implementation paths while protecting workflow metadata.",
  revision: "v1",
  roots: ["."],
  deny: [".git/**", ".weft/**"],
  grantTtl: "1h",
});

const WorkflowOutputSchema = z.object({
  branch: z.string(),
  head: z.string(),
  pullRequestNumber: z.number().int().positive(),
  pullRequestUrl: z.string().url(),
  ciUrl: z.string().url(),
  reviewEvidenceRefs: z.array(z.string()),
  releaseEvidenceRef: z.string(),
});

/** Why: Selects an independent review perspective and provider without weakening workflow authority. Use: Fan these lanes out over the same immutable commit. */
interface ReviewLane {
  key: string;
  lens: string;
  provider: Provider;
}

const reviewLanes = [
  {
    key: "correctness",
    lens: "correctness and regression risk",
    provider: {
      id: "claude",
      model: "sonnet",
      effort: "high",
      options: { permissionMode: "dontAsk" },
    },
  },
  {
    key: "security",
    lens: "security, trust boundaries, and failure handling",
    provider: {
      id: "codex",
      model: "gpt-5.6-sol",
      effort: "high",
      options: { sandboxMode: "read-only", networkAccess: false },
    },
  },
] satisfies readonly ReviewLane[];

/** Why: Names the evidence and actionable findings returned by one complete review round. Use: Feed blocking findings into the next implementation round and retain the artifact reference. */
interface RoundReviewOutcome {
  blockingFindings: ReviewFinding[];
  evidenceRef: string;
}

defineWorkflow(
  {
    id: "round-01-review-release",
    name: "Review and release a coding change",
    description:
      "Builds in one branch, independently reviews, gates publication, opens a PR, and waits for CI.",
    input: WorkflowInputSchema,
    output: WorkflowOutputSchema,
    workspace: ({ input }) => ({ branch: input.branch, from: input.base }),
  },
  async (ctx, input) => {
    const reviewEvidenceRefs: string[] = [];
    let pendingFindings: ReviewFinding[] = [];
    let changedFiles: string[] = [];
    let acceptedHead = "";

    for (let round = 1; round <= 3; round += 1) {
      const implementation = await ctx.step(`implementation:${round}`, async (implementationCtx) => {
        const writeScope = await implementationCtx.paths.resolve(
          reviewedImplementationPaths,
          { proposedPaths: input.allowedPaths },
          { key: "implementation-write-scope", label: `Resolve paths for round ${round}` },
        );
        return implementationCtx.agent(
          implementationAgent,
          {
            ticket: input.ticket,
            title: input.title,
            acceptanceCriteria: input.acceptanceCriteria,
            allowedPaths: input.allowedPaths,
            priorFindings: pendingFindings,
          },
          {
            key: "implement",
            label: round === 1 ? `Implement ${input.ticket}` : `Resolve review round ${round - 1}`,
            write: writeScope,
            goal: {
              definition: implementationGoal,
              input: { packageFilter: input.packageFilter },
              attempts: 3,
            },
          },
        );
      });

      changedFiles = [...new Set([...changedFiles, ...implementation.files])];
      const commit = await ctx.step(`commit:${round}`, async (commitCtx) => {
        await commitCtx.git.add({
          key: `stage-review-round-${round}`,
          paths: implementation.files,
        });
        return commitCtx.git.commit({
          key: `commit-review-round-${round}`,
          message: round === 1 ? `feat: ${input.title}` : `fix: address review round ${round - 1}`,
          paths: implementation.files,
        });
      });

      const roundReview = await ctx.step(
        `review:${round}`,
        async (reviewCtx): Promise<RoundReviewOutcome> => {
          const reviews = await reviewCtx.parallel.all(
            reviewLanes,
            (lane) =>
              reviewCtx.agent(
                codeReviewer,
                {
                  head: commit.sha,
                  lens: lane.lens,
                  acceptanceCriteria: input.acceptanceCriteria,
                },
                {
                  key: `review:${lane.key}`,
                  provider: lane.provider,
                  providerRequirements: { structured: "native" },
                },
              ),
            {
              key: "independent-reviews",
              keyOf: (lane) => lane.key,
              concurrency: 2,
            },
          );

          const reviewValues: ReviewResultValue[] = reviews.map((review) => review.value);
          const candidates = reviewValues.flatMap((review) => review.findings);
          const refutations = await reviewCtx.parallel.all(
            candidates,
            async (finding): Promise<RefutationRecord> => {
              const verdict = await reviewCtx.agent(findingRefuter, finding, {
                key: `refute:${finding.id}`,
                providerRequirements: { structured: "native" },
              });
              return { finding, verdict: verdict.value };
            },
            {
              key: "independent-refutations",
              keyOf: (finding) => finding.id,
              concurrency: 4,
            },
          );

          const confirmed = refutations
            .filter((record) => record.verdict.real)
            .map((record) => record.finding);
          const evidence = await reviewCtx.artifact(
            reviewEvidenceArtifact,
            {
              content: {
                round,
                head: commit.sha,
                reviews: reviewValues,
                refutations,
                confirmed,
              },
              metadata: {
                branch: ctx.workspace.branch,
                base: input.base,
                head: commit.sha,
                round,
              },
            },
            { key: "evidence", label: `Review evidence for round ${round}` },
          );

          return {
            blockingFindings: confirmed.filter((finding) => finding.blocking),
            evidenceRef: evidence.ref,
          };
        },
      );

      reviewEvidenceRefs.push(roundReview.evidenceRef);
      acceptedHead = commit.sha;
      pendingFindings = roundReview.blockingFindings;
      if (pendingFindings.length === 0) break;
    }

    if (pendingFindings.length > 0) {
      await ctx.note({
        key: "record-review-exhaustion",
        kind: "risk",
        text: "Release stopped after three review and rework rounds.",
        evidence: JSON.stringify(pendingFindings),
      });
      throw new Error("Confirmed blocking review findings remain after three rounds");
    }

    if (acceptedHead.length === 0 || changedFiles.length === 0) {
      throw new Error("The workflow produced no releasable commit");
    }

    const finalChecks = await ctx.step("final-verification", (verificationCtx) =>
      verificationCtx.check(deliveryChecks, { packageFilter: input.packageFilter }, { key: "release" }),
    );
    if (!finalChecks.passed) {
      throw new Error("Final checks failed; the reviewed branch was not published");
    }

    const publicationApproval = await ctx.human.approve({
      key: "approve-reviewed-publication",
      action: `Publish ${ctx.workspace.branch} at ${acceptedHead}`,
      detail: `Approve ${changedFiles.length} changed files backed by review artifacts ${reviewEvidenceRefs.join(", ")}.`,
      timeout: "24h",
      onTimeout: "deny",
    });
    if (!publicationApproval.approved) {
      throw new Error(publicationApproval.note ?? "Publication was denied");
    }

    const pullRequestInput = {
      branch: ctx.workspace.branch,
      base: input.base,
      head: acceptedHead,
      title: input.title,
      body: input.body,
    };
    const pullRequestCandidate = await ctx.operation.prepare(publishReviewedPullRequest, pullRequestInput, {
      key: "prepare-publication",
      label: "Freeze reviewed publication input",
    });
    const pullRequestAuthorization = await ctx.operation.authorize(
      publishReviewedPullRequest,
      pullRequestCandidate,
      {
        key: "authorize-publication",
        label: "Authorize reviewed branch publication",
        detail: `Push ${ctx.workspace.branch} at ${acceptedHead} and open ${input.title}`,
      },
    );
    const pullRequest = await ctx.operation.execute(
      publishReviewedPullRequest,
      { candidate: pullRequestCandidate, authorization: pullRequestAuthorization },
      { key: "publish-pull-request", label: "Publish reviewed branch and pull request" },
    );
    if (pullRequest.head !== acceptedHead) {
      throw new Error("The pull request operation did not preserve the reviewed head");
    }

    const ci = await ctx.observe(
      waitForPullRequestCi,
      { pullRequest: pullRequest.number, head: acceptedHead },
      { key: "wait-for-ci", label: "Wait for exact-head CI", every: "30s", timeout: "2h" },
    );
    if (ci.status !== "passed" || ci.head !== acceptedHead) {
      throw new Error(`CI did not pass for reviewed commit ${acceptedHead}`);
    }

    const recordedAt = await ctx.now({ key: "release-evidence-recorded-at" });
    const releaseEvidence = await ctx.artifact(
      releaseEvidenceArtifact,
      {
        content: {
          branch: ctx.workspace.branch,
          head: acceptedHead,
          pullRequest,
          ci,
          finalChecksPassed: true,
          reviewEvidenceRefs,
        },
        metadata: {
          runId: ctx.run.id,
          branch: ctx.workspace.branch,
          head: acceptedHead,
          recordedAt,
        },
      },
      { key: "release-evidence", label: "Reviewed release evidence" },
    );

    await ctx.note({
      key: "record-reviewed-release",
      kind: "claim",
      text: `Pull request ${pullRequest.url} passed CI for reviewed commit ${acceptedHead}.`,
      evidence: releaseEvidence.ref,
    });

    return {
      branch: ctx.workspace.branch,
      head: acceptedHead,
      pullRequestNumber: pullRequest.number,
      pullRequestUrl: pullRequest.url,
      ciUrl: ci.url,
      reviewEvidenceRefs,
      releaseEvidenceRef: releaseEvidence.ref,
    };
  },
);
