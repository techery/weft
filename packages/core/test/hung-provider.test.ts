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
          ok: ctx.successes(settled).length,
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

  test("under a budget, it frees its admission slot too", async () => {
    // The concurrency permit was only half of what a zombie holds. With a ceiling
    // configured, every dispatch also reserves an admission slot — and until the first
    // call is PRICED, admission lets exactly one through ("while an unpriced call is in
    // flight"). The reservation was handed back only by the attempt's `finally`, which a
    // promise that never settles never reaches: the pool kept a phantom in-flight call,
    // `wake()` never fired, and every other lane — including the timed-out step's own
    // retry — parked in reserveCall for good. A permanent hang, arriving with the fix
    // that made admission wait instead of refusing.
    const wf = defineWorkflow(
      {
        name: "hung-budget",
        description: "an unresponsive lane holding the only admission slot",
        input: z.object({}),
        output: z.object({ ok: z.number(), failed: z.array(z.string()) }),
      },
      async (ctx) => {
        const settled = await ctx.parallel([
          ctx.agent("hangs forever", { schema: Value, key: "hang", timeout: "300ms" }),
          ...Array.from({ length: 3 }, (_, i) => ctx.agent(`healthy ${i}`, { schema: Value, key: `ok${i}` })),
        ]);
        return {
          ok: ctx.successes(settled).length,
          failed: settled.filter((s) => !s.ok).map((s) => (s.ok ? "" : s.error.code)),
        };
      },
    );

    const provider = mock()
      .on({ key: "hang" }, () => new Promise<never>(() => {}))
      .on({ key: "ok*" }, () => ({ v: 1 }));

    const { output } = await runWorkflow(wf, {
      input: {},
      provider,
      // A ceiling generous enough that nothing is legitimately refused: the point is the
      // admission slot, not the money.
      budget: { tokens: 1_000_000 },
    });

    expect(output.failed).toEqual(["timeout"]);
    expect(output.ok).toBe(3);
  }, 20_000);
});
