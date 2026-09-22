/**
 * review — review the files changed since a base ref, have Claude find bugs, have
 * Codex try to refute each one, and return only what survived.
 *
 *   weft run review --base main --watch
 */
import { defineWorkflow, z } from "@techery/weft-sdk";
import { findingKey, uniqueFindings } from "@techery/weft-stdlib";
import { Finding, Verdict } from "./lib/schemas.ts";

export default defineWorkflow(
  {
    // `name` derives from the package directory: "review".
    description: "Review changed files; keep only findings that survive refutation",
    input: z.object({ base: z.string().default("main") }),
    output: z.object({ confirmed: z.array(Finding) }),
  },
  async (ctx, { base }) => {
    ctx.phase("Scope");
    const { files } = await ctx.git.changedSince(base); // [{ path, status }] · journaled
    const paths = [...new Set(files.filter((f) => f.status !== "D").map((f) => f.path))];

    ctx.phase("Find");
    const found = ctx.all(
      await ctx.parallel(
        paths,
        (f) =>
          ctx.agent(`Review ${f} for correctness bugs. Cite file:line and quote the evidence.`, {
            schema: z.object({ findings: z.array(Finding) }), // required on every step
            key: `review:${f}`, // stable identity for replay, tests, the tree
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
          const verdict = await ctx.agent(
            `Try to refute: ${f.claim} (${f.file}:${f.line}). Default real=false if unsure.\n\n${f.evidence}`,
            {
              schema: Verdict,
              provider: "codex", // a different vendor grades
              key: `refute:${findingKey(f)}`,
            },
          );
          return { finding: f, verdict };
        },
        { concurrency: 4 },
      ),
    );
    const confirmed = verified.filter(({ verdict }) => verdict.real).map(({ finding }) => finding);

    return { confirmed };
  },
);
