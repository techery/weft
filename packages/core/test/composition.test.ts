import type { JournalRecord } from "@techery/weft-core";
import { type Ctx, defineProcedure, defineWorkflow, z } from "@techery/weft-sdk";
import { execa } from "execa";
import { afterAll, expect, test } from "vitest";
import { reduceState } from "../src/projections.ts";
import { cleanupRepos, reopen, tempDir, tempRepo, testEngine } from "./helpers.ts";

afterAll(cleanupRepos);

async function records(t: ReturnType<typeof testEngine>, runId: string) {
  const result: JournalRecord[] = [];
  for await (const record of t.journal.read(runId)) result.push(record);
  return result;
}

test("keyed lanes reject duplicate semantic keys before any mapper starts", async () => {
  const dispatched: string[] = [];
  const def = defineWorkflow(
    { name: "duplicates", description: "test", input: z.object({}), output: z.array(z.string()) },
    (ctx) =>
      ctx.parallel.all(
        ["same", "same"],
        (item) => {
          dispatched.push(item);
          return item;
        },
        { key: "review", keyOf: (item) => item },
      ),
  );
  const t = testEngine();
  const handle = await t.engine.start(def, { input: {}, cwd: await tempDir() });
  await expect(handle.result).rejects.toThrow(/duplicate item key "same"/);
  expect(dispatched).toEqual([]);
});

test("all settles queued and in-flight lanes before throwing; settled keeps failures explicit", async () => {
  const finished: string[] = [];
  const def = defineWorkflow(
    { name: "settling", description: "test", input: z.object({}), output: z.array(z.boolean()) },
    async (ctx) => {
      await expect(
        ctx.parallel.all(
          ["bad", "slow", "queued"],
          async (item) => {
            if (item === "bad") throw new Error("review unavailable");
            await new Promise((resolve) => setTimeout(resolve, 5));
            finished.push(item);
            return item;
          },
          { key: "required", keyOf: (item) => item, concurrency: 2 },
        ),
      ).rejects.toThrow("review unavailable");
      expect(finished.sort()).toEqual(["queued", "slow"]);
      const results = await ctx.parallel.settled(
        ["bad", "good"],
        (item) => {
          if (item === "bad") throw new Error("optional unavailable");
          return item;
        },
        { key: "optional", keyOf: (item) => item },
      );
      return results.map((result) => result.ok);
    },
  );
  const t = testEngine();
  expect(await (await t.engine.start(def, { input: {}, cwd: await tempDir() })).result).toEqual([
    false,
    true,
  ]);
});

test("lane contexts isolate identical local keys and replay reordered items", async () => {
  const make = (items: string[]) =>
    defineWorkflow(
      { name: "lanes", description: "test", input: z.object({}), output: z.array(z.string()) },
      (ctx) =>
        ctx.parallel.all(
          items,
          async (item, lane) => {
            expect(lane.itemKey).toBe(item);
            // Both the passed lane and a captured caller context remain in this lane's namespace.
            const first = await lane.agent(item, { key: "first", schema: z.object({ value: z.string() }) });
            const second = await ctx.agent(item, { key: "second", schema: z.object({ value: z.string() }) });
            return `${first.value}:${second.value}`;
          },
          { key: "review", keyOf: (item) => item, concurrency: 2 },
        ),
    );
  const t = testEngine();
  t.builder.on({ key: "review/*" }, (req) => ({ value: req.key! }));
  const first = await t.engine.start(make(["a", "b"]), { input: {}, cwd: await tempDir() });
  expect(await first.result).toEqual(["review/a/first:review/a/second", "review/b/first:review/b/second"]);
  const resumed = reopen(t);
  const next = await resumed.engine.resume(first.runId, { def: make(["b", "a"]) });
  expect(await next.result).toEqual(["review/b/first:review/b/second", "review/a/first:review/a/second"]);
  expect(resumed.builder.calls).toHaveLength(0);
});

test("procedures re-enter, replay leaves, and expose named timing without aggregate caching", async () => {
  let entered = 0;
  const review = defineProcedure({
    name: "Review",
    revision: "v1",
    input: z.string().trim(),
    output: z.string(),
    requires: ["agent"],
    run: async (ctx: Pick<Ctx, "agent">, item) => {
      entered++;
      return (await ctx.agent(item, { key: "inspect", schema: z.object({ value: z.string() }) })).value;
    },
  });
  const def = defineWorkflow(
    { name: "procedures", description: "test", input: z.object({}), output: z.array(z.string()) },
    async (ctx) => [
      await ctx.procedure(review, " a ", { key: "a" }),
      await ctx.procedure(review, " b ", { key: "b" }),
    ],
  );
  const t = testEngine();
  t.builder.on({ key: "*/inspect" }, (req) => ({ value: req.key! }));
  const handle = await t.engine.start(def, { input: {}, cwd: await tempDir() });
  expect(await handle.result).toEqual(["a/inspect", "b/inspect"]);
  const resumed = reopen(t);
  expect(await (await resumed.engine.resume(handle.runId, { def })).result).toEqual([
    "a/inspect",
    "b/inspect",
  ]);
  expect(entered).toBe(4);
  expect(resumed.builder.calls).toHaveLength(0);
  const trace = reduceState(await records(resumed, handle.runId));
  expect(trace.procedures).toHaveLength(4);
  expect(
    trace.procedures?.every(
      (entry) => entry.name === "Review" && entry.status === "complete" && entry.durationMs !== undefined,
    ),
  ).toBe(true);
});

test("changed procedure revision invalidates leaves even when parent body and leaf payload are unchanged", async () => {
  const make = (revision: string) => {
    const review = defineProcedure({
      name: "review",
      revision,
      input: z.string(),
      output: z.string(),
      run: async (ctx: Pick<Ctx, "agent">, input) =>
        (await ctx.agent(input, { key: "leaf", schema: z.object({ value: z.string() }) })).value,
    });
    return defineWorkflow(
      { name: "revision", description: "test", input: z.object({}), output: z.string() },
      (ctx) => ctx.procedure(review, "stable", { key: "review" }),
    );
  };
  const t = testEngine();
  t.builder.on({ key: "review/leaf" }, { value: "old" });
  const handle = await t.engine.start(make("v1"), { input: {}, cwd: await tempDir() });
  expect(await handle.result).toBe("old");
  const resumed = reopen(t);
  resumed.builder.on({ key: "review/leaf" }, { value: "new" });
  expect(await (await resumed.engine.resume(handle.runId, { def: make("v2"), reuse: "key" })).result).toBe(
    "new",
  );
  expect(resumed.builder.calls).toHaveLength(1);
});

test("procedure resume executes leaf freshness verifiers and re-establishes a removed Git branch", async () => {
  let entered = 0;
  const prepare = defineProcedure({
    name: "prepare",
    revision: "v1",
    input: z.string(),
    output: z.boolean(),
    run: async (ctx: Pick<Ctx, "git">, branch) => {
      entered++;
      await ctx.git.branch.create(branch);
      return true;
    },
  });
  const def = defineWorkflow(
    { name: "verify-procedure", description: "test", input: z.object({}), output: z.boolean() },
    (ctx) => ctx.procedure(prepare, "prepared", { key: "prepare" }),
  );
  const cwd = await tempRepo();
  const t = testEngine();
  const handle = await t.engine.start(def, { input: {}, cwd });
  expect(await handle.result).toBe(true);
  await execa("git", ["branch", "-D", "prepared"], { cwd });
  const resumed = reopen(t);
  expect(await (await resumed.engine.resume(handle.runId, { def })).result).toBe(true);
  expect(entered).toBe(2);
  expect((await execa("git", ["show-ref", "--verify", "refs/heads/prepared"], { cwd })).exitCode).toBe(0);
});

test("human request keys stay distinct inside concurrent lanes", async () => {
  const def = defineWorkflow(
    { name: "lane-humans", description: "test", input: z.object({}), output: z.array(z.boolean()) },
    (ctx) =>
      ctx.parallel.all(
        ["a", "b"],
        async (_, lane) => (await lane.human.approve({ key: "approve", action: "Ready?" })).approved,
        { key: "review", keyOf: (item) => item },
      ),
  );
  const t = testEngine();
  const handle = await t.engine.start(def, { input: {}, cwd: await tempDir() });
  const outcome = await handle.outcome();
  expect(outcome.status).toBe("waiting_for_human");
  if (outcome.status !== "waiting_for_human") throw new Error("expected suspension");
  const pending = (await records(t, handle.runId)).filter((record) => record.ev.type === "human.requested");
  expect(pending.map((record) => record.ev.type === "human.requested" && record.ev.key).sort()).toEqual([
    "review/a/approve",
    "review/b/approve",
  ]);
  for (const record of pending)
    if (record.ev.type === "human.requested")
      await t.engine.answer(handle.runId, record.ev.id, { approved: true });
  expect(await handle.result).toEqual([true, true]);
});

test("captured defaults handles cannot escape a nested procedure namespace", async () => {
  const def = defineWorkflow(
    { name: "captured-scope", description: "test", input: z.object({}), output: z.array(z.string()) },
    async (ctx) => {
      const defaults = ctx.scope({ agent: { provider: "claude" } });
      const inner = defineProcedure({
        name: "inner",
        revision: "v1",
        input: z.string(),
        output: z.string(),
        run: async (_ctx: Pick<Ctx, "agent">, item) =>
          (await defaults.agent(item, { key: "inspect", schema: z.object({ value: z.string() }) })).value,
      });
      const outer = defineProcedure({
        name: "outer",
        revision: "v1",
        input: z.string(),
        output: z.string(),
        run: (ctx: Ctx, item) => ctx.procedure(inner, item, { key: "inner" }),
      });
      return [await ctx.procedure(outer, "a", { key: "a" }), await ctx.procedure(outer, "b", { key: "b" })];
    },
  );
  const t = testEngine();
  t.builder.on({ key: "*/inner/inspect" }, (req) => ({ value: req.key! }));
  const handle = await t.engine.start(def, { input: {}, cwd: await tempDir() });
  expect(await handle.result).toEqual(["a/inner/inspect", "b/inner/inspect"]);
});

test("keyed fan-out rejects an unsettled eager promise without waiting", async () => {
  const def = defineWorkflow(
    { name: "reject-eager", description: "test", input: z.object({}), output: z.array(z.string()) },
    (ctx) =>
      // @ts-expect-error Eager promises are rejected statically and by the runtime for JS callers.
      ctx.parallel.all([new Promise<string>(() => {})], () => "unexpected", {
        key: "eager",
        keyOf: () => "item",
      }),
  );
  const t = testEngine();
  const handle = await t.engine.start(def, { input: {}, cwd: await tempDir() });
  await expect(handle.result).rejects.toThrow(/already-started promises/);
});

test("owned workspace capabilities remain callable through lanes and procedures when frozen", async () => {
  const def = defineWorkflow(
    {
      name: "workspace-lanes",
      description: "test",
      input: z.object({}),
      output: z.array(z.string()),
      workspace: { branch: "composition-workspace" },
    },
    async (ctx) => {
      const capture = defineProcedure({
        name: "capture",
        revision: "v1",
        input: z.string(),
        output: z.string(),
        run: async (ctx: Ctx) => {
          expect(Object.keys(ctx)).toContain("workspace");
          expect(ctx.workspace).toBeDefined();
          return (await ctx.workspace!.snapshot({ key: "snapshot" })).head;
        },
      });
      return ctx.parallel.all(["a", "b"], (item, lane) => lane.procedure(capture, item, { key: "capture" }), {
        key: "lanes",
        keyOf: (item) => item,
      });
    },
  );
  const t = testEngine();
  const handle = await t.engine.start(def, { input: {}, cwd: await tempRepo() });
  const output = (await handle.result) as string[];
  expect(output).toHaveLength(2);
  expect(output[0]).toBe(output[1]);
  const scheduled = (await records(t, handle.runId)).filter((record) => record.ev.type === "step.scheduled");
  expect(scheduled.map((record) => record.ev.type === "step.scheduled" && record.ev.key)).toEqual(
    expect.arrayContaining(["lanes/a/capture/snapshot", "lanes/b/capture/snapshot"]),
  );
});
