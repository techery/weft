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
import { defineWorkflow, z } from "@techery/weft-sdk";
import {
  assertIntegratedWhenChanged,
  findingKey,
  groupFindingsByFile,
  uniqueFindings,
} from "@techery/weft-stdlib";
import { Finding, FixResult, Verdict } from "./lib/schemas.ts";

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
    const found = ctx.all(
      await ctx.parallel(
        [...new Set(paths)],
        (p) =>
          ctx.agent(`Find correctness bugs in ${p}. Cite file:line and quote the evidence.`, {
            schema: z.object({ findings: z.array(Finding) }),
            key: `find:${p}`,
            effort: "high",
          }),
        { concurrency: 4 },
      ),
    );
    const findings = uniqueFindings(found.flatMap((r) => r.findings));

    ctx.phase("Verify");
    const verified = ctx.all(
      await ctx.parallel(
        findings,
        async (f) => {
          const votes = ctx.all(
            await ctx.parallel(
              PANEL,
              (provider, i) =>
                ctx.agent(`Try to refute: ${f.claim} (${f.file}:${f.line})\n\n${f.evidence}`, {
                  schema: Verdict,
                  provider,
                  key: `refute:${findingKey(f)}:${i}`,
                }),
              { concurrency: PANEL.length },
            ),
          );
          return { finding: f, real: votes.filter((vote) => vote.real).length >= 2 };
        },
        { concurrency: 4 },
      ),
    );
    const real = verified.filter((result) => result.real).map(({ finding }) => finding);
    await ctx.note({
      kind: "claim",
      text: `${real.length} of ${findings.length} findings survived refutation`,
    });
    if (real.length === 0) return { fixed: [], skipped: [] };

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

    const fixed: Finding[] = [];
    // One coherent writer per file; each later writer starts from the integrated
    // tree, so shared regression tests cannot be edited from competing bases.
    for (const group of groupFindingsByFile(real)) {
      const key = `fix:${group.file}`;
      const fix = await ctx.agent.detailed(
        `Fix all of these findings together and add focused regression tests:\n${group.findings.map((f) => `${f.file}:${f.line} — ${f.claim}\n${f.evidence}`).join("\n\n")}`,
        {
          schema: FixResult,
          isolation: "worktree", // its own git worktree at the integration tree
          write: { paths: [group.file, "**/*.test.ts"], also: ["pnpm-lock.yaml"], mode: "strict" },
          key,
        },
      );
      const ledger = await ctx.integrate([fix], { order: "sequential", onConflict: "fail" });
      assertIntegratedWhenChanged(key, fix.files, ledger.merged, ledger.quarantined);
      // A successful model answer without an integrated patch is not a fix.
      if (fix.patch && ledger.merged.includes(fix.patch.key)) fixed.push(...group.findings);
    }

    ctx.phase("Check");
    const tests = await ctx.check("tests", { key: "tests", exec: ["pnpm", "test"], required: true });
    if (tests.status === "fail") {
      await ctx.note({
        kind: "risk",
        text: "tests failed after integration",
        evidence: tests.evidence ?? "",
      });
    }

    const fixedKeys = new Set(fixed.map(findingKey));
    return { fixed, skipped: real.filter((f) => !fixedKeys.has(findingKey(f))) };
  },
);
