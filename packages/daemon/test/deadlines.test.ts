import type { JournalRecord } from "@techery/weft-core";
import type { Weft } from "@techery/weft-host";
import { defineWorkflow, z } from "@techery/weft-sdk";
import { afterEach, expect, test, vi } from "vitest";
import { cleanupRepos, reopen, tempDir, testEngine } from "../../core/test/helpers.ts";
import { type DeadlineScheduler, nextDeadline, startDeadlineScheduler } from "../src/deadlines.ts";

const schedulers: DeadlineScheduler[] = [];
const engines: Array<{ shutdown(): Promise<void> }> = [];
afterEach(async () => {
  await Promise.all(schedulers.splice(0).map((scheduler) => scheduler.close()));
  await Promise.all(engines.splice(0).map((engine) => engine.shutdown()));
  await cleanupRepos();
});

function records(events: Array<JournalRecord["ev"]>): JournalRecord[] {
  return events.map((ev, i) => ({ ev, i, at: 100 + i * 10 }));
}

test("deadline projection retains original wait time and removes settled waits", () => {
  const scheduled = {
    type: "step.scheduled",
    seq: 1,
    kind: "sleep",
    hash: "h",
    payload: { ms: 500 },
  } as const;
  expect(nextDeadline(records([scheduled, { ...scheduled, originAt: 100 }]))).toBe(600);
  expect(nextDeadline(records([scheduled, scheduled]))).toBe(600);
  // A crash after timer.fired but before leaf completion must still wake the run.
  expect(nextDeadline(records([scheduled, { type: "timer.fired", seq: 1, deadline: 600 }]))).toBe(600);
  expect(
    nextDeadline(records([scheduled, { type: "step.completed", seq: 1, output: { firedAt: 600 } }])),
  ).toBeUndefined();
  expect(nextDeadline(records([{ ...scheduled, kind: "signal", timeoutMs: 75 }]))).toBe(175);
  expect(
    nextDeadline(
      records([scheduled, { type: "resume.blocked", source: "deadline-scheduler", reason: "changed" }]),
    ),
  ).toBeUndefined();
});

async function sleeping(ms = 150) {
  const cwd = await tempDir();
  const def = defineWorkflow(
    { name: "deadline", description: "restart timer", input: z.object({}), output: z.string() },
    async (ctx) => {
      await ctx.sleep(ms);
      return "awake";
    },
  );
  const registry = { get: async () => def, hashOf: async () => "bundle-v1" };
  const first = testEngine({ registry });
  const run = await first.engine.start(def, { input: {}, cwd, defHash: "bundle-v1" });
  void run.result.catch(() => undefined);
  await vi.waitFor(
    async () =>
      expect((await first.engine.state(run.runId)).steps.some((step) => step.kind === "sleep")).toBe(true),
    { interval: 1 },
  );
  await first.engine.shutdown();
  const second = reopen(first, { registry });
  engines.push(second.engine);
  const weft = { engine: second.engine, runsDir: cwd, config: {} } as unknown as Weft;
  return { ...second, weft, runId: run.runId, registry };
}

test("startup schedules a future durable sleep and resumes it without another request", async () => {
  const t = await sleeping();
  const scheduler = startDeadlineScheduler(t.weft, { intervalMs: 5 });
  schedulers.push(scheduler);
  await scheduler.scan();
  expect((await t.engine.state(t.runId)).status).toBe("executing");
  await vi.waitFor(async () => expect((await t.engine.state(t.runId)).status).toBe("complete"));
  expect((await t.engine.state(t.runId)).output).toBe("awake");
  const read = vi.spyOn(t.journal, "read");
  await scheduler.scan();
  await scheduler.scan();
  expect(read).not.toHaveBeenCalled();
});

test("closing scheduler disarms future wakeups", async () => {
  const t = await sleeping(100);
  const scheduler = startDeadlineScheduler(t.weft, { intervalMs: 5 });
  await scheduler.scan();
  await scheduler.close();
  await new Promise((resolve) => setTimeout(resolve, 130));
  expect((await t.engine.state(t.runId)).status).toBe("executing");
  expect(t.engine.isActive(t.runId)).toBe(false);
});

test("active runs are never scanned or resumed by the scheduler", async () => {
  const t = await sleeping(150);
  const handle = await t.engine.resume(t.runId, { mode: "strict" });
  void handle.result.catch(() => undefined);
  const read = vi.spyOn(t.journal, "read");
  const scheduler = startDeadlineScheduler(t.weft, { intervalMs: 5 });
  schedulers.push(scheduler);
  await scheduler.scan();
  expect(read).not.toHaveBeenCalled();
});

test("expired human timeout is recovered after host restart", async () => {
  const cwd = await tempDir();
  const def = defineWorkflow(
    { name: "human-deadline", description: "timeout", input: z.object({}), output: z.string() },
    async (ctx) => {
      return ctx.human.ask({
        question: "Reply",
        schema: z.string(),
        timeout: 60,
        onTimeout: { default: "expired" },
      });
    },
  );
  const registry = { get: async () => def, hashOf: async () => "bundle-v1" };
  const first = testEngine({ registry });
  const run = await first.engine.start(def, { input: {}, cwd, defHash: "bundle-v1" });
  void run.result.catch(() => undefined);
  expect((await run.outcome()).status).toBe("waiting_for_human");
  await first.engine.shutdown();
  await new Promise((resolve) => setTimeout(resolve, 80));
  const second = reopen(first, { registry });
  engines.push(second.engine);
  const scheduler = startDeadlineScheduler(
    { engine: second.engine, runsDir: cwd, config: {} } as unknown as Weft,
    { intervalMs: 5 },
  );
  schedulers.push(scheduler);
  await vi.waitFor(async () => expect((await second.engine.state(run.runId)).output).toBe("expired"));
});

async function suspendedChildDeadline(options: { nested?: boolean; timeout?: number } = {}) {
  const cwd = await tempDir();
  const child = defineWorkflow(
    { name: "deadline-child", description: "child timeout", input: z.object({}), output: z.string() },
    async (ctx) =>
      ctx.human.ask({
        question: "Reply to the child",
        schema: z.string(),
        timeout: options.timeout ?? 60_000,
        onTimeout: { default: "expired" },
      }),
  );
  const middle = defineWorkflow(
    { name: "deadline-middle", description: "nested timeout", input: z.object({}), output: z.string() },
    async (ctx) => ctx.workflow(child, {}, { key: "child" }),
  );
  const original = defineWorkflow(
    { name: "deadline-root", description: "root timeout", input: z.object({}), output: z.string() },
    async (ctx) => {
      await ctx.workflow(options.nested ? middle : child, {}, { key: "child" });
      return "original";
    },
  );
  // This original registry definition is the same source retained automatic resume
  // would load after a caller explicitly resumes with an edited definition.
  const registry = { get: async () => original, hashOf: async () => "bundle-v1" };
  const first = testEngine({ registry });
  engines.push(first.engine);
  const run = await first.engine.start(original, { input: {}, cwd, defHash: "bundle-v1" });
  void run.result.catch(() => undefined);
  let childId: string | undefined;
  await vi.waitFor(
    async () => {
      const waiting = (await first.engine.list()).find(
        (summary) => summary.workflow === "deadline-child" && summary.status === "waiting_for_human",
      );
      expect(waiting).toBeDefined();
      childId = waiting?.runId;
    },
    { interval: 1 },
  );
  await first.engine.shutdown();
  const second = reopen(first, { registry });
  engines.push(second.engine);
  return {
    ...second,
    runId: run.runId,
    childId: childId!,
    original,
    weft: { engine: second.engine, runsDir: cwd, config: {} } as unknown as Weft,
  };
}

test.each(["complete", "failed", "cancelled"] as const)(
  "an old child deadline never reopens a %s root",
  async (status) => {
    const t = await suspendedChildDeadline();
    if (status === "cancelled") {
      await t.engine.cancel(t.runId);
    } else {
      const edited = defineWorkflow(
        { name: "deadline-root", description: "edited root", input: z.object({}), output: z.string() },
        async () => {
          if (status === "failed") throw new Error("edited failure");
          return "edited";
        },
      );
      const resumed = await t.engine.resume(t.runId, {
        def: edited,
        defHash: "bundle-v2",
        mode: "edit-tolerant",
      });
      if (status === "failed") await expect(resumed.result).rejects.toThrow("edited failure");
      else expect(await resumed.result).toBe("edited");
    }
    await vi.waitFor(() => expect(t.engine.isActive(t.runId)).toBe(false), { interval: 1 });
    const before = await t.engine.state(t.runId);
    expect(before.status).toBe(status);
    expect((await t.engine.state(t.childId)).status).toBe("waiting_for_human");
    const resume = vi.spyOn(t.engine, "resume");
    const scheduler = startDeadlineScheduler(t.weft, { now: () => Date.now() + 60_000 });
    schedulers.push(scheduler);
    await scheduler.scan();
    expect(resume).not.toHaveBeenCalled();
    expect(await t.engine.state(t.runId)).toEqual(before);
  },
);

test("a replaced child step cannot wake a root waiting on a different deadline", async () => {
  const t = await suspendedChildDeadline();
  const edited = defineWorkflow(
    { name: "deadline-root", description: "edited root", input: z.object({}), output: z.string() },
    async (ctx) => {
      await ctx.sleep(120_000, { key: "new-root-deadline" });
      return "edited";
    },
  );
  const resumed = await t.engine.resume(t.runId, {
    def: edited,
    defHash: "bundle-v2",
    mode: "edit-tolerant",
  });
  void resumed.result.catch(() => undefined);
  await vi.waitFor(
    async () =>
      expect((await t.engine.state(t.runId)).steps.some((step) => step.key === "new-root-deadline")).toBe(
        true,
      ),
    { interval: 1 },
  );
  await t.engine.shutdown();
  const resume = vi.spyOn(t.engine, "resume");
  const scheduler = startDeadlineScheduler(t.weft, { now: () => Date.now() + 60_000 });
  schedulers.push(scheduler);
  await scheduler.scan();
  expect(resume).not.toHaveBeenCalled();
  expect((await t.engine.state(t.runId)).steps.at(-1)?.key).toBe("new-root-deadline");
});

test("a child deadline cannot wake through a cancelled intermediate ancestor", async () => {
  const t = await suspendedChildDeadline({ nested: true });
  const middleId = (await t.engine.state(t.childId)).parentRunId!;
  await t.engine.cancel(middleId);
  const resume = vi.spyOn(t.engine, "resume");
  const scheduler = startDeadlineScheduler(t.weft, { now: () => Date.now() + 60_000 });
  schedulers.push(scheduler);
  await scheduler.scan();
  expect(resume).not.toHaveBeenCalled();
  expect((await t.engine.state(middleId)).status).toBe("cancelled");
});

test("a current nested child deadline still resumes its root after restart", async () => {
  const t = await suspendedChildDeadline({ nested: true, timeout: 60 });
  const resume = vi.spyOn(t.engine, "resume");
  const scheduler = startDeadlineScheduler(t.weft, { intervalMs: 5 });
  schedulers.push(scheduler);
  await vi.waitFor(async () => expect((await t.engine.state(t.runId)).output).toBe("original"));
  expect(resume).toHaveBeenCalledWith(t.runId, expect.objectContaining({ mode: "strict" }));
  expect((await t.engine.state(t.childId)).output).toBe("expired");
});

test("changed executable identity becomes attention once instead of automatic edit-tolerant execution", async () => {
  const t = await sleeping(30);
  t.registry.hashOf = async () => "bundle-v2";
  await new Promise((resolve) => setTimeout(resolve, 50));
  const scheduler = startDeadlineScheduler(t.weft, { intervalMs: 5 });
  schedulers.push(scheduler);
  await scheduler.scan();
  const state = await t.engine.state(t.runId);
  expect(state.status).toBe("executing");
  expect(state.resumeBlocked?.reason).toContain("strict resume refused");
  expect(state.attention?.[0]?.title).toBe("Recovery required");
  await scheduler.scan();
  await scheduler.scan();
  const journal: JournalRecord[] = [];
  for await (const record of t.journal.read(t.runId)) journal.push(record);
  expect(journal.filter(({ ev }) => ev.type === "resume.blocked")).toHaveLength(1);
  expect(t.engine.isActive(t.runId)).toBe(false);
});
