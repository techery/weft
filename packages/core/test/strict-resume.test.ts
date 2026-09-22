import { type JournalEvent, MemoryJournalStore } from "@techery/weft-core";
import { defineWorkflow, z } from "@techery/weft-sdk";
import { afterAll, expect, test, vi } from "vitest";
import { sha256Hex } from "../src/canonical.ts";
import { cleanupRepos, reopen, tempDir, testEngine } from "./helpers.ts";

afterAll(cleanupRepos);
const make = (value: string) =>
  defineWorkflow(
    { name: "strict", description: "test", input: z.object({}), output: z.string() },
    async (ctx) => {
      await ctx.now();
      return value;
    },
  );

test("strict resume accepts matching bundle identity and refuses dependency changes before journal writes", async () => {
  const t = testEngine();
  const def = make("old");
  const run = await t.engine.start(def, { input: {}, cwd: await tempDir(), defHash: "bundle-v1" });
  await run.result;
  const resumed = reopen(t);
  expect(
    await (await resumed.engine.resume(run.runId, { def, defHash: "bundle-v1", mode: "strict" })).result,
  ).toBe("old");
  const before: unknown[] = [];
  for await (const rec of t.journal.read(run.runId)) before.push(rec);
  await expect(
    reopen(t).engine.resume(run.runId, { def: make("new"), defHash: "bundle-v2", mode: "strict" }),
  ).rejects.toThrow(/strict resume refused a changed workflow/);
  const after: unknown[] = [];
  for await (const rec of t.journal.read(run.runId)) after.push(rec);
  expect(after).toEqual(before);
  expect(
    await (
      await reopen(t).engine.resume(run.runId, {
        def: make("new"),
        defHash: "bundle-v2",
        mode: "edit-tolerant",
      })
    ).result,
  ).toBe("new");
});

test("strict mode refuses absent bundle provenance and key-only salvage", async () => {
  const t = testEngine();
  const def = make("value");
  const run = await t.engine.start(def, { input: {}, cwd: await tempDir() });
  await run.result;
  await expect(reopen(t).engine.resume(run.runId, { def, mode: "strict" })).rejects.toThrow(
    /recorded and current executable bundle/,
  );
  await expect(reopen(t).engine.resume(run.runId, { def, mode: "strict", reuse: "key" })).rejects.toThrow(
    /key reuse is edit-tolerant only/,
  );
});

test.each([false, true])(
  "unnamed workflow replay preserves repeated step results with legacy hash=%s",
  async (legacy) => {
    const def = defineWorkflow(
      { description: "unnamed replay", input: z.object({}), output: z.array(z.string()) },
      async (ctx) => [
        (await ctx.agent("same question", { schema: z.object({ tag: z.string() }) })).tag,
        (await ctx.agent("same question", { schema: z.object({ tag: z.string() }) })).tag,
      ],
    );
    const first = testEngine();
    first.builder.on({}, { tag: "recorded" });
    const run = await first.engine.start(def, { input: {}, cwd: await tempDir(), defHash: "bundle-v1" });
    expect(await run.result).toEqual(["recorded", "recorded"]);
    await first.engine.shutdown();
    let journal = first.journal;
    if (legacy) {
      journal = new MemoryJournalStore();
      const events: JournalEvent[] = [];
      for await (const { ev } of first.journal.read(run.runId))
        events.push(
          ev.type === "run.created"
            ? { ...ev, workflow: { ...ev.workflow, bodyHash: sha256Hex(`\n${def.run.toString()}`) } }
            : ev,
        );
      await journal.append(run.runId, events);
    }
    const resumed = reopen({ ...first, journal });
    const preview = await resumed.engine.replayDry(run.runId, { def, defHash: "bundle-v1" });
    expect(preview).toMatchObject({ completed: true, hits: 2, diverged: [] });
    for (const mode of ["strict", "edit-tolerant"] as const) {
      expect(
        await (await resumed.engine.resume(run.runId, { def, defHash: "bundle-v1", mode })).result,
      ).toEqual(["recorded", "recorded"]);
      await vi.waitFor(() => expect(resumed.engine.isActive(run.runId)).toBe(false), { interval: 1 });
    }
    expect(resumed.builder.calls).toHaveLength(0);
  },
);

test("strict parent resume reuses steps in an id-only child", async () => {
  const child = defineWorkflow(
    { id: "unnamed-child", description: "child replay", input: z.object({}), output: z.array(z.string()) },
    async (ctx) => {
      const values = [
        (await ctx.agent("same question", { schema: z.object({ tag: z.string() }) })).tag,
        (await ctx.agent("same question", { schema: z.object({ tag: z.string() }) })).tag,
      ];
      await ctx.human.ask({ question: "Continue?", schema: z.string() });
      return values;
    },
  );
  const parent = defineWorkflow(
    { name: "parent", description: "parent replay", input: z.object({}), output: z.array(z.string()) },
    async (ctx) => ctx.workflow(child, {}, { key: "child" }),
  );
  const first = testEngine();
  first.builder.on({}, { tag: "recorded" });
  const run = await first.engine.start(parent, { input: {}, cwd: await tempDir(), defHash: "bundle-v1" });
  void run.result.catch(() => undefined);
  const outcome = await run.outcome();
  if (outcome.status !== "waiting_for_human") throw new Error("expected child request");
  await first.engine.shutdown();
  const resumed = reopen(first);
  const request = outcome.pending[0]!;
  await resumed.engine.answer(request.runId, request.id, { value: "continue" });
  expect(
    await (await resumed.engine.resume(run.runId, { def: parent, defHash: "bundle-v1", mode: "strict" }))
      .result,
  ).toEqual(["recorded", "recorded"]);
  expect(resumed.builder.calls).toHaveLength(0);
});

test.each(["complete", "failed", "cancelled"] as const)(
  "automatic resume refuses a run that becomes %s while its lease is acquired",
  async (status) => {
    let executions = 0;
    const def = defineWorkflow(
      { name: "automatic", description: "resume guard", input: z.object({}), output: z.string() },
      async (ctx) => {
        executions++;
        return ctx.human.ask({ question: "Reply", schema: z.string() });
      },
    );
    const first = testEngine();
    const run = await first.engine.start(def, { input: {}, cwd: await tempDir(), defHash: "bundle-v1" });
    void run.result.catch(() => undefined);
    expect((await run.outcome()).status).toBe("waiting_for_human");
    await first.engine.shutdown();
    const resumed = reopen(first);
    const acquireRun = first.journal.acquireRun.bind(first.journal);
    vi.spyOn(first.journal, "acquireRun").mockImplementationOnce(async (runId) => {
      const lease = await acquireRun(runId);
      const terminal: JournalEvent =
        status === "complete"
          ? { type: "run.completed", output: "finished elsewhere" }
          : status === "cancelled"
            ? { type: "run.cancelled" }
            : {
                type: "run.failed",
                error: { name: "StepError", code: "internal", message: "failed elsewhere", step: {} },
              };
      await first.journal.append(runId, [terminal]);
      return lease;
    });
    await expect(
      resumed.engine.resume(run.runId, {
        def,
        defHash: "bundle-v1",
        mode: "strict",
        nonterminalOnly: true,
      }),
    ).rejects.toMatchObject({ code: "invalid_input", detail: { reason: "run_terminal" } });
    expect(executions).toBe(1);
    expect((await resumed.engine.state(run.runId)).status).toBe(status);
    const nextLease = await first.journal.acquireRun(run.runId);
    expect(nextLease).toBeDefined();
    await nextLease?.release();
  },
);
