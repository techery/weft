import { z } from "zod";

import {
  type AgentResult,
  defineAgent,
  defineOperation,
  definePrompt,
  defineWorkflow,
  prompt,
  type WorkflowNode,
} from "../../core/index.ts";

/** Why: Makes compile-time assertions visible without adding a runtime test helper. Use: Pass inferred DSL values to it in this typechecked example. */
declare function expectType<T>(value: T): void;

const RepositoryInput = z.object({
  repository: z.string().min(1),
});

const IssueLookupInput = RepositoryInput.extend({
  issueNumber: z.number().int().positive(),
});

const IssueRecord = z.object({
  source: z.literal("github"),
  repository: z.string().min(1),
  number: z.number().int().positive(),
  title: z.string().min(1),
  body: z.string(),
  state: z.enum(["open", "closed"]),
  labels: z.array(z.string()),
  url: z.string().url(),
  updatedAt: z.string().datetime(),
});

const lookupIssue = defineOperation({
  name: "round-04-lookup-issue",
  description: "Reads one issue through a host-authorized GitHub adapter without exposing credentials.",
  input: IssueLookupInput,
  output: IssueRecord,
  binding: "github.issue.lookup",
  capabilities: ["network", "integration:github"],
  authorization: { mode: "none" },
  defaults: { timeout: "1m", attempts: 2 },
});

const PullRequestLookupInput = RepositoryInput.extend({
  pullRequestNumber: z.number().int().positive(),
});

const PullRequestRecord = z.object({
  source: z.literal("github"),
  repository: z.string().min(1),
  number: z.number().int().positive(),
  title: z.string().min(1),
  body: z.string(),
  state: z.enum(["open", "closed", "merged"]),
  draft: z.boolean(),
  author: z.string().min(1),
  base: z.string().min(1),
  head: z.string().min(1),
  labels: z.array(z.string()),
  changedFiles: z.array(z.string().min(1)),
  url: z.string().url(),
  updatedAt: z.string().datetime(),
});

const lookupPullRequest = defineOperation({
  name: "round-04-lookup-pull-request",
  description: "Reads review-relevant pull-request metadata through a host-authorized GitHub adapter.",
  input: PullRequestLookupInput,
  output: PullRequestRecord,
  binding: "github.pull-request.lookup",
  capabilities: ["network", "integration:github"],
  authorization: { mode: "none" },
  defaults: { timeout: "1m", attempts: 2 },
});

const CodeSearchInput = RepositoryInput.extend({
  revision: z.string().min(1),
  query: z.string().min(1).max(200),
  roots: z.array(z.string().min(1)).min(1).max(8),
  maxMatches: z.number().int().min(1).max(50),
});

const CodeSearchResult = z.object({
  repository: z.string().min(1),
  revision: z.string().min(1),
  query: z.string().min(1),
  matches: z.array(
    z.object({
      path: z.string().min(1),
      line: z.number().int().positive(),
      snippet: z.string(),
    }),
  ),
  truncated: z.boolean(),
});

const searchCode = defineOperation({
  name: "round-04-search-code",
  description:
    "Searches only the supplied roots at one exact repository revision and returns bounded matches.",
  input: CodeSearchInput,
  output: CodeSearchResult,
  binding: "repository.code.search",
  capabilities: ["workspace:read", "filesystem:read"],
  authorization: { mode: "none" },
  defaults: { timeout: "30s", attempts: 1 },
});

const FocusedTestInput = RepositoryInput.extend({
  revision: z.string().min(1),
  target: z.string().min(1),
});

const FocusedTestResult = z.object({
  repository: z.string().min(1),
  revision: z.string().min(1),
  target: z.string().min(1),
  status: z.enum(["passed", "failed"]),
  durationMs: z.number().int().nonnegative(),
  summary: z.string().min(1),
  outputRef: z.string().min(1),
});

const runFocusedTest = defineOperation({
  name: "round-04-run-focused-test",
  description:
    "Runs one host-registered test target at an exact revision; it never accepts a model-authored command.",
  input: FocusedTestInput,
  output: FocusedTestResult,
  binding: "repository.test.run-registered",
  capabilities: ["workspace:read", "process"],
  authorization: {
    mode: "required",
    action: "run a registered focused test against an exact repository revision",
    risk: "low",
    timeout: "5m",
  },
  defaults: { timeout: "10m", attempts: 1 },
});

const AllowedTestTarget = z.object({
  id: z.string().min(1),
  description: z.string().min(1),
});

const ToolsetWorkflowInput = RepositoryInput.extend({
  issueNumber: z.number().int().positive(),
  pullRequestNumber: z.number().int().positive(),
  searchRoots: z.array(z.string().min(1)).min(1).max(8),
  allowedTests: z.array(AllowedTestTarget).min(1).max(12),
});

const InvestigationPlanInput = z.object({
  issue: IssueRecord,
  pullRequest: PullRequestRecord,
  searchRoots: z.array(z.string().min(1)).min(1),
  allowedTests: z.array(AllowedTestTarget).min(1),
});

const InvestigationPlan = z.object({
  hypothesis: z.string().min(1),
  searchQueries: z.array(z.string().min(1).max(200)).min(1).max(3),
  testTargets: z.array(z.string().min(1)).min(1).max(2),
});

const planningPrompt = definePrompt({
  name: "round-04-plan-bounded-investigation",
  input: InvestigationPlanInput,
  render: ({ issue, pullRequest, searchRoots, allowedTests }) => [
    prompt.json("Issue metadata", issue),
    prompt.json("Pull-request metadata", pullRequest),
    prompt.json("Search roots", searchRoots),
    prompt.json("Registered test targets", allowedTests),
    prompt.section(
      "Plan contract",
      [
        "Form one falsifiable hypothesis about whether the pull request resolves the issue.",
        "Request one to three literal code-search queries; the workflow fixes their revision and roots.",
        "Select one or two test target IDs exactly as registered above; never invent a shell command.",
        "You may use only the granted code-search and registered-test tools, within their call budgets.",
        "Return the exact bounded requests so the workflow can preserve independently replayable evidence.",
      ].join("\n"),
    ),
  ],
});

const investigationPlanner = defineAgent({
  name: "round-04-investigation-planner",
  description:
    "Plans a small evidence request without receiving ambient repository, process, or network access.",
  prompt: planningPrompt,
  schema: InvestigationPlan,
  defaults: {
    provider: {
      id: "codex",
      effort: "high",
      options: { sandboxMode: "read-only", networkAccess: false, webSearch: "disabled" },
    },
    maxTurns: 4,
    timeout: "5m",
    repair: 1,
    tools: [
      { operation: searchCode, maxCalls: 3 },
      { operation: runFocusedTest, maxCalls: 2 },
    ],
  },
});

const InvestigationEvidence = z.object({
  issue: IssueRecord,
  pullRequest: PullRequestRecord,
  plan: InvestigationPlan,
  searches: z.array(CodeSearchResult).min(1).max(3),
  tests: z.array(FocusedTestResult).min(1).max(2),
});

const InvestigationAssessment = z.object({
  verdict: z.enum(["supports-fix", "does-not-support-fix", "inconclusive"]),
  summary: z.string().min(1),
  codeEvidence: z.array(z.object({ path: z.string().min(1), rationale: z.string().min(1) })),
  testEvidence: z.array(z.object({ target: z.string().min(1), rationale: z.string().min(1) })),
  missingEvidence: z.array(z.string()),
});

const assessmentPrompt = definePrompt({
  name: "round-04-assess-bounded-investigation",
  input: InvestigationEvidence,
  render: (evidence) => [
    prompt.json("Bounded investigation evidence", evidence),
    prompt.section(
      "Assessment contract",
      [
        "Assess only whether this exact pull-request head supports the issue's claimed fix.",
        "Cite only paths and registered test targets present in the supplied operation results.",
        "Treat failed tests and truncated searches explicitly; use inconclusive when evidence is insufficient.",
        "Do not claim access to GitHub, the repository, a shell, or any operation beyond this evidence.",
      ].join("\n"),
    ),
  ],
});

const investigationAssessor = defineAgent({
  name: "round-04-investigation-assessor",
  description: "Assesses host-returned evidence while remaining isolated from its collection mechanisms.",
  prompt: assessmentPrompt,
  schema: InvestigationAssessment,
  defaults: {
    provider: {
      id: "codex",
      effort: "high",
      options: { sandboxMode: "read-only", networkAccess: false, webSearch: "disabled" },
    },
    maxTurns: 6,
    timeout: "8m",
    repair: 1,
  },
});

const ToolsetWorkflowOutput = z.object({
  issue: z.object({ number: z.number().int().positive(), url: z.string().url() }),
  pullRequest: z.object({
    number: z.number().int().positive(),
    url: z.string().url(),
    head: z.string().min(1),
  }),
  plan: InvestigationPlan,
  searches: z.array(CodeSearchResult),
  tests: z.array(FocusedTestResult),
  assessment: InvestigationAssessment,
});

/** Why: Rejects model-authored aliases that are not in the workflow's explicit test grant. Use: Validate the plan before invoking the host-bound test operation. */
function requireAllowedTestTargets(
  requested: readonly string[],
  allowed: ReadonlyArray<z.infer<typeof AllowedTestTarget>>,
): string[] {
  const allowedIds = new Set(allowed.map(({ id }) => id));
  const uniqueRequested = [...new Set(requested)];
  if (uniqueRequested.length !== requested.length || uniqueRequested.some((id) => !allowedIds.has(id))) {
    throw new Error("The agent requested a duplicate or unregistered test target");
  }
  return uniqueRequested;
}

/** Why: Prevents duplicate model-authored searches from consuming the bounded operation budget. Use: Validate the plan before code-search fan-out. */
function requireUniqueQueries(queries: readonly string[]): string[] {
  const uniqueQueries = [...new Set(queries)];
  if (uniqueQueries.length !== queries.length) throw new Error("The agent requested duplicate code searches");
  return uniqueQueries;
}

/** Why: Demonstrates the strongest current-DSL approximation of agent tools: an explicit, workflow-mediated request/evidence cycle. Use: Launch it to assess one issue against one pull-request head with fixed search and test bounds. */
const boundedAgentToolsetWorkflow = defineWorkflow(
  {
    id: "round-04-agent-toolset",
    name: "Bounded agent investigation toolset",
    description:
      "Mediates issue lookup, PR metadata, code search, and registered tests around isolated agent calls.",
    input: ToolsetWorkflowInput,
    output: ToolsetWorkflowOutput,
  },
  async (ctx, input) => {
    const issue = await ctx.operation(
      lookupIssue,
      { repository: input.repository, issueNumber: input.issueNumber },
      { key: "lookup-issue" },
    );
    const pullRequest = await ctx.operation(
      lookupPullRequest,
      { repository: input.repository, pullRequestNumber: input.pullRequestNumber },
      { key: "lookup-pull-request" },
    );

    const plan = await ctx.agent(
      investigationPlanner,
      { issue, pullRequest, searchRoots: input.searchRoots, allowedTests: input.allowedTests },
      {
        key: "plan-investigation",
      },
    );
    expectType<AgentResult<z.infer<typeof InvestigationPlan>>>(plan);

    const queries = requireUniqueQueries(plan.value.searchQueries);
    const testTargets = requireAllowedTestTargets(plan.value.testTargets, input.allowedTests);
    const searches = await ctx.parallel.all(
      queries,
      (query, lane, index) =>
        lane.ctx.operation(
          searchCode,
          {
            repository: input.repository,
            revision: pullRequest.head,
            query,
            roots: input.searchRoots,
            maxMatches: 20,
          },
          { key: `search-${index + 1}` },
        ),
      { key: "bounded-code-searches", keyOf: (_query, index) => String(index + 1), concurrency: 3 },
    );
    const tests = await ctx.parallel.all(
      testTargets,
      async (target, lane, index) => {
        const candidate = await lane.ctx.operation.prepare(
          runFocusedTest,
          { repository: input.repository, revision: pullRequest.head, target },
          { key: `test-${index + 1}-prepare`, label: `Prepare registered test ${target}` },
        );
        const authorization = await lane.ctx.operation.authorize(runFocusedTest, candidate, {
          key: `test-${index + 1}-authorize`,
          label: `Authorize registered test ${target}`,
          detail: `Run ${target} at exact revision ${pullRequest.head}.`,
        });
        return lane.ctx.operation.execute(
          runFocusedTest,
          { candidate, authorization },
          { key: `test-${index + 1}-execute`, attempts: 1 },
        );
      },
      { key: "bounded-focused-tests", keyOf: (target) => target, concurrency: 2 },
    );

    const assessment = await ctx.agent(
      investigationAssessor,
      { issue, pullRequest, plan: plan.value, searches, tests },
      {
        key: "assess-investigation",
      },
    );
    expectType<AgentResult<z.infer<typeof InvestigationAssessment>>>(assessment);

    return {
      issue: { number: issue.number, url: issue.url },
      pullRequest: { number: pullRequest.number, url: pullRequest.url, head: pullRequest.head },
      plan: plan.value,
      searches,
      tests,
      assessment: assessment.value,
    };
  },
);

expectType<WorkflowNode<"weft.workflow">>(boundedAgentToolsetWorkflow);

// Round 4 reimplementation: the planner receives a deny-by-default operation allowlist with per-tool call
// budgets. The durable mediator still validates model-selected queries and test IDs, then records replayable
// results; protected test execution additionally follows prepare -> authorize -> execute outside the model.
// A named `defineToolset` remains unnecessary until shared registry identity or reusable policy appears.
