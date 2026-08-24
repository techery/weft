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
  }, 30_000);
});
