/**
 * review — review the files changed since a base ref, have Claude find bugs, have
 * Codex try to refute each one, and return only what survived.
 *
 *   weft run review --base main --watch
 */
import { defineWorkflow, z } from "@techery/weft-sdk";
import { Finding, Verdict } from "./schemas.ts";

export default defineWorkflow(
  {
    // `name` derives from the filename: "review".
    description: "Review changed files; keep only findings that survive refutation",
    input: z.object({ base: z.string().default("main") }),
    output: z.object({ confirmed: z.array(Finding) }),
  },
  async (ctx, { base }) => {
    ctx.phase("Scope");
    const { files } = await ctx.git.changedSince(base); // [{ path, status }] · journaled
    const paths = files.filter((f) => f.status !== "D").map((f) => f.path);

    ctx.phase("Find");
    const found = ctx.successes(
      await ctx.parallel(
        paths.map((f) =>
          ctx.agent(`Review ${f} for correctness bugs. Cite file:line and quote the evidence.`, {
            schema: z.object({ findings: z.array(Finding) }), // required on every step
            key: `review:${f}`, // stable identity for replay, tests, the tree
          }),
        ),
      ),
    );
    const findings = found.flatMap((r) => r.findings); // typed — no nulls to filter

    ctx.phase("Verify");
    const confirmed = ctx.successes(
      await ctx
        .pipeline(findings)
        .step((f) =>
          ctx.agent(`Try to refute: ${f.claim} (${f.file}:${f.line}). Default real=false if unsure.`, {
            schema: Verdict,
            provider: "codex", // a different vendor grades
            key: `refute:${f.file}:${f.line}`,
          }),
        )
        .filter((verdict) => verdict.real) // drop refuted lanes
        .map((_verdict, f) => f) // back to the finding
        .run(),
    );

    return { confirmed };
  },
);
