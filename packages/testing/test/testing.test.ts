import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AgentRequest, MemoryBlobStore, MemoryJournalStore } from "@techery/weft-core";
import {
  defineAgent,
  defineCheck,
  defineCheckSuite,
  definePrompt,
  defineRecipe,
  defineStep,
  defineWorkflow,
  prompt,
  StepError,
  z,
} from "@techery/weft-sdk";
import { FsBlobStore, FsJournalStore } from "@techery/weft-store-fs";
import { afterAll, describe, expect, test } from "vitest";
import { blobStoreConformance, journalStoreConformance } from "../src/conformance.ts";
import { fixture, mock, runWorkflow } from "../src/index.ts";

const tempDirs: string[] = [];

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterAll(async () => {
  await Promise.all(
    tempDirs
      .splice(0)
      .map((d) =>
        rm(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }).catch(() => undefined),
      ),
  );
});

describe("composable workflow DSL", () => {
  const echoPrompt = definePrompt({
    name: "echo-value",
    input: z.object({ value: z.string(), context: z.string() }),
    render: ({ value, context }) => [
      prompt.section("Role", "Return the requested value."),
      prompt.section("Value", value),
      prompt.section("Bounded context", context),
    ],
  });
  const echoAgent = defineAgent({
    name: "echo-agent",
    prompt: echoPrompt,
    schema: z.object({ value: z.string() }),
    defaults: { effort: "low", tasks: false },
  });
  const echoStep = defineStep<{ key: string; value: string }, string>({
    name: "echo-step",
    run: async (ctx, input) => {
      const result = await ctx.agent(
        echoAgent,
        { value: input.value, context: `run:${ctx.run.id}` },
        { key: input.key },
      );
      return result.value;
    },
  });

  test("phase handles isolate concurrent calls and scopes compose agents, parallel policy, recipes, and humans", async () => {
    let activeReviewCalls = 0;
    let maxReviewCalls = 0;
    const provider = mock()
      .on({ key: "phase-a" }, { value: "A" })
      .on({ key: "phase-b" }, { value: "B" })
      .on({ key: "review:*" }, async (request) => {
        activeReviewCalls++;
        maxReviewCalls = Math.max(maxReviewCalls, activeReviewCalls);
        await new Promise((resolve) => setTimeout(resolve, 5));
        activeReviewCalls--;
        return { value: request.key!.slice("review:".length) };
      });
    const workflow = defineWorkflow(
      {
        name: "composable-prototype",
        description: "exercise immutable execution contexts and reusable definitions",
        input: z.object({}),
        output: z.object({ values: z.array(z.string()), approved: z.boolean() }),
      },
      async (ctx) => {
        const phaseA = ctx.phase("Phase A").scope({ agent: { provider: "codex", effort: "high" } });
        const phaseB = ctx.phase("Phase B");
        const first = await ctx.parallel([
          () => phaseA.step(echoStep, { key: "phase-a", value: "A" }),
          () => phaseB.step(echoStep, { key: "phase-b", value: "B" }),
        ]);

        const review = ctx.phase("Review");
        const reviewers = review.phase("Files").scope({
          parallel: { concurrency: 1, errors: "throw" },
        });
        const reviewed = await reviewers.parallel(["one", "two"], (value) =>
          reviewers.step(echoStep, { key: `review:${value}`, value }),
        );
        const approval = await ctx.phase("Approve").human.approve({
          key: "approve",
          action: "Approve the composed result?",
        });
        return { values: [...ctx.all(first), ...reviewers.all(reviewed)], approved: approval.approved };
      },
    );

    const result = await runWorkflow(workflow, {
      input: {},
      provider,
      answers: { "Approve the composed result?": { approved: true } },
    });

    expect(result.output).toEqual({ values: ["A", "B", "one", "two"], approved: true });
    expect(result.journal.step("phase-a").phase).toBe("Phase A");
    expect(result.journal.step("phase-b").phase).toBe("Phase B");
    expect(result.journal.step("review:one").phase).toBe("Review / Files");
    expect(maxReviewCalls).toBe(1);
    expect(provider.calls.find((call) => call.key === "phase-a")).toMatchObject({
      effort: "high",
    });
    const human = result.journal.records.find((record) => record.ev.type === "human.requested")?.ev;
    expect(human).toMatchObject({ type: "human.requested", key: "approve", phase: "Approve" });
  });

  test("runs reusable checks and suites as independently journaled phase steps", async () => {
    let active = 0;
    let maxActive = 0;
    let configuredCoverage: number | undefined;
    const validation = (name: string) =>
      defineCheck({
        name,
        policy: "required",
        run: async () => {
          active++;
          maxActive = Math.max(maxActive, active);
          await new Promise((resolve) => setTimeout(resolve, 5));
          active--;
          return { status: "pass" as const, evidence: `${name} passed` };
        },
      });
    const quality = defineCheckSuite({
      name: "quality",
      checks: [validation("lint"), validation("tests")],
      concurrency: 1,
    });
    const coverage = defineCheck({
      name: "coverage",
      policy: "required",
      input: z.object({ actual: z.coerce.number(), minimum: z.number() }),
      run: ({ actual, minimum }) => {
        configuredCoverage = actual;
        return {
          status: actual >= minimum ? "pass" : "fail",
          details: [{ kind: "metric", name: "coverage", actual, expected: minimum, unit: "%" }],
        };
      },
    });
    const metrics = defineCheckSuite({
      name: "metrics",
      input: z.object({ actual: z.union([z.string(), z.number()]), minimum: z.number() }),
      checks: (input, use) => ({ coverage: use(coverage, input) }),
    });
    const workflow = defineWorkflow(
      {
        name: "reusable-checks",
        description: "exercise reusable checks and suites",
        input: z.object({}),
        output: z.object({ suitePassed: z.boolean(), coverage: z.string() }),
      },
      async (ctx) => {
        const verify = ctx.phase("Verify");
        const suite = await verify.check(quality, { keyPrefix: "quality" });
        const measured = await verify.check(metrics, { actual: "95", minimum: 90 }, { keyPrefix: "metrics" });
        return { suitePassed: suite.passed, coverage: measured.results.coverage.status };
      },
    );

    const result = await runWorkflow(workflow, { input: {} });

    expect(result.output).toEqual({ suitePassed: true, coverage: "pass" });
    expect(result.journal.step("quality:lint")).toMatchObject({ kind: "check", phase: "Verify" });
    expect(result.journal.step("quality:tests")).toMatchObject({ kind: "check", phase: "Verify" });
    expect(result.journal.step("metrics:coverage")).toMatchObject({ kind: "check", phase: "Verify" });
    expect(result.journal.steps({ kind: "check", phase: "Verify" })).toHaveLength(3);
    expect(maxActive).toBe(1);
    expect(configuredCoverage).toBe(95);
  });

  test("aggregates non-required suite failures without hiding successful members", async () => {
    const quality = defineCheckSuite({
      name: "advisory-quality",
      checks: [
        defineCheck({ name: "lint", run: () => false }),
        defineCheck({
          name: "tests",
          run: () => ({ status: "pass", evidence: "12 tests passed" }),
        }),
      ],
    });
    const workflow = defineWorkflow(
      {
        name: "advisory-check-suite",
        description: "return the aggregate status of an advisory suite",
        input: z.object({}),
        output: z.object({ passed: z.boolean(), lint: z.string(), tests: z.string() }),
      },
      async (ctx) => {
        const result = await ctx.check(quality, { keyPrefix: "advisory" });
        return {
          passed: result.passed,
          lint: result.results.lint.status,
          tests: result.results.tests.status,
        };
      },
    );

    const result = await runWorkflow(workflow, { input: {} });

    expect(result.output).toEqual({ passed: false, lint: "fail", tests: "pass" });
    expect(result.journal.step("advisory:lint").output).toEqual({
      status: "fail",
      disposition: "executed",
    });
    expect(result.journal.step("advisory:tests").output).toEqual({
      status: "pass",
      disposition: "executed",
      evidence: "12 tests passed",
    });
  });

  test("rejects invalid reusable-check input before executing the check", async () => {
    let executed = false;
    const nonEmpty = defineCheck({
      name: "non-empty",
      input: z.object({ value: z.string().min(1) }),
      run: ({ value }) => {
        executed = true;
        return value.length > 0;
      },
    });
    const workflow = defineWorkflow(
      {
        name: "invalid-check-input",
        description: "fail closed before a reusable check executes",
        input: z.object({}),
        output: z.object({}),
      },
      async (ctx) => {
        await ctx.check(nonEmpty, { value: "" }, { key: "non-empty" });
        return {};
      },
    );

    await expect(runWorkflow(workflow, { input: {} })).rejects.toThrow(
      /check:non-empty: input failed schema validation.*value/,
    );
    expect(executed).toBe(false);
  });

  test("rejects an invalid executed-check status instead of recording a false pass", async () => {
    const invalid = defineCheck({
      name: "invalid-status",
      run: () => ({ status: "skipped" }) as unknown as { status: "pass" },
    });
    const workflow = defineWorkflow(
      {
        name: "invalid-check-output",
        description: "fail closed on malformed check output",
        input: z.object({}),
        output: z.object({}),
      },
      async (ctx) => {
        await ctx.check(invalid, { key: "invalid-status" });
        return {};
      },
    );

    await expect(runWorkflow(workflow, { input: {} })).rejects.toThrow(/returned an invalid status/);
  });

  test("validates and transforms transparent recipe input and output", async () => {
    const double = defineRecipe({
      name: "double",
      input: z.object({ value: z.coerce.number() }),
      output: z.object({ doubled: z.number() }),
      run: async (_ctx, { value }) => ({ doubled: value * 2 }),
    });
    const workflow = defineWorkflow(
      {
        name: "schema-recipe",
        description: "exercise a schema-backed transparent recipe",
        input: z.object({}),
        output: z.object({ doubled: z.number() }),
      },
      async (ctx) => ctx.phase("Compute").recipe(double, { value: "21" }),
    );

    await expect(runWorkflow(workflow, { input: {} })).resolves.toMatchObject({
      output: { doubled: 42 },
    });
  });

  test("validates and transforms reusable-agent prompt input before rendering", async () => {
    const numberPrompt = definePrompt({
      name: "number-prompt",
      input: z.object({ value: z.coerce.number() }),
      render: ({ value }) => `Type: ${typeof value}; value: ${value}`,
    });
    const numberAgent = defineAgent({
      name: "number-agent",
      prompt: numberPrompt,
      schema: z.object({ ok: z.boolean() }),
    });
    const workflow = defineWorkflow(
      {
        name: "schema-prompt",
        description: "exercise schema-backed prompt input",
        input: z.object({}),
        output: z.object({ ok: z.boolean() }),
      },
      async (ctx) => ctx.agent(numberAgent, { value: "3" }, { key: "number" }),
    );
    const provider = mock().on({ key: "number" }, { ok: true });

    const result = await runWorkflow(workflow, { input: {}, provider });

    expect(result.output).toEqual({ ok: true });
    expect(provider.calls[0]?.prompt).toContain("Type: number; value: 3");
  });

  test("fails a recipe whose raw output violates its output schema", async () => {
    const invalid = defineRecipe({
      name: "invalid-output",
      input: z.object({}),
      output: z.object({ value: z.number() }),
      run: async () => ({ value: "not a number" }) as unknown as { value: number },
    });
    const workflow = defineWorkflow(
      {
        name: "invalid-recipe-output",
        description: "fail closed on recipe output",
        input: z.object({}),
        output: z.object({ value: z.number() }),
      },
      async (ctx) => ctx.recipe(invalid, {}),
    );

    await expect(runWorkflow(workflow, { input: {} })).rejects.toThrow(
      /recipe:invalid-output: output failed schema validation/,
    );
  });
});

// ---------------------------------------------------------------------------
// The developer guide's example workflow
// ---------------------------------------------------------------------------

const Finding = z.object({ file: z.string(), line: z.number(), claim: z.string(), evidence: z.string() });

const review = defineWorkflow(
  {
    name: "review",
    description: "review the changed files and keep only findings that survive refutation",
    input: z.object({ base: z.string() }),
    output: z.object({ confirmed: z.array(Finding) }),
  },
  async (ctx, { base }) => {
    ctx.phase("Survey");
    const { files } = await ctx.git.changedSince(base);

    ctx.phase("Review");
    const reviewed = ctx.successes(
      await ctx.parallel(
        files.map(
          (f) => () =>
            ctx.agent(`Review ${f.path} for defects.`, {
              schema: z.object({ findings: z.array(Finding) }),
              key: `review:${f.path}`,
            }),
        ),
      ),
    );
    const findings = reviewed.flatMap((r) => r.findings);

    ctx.phase("Refute");
    const verdicts = ctx.successes(
      await ctx.parallel(
        findings.map(
          (f) => () =>
            ctx.agent(
              `Refute this finding: ${f.claim}\nEvidence: ${f.evidence}\n` +
                `Default real=false unless the evidence proves the claim.`,
              {
                schema: z.object({ real: z.boolean(), reason: z.string() }),
                key: `refute:${f.file}:${f.line}`,
              },
            ),
        ),
      ),
    );
    return { confirmed: findings.filter((_, i) => verdicts[i]?.real === true) };
  },
);

function reviewProvider() {
  return mock()
    .on({ key: "review:*" }, () => ({
      findings: [{ file: "a.ts", line: 3, claim: "off-by-one", evidence: "for (i <= n)" }],
    }))
    .on({ key: "refute:*" }, (req) => ({ real: req.prompt.includes("off-by-one"), reason: "loop bound" }));
}

const changedSince = { changedSince: { files: [{ path: "a.ts", status: "M" }] } };

describe("runWorkflow", () => {
  test("accepts raw transformed workflow inputs and task extension seeds", async () => {
    const transformed = defineWorkflow(
      {
        id: "testing-transforms",
        description: "exercise raw and parsed test-harness boundaries",
        input: z.string().transform((value) => ({ value })),
        output: z.object({ value: z.string() }),
        tasks: {
          extensions: z.object({
            owner: z.string().default("platform"),
            code: z.string().transform((value) => ({ value })),
          }),
          semanticRevision: "testing-transforms-v1",
        },
      },
      async (_ctx, input) => ({ value: input.value }),
    );

    const result = await runWorkflow(transformed, {
      input: "raw-input",
      taskSeeds: [
        {
          title: "Seed",
          description: "Seed transformed task data",
          extensions: { code: "ABC" },
        },
      ],
    });

    expect(result.output).toEqual({ value: "raw-input" });
    expect(result.tasks.tasks[0]?.extensions).toEqual({ owner: "platform", code: { value: "ABC" } });
  });

  test("keeps only findings that survive refutation", async () => {
    const { output, journal, state, runId } = await runWorkflow(review, {
      input: { base: "main" },
      provider: reviewProvider(),
      git: changedSince,
    });

    expect(output.confirmed).toHaveLength(1);
    expect(output.confirmed[0]).toMatchObject({ file: "a.ts", line: 3, claim: "off-by-one" });
    expect(journal.steps({ kind: "agent" })).toHaveLength(2);
    expect(journal.step("refute:a.ts:3").prompt).toContain("Default real=false");

    expect(runId).toMatch(/^[0-9a-f]{8}$/);
    expect(state.status).toBe("complete");
    expect(journal.records.length).toBeGreaterThan(0);
    // The git fixture is journaled exactly like a real read.
    const gitStep = journal.steps({ kind: "git" })[0];
    expect(gitStep?.label).toBe("git.changedSince");
    expect(gitStep?.output).toEqual({ files: [{ path: "a.ts", status: "M" }] });
    // Phases carry through to the view.
    expect(journal.steps({ kind: "agent", phase: "Refute" }).map((s) => s.key)).toEqual(["refute:a.ts:3"]);
    expect(journal.steps({ kind: "agent", phase: "Review" })).toHaveLength(1);
  });

  test("a git fixture may be a function of the op args", async () => {
    const seen: unknown[] = [];
    const { output } = await runWorkflow(review, {
      input: { base: "release/2.0" },
      provider: reviewProvider(),
      git: {
        changedSince: (args) => {
          seen.push(args);
          return { files: [{ path: "a.ts", status: "M" }] };
        },
      },
    });
    expect(seen).toEqual([{ ref: "release/2.0" }]);
    expect(output.confirmed).toHaveLength(1);
  });

  test("binds task schemas independently for child workflows", async () => {
    const child = defineWorkflow(
      {
        id: "child-tasks",
        description: "observe child tasks",
        input: z.object({}),
        output: z.object({ count: z.number() }),
        tasks: {
          extensions: z.object({ lane: z.literal("child") }),
          semanticRevision: "child-lane-v1",
        },
      },
      async (ctx) => ({ count: (await ctx.tasks.observe({}, { key: "child:tasks" })).tasks.length }),
    );
    const parent = defineWorkflow(
      {
        id: "parent-tasks",
        description: "invoke child",
        input: z.object({}),
        output: z.object({ count: z.number() }),
        tasks: {
          extensions: z.object({ lane: z.literal("parent") }),
          semanticRevision: "parent-lane-v1",
        },
      },
      async (ctx) => (await ctx.workflow(child, {}, { key: "child" })) as { count: number },
    );

    await expect(runWorkflow(parent, { input: {} })).resolves.toMatchObject({ output: { count: 0 } });
  });

  test("journal.step() throws and lists the known keys", async () => {
    const { journal } = await runWorkflow(review, {
      input: { base: "main" },
      provider: reviewProvider(),
      git: changedSince,
    });
    expect(() => journal.step("nope")).toThrow(/no step with key "nope"/);
    expect(() => journal.step("nope")).toThrow(/review:a\.ts.*refute:a\.ts:3/);
  });

  test("journal.toJSON() is snapshot-stable across runs", async () => {
    const run = () =>
      runWorkflow(review, { input: { base: "main" }, provider: reviewProvider(), git: changedSince });
    const first = await run();
    const second = await run();
    expect(first.runId).not.toBe(second.runId);
    expect(first.journal.toJSON()).toEqual(second.journal.toJSON());
    expect(first.journal.toJSON()).toMatchSnapshot();
  });

  test("a fixture that violates the step schema fails with the schema error", async () => {
    const counter = defineWorkflow(
      {
        name: "counter",
        description: "a single typed step",
        input: z.object({}),
        output: z.object({ n: z.number() }),
      },
      async (ctx) => ctx.agent("count the files", { schema: z.object({ n: z.number() }), key: "count" }),
    );

    const failure = await runWorkflow(counter, {
      input: {},
      provider: mock().on({ key: "count" }, { n: "seven" }),
    }).then(
      () => undefined,
      (err: unknown) => err,
    );

    expect(failure).toBeInstanceOf(StepError);
    const err = failure as StepError;
    expect(err.code).toBe("schema_repair_exhausted");
    expect(err.message).toMatch(/schema repair exhausted/);
    expect(err.step.key).toBe("count");
  });

  test("an un-fixtured agent step fails loudly", async () => {
    const counter = defineWorkflow(
      {
        name: "bare",
        description: "no fixtures at all",
        input: z.object({}),
        output: z.object({ n: z.number() }),
      },
      async (ctx) => ctx.agent("count", { schema: z.object({ n: z.number() }), key: "count" }),
    );
    await expect(runWorkflow(counter, { input: {} })).rejects.toThrow(/no fixture matches/);
  });
});

// ---------------------------------------------------------------------------
// Human requests
// ---------------------------------------------------------------------------

const ship = defineWorkflow(
  {
    name: "ship",
    description: "ask a human before shipping",
    input: z.object({}),
    output: z.object({ approved: z.boolean(), channel: z.string() }),
  },
  async (ctx) => {
    const gate = await ctx.human.approve({ action: "publish the release" });
    const answer = await ctx.human.ask({
      question: "which channel?",
      schema: z.object({ channel: z.string() }),
    });
    return { approved: gate.approved, channel: answer.channel };
  },
);

describe("human answers", () => {
  test("answers auto-answer an approve gate by question", async () => {
    const { output, journal, state } = await runWorkflow(ship, {
      input: {},
      answers: { "publish the release": { approved: true }, "which channel?": { channel: "stable" } },
    });
    expect(output).toEqual({ approved: true, channel: "stable" });
    expect(state.humans.map((h) => h.status)).toEqual(["answered", "answered"]);
    expect(journal.steps({ kind: "human" }).map((s) => s.label)).toEqual([
      "publish the release",
      "which channel?",
    ]);
    expect(journal.step("h1").output).toEqual({ approved: true });
  });

  test("answers may be keyed by request id, or be a function of the request", async () => {
    const byId = await runWorkflow(ship, {
      input: {},
      answers: { h1: { approved: false }, h2: { channel: "beta" } },
    });
    expect(byId.output).toEqual({ approved: false, channel: "beta" });

    const byFn = await runWorkflow(ship, {
      input: {},
      answers: (req) => (req.kind === "approve" ? { approved: true } : { channel: "canary" }),
    });
    expect(byFn.output).toEqual({ approved: true, channel: "canary" });
  });

  test("an unanswered request names the question instead of hanging", async () => {
    await expect(
      runWorkflow(ship, { input: {}, answers: { "publish the release": { approved: true } } }),
    ).rejects.toThrow("runWorkflow: unanswered human request: which channel? - provide it via opts.answers");
  });

  test("a run blocked on a signal reports the signal it is waiting for", async () => {
    const waiter = defineWorkflow(
      {
        name: "waiter",
        description: "blocks on an external signal",
        input: z.object({}),
        output: z.object({ got: z.string() }),
      },
      async (ctx) => ({ got: (await ctx.signal("deploy", z.object({ sha: z.string() }))).sha }),
    );
    await expect(runWorkflow(waiter, { input: {} })).rejects.toThrow(/waiting for signal:deploy/);

    const delivered = await runWorkflow(waiter, {
      input: {},
      signals: { deploy: { sha: "abc123" } },
    });
    expect(delivered.output).toEqual({ got: "abc123" });
    expect(delivered.journal.steps({ kind: "signal" })[0]?.output).toEqual({ sha: "abc123" });
  });

  test("task seeds are validated and the final task snapshot is returned", async () => {
    const taskWorkflow = defineWorkflow(
      {
        id: "testing-task-fixtures",
        description: "update a seeded task",
        input: z.object({}),
        output: z.object({ count: z.number() }),
        tasks: {
          extensions: z.object({ lane: z.enum(["api", "ui"]) }),
          semanticRevision: "lane-v1",
        },
      },
      async (ctx) => {
        const before = await ctx.tasks.observe({}, { key: "tasks:before" });
        await ctx.tasks.update(
          before.tasks[0]!.id,
          { status: "in_progress", extensions: { lane: "ui" } },
          { key: "tasks:update" },
        );
        return { count: before.tasks.length };
      },
    );

    const result = await runWorkflow(taskWorkflow, {
      input: {},
      taskSeeds: [
        {
          id: "task-1234abcd",
          title: "Seeded work",
          description: "Available before the first workflow step",
          extensions: { lane: "api" },
        },
      ],
    });

    expect(result.output).toEqual({ count: 1 });
    expect(result.tasks.tasks[0]).toMatchObject({
      id: "task-1234abcd",
      status: "in_progress",
      extensions: { lane: "ui" },
    });
  });

  test("concise task upsert converges an existing deduplicated task on set", async () => {
    const taskWorkflow = defineWorkflow(
      {
        id: "concise-task-upsert",
        description: "refresh a recurring task without duplicate create/update objects",
        input: z.object({}),
        output: z.object({}),
      },
      async (ctx) => {
        await ctx.tasks.upsert({
          dedupeKey: "review:auth",
          key: "tasks:record",
          set: {
            title: "Review authentication",
            description: "Current review summary",
            status: "done",
            relatedFiles: ["src/auth.ts"],
          },
          note: "Review completed.",
        });
        return {};
      },
    );

    const result = await runWorkflow(taskWorkflow, {
      input: {},
      taskSeeds: [
        {
          id: "task-1234abcd",
          dedupeKey: "review:auth",
          title: "Old title",
          description: "Old summary",
          status: "blocked",
        },
      ],
    });

    expect(result.tasks.tasks[0]).toMatchObject({
      id: "task-1234abcd",
      dedupeKey: "review:auth",
      title: "Review authentication",
      description: "Current review summary",
      status: "done",
      relatedFiles: ["src/auth.ts"],
      latestNote: expect.objectContaining({ text: "Review completed." }),
    });
  });
});

// ---------------------------------------------------------------------------
// Side-effect fixtures
// ---------------------------------------------------------------------------

const effects = defineWorkflow(
  {
    name: "effects",
    description: "exercise every stubbed side effect",
    input: z.object({}),
    output: z.object({ version: z.string(), greeting: z.string(), status: z.number(), token: z.string() }),
  },
  async (ctx) => {
    const version = await ctx.exec("node", ["--version"]);
    const greeting = await ctx.bash("echo hello");
    const health = await ctx.fetch("https://api.example.test/health");
    const token = await ctx.env.get("WEFT_TOKEN");
    return {
      version: version.stdout.trim(),
      greeting: greeting.stdout.trim(),
      status: health.status,
      token: token ?? "(unset)",
    };
  },
);

describe("side-effect fixtures", () => {
  test("exec/bash/fetch/env records round-trip through the journal", async () => {
    const { output, journal } = await runWorkflow(effects, {
      input: {},
      exec: { "node --version": { exitCode: 0, stdout: "v22.12.0\n", stderr: "" } },
      bash: { "echo hello": { exitCode: 0, stdout: "hello\n", stderr: "" } },
      fetch: {
        "https://api.example.test/health": {
          status: 200,
          headers: { "content-type": "application/json" },
          body: '{"ok":true}',
        },
      },
      env: { WEFT_TOKEN: "t0ken" },
    });

    expect(output).toEqual({ version: "v22.12.0", greeting: "hello", status: 200, token: "t0ken" });
    expect(journal.steps({ kind: "exec" })[0]?.output).toEqual({
      exitCode: 0,
      stdout: "v22.12.0\n",
      stderr: "",
    });
    expect(journal.steps({ kind: "bash" })[0]?.output).toMatchObject({ stdout: "hello\n" });
    expect(journal.steps({ kind: "fetch" })[0]?.output).toMatchObject({ status: 200 });
    expect(journal.steps({ kind: "env" })[0]?.output).toEqual({ value: "t0ken" });
  });

  test("fixture tables accept globs and functions", async () => {
    const { output } = await runWorkflow(effects, {
      input: {},
      exec: (file, args) =>
        file === "node" ? { exitCode: 0, stdout: `${args.join(" ")} ok\n`, stderr: "" } : undefined,
      bash: { "echo *": { exitCode: 0, stdout: "globbed\n", stderr: "" } },
      fetch: (url, method) => ({ status: 204, headers: { "x-url": url, "x-method": method }, body: "" }),
      env: {},
    });
    expect(output).toEqual({
      version: "--version ok",
      greeting: "globbed",
      status: 204,
      token: "(unset)",
    });
  });

  test("a fetch fixture keyed by method and url is used, and a schema still validates it", async () => {
    const typed = defineWorkflow(
      {
        name: "typed-fetch",
        description: "fetch with a schema",
        input: z.object({}),
        output: z.object({ ok: z.boolean() }),
      },
      async (ctx) => ctx.fetch("https://api.example.test/state", { schema: z.object({ ok: z.boolean() }) }),
    );
    const { output } = await runWorkflow(typed, {
      input: {},
      fetch: {
        "GET https://api.example.test/state": { status: 200, headers: {}, body: '{"ok":true}' },
      },
    });
    expect(output).toEqual({ ok: true });
  });

  test("opts.cwd, budget, and config reach the engine", async () => {
    const introspect = defineWorkflow(
      {
        name: "introspect",
        description: "reports the run environment",
        input: z.object({}),
        output: z.object({ cwd: z.string(), remainingTokens: z.number(), model: z.string() }),
      },
      async (ctx) => {
        const routed = await ctx.agent.detailed("hello", {
          schema: z.object({ ok: z.boolean() }),
          key: "hi",
        });
        return {
          cwd: ctx.run.cwd,
          remainingTokens: ctx.budget.remaining.tokens ?? -1,
          model: routed.value.ok ? "seen" : "unseen",
        };
      },
    );
    const cwd = await tempDir("weft-cwd-");
    const provider = mock().on({ key: "hi" }, { ok: true });
    const { output, journal } = await runWorkflow(introspect, {
      input: {},
      cwd,
      provider,
      budget: { tokens: 10_000 },
      config: { defaults: { model: "claude-haiku-4-5" } },
    });
    expect(output.cwd).toBe(cwd);
    // The budget ceiling is live: the mock's default 100 in / 50 out is already charged.
    expect(output.remainingTokens).toBe(9_850);
    expect(output.model).toBe("seen");
    expect(journal.step("hi").route).toMatchObject({ provider: "claude", model: "claude-haiku-4-5" });
    expect(provider.calls[0]!.cwd).toBe(cwd);
  });

  test("materializes filesystem fixtures and loads a checked config fixture", async () => {
    const inspect = defineWorkflow(
      {
        name: "fixture-files",
        description: "read a seeded file and route through fixture config",
        input: z.object({}),
        output: z.object({ content: z.string() }),
      },
      async (ctx) => {
        const file = await ctx.fs.read("src/message.txt");
        await ctx.agent("configured", { key: "configured", schema: z.object({ ok: z.boolean() }) });
        return { content: file.content };
      },
    );
    const provider = mock().on({ key: "configured" }, { ok: true });
    const result = await runWorkflow(inspect, {
      input: {},
      provider,
      fs: {
        "src/message.txt": "hello from fixture\n",
        ".weft/test-config.json": JSON.stringify({ defaults: { model: "claude-haiku-4-5" } }),
      },
      config: { path: ".weft/test-config.json" },
    });

    expect(result.output).toEqual({ content: "hello from fixture\n" });
    expect(await readFile(join(result.cwd, "src/message.txt"), "utf8")).toBe("hello from fixture\n");
    expect(result.journal.step("configured").route?.model).toBe("claude-haiku-4-5");
  });

  test("sequence composes stable item keys, phases, and explicit response sequences", async () => {
    const workflow = defineWorkflow(
      {
        name: "sequence-dx",
        description: "run stable item stages sequentially",
        input: z.object({}),
        output: z.object({ values: z.array(z.string()), after: z.string() }),
      },
      async (ctx) => {
        const values = await ctx.sequence(
          ["auth", "billing"],
          { key: "module", keyOf: (item) => item, phase: (item) => `Review ${item}` },
          async (_item, item) => {
            const response = await item.ctx.agent("review", {
              key: item.key("review"),
              schema: z.object({ value: z.string() }),
            });
            return response.value;
          },
        );
        const after = await ctx.agent("after", {
          key: "after-sequence",
          schema: z.object({ value: z.string() }),
        });
        return { values, after: after.value };
      },
    );
    const provider = mock()
      .on({ key: "module:*:review" }, fixture.sequence([{ value: "auth-ok" }, { value: "billing-ok" }]))
      .on({ key: "after-sequence" }, { value: "done" });
    const result = await runWorkflow(workflow, { input: {}, provider });

    expect(result.output.values).toEqual(["auth-ok", "billing-ok"]);
    expect(result.output.after).toBe("done");
    expect(result.journal.step("module:auth:review").phase).toBe("Review auth");
    expect(result.journal.step("module:billing:review").phase).toBe("Review billing");
    expect(result.journal.ran("module:auth:review")).toBe(true);
    expect(result.journal.neverRan("module:other:review")).toBe(true);
    expect(result.journal.step("module:auth:review").payload).toMatchObject({ prompt: "review" });
    expect(result.journal.step("after-sequence").phase).toBeUndefined();
  });

  test("sequence rejects duplicate item identity before dispatching any effect", async () => {
    const provider = mock().on({ key: "*" }, { ok: true });
    const workflow = defineWorkflow(
      {
        name: "duplicate-sequence",
        description: "fail before running an ambiguous sequence",
        input: z.object({}),
        output: z.object({}),
      },
      async (ctx) => {
        await ctx.sequence(
          ["same", "same"],
          { key: "duplicate", keyOf: (item) => item },
          async (_item, scope) => {
            await scope.ctx.agent("never", {
              key: scope.key("agent"),
              schema: z.object({ ok: z.boolean() }),
            });
          },
        );
        return {};
      },
    );

    await expect(runWorkflow(workflow, { input: {}, provider })).rejects.toThrow(/duplicate item key/);
    expect(provider.calls).toHaveLength(0);
  });

  test("strict mocks fail when a read-only fixture tries to write", async () => {
    const provider = mock({ strict: true }).on(
      { key: "read-only" },
      { ok: true },
      { writes: { "src/changed.ts": "changed\n" } },
    );
    const workflow = defineWorkflow(
      {
        name: "strict-read-only",
        description: "a read-only agent cannot mutate fixtures",
        input: z.object({}),
        output: z.object({}),
      },
      async (ctx) => {
        await ctx.agent("inspect", { key: "read-only", schema: z.object({ ok: z.boolean() }) });
        return {};
      },
    );

    await expect(runWorkflow(workflow, { input: {}, provider })).rejects.toThrow(
      /fixture attempted writes in a read-only step/,
    );
  });

  test("strict mocks reject out-of-scope and protected writes before touching the fixture tree", async () => {
    const cwd = await tempDir("weft-strict-scope-");
    const request: AgentRequest = {
      prompt: "change one file",
      key: "write",
      label: "write",
      cwd,
      schema: { type: "object" },
      tools: { allowEdits: true },
      writeScope: { paths: ["src/**"], mode: "strict" },
      protectedPaths: [join(cwd, "src", "protected")],
      hitl: {
        onPermission: async () => ({ behavior: "allow" }),
        onAsk: async () => ({}),
      },
    };
    const control = { signal: new AbortController().signal };

    const outside = mock({ strict: true })
      .on({ key: "write" }, { ok: true }, { writes: { "docs/outside.md": "no\n" } })
      .provider("claude");
    await expect(outside.run(request, control)).rejects.toThrow(/outside the declared scope/);

    const protectedWrite = mock({ strict: true })
      .on({ key: "write" }, { ok: true }, { writes: { "src/protected/state.json": "no\n" } })
      .provider("claude");
    await expect(protectedWrite.run(request, control)).rejects.toThrow(/targets protected path/);
    await expect(readFile(join(cwd, "docs/outside.md"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(join(cwd, "src/protected/state.json"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  test("routes only the selected provider options and preflights required capabilities", async () => {
    const codex = mock({ profile: "codex" }).on({ key: "route" }, { ok: true });
    const routed = defineWorkflow(
      {
        name: "provider-options",
        description: "dispatch selected provider mechanics",
        input: z.object({}),
        output: z.object({}),
      },
      async (ctx) => {
        await ctx.agent("route", {
          key: "route",
          provider: "codex",
          providerOptions: {
            claude: { permissionMode: "dontAsk" },
            codex: { sandboxMode: "read-only", networkAccess: false, webSearch: "cached" },
          },
          providerRequirements: { structured: "native", sessionResume: true },
          schema: z.object({ ok: z.boolean() }),
        });
        return {};
      },
    );
    const result = await runWorkflow(routed, { input: {}, providers: { codex } });
    expect(codex.calls[0]?.providerOptions).toEqual({
      sandboxMode: "read-only",
      networkAccess: false,
      webSearch: "cached",
    });
    expect(result.journal.step("route").payload).toMatchObject({
      providerOptions: { sandboxMode: "read-only" },
      providerRequirements: { structured: "native", sessionResume: true },
    });

    const impossible = defineWorkflow(
      {
        name: "provider-preflight",
        description: "fail before a provider without a permission hook runs",
        input: z.object({}),
        output: z.object({}),
      },
      async (ctx) => {
        await ctx.agent("cannot run", {
          key: "needs-hook",
          provider: "codex",
          providerRequirements: { permissionHook: true },
          schema: z.object({ ok: z.boolean() }),
        });
        return {};
      },
    );
    const preflight = mock({ profile: "codex" }).on({ key: "needs-hook" }, { ok: true });
    await expect(runWorkflow(impossible, { input: {}, providers: { codex: preflight } })).rejects.toThrow(
      /required capability permissionHook is unavailable/,
    );
    expect(preflight.calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Conformance suites, run against both store implementations
// ---------------------------------------------------------------------------

journalStoreConformance("MemoryJournalStore", async () => ({ store: new MemoryJournalStore() }));

journalStoreConformance("FsJournalStore", async () => {
  const dir = await mkdtemp(join(tmpdir(), "weft-fs-journal-"));
  return {
    store: new FsJournalStore(join(dir, "runs")),
    cleanup: () => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }),
  };
});

blobStoreConformance("MemoryBlobStore", async () => ({ store: new MemoryBlobStore() }));

blobStoreConformance("FsBlobStore", async () => {
  const dir = await mkdtemp(join(tmpdir(), "weft-fs-blobs-"));
  return {
    store: new FsBlobStore(join(dir, "blobs")),
    cleanup: () => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }),
  };
});
