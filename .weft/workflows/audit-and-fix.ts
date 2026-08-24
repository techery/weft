/**
 * audit-and-fix — find bugs, verify them across vendors, fix the survivors in
 * isolated worktrees, merge the patches explicitly, and gate the run on tests.
 *
 *   weft run audit-and-fix --args '{"paths":["src/auth","src/api"]}' --watch
 *
 * The shape of this workflow is the shape of the engine's guarantees: every step
 * returns a schema-validated value (C2), the human sits in the graph as a step (C5),
 * and edits reach the tree only as journaled patches (C6).
 */
import { defineWorkflow, z } from "@weft/sdk";
import { Finding, FixResult, Verdict } from "./schemas.ts";

/** Cross-vendor refutation panel: two vendors, three votes, majority wins. */
const PANEL = ["claude", "codex", "claude"] as const;

export default defineWorkflow(
  {
    description: "Find bugs, verify across vendors, fix with approval",
    input: z.object({ paths: z.array(z.string()).min(1) }),
    output: z.object({ fixed: z.array(Finding), skipped: z.array(Finding) }),
  },
  async (ctx, { paths }) => {
    ctx.phase("Find");
    const found = ctx.ok(
      await ctx.parallel(
        paths.map((p) =>
          ctx.agent(`Find correctness bugs in ${p}. Cite file:line and quote the evidence.`, {
            schema: z.object({ findings: z.array(Finding) }),
            key: `find:${p}`,
            effort: "high",
          }),
        ),
      ),
    );
    const findings = found.flatMap((r) => r.findings); // typed; no nulls

    ctx.phase("Verify");
    const real = ctx.ok(
      await ctx
        .pipeline(findings)
        .step((f) =>
          ctx.parallel(
            PANEL.map((provider, i) =>
              ctx.agent(`Try to refute: ${f.claim} (${f.file}:${f.line})\n\n${f.evidence}`, {
                schema: Verdict,
                provider,
                key: `refute:${f.file}:${f.line}:${i}`,
              }),
            ),
          ),
        )
        .filter((votes) => ctx.ok(votes).filter((v) => v.real).length >= 2)
        .map((_votes, f) => f)
        .run(),
    );
    await ctx.note({
      kind: "claim",
      text: `${real.length} of ${findings.length} findings survived refutation`,
    });

    ctx.phase("Fix");
    const go = await ctx.gate({
      action: `Apply fixes for ${real.length} bugs`,
      risk: "medium",
      detail: real.map((f) => `${f.file}:${f.line} — ${f.claim}`).join("\n"),
    });
    if (!go.approved) {
      await ctx.note({ kind: "decision", text: `fixes declined: ${go.note ?? "no reason given"}` });
      return { fixed: [], skipped: real };
    }

    const fixes = ctx.ok(
      await ctx.parallel(
        real.map((f) =>
          ctx.agent.detailed(`Fix and add a focused test: ${f.claim} (${f.file}:${f.line})`, {
            schema: FixResult,
            isolation: "worktree", // its own git worktree at the integration tree
            write: { paths: [f.file, "**/*.test.ts"], also: ["pnpm-lock.yaml"], mode: "warn" },
            key: `fix:${f.file}`,
          }),
        ),
      ),
    );
    const ledger = await ctx.integrate(fixes, { order: "sequential", onConflict: "ask" });
    const merged = new Set(ledger.merged);

    ctx.phase("Check");
    const tests = await ctx.check("tests", { exec: ["pnpm", "test"], required: true });
    if (tests.status === "fail") {
      await ctx.note({
        kind: "risk",
        text: "tests failed after integration",
        evidence: tests.evidence ?? "",
      });
    }

    return {
      fixed: real.filter((f) => merged.has(`fix:${f.file}`)),
      skipped: real.filter((f) => !merged.has(`fix:${f.file}`)),
    };
  },
);
