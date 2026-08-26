/**
 * An abort is a request. A step that ignores it — a provider SDK with no cancellation, a
 * wedged subprocess — used to hang `cancel()` for as long as it kept running, so no
 * caller could get an answer and the projection never said the run was cancelled.
 */

import type { JournalRecord } from "@techery/weft-core";
import { mock } from "@techery/weft-provider-mock";
import { defineWorkflow, z } from "@techery/weft-sdk";
import { afterAll, describe, expect, test } from "vitest";
import { cleanupRepos, tempDir, testEngine } from "./helpers.ts";

afterAll(cleanupRepos);

describe("cancel() against a non-cooperative step", () => {
  test("returns within the drain bound and records the cancellation", async () => {
    const def = defineWorkflow(
      { name: "wedged", description: "wedged", input: z.object({}), output: z.object({ v: z.number() }) },
      async (ctx) => ctx.agent("never settles", { schema: z.object({ v: z.number() }), key: "hang" }),
    );

    const t = testEngine({
      // Never settles and never observes the abort: the zombie case exactly.
      builder: mock().on({ key: "hang" }, () => new Promise<never>(() => undefined)),
    });
    const cwd = await tempDir();
    const h = await t.engine.start(def, { input: {}, cwd });
    h.result.catch(() => undefined);

    // Let the step get in flight.
    await new Promise((r) => setTimeout(r, 50));

    const started = Date.now();
    await t.engine.cancel(h.runId);
    const elapsed = Date.now() - started;

    // Bounded: a hang regression would sit here until the test timeout.
    expect(elapsed).toBeLessThan(15_000);

    const state = await t.engine.state(h.runId);
    expect(state.status).toBe("cancelled");

    // The execution is retired, not merely reported cancelled. `fence()` cannot settle
    // the promise `def.run` awaits, so both cleanup paths — which hang off it — would
    // otherwise never fire: the run would stay active, renew its claim forever, and
    // hand every later resume the same hung promise.
    expect(t.engine.isActive(h.runId)).toBe(false);
  }, 30_000);

  test("a journal that cannot record the cancellation reports failure, not success", async () => {
    // Past the bound the run is retired in-process whatever happens — the abort was
    // requested and the execution is unobservable. But "cancelled" MEANS the durable
    // record: if ENOSPC or EIO ate it, the journal still says `executing`, the retained
    // claim expires on its TTL, and the next process resumes and re-executes a run this
    // call reported as cancelled. Silent and unrecoverable; raised, the caller can retry.
    const def = defineWorkflow(
      { name: "wedged3", description: "wedged", input: z.object({}), output: z.object({ v: z.number() }) },
      async (ctx) => ctx.agent("never settles", { schema: z.object({ v: z.number() }), key: "hang" }),
    );
    const t = testEngine({
      builder: mock().on({ key: "hang" }, () => new Promise<never>(() => undefined)),
    });
    const cwd = await tempDir();
    const h = await t.engine.start(def, { input: {}, cwd });
    h.result.catch(() => undefined);
    await new Promise((r) => setTimeout(r, 50));

    // The volume goes away exactly when the terminal record is written.
    const journal = t.journal as unknown as { append: (...args: never[]) => Promise<unknown> };
    const realAppend = journal.append.bind(journal);
    journal.append = async () => {
      throw Object.assign(new Error("ENOSPC: no space left on device, write"), { code: "ENOSPC" });
    };

    await expect(t.engine.cancel(h.runId)).rejects.toThrow(/ENOSPC/);
    journal.append = realAppend;

    // Still retired: reporting the failure must not also leave a wedged entry behind.
    expect(t.engine.isActive(h.runId)).toBe(false);
  }, 30_000);

  test("a later resume is refused promptly, not handed the hung promise", async () => {
    const def = defineWorkflow(
      { name: "wedged2", description: "wedged", input: z.object({}), output: z.object({ v: z.number() }) },
      async (ctx) => ctx.agent("never settles", { schema: z.object({ v: z.number() }), key: "hang" }),
    );
    const t = testEngine({
      builder: mock().on({ key: "hang" }, () => new Promise<never>(() => undefined)),
    });
    const cwd = await tempDir();
    const h = await t.engine.start(def, { input: {}, cwd });
    h.result.catch(() => undefined);
    await new Promise((r) => setTimeout(r, 50));
    await t.engine.cancel(h.runId);

    // The claim is deliberately NOT released — the zombie may still be writing, and
    // handing the run to another executor while it does is worse than waiting out the
    // TTL (shutdown() takes the same position). So a resume is REFUSED, and that is the
    // correct outcome. What must not happen, and used to, is being handed the pending
    // promise of a run this engine still believes it is executing.
    await expect(
      Promise.race([
        t.engine.resume(h.runId, { def }),
        new Promise((_, reject) => setTimeout(() => reject(new Error("resume hung")), 5_000)),
      ]),
    ).rejects.toThrow(/active in another process/);
  }, 30_000);
});

describe("architecture review @ 627b28e — a terminal record never lands over live work", () => {
  const One = z.object({ n: z.number() });

  test("a rejecting fan-out lane does not let run.failed overtake its sibling's step", async () => {
    // `drive()` appended the terminal record and released the ownership claim as soon as
    // the BODY settled. A raw Promise.all whose fast lane rejects leaves the slow lane
    // running: it kept spending, kept appending to a journal that was already terminal,
    // and the freed claim let a second process resume and interleave into the same file.
    const t = testEngine();
    t.builder.on({ key: "slow" }, { n: 1 }, { delayMs: 300 });
    t.builder.on({ key: "fast" }, () => {
      throw new Error("provider exploded");
    });

    const def = defineWorkflow(
      { name: "race", description: "r", input: z.object({}), output: One },
      async (ctx) => {
        // Deliberately raw Promise.all, not ctx.parallel: the body settles on the
        // rejection while the other lane is still in flight.
        const [a] = await Promise.all([
          ctx.agent("slow", { schema: One, key: "slow" }),
          ctx.agent("fast", { schema: One, key: "fast" }),
        ]);
        return a;
      },
    );

    const h = await t.engine.start(def, { input: {}, cwd: await tempDir() });
    await expect(h.result).rejects.toBeTruthy();

    const recs: JournalRecord[] = [];
    for await (const rec of t.journal.read(h.runId)) recs.push(rec);
    const types = recs.map((r) => r.ev.type);
    const terminal = types.findIndex((tp) => tp === "run.failed" || tp === "run.completed");
    expect(terminal).toBeGreaterThanOrEqual(0);
    // Nothing from a step may appear after the run's terminal record.
    expect(types.slice(terminal + 1).filter((tp) => tp.startsWith("step."))).toEqual([]);

    // And the slow lane's own completion did land — it was waited for, not dropped.
    expect(types.filter((tp) => tp === "step.completed").length).toBeGreaterThanOrEqual(1);
  });
});
