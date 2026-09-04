import {
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
  type WorkflowContract,
  z,
} from "../../index.ts";

/** Why: Names validated routing for one issue-owned run. Use: Launch it after ingress authenticates and deduplicates an event. */
export interface IssueToReviewedPrInput {
  repository: string;
  issueNumber: number;
  baseRef: string;
  branch: string;
}

const InputSchema: z.ZodType<IssueToReviewedPrInput, IssueToReviewedPrInput> = z
  .object({
    repository: z.string().min(1),
    issueNumber: z.number().int().positive(),
    baseRef: z.string().min(1),
    branch: z.string().min(1),
  })
  .strict();

const IssueSchema = z
  .object({
    repository: z.string().min(1),
    number: z.number().int().positive(),
    url: z.string().url(),
    title: z.string().min(1),
    body: z.string().min(1),
    state: z.enum(["open", "closed"]),
    labels: z.array(z.string()),
    revision: z.string().min(1),
  })
  .strict();
type CanonicalIssue = z.infer<typeof IssueSchema>;

const issueSource = defineContextSource({
  name: "refined-authoritative-issue",
  input: z.object({ repository: z.string().min(1), issueNumber: z.number().int().positive() }).strict(),
  output: IssueSchema,
  binding: "github.issue.read",
  freshness: { maxAge: "30s", stale: "reject" },
  trust: { minimum: "authoritative", authorities: ["github-app"] },
});

const PlanSchema = z
  .object({
    summary: z.string().min(1),
    proposedPaths: z.array(z.string().min(1)).min(1).max(32),
    acceptanceCriteria: z.array(z.string().min(1)).min(1).max(16),
  })
  .strict();

const planner = defineAgent({
  name: "refined-issue-planner",
  prompt: definePrompt({
    name: "refined-plan-issue",
    input: IssueSchema,
    render: (issue) => [
      `Plan a minimal fix for ${issue.repository}#${issue.number}: ${issue.title}.`,
      issue.body,
      "Propose repository-relative paths only. Do not edit or claim verification.",
    ],
  }),
  schema: PlanSchema,
  defaults: { maxTurns: 8, timeout: "10m" },
});

const FeedbackSchema = z
  .object({
    source: z.enum(["implementation", "quality", "review"]),
    summary: z.string().min(1),
    details: z.array(z.string().min(1)).max(16),
  })
  .strict();
const ImplementationInputSchema = z
  .object({
    issue: IssueSchema,
    plan: PlanSchema,
    attempt: z.number().int().min(1).max(3),
    feedback: z.array(FeedbackSchema),
  })
  .strict();

const implementer = defineAgent({
  name: "refined-issue-implementer",
  prompt: definePrompt({
    name: "refined-implement-issue",
    input: ImplementationInputSchema,
    render: ({ issue, plan, attempt, feedback }) => [
      `Attempt ${attempt}/3 for ${issue.repository}#${issue.number}: ${issue.title}.`,
      `Plan: ${plan.summary}`,
      `Criteria:\n${plan.acceptanceCriteria.map((item) => `- ${item}`).join("\n")}`,
      `Prior feedback: ${feedback.length === 0 ? "none" : JSON.stringify(feedback)}`,
      "Edit only through the supplied scope. Do not commit, publish, or claim verification.",
    ],
  }),
  schema: z.object({ summary: z.string().min(1) }).strict(),
  defaults: { maxTurns: 24, timeout: "35m", repair: 1 },
});

const writePolicy = definePathPolicy({
  name: "refined-issue-writes",
  revision: "v1",
  roots: ["."],
  deny: [".git/**", ".weft/**", "**/node_modules/**", "**/dist/**", "**/.env*"],
  grantTtl: "2h",
});

const typecheck = defineCheck({
  name: "refined-required-typecheck",
  revision: "v1",
  command: ["pnpm", "typecheck"],
  policy: "required",
  waiver: { mode: "never" },
  defaults: { timeout: "15m" },
});
const tests = defineCheck({
  name: "refined-required-tests",
  revision: "v1",
  command: ["pnpm", "test"],
  policy: "required",
  waiver: { mode: "never" },
  defaults: { timeout: "30m" },
});
const lint = defineCheck({
  name: "refined-required-lint",
  revision: "v1",
  command: ["pnpm", "lint"],
  policy: "required",
  waiver: { mode: "never" },
  defaults: { timeout: "15m" },
});
const qualitySuite = defineCheckSuite({
  name: "refined-required-quality",
  input: z.object({}).strict(),
  checks: (_input, use) => ({
    typecheck: use(typecheck),
    tests: use(tests),
    lint: use(lint),
  }),
  concurrency: 3,
});

const FindingSchema = z
  .object({
    code: z.string().min(1),
    message: z.string().min(1),
    path: z.string().min(1).nullable(),
  })
  .strict();

const ReviewInputSchema = z
  .object({
    issue: IssueSchema,
    plan: PlanSchema,
    head: z.string().min(1),
    changedFiles: z.array(z.string().min(1)).min(1),
    checkAttestationRef: z.string().min(1),
  })
  .strict();
const reviewer = defineAgent({
  name: "refined-independent-reviewer",
  prompt: definePrompt({
    name: "refined-review-issue-candidate",
    input: ReviewInputSchema,
    render: ({ issue, plan, head, changedFiles, checkAttestationRef }) => [
      `Review ${head} for ${issue.repository}#${issue.number} against: ${plan.summary}`,
      `Changed files:\n${changedFiles.map((path) => `- ${path}`).join("\n")}`,
      `Required-check attestation: ${checkAttestationRef}`,
      "Inspect the workspace. Mark correctness, scope, or missing-test defects as blocking.",
    ],
  }),
  schema: z
    .object({
      assessments: z.array(
        z
          .object({
            finding: FindingSchema,
            disposition: z.enum(["blocking", "advisory", "refuted"]),
            sources: z.array(z.string().min(1)).min(1),
            rationale: z.string().min(1),
          })
          .strict(),
      ),
    })
    .strict(),
  defaults: { maxTurns: 16, timeout: "20m" },
});
const candidateReview = defineReview({
  name: "refined-issue-candidate-review",
  input: ReviewInputSchema,
  finding: FindingSchema,
  evaluate: async (ctx, input) => (await ctx.agent(reviewer, input, { key: "reviewer" })).value,
  accept: ({ assessments }) => assessments.every(({ disposition }) => disposition !== "blocking"),
});

/** Why: Closes expected workflow-level blocking outcomes. Use: Treat other thrown failures as host or delivery failures. */
export type IssueBlockReason =
  | "issue-ineligible"
  | "implementation-exhausted"
  | "quality-exhausted"
  | "review-exhausted"
  | "issue-drift";

const BlockReasonSchema: z.ZodType<IssueBlockReason, IssueBlockReason> = z.enum([
  "issue-ineligible",
  "implementation-exhausted",
  "quality-exhausted",
  "review-exhausted",
  "issue-drift",
]);

const DossierSchema = z
  .object({
    repository: z.string().min(1),
    issueNumber: z.number().int().positive(),
    issueRevision: z.string().min(1),
    planSummary: z.string().min(1),
    attempt: z.number().int().min(1).max(3),
    branch: z.string().min(1),
    head: z.string().min(1),
    changedFiles: z.array(z.string().min(1)),
    qualityRef: z.string().min(1).nullable(),
    reviewRef: z.string().min(1).nullable(),
  })
  .strict();

const dossierArtifact = defineArtifact({
  name: "refined-issue-to-reviewed-pr-dossier",
  mediaType: "application/json",
  extension: ".json",
  content: DossierSchema,
});

const delivery = defineDelivery({
  name: "refined-reviewed-pull-request",
  binding: "github.reviewed-pr-delivery",
  input: z
    .object({
      idempotencyKey: z.string().min(1),
      repository: z.string().min(1),
      issueNumber: z.number().int().positive(),
      issueUrl: z.string().url(),
      base: z.string().min(1),
      branch: z.string().min(1),
      expectedHead: z.string().min(1),
      title: z.string().min(1),
      body: z.string().min(1),
      dossierRef: z.string().min(1),
      dossierSha256: z.string().min(1),
    })
    .strict(),
  output: z
    .object({
      pullRequestNumber: z.number().int().positive(),
      pullRequestUrl: z.string().url(),
    })
    .strict(),
  capabilities: ["git:read", "git:write", "network", "integration:github"],
  defaults: {
    timeout: "10m",
    attempts: 2,
    authorization: {
      action: "Push an exact reviewed branch and open its pull request",
      risk: "high",
      timeout: "24h",
    },
  },
});

/** Why: Names the successfully opened and attested pull request. Use: Continue with post-PR observation outside this workflow. */
export interface OpenedPullRequestOutput {
  status: "opened";
  repository: string;
  issueNumber: number;
  branch: string;
  head: string;
  attempts: number;
  pullRequestNumber: number;
  pullRequestUrl: string;
  dossierRef: string;
  deliveryAttestationRef: string;
}

/** Why: Names expected exhaustion and issue drift without swallowing host failures. Use: Present it for re-triage or a later run. */
export interface BlockedPullRequestOutput {
  status: "blocked";
  repository: string;
  issueNumber: number;
  branch: string;
  attempts: number;
  reason: IssueBlockReason;
  lastHead: string | null;
  evidenceRef: string | null;
}

/** Why: Makes expected exhaustion and drift explicit without swallowing host failures. Use: Branch on status; retry outside this run. */
export type IssueToReviewedPrOutput = OpenedPullRequestOutput | BlockedPullRequestOutput;

const OutputSchema: z.ZodType<IssueToReviewedPrOutput, IssueToReviewedPrOutput> = z.discriminatedUnion(
  "status",
  [
    z.object({
      status: z.literal("opened"),
      repository: z.string().min(1),
      issueNumber: z.number().int().positive(),
      branch: z.string().min(1),
      head: z.string().min(1),
      attempts: z.number().int().min(1).max(3),
      pullRequestNumber: z.number().int().positive(),
      pullRequestUrl: z.string().url(),
      dossierRef: z.string().min(1),
      deliveryAttestationRef: z.string().min(1),
    }),
    z.object({
      status: z.literal("blocked"),
      repository: z.string().min(1),
      issueNumber: z.number().int().positive(),
      branch: z.string().min(1),
      attempts: z.number().int().min(0).max(3),
      reason: BlockReasonSchema,
      lastHead: z.string().min(1).nullable(),
      evidenceRef: z.string().min(1).nullable(),
    }),
  ],
);

function requireIssue(issue: CanonicalIssue, input: IssueToReviewedPrInput): void {
  if (issue.repository !== input.repository || issue.number !== input.issueNumber) {
    throw new Error("The authoritative source returned a different issue");
  }
}

function eligible(issue: CanonicalIssue): boolean {
  return issue.state === "open" && issue.labels.includes("agent-ready");
}

function blocked(
  input: IssueToReviewedPrInput,
  reason: IssueBlockReason,
  attempts: number,
  lastHead: string | null,
  evidenceRef: string | null,
): BlockedPullRequestOutput {
  return {
    status: "blocked",
    repository: input.repository,
    issueNumber: input.issueNumber,
    branch: input.branch,
    attempts,
    reason,
    lastHead,
    evidenceRef,
  };
}

/** Why: Demonstrates candidate-correlated issue-to-reviewed-PR delivery with bounded rework. Use: Prefer it over earlier structural examples. */
export const issueToReviewedPrWorkflow: WorkflowContract<
  IssueToReviewedPrInput,
  IssueToReviewedPrOutput,
  unknown,
  unknown,
  true,
  "refined-issue-to-reviewed-pr"
> = defineWorkflow(
  {
    id: "refined-issue-to-reviewed-pr",
    name: "Issue to reviewed pull request",
    input: InputSchema,
    output: OutputSchema,
    workspace: ({ input }) => ({
      target: { binding: "coding.issue-repository", repository: input.repository },
      from: input.baseRef,
      branch: input.branch,
    }),
  },
  async (ctx, input): Promise<IssueToReviewedPrOutput> => {
    const initialStatus = await ctx.git.status({ key: "initial-git-status" });
    if (!initialStatus.clean || initialStatus.branch !== input.branch) {
      throw new Error("The workflow requires its clean, host-selected branch");
    }
    const baseHead = (await ctx.git.head({ key: "base-git-head" })).sha;

    const issueSnapshot = await ctx.context(
      issueSource,
      { repository: input.repository, issueNumber: input.issueNumber },
      { key: "issue", maxAge: "30s" },
    );
    const issue = issueSnapshot.value;
    requireIssue(issue, input);
    if (!eligible(issue)) {
      return blocked(input, "issue-ineligible", 0, null, issueSnapshot.evidence.ref);
    }

    const plan = (await ctx.agent(planner, issue, { key: "plan", context: [issueSnapshot] })).value;
    let feedback: z.infer<typeof FeedbackSchema>[] = [];

    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const key = (local: string) => `attempt-${attempt}:${local}`;
      const scope = await ctx.paths.resolve(
        writePolicy,
        { proposedPaths: plan.proposedPaths },
        { key: key("paths") },
      );
      const implementation = await ctx.agent(
        implementer,
        { issue, plan, attempt, feedback },
        {
          key: key("implement"),
          context: [issueSnapshot],
          write: scope,
        },
      );
      const changedFiles = [...new Set(implementation.files)].sort();

      if (changedFiles.length === 0) {
        if (attempt < 3) {
          feedback = [{ source: "implementation", summary: "No files changed", details: [] }];
          continue;
        }
        const head = (await ctx.git.head({ key: key("empty-implementation-head") })).sha;
        return blocked(input, "implementation-exhausted", attempt, head, null);
      }

      await ctx.git.add({ key: key("stage-changed-files"), paths: changedFiles });
      const committed = await ctx.git.commit({
        key: key("commit-implementation"),
        message: `fix: resolve #${issue.number} ${issue.title}`.slice(0, 120),
        paths: changedFiles,
      });
      const status = await ctx.git.status({ key: key("committed-git-status") });
      const head = (await ctx.git.head({ key: key("committed-git-head") })).sha;
      if (!status.clean || status.branch !== input.branch || head !== committed.sha) {
        throw new Error("The committed attempt is not the clean workflow branch head");
      }
      const candidate = ctx.workspace.snapshot;
      const candidateFiles = (
        await ctx.git.changedSince(baseHead, { key: key("candidate-files-since-base") })
      ).files.map(({ path }) => path);
      if (candidateFiles.length === 0) {
        if (attempt < 3) {
          feedback = [{ source: "implementation", summary: "Candidate has no net changes", details: [] }];
          continue;
        }
        return blocked(input, "implementation-exhausted", attempt, head, null);
      }

      const quality = await ctx.check(
        qualitySuite,
        {},
        { key: key("quality"), policy: "required", concurrency: 3, candidate },
      );
      if (!quality.passed) {
        const details = [quality.results.typecheck, quality.results.tests, quality.results.lint]
          .filter((result) => result.status === "fail")
          .map((result) => result.summary ?? result.evidence ?? "Required check failed");
        if (attempt < 3) {
          feedback = [{ source: "quality", summary: "Required checks failed", details }];
          continue;
        }
        return blocked(input, "quality-exhausted", attempt, head, quality.attestation.ref);
      }

      const review = await ctx.review(
        candidateReview,
        { issue, plan, head, changedFiles: candidateFiles, checkAttestationRef: quality.attestation.ref },
        { key: key("review"), candidate },
      );
      if (review.status === "rework") {
        const details = review.blocking.map(({ code, message, path }) =>
          path === null ? `${code}: ${message}` : `${path}: ${code}: ${message}`,
        );
        if (attempt < 3) {
          feedback = [{ source: "review", summary: "Review requested changes", details }];
          continue;
        }
        return blocked(input, "review-exhausted", attempt, head, review.attestation.ref);
      }

      const refreshed = await ctx.context(
        issueSource,
        { repository: input.repository, issueNumber: input.issueNumber },
        { key: key("refresh-issue"), maxAge: "30s" },
      );
      requireIssue(refreshed.value, input);
      if (refreshed.value.revision !== issue.revision || !eligible(refreshed.value)) {
        return blocked(input, "issue-drift", attempt, head, refreshed.evidence.ref);
      }

      const dossier = await ctx.artifact(
        dossierArtifact,
        {
          content: {
            repository: issue.repository,
            issueNumber: issue.number,
            issueRevision: issue.revision,
            planSummary: plan.summary,
            attempt,
            branch: input.branch,
            head,
            changedFiles: candidateFiles,
            qualityRef: quality.attestation.ref,
            reviewRef: review.attestation.ref,
          },
        },
        {
          key: key("dossier"),
          candidate,
          sources: [issueSnapshot.evidence, refreshed.evidence, quality.attestation, review.attestation],
        },
      );
      const receipt = await ctx.delivery(
        delivery,
        {
          idempotencyKey: `${issue.repository}#${issue.number}:${candidate.treeHash}`,
          repository: issue.repository,
          issueNumber: issue.number,
          issueUrl: issue.url,
          base: input.baseRef,
          branch: input.branch,
          expectedHead: head,
          title: issue.title,
          body: `${plan.summary}\n\nCloses ${issue.url}\n\nEvidence: ${dossier.ref}`,
          dossierRef: dossier.ref,
          dossierSha256: dossier.sha256,
        },
        {
          key: key("publish-pull-request"),
          candidate,
          proofs: [quality.proof, review.proof],
          artifacts: [dossier],
          authorization: { detail: `Push ${input.branch} at ${head} and open its pull request.` },
          attempts: 2,
        },
      );
      const value = receipt.value;
      return {
        status: "opened",
        repository: issue.repository,
        issueNumber: issue.number,
        branch: input.branch,
        head,
        attempts: attempt,
        pullRequestNumber: value.pullRequestNumber,
        pullRequestUrl: value.pullRequestUrl,
        dossierRef: dossier.ref,
        deliveryAttestationRef: receipt.attestation.ref,
      };
    }

    throw new Error("Unreachable: every bounded attempt returns or continues");
  },
);

/** Why: Names the exact inferred workflow contract without restating its hidden type state. Use: Reuse it in registries and trigger definitions. */
export type IssueToReviewedPrWorkflow = typeof issueToReviewedPrWorkflow;
