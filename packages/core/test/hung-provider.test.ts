/**
 * A provider that ignores its abort signal is a zombie the engine cannot kill. What it
 * must not do is keep the concurrency permit: with the default cap of min(16, cpus - 2),
 * a couple of unresponsive calls used to wedge the whole run past any timeout.
 */
import { defineWorkflow, z } from "@techery/weft-sdk";
import { mock, runWorkflow } from "@techery/weft-testing";
import { describe, expect, test } from "vitest";

const Value = z.object({ v: z.number() });

describe("a hung provider call", () => {
  test("times out and frees its slot for the rest of the fan-out", async () => {
    const wf = defineWorkflow(
      {
        name: "hung",
        description: "one unresponsive lane beside healthy ones",
        input: z.object({}),
        output: z.object({ ok: z.number(), failed: z.array(z.string()) }),
      },
      async (ctx) => {
        const settled = await ctx.parallel([
          ctx.agent("hangs forever", { schema: Value, key: "hang", timeout: "300ms" }),
          ...Array.from({ length: 4 }, (_, i) => ctx.agent(`healthy ${i}`, { schema: Value, key: `ok${i}` })),
        ]);
        return {
          ok: ctx.ok(settled).length,
          failed: settled.filter((s) => !s.ok).map((s) => (s.ok ? "" : s.error.code)),
        };
      },
    );

    const provider = mock()
      // Never settles and never observes the abort signal — the zombie case exactly.
      .on({ key: "hang" }, () => new Promise<never>(() => {}))
      .on({ key: "ok*" }, () => ({ v: 1 }));

    const { output } = await runWorkflow(wf, {
      input: {},
      provider,
      config: { limits: { concurrency: 2 } },
    });

    // Before the fix the four healthy lanes queued behind a permit the zombie never
    // released, and the workflow never returned.
    expect(output.failed).toEqual(["timeout"]);
    expect(output.ok).toBe(4);
  }, 20_000);
});
