/**
 * Sub-workflows and real accounting (C8): child runs have their own journals and
 * typed boundaries; budgets are hard ceilings pooled across the whole run tree.
 *
 *   npx tsx examples/05-sub-workflows-and-budget/main.ts
 *
 * The parent verifies claims by fanning each one to a child workflow. The run
 * carries an 1,800-token ceiling and every mock agent call bills 600: three calls
 * spend the pool exactly, so the fourth is refused before it starts — the failure
 * lands in that child, surfaces as a per-branch error, and the parent returns
 * what it completed.
 */
import { Engine, MemoryBlobStore, MemoryJournalStore, ProviderRegistry } from "@weft/core";
import { mock } from "@weft/provider-mock";
import { defineWorkflow, z } from "@weft/sdk";

const verifyOne = defineWorkflow(
  {
    name: "verify-one",
    description: "One claim, one refuter",
    input: z.object({ claim: z.string() }),
    output: z.object({ claim: z.string(), real: z.boolean() }),
  },
  async (ctx, { claim }) => {
    const verdict = await ctx.agent(`Try to refute: ${claim}`, {
      schema: z.object({ real: z.boolean() }),
      key: `refute:${claim}`,
    });
    return { claim, real: verdict.real };
  },
);

const parent = defineWorkflow(
  {
    name: "verify-all",
    description: "Fan claims out to child runs under one shared budget pool",
    input: z.object({ claims: z.array(z.string()) }),
    output: z.object({
      verified: z.array(z.object({ claim: z.string(), real: z.boolean() })),
      skipped: z.array(z.string()),
      spentTokens: z.number(),
    }),
  },
  async (ctx, { claims }) => {
    const settled = await ctx.parallel(
      claims.map((claim) => () => ctx.workflow(verifyOne, { claim }, { key: `child:${claim}` })),
      { concurrency: 1 }, // serialize so the budget cliff is deterministic
    );
    const verified: Array<{ claim: string; real: boolean }> = [];
    const skipped: string[] = [];
    settled.forEach((s, i) => {
      if (s.ok) verified.push(s.value as { claim: string; real: boolean });
      else {
        ctx.log(`child for "${claims[i]}" failed: ${s.error.code}`);
        skipped.push(claims[i]!);
      }
    });
    return { verified, skipped, spentTokens: ctx.budget.spent.tokens };
  },
);

const builder = mock().on({ key: "refute:*" }, (req) => ({ real: !req.prompt.includes("cold fusion") }), {
  usage: { input: 400, output: 200 }, // 600 tokens per call
});
const providers = new ProviderRegistry();
providers.register(builder.provider("claude"));
providers.register(builder.provider("codex"));
const engine = new Engine({ journal: new MemoryJournalStore(), blobs: new MemoryBlobStore(), providers });

const handle = await engine.start(parent, {
  input: {
    claims: ["water is wet", "the loop is unbounded", "cold fusion ships friday", "the cache is stale"],
  },
  cwd: process.cwd(),
  budget: { tokens: 1_800 }, // three 600-token calls spend it exactly; the fourth throws
});
const output = (await handle.result) as { verified: unknown[]; skipped: string[]; spentTokens: number };
console.log("verified:", output.verified);
console.log("skipped: ", output.skipped, "(budget_exceeded inside that child)");
console.log(
  `budget:   ${output.spentTokens} of 1800 tokens spent across ${output.verified.length} completed children`,
);

// every child is a real run with its own journal, resumable on its own
const runs = await engine.list();
console.log(
  `runs:     ${runs.length} total — ${runs.filter((r) => r.parentRunId).length} children of ${handle.runId}`,
);
