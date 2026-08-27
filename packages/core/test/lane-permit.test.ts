/**
 * A concurrency permit bounds a whole fan-out lane, not just its model call. Held only
 * around the provider, every lane built its git worktree first and then queued: a wide
 * fan-out cut one full checkout per item to run a handful at a time.
 */
import { defineWorkflow, z } from "@techery/weft-sdk";
import { mock, runWorkflow } from "@techery/weft-testing";
import { describe, expect, test } from "vitest";

describe("fan-out concurrency", () => {
  test("no more lanes start work than the limit allows", async () => {
    let live = 0;
    let peak = 0;

    const wf = defineWorkflow(
      {
        name: "lanes",
        description: "eight lanes against a cap of two",
        input: z.object({}),
        output: z.object({ ok: z.number(), peak: z.number() }),
      },
      async (ctx) => {
        const settled = await ctx.parallel(
          Array.from({ length: 8 }, (_, i) =>
            ctx.agent(`work ${i}`, { schema: z.object({ v: z.number() }), key: `w${i}` }),
          ),
        );
        return { ok: ctx.successes(settled).length, peak };
      },
    );

    const provider = mock().on({ key: "w*" }, async () => {
      live++;
      peak = Math.max(peak, live);
      await new Promise((r) => setTimeout(r, 30));
      live--;
      return { v: 1 };
    });

    const { output } = await runWorkflow(wf, {
      input: {},
      provider,
      config: { limits: { concurrency: 2 } },
    });

    expect(output.ok).toBe(8);
    expect(output.peak).toBeLessThanOrEqual(2);
  }, 30_000);
});
