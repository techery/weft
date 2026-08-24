/**
 * A budget ceiling is a SCHEDULING constraint, not an error.
 *
 * `Budget.reserveCall` used to refuse a call it could not immediately price, which meant
 * every cold-start fan-out under any ceiling lost N−1 lanes: nothing has charged yet, so
 * exactly one call fits and the rest were dropped with `budget_exceeded` at 0% of the
 * ceiling. `ctx.ok()` then swallowed them, and `adversarialVerify` — which counts a failed
 * refuter as a refute vote — inverted its verdict on every budgeted run.
 *
 * These tests pin both halves of the contract: no lane is lost while budget remains, and
 * the ceiling still stops the run rather than parking on it.
 */

import { defineWorkflow, z } from "@techery/weft-sdk";
import { adversarialVerify } from "@techery/weft-stdlib";
import { mock, runWorkflow } from "@techery/weft-testing";
import { describe, expect, test } from "vitest";

const Value = z.object({ v: z.number() });

const fanOut = (width: number) =>
  defineWorkflow(
    {
      name: "fanout",
      description: "parallel agents",
      input: z.object({}),
      output: z.object({ ok: z.number(), dropped: z.array(z.string()) }),
    },
    async (ctx) => {
      const settled = await ctx.parallel(
        Array.from({ length: width }, (_, i) => ctx.agent(`work ${i}`, { schema: Value, key: `w${i}` })),
      );
      return {
        ok: ctx.ok(settled).length,
        dropped: settled.filter((s) => !s.ok).map((s) => (s.ok ? "" : s.error.code)),
      };
    },
  );

/** Latency matters: instant responses hide the bug by charging before the next dispatch. */
const slowProvider = (usage?: { input: number; output: number }) =>
  mock().on({ key: "w*" }, () => ({ v: 1 }), { delayMs: 40, ...(usage ? { usage } : {}) });

describe("budgeted fan-out", () => {
  test("a ceiling with headroom loses no lanes", async () => {
    const width = 8;
    const { output } = await runWorkflow(fanOut(width), {
      input: {},
      budget: { usd: 500 },
      provider: slowProvider(),
    });
    expect(output.dropped).toEqual([]);
    expect(output.ok).toBe(width);
  }, 30_000);

  test("a token ceiling with headroom matches the unbudgeted result exactly", async () => {
    const width = 8;
    const budgeted = await runWorkflow(fanOut(width), {
      input: {},
      budget: { tokens: 10_000_000 },
      provider: slowProvider(),
    });
    const free = await runWorkflow(fanOut(width), { input: {}, provider: slowProvider() });
    expect(budgeted.output.ok).toBe(free.output.ok);
    expect(budgeted.output.ok).toBe(width);
  }, 30_000);

  test("the ceiling is still hard: it stops the run instead of parking on it", async () => {
    // 600 tokens a call against an 1800-token pool: three calls fit, the rest must not run.
    const started = Date.now();
    const { output } = await runWorkflow(fanOut(20), {
      input: {},
      budget: { tokens: 1_800 },
      provider: slowProvider({ input: 300, output: 300 }),
    });
    expect(output.ok).toBeGreaterThan(0);
    expect(output.ok).toBeLessThan(20);
    expect(output.dropped.every((code) => code === "budget_exceeded")).toBe(true);
    // A parked-forever regression would hit the test timeout instead.
    expect(Date.now() - started).toBeLessThan(20_000);
  }, 30_000);
});

describe("stdlib under a budget", () => {
  const claims = [{ id: 0 }, { id: 1 }, { id: 2 }, { id: 3 }];

  const verify = defineWorkflow(
    {
      name: "verify",
      description: "adversarialVerify over four claims",
      input: z.object({}),
      output: z.object({ survived: z.number(), refuted: z.number() }),
    },
    async (ctx) => {
      const out = await adversarialVerify(ctx, {
        claims,
        describe: (c) => `claim ${c.id}`,
        refuters: 3,
      });
      return { survived: out.survived.length, refuted: out.refuted.length };
    },
  );

  /** Every refuter honestly reports the claim holds; nothing may be refuted. */
  const honest = () =>
    mock().on({ key: "refute:*" }, () => ({ refuted: false, reason: "checked; it holds" }), {
      delayMs: 40,
    });

  test("a budget does not invert adversarialVerify", async () => {
    const budgeted = await runWorkflow(verify, {
      input: {},
      budget: { usd: 500 },
      provider: honest(),
    });
    const free = await runWorkflow(verify, { input: {}, provider: honest() });

    expect(budgeted.output).toEqual(free.output);
    expect(budgeted.output.survived).toBe(claims.length);
    expect(budgeted.output.refuted).toBe(0);
  }, 30_000);
});
