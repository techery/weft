/**
 * An abort is a request. A step that ignores it — a provider SDK with no cancellation, a
 * wedged subprocess — used to hang `cancel()` for as long as it kept running, so no
 * caller could get an answer and the projection never said the run was cancelled.
 */

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
