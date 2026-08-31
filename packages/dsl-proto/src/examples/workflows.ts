import {
  defineAgent,
  defineCheck,
  defineCheckSuite,
  defineGoal,
  definePathPolicy,
  definePrompt,
  defineResultView,
  defineTaskContract,
  defineUiView,
  defineWorkflow,
  type HumanReviewResult,
  type PatchRef,
  z,
} from "../index.ts";

declare function expectType<T>(value: T): void;

const BugInput = z.object({
  ticket: z.string(),
  allowedPaths: z.array(z.string()),
  testCommand: z.array(z.string()),
});

const BuildResult = z.object({ summary: z.string(), redEvidence: z.string() });

const bugWriterPaths = definePathPolicy({
  name: "bug-writer-paths",
  description: "Canonicalizes caller-proposed bug-fix paths inside the workspace.",
  revision: "v1",
  roots: ["."],
  deny: [".git/**", ".weft/**"],
  grantTtl: "1h",
});

const bugPrompt = definePrompt({
  name: "bug-prompt",
  input: z.object({ ticket: BugInput }),
  render: ({ ticket }) => `Fix ${ticket.ticket}`,
});

const developer = defineAgent({
  name: "bug-developer",
  prompt: bugPrompt,
  schema: BuildResult,
  defaults: {
    provider: {
      id: "claude",
      model: "sonnet",
      effort: "high",
      options: { permissionMode: "dontAsk" },
    },
  },
});

const summarizer = defineAgent({
  name: "summarizer",
  prompt: "Summarize the current repository",
  schema: BuildResult,
});

const regression = defineCheck({
  name: "regression",
  policy: "required",
  input: z.object({ command: z.array(z.string()) }),
  command: ({ command }) => command as [string, ...string[]],
});

const lint = defineCheck({
  name: "lint",
  policy: "required",
  defaults: { timeout: "2m" },
  command: ["pnpm", "lint"],
  parse: ({ exitCode, stdout }) => ({
    status: exitCode === 0 ? ("pass" as const) : ("fail" as const),
    evidence: stdout,
  }),
});

const quality = defineCheckSuite({
  name: "quality",
  input: z.object({ testCommand: z.array(z.string()) }),
  checks: ({ testCommand }, use) => ({
    regression: use(regression, { command: testCommand }),
    lint: use(lint),
  }),
});

const goal = defineGoal({
  name: "bug-complete",
  check: quality,
  defaults: { attempts: 3 },
});

const staticGoal = defineGoal({ name: "lint-complete", check: lint });

const patchBugWorkflow = defineWorkflow(
  { id: "patch-bug", input: BugInput, output: BuildResult },
  async (ctx, input) => {
    const writeScope = await ctx.paths.resolve(
      bugWriterPaths,
      { proposedPaths: input.allowedPaths },
      { key: "developer-write-scope", label: "Resolve bug-fix paths" },
    );
    const built = await ctx.agent(
      developer,
      { ticket: input },
      {
        key: "developer",
        write: writeScope,
        goal: { definition: goal, input: { testCommand: input.testCommand } },
      },
    );

    expectType<PatchRef>(built.patch);
    expectType<"met">(built.goal.status);
    expectType<string>(built.value.summary);
    await ctx.integrate([built.patch], { key: "integrate-bug-patch" });

    const summary = await ctx.agent(summarizer, {
      key: "summary",
      goal: { definition: staticGoal },
    });
    expectType<string>(summary.value.summary);
    return built.value;
  },
);

const Review = z.object({ decision: z.enum(["approved", "changes-requested"]) });

const reviewView = defineUiView({
  id: "review",
  revision: "v1",
  props: z.object({ markdown: z.string() }),
  answer: Review,
  component: ({ props, propose }) => {
    expectType<string>(props.markdown);
    propose({ decision: "approved" });
  },
});

const resultView = defineResultView({
  id: "result",
  props: z.object({ url: z.string().url() }),
  component: ({ props }) => expectType<string>(props.url),
});

const branchDeliveryWorkflow = defineWorkflow(
  {
    id: "branch-delivery",
    input: BugInput,
    output: BuildResult,
    workspace: ({ input }) => ({ branch: `feature/${input.ticket}`, from: "main" }),
  },
  async (ctx, input) => {
    const built = await ctx.step("build", async (step) => {
      const writeScope = await step.paths.resolve(
        bugWriterPaths,
        { proposedPaths: input.allowedPaths },
        { key: "developer-write-scope", label: "Resolve branch bug-fix paths" },
      );
      return step.agent(
        developer,
        { ticket: input },
        {
          key: "developer",
          write: writeScope,
        },
      );
    });

    // Workspace writes are already present and never yield a patch to integrate.
    expectType<undefined>(built.patch);
    expectType<string>(ctx.workspace.branch);

    const reviewed = await ctx.human.review({
      key: "review",
      question: "Review the plan",
      subject: { kind: "file", path: "PLAN.md", mode: "edit" },
      schema: Review,
      ui: { view: reviewView, props: { markdown: "# Plan" } },
    });
    expectType<HumanReviewResult<{ decision: "approved" | "changes-requested" }>>(reviewed);

    await ctx.ui.render({ key: "result", view: resultView, props: { url: "https://example.com" } });
    return built.value;
  },
);

async function inspectTicket(ticket: { ticket: string }): Promise<{ ticket: string }> {
  return ticket;
}

const compositionWorkflow = defineWorkflow(
  { id: "composition", input: z.array(z.object({ ticket: z.string() })), output: z.array(z.string()) },
  async (ctx, input) => {
    const results = await ctx.parallel.all(input, (item) => inspectTicket(item), {
      key: "inspect",
      keyOf: (item) => item.ticket,
      concurrency: 2,
    });
    return results.map((item) => item.ticket);
  },
);

const Tasks = defineTaskContract({
  schema: z.object({ ticket: z.string(), branch: z.string().nullable() }),
  agentAccess: "write",
});

const taskWorkflow = defineWorkflow(
  { id: "task-workflow", input: BugInput, output: BuildResult, tasks: Tasks },
  async (ctx, input) => {
    await ctx.tasks.upsert(
      {
        dedupeKey: input.ticket,
        set: {
          title: input.ticket,
          description: "Bug",
          extensions: { ticket: input.ticket, branch: null },
        },
      },
      { key: "task:intake" },
    );
    const result = await ctx.agent(
      { prompt: "Summarize", schema: BuildResult },
      {
        key: "read",
        failure: "return",
        tasks: { mode: "read", dedupeKeys: [input.ticket] },
      },
    );
    if (!result.ok) return { summary: "unavailable", redEvidence: "unavailable" };
    return result.result.value;
  },
);

// Every `define*` result shares one nominal base type while retaining its precise inferred contract.
expectType<"weft.prompt">(bugPrompt.kind);
expectType<"weft.agent">(developer.kind);
expectType<"weft.check">(regression.kind);
expectType<"weft.check-suite">(quality.kind);
expectType<"weft.goal">(goal.kind);
expectType<"weft.ui-view">(reviewView.kind);
expectType<"weft.ui-view">(resultView.kind);
expectType<"weft.task-contract">(Tasks.kind);
expectType<"weft.workflow">(patchBugWorkflow.kind);
expectType<"weft.workflow">(branchDeliveryWorkflow.kind);
expectType<"weft.workflow">(compositionWorkflow.kind);
expectType<"weft.workflow">(taskWorkflow.kind);
