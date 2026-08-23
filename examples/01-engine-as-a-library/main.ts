/**
 * Weft as a library, with no CLI, no filesystem, and no models.
 *
 *   npx tsx examples/01-engine-as-a-library/main.ts
 *
 * The engine is just a class: hand it a journal store, a blob store, and a provider
 * registry, and it will run a workflow definition you built in the same process. Here
 * the stores are in-memory and the provider is `@weft/provider-mock`, so the whole run
 * is deterministic and free — the same shape a test, a daemon, or the CLI would use,
 * only with the fs stores and a real vendor adapter swapped in.
 *
 * What it prints is `report.md`: a projection rebuilt from the journal after the fact,
 * exactly like `weft report <run>` would render it.
 */
import {
  Engine,
  type JournalRecord,
  MemoryBlobStore,
  MemoryJournalStore,
  ProviderRegistry,
  reduceState,
  renderReport,
} from "@weft/core";
import { mock } from "@weft/provider-mock";
import { defineWorkflow, z } from "@weft/sdk";

// ---------------------------------------------------------------------------
// The workflow — defined inline, exactly as a .weft/workflows/*.ts file would be
// ---------------------------------------------------------------------------

const Finding = z.object({
  file: z.string(),
  line: z.number().int().min(1),
  claim: z.string(),
  evidence: z.string(),
});
type Finding = z.infer<typeof Finding>;

const Verdict = z.object({ real: z.boolean(), reason: z.string() });

const audit = defineWorkflow(
  {
    name: "inline-audit",
    description: "Find bugs in the given paths; keep the ones a second vendor cannot refute",
    input: z.object({ paths: z.array(z.string()).min(1) }),
    output: z.object({ confirmed: z.array(Finding), refuted: z.array(Finding) }),
  },
  async (ctx, { paths }) => {
    ctx.phase("Find");
    const found = ctx.ok(
      await ctx.parallel(
        paths.map((p) =>
          ctx.agent(`Find correctness bugs in ${p}. Cite file:line and quote the evidence.`, {
            schema: z.object({ findings: z.array(Finding) }),
            key: `find:${p}`,
          }),
        ),
      ),
    );
    const findings = found.flatMap((r) => r.findings);
    ctx.log(`${findings.length} candidate findings across ${paths.length} paths`);

    ctx.phase("Verify");
    const graded = ctx.ok(
      await ctx
        .pipeline(findings)
        .step((f) =>
          ctx.agent(`Try to refute: ${f.claim} (${f.file}:${f.line}). Default real=false if unsure.`, {
            schema: Verdict,
            provider: "codex", // a different vendor grades
            key: `refute:${f.file}:${f.line}`,
          }),
        )
        .map((verdict, finding) => ({ finding, verdict }))
        .run(),
    );

    for (const { finding, verdict } of graded) {
      await ctx.note({
        kind: verdict.real ? "risk" : "decision",
        text: `${finding.file}:${finding.line} — ${verdict.real ? "confirmed" : "refuted"}: ${verdict.reason}`,
        evidence: finding.evidence,
      });
    }

    return {
      confirmed: graded.filter((g) => g.verdict.real).map((g) => g.finding),
      refuted: graded.filter((g) => !g.verdict.real).map((g) => g.finding),
    };
  },
);

type AuditOutput = Awaited<ReturnType<typeof audit.run>>;

// ---------------------------------------------------------------------------
// The fixtures — matched on the step key, validated against the step's schema
// ---------------------------------------------------------------------------

const BUGS: Record<string, Finding[]> = {
  "src/auth/login.ts": [
    {
      file: "src/auth/login.ts",
      line: 42,
      claim: "a null session token compares equal to a missing stored token",
      evidence: "if (token == user.token) return true;",
    },
  ],
  "src/api/handlers.ts": [
    {
      file: "src/api/handlers.ts",
      line: 17,
      claim: "off-by-one drops the last page of results",
      evidence: "for (let i = 0; i < pages.length - 1; i++)",
    },
    {
      file: "src/api/handlers.ts",
      line: 88,
      claim: "unbounded retry loop on any 5xx response",
      evidence: "while (res.status >= 500) res = await send(req);",
    },
  ],
  "src/db/pool.ts": [
    {
      file: "src/db/pool.ts",
      line: 9,
      claim: "connections are never released when the handler throws",
      evidence: "const c = await pool.acquire(); return handler(c);",
    },
  ],
};

/** Findings the refuting vendor knocks down — everything else survives. */
const REFUTED = new Map([["src/db/pool.ts:9", "the pool wrapper releases in a finally block one frame up"]]);

const fixtures = mock()
  .on({ key: "find:*" }, (req) => ({ findings: BUGS[req.key?.slice("find:".length) ?? ""] ?? [] }))
  .on({ key: "refute:*" }, (req) => {
    const target = req.key?.slice("refute:".length) ?? "";
    const refutation = REFUTED.get(target);
    return refutation
      ? { real: false, reason: refutation }
      : { real: true, reason: "reproduced the failure from the quoted line" };
  });

// ---------------------------------------------------------------------------
// The engine — stores in, providers in, run out
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const journal = new MemoryJournalStore();
  const blobs = new MemoryBlobStore();
  const providers = new ProviderRegistry()
    .register(fixtures.provider("claude"))
    .register(fixtures.provider("codex"));

  const engine = new Engine({ journal, blobs, providers });
  const handle = await engine.start(audit, {
    input: { paths: Object.keys(BUGS) },
    cwd: process.cwd(),
    runId: "inline1",
  });

  const outcome = await handle.outcome();
  if (outcome.status !== "complete") {
    console.error(`run ${handle.runId} ended ${outcome.status}`);
    process.exitCode = 1;
    return;
  }

  // `start()` hands back `Promise<unknown>`; the definition still carries the type.
  const output = (await handle.result) as AuditOutput;

  // The journal is the truth; the report is a projection over it, rebuilt on demand.
  const records: JournalRecord[] = [];
  for await (const record of journal.read(handle.runId)) records.push(record);

  console.log(renderReport(reduceState(records)));
  console.log("---");
  console.log(`${records.length} journal records · ${fixtures.calls.length} provider calls`);
  console.log(`confirmed: ${output.confirmed.map((f) => `${f.file}:${f.line}`).join(", ") || "(none)"}`);
  console.log(`refuted:   ${output.refuted.map((f) => `${f.file}:${f.line}`).join(", ") || "(none)"}`);
}

await main();
