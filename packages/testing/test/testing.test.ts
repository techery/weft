import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryBlobStore, MemoryJournalStore } from "@techery/weft-core";
import { defineWorkflow, StepError, z } from "@techery/weft-sdk";
import { FsBlobStore, FsJournalStore } from "@techery/weft-store-fs";
import { afterAll, describe, expect, test } from "vitest";
import { blobStoreConformance, journalStoreConformance } from "../src/conformance.ts";
import { mock, runWorkflow } from "../src/index.ts";

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
    const reviewed = ctx.ok(
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
    const verdicts = ctx.ok(
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
        tasks: { extensions: z.object({ lane: z.literal("child") }) },
      },
      async (ctx) => ({ count: (await ctx.tasks.observe({}, { key: "child:tasks" })).tasks.length }),
    );
    const parent = defineWorkflow(
      {
        id: "parent-tasks",
        description: "invoke child",
        input: z.object({}),
        output: z.object({ count: z.number() }),
        tasks: { extensions: z.object({ lane: z.literal("parent") }) },
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
