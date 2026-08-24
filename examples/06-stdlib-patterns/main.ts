/**
 * @techery/weft-stdlib — quality patterns as plain typed helpers over ctx: nothing here is
 * engine-privileged, so every pattern replays, salvages, and budgets like the
 * hand-written steps it expands into.
 *
 *   npx tsx examples/06-stdlib-patterns/main.ts
 */
import { Engine, MemoryBlobStore, MemoryJournalStore, ProviderRegistry } from "@techery/weft-core";
import { mock } from "@techery/weft-provider-mock";
import { defineWorkflow, z } from "@techery/weft-sdk";
import { adversarialVerify, finalReport, loopUntilDry } from "@techery/weft-stdlib";

const Finding = z.object({ file: z.string(), claim: z.string() });
type Finding = z.infer<typeof Finding>;

const sweepAndVerify = defineWorkflow(
  {
    name: "sweep-and-verify",
    description: "loopUntilDry to exhaust discovery, adversarialVerify to keep only what survives",
    input: z.object({}),
    output: z.object({ report: z.string(), survived: z.number(), refuted: z.number() }),
  },
  async (ctx) => {
    ctx.phase("Find");
    // Keep sweeping until two consecutive rounds add nothing new; rounds overlap
    // on purpose — loopUntilDry dedupes against everything already seen.
    const findings = await loopUntilDry<Finding>(ctx, {
      find: async (round) => {
        const r = await ctx.agent(`Discovery round ${round}: list correctness findings.`, {
          schema: z.object({ findings: z.array(Finding) }),
          key: `sweep:${round}`,
        });
        return r.findings;
      },
      keyOf: (f) => `${f.file}:${f.claim}`,
      dryRounds: 2,
    });
    ctx.log(`discovery dried up with ${findings.length} unique findings`);

    ctx.phase("Verify");
    // Three skeptics per claim, each prompted to KILL it; majority refutes win.
    const verdict = await adversarialVerify(ctx, {
      claims: findings,
      describe: (f) => `${f.claim} (in ${f.file})`,
      refuters: 3,
    });

    ctx.phase("Report");
    const report = finalReport(ctx, {
      title: "Sweep & verify",
      sections: [
        {
          heading: "Survived",
          body: verdict.survived.map((f) => `- ${f.file}: ${f.claim}`).join("\n") || "(none)",
        },
        {
          heading: "Refuted",
          body:
            verdict.refuted.map((r) => `- ${r.claim.file}: ${r.claim.claim} — ${r.reasons[0]}`).join("\n") ||
            "(none)",
        },
      ],
    });
    return { report, survived: verdict.survived.length, refuted: verdict.refuted.length };
  },
);

// -- fixtures: rounds 1-2 overlap, 3-4 are dry; one claim is indefensible ----
const builder = mock()
  .on(
    { key: "sweep:1" },
    {
      findings: [
        { file: "auth.ts", claim: "loop is unbounded" },
        { file: "api.ts", claim: "retry never backs off" },
      ],
    },
  )
  .on(
    { key: "sweep:2" },
    {
      findings: [
        { file: "api.ts", claim: "retry never backs off" },
        { file: "db.ts", claim: "connection leaks on error" },
      ],
    },
  )
  .on({ key: "sweep:*" }, { findings: [] }) // dry rounds end the loop
  .on({ key: "refute:*" }, (req) => ({
    // the connection-leak claim dies (a finally releases it); the rest hold
    refuted: req.prompt.includes("connection leaks"),
    reason: req.prompt.includes("connection leaks")
      ? "released in a finally block one frame up"
      : "confirmed against the source",
  }));

const providers = new ProviderRegistry();
providers.register(builder.provider("claude"));
providers.register(builder.provider("codex"));
const engine = new Engine({ journal: new MemoryJournalStore(), blobs: new MemoryBlobStore(), providers });

const handle = await engine.start(sweepAndVerify, { input: {}, cwd: process.cwd() });
const output = (await handle.result) as { report: string; survived: number; refuted: number };
console.log(output.report);
console.log(
  `\n${output.survived} survived · ${output.refuted} refuted · ${builder.calls.length} agent calls total`,
);
