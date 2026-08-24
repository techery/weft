/**
 * @techery/weft-testing outside a test runner: runWorkflow drives a real engine over
 * memory stores, mock fixtures are validated against each step's schema, and the
 * journal is a first-class assertion target. The same API backs vitest suites —
 * here plain node:assert proves the point with zero infrastructure.
 *
 *   npx tsx examples/07-testing-workflows/main.ts
 */
import assert from "node:assert/strict";
import { defineWorkflow, z } from "@techery/weft-sdk";
import { mock, runWorkflow } from "@techery/weft-testing";

const Finding = z.object({ file: z.string(), line: z.number(), claim: z.string() });

const review = defineWorkflow(
  {
    name: "review",
    description: "Review changed files; keep only findings that survive refutation",
    input: z.object({ base: z.string().default("main") }),
    output: z.object({ confirmed: z.array(Finding) }),
  },
  async (ctx, { base }) => {
    ctx.phase("Scope");
    const { files } = await ctx.git.changedSince(base);
    const paths = files.filter((f) => f.status !== "D").map((f) => f.path);

    ctx.phase("Find");
    const found = ctx.ok(
      await ctx.parallel(
        paths.map((f) =>
          ctx.agent(`Review ${f} for correctness bugs.`, {
            schema: z.object({ findings: z.array(Finding) }),
            key: `review:${f}`,
          }),
        ),
      ),
    );
    const findings = found.flatMap((r) => r.findings);

    ctx.phase("Verify");
    const confirmed = ctx.ok(
      await ctx
        .pipeline(findings)
        .step((f) =>
          ctx.agent(`Try to refute: ${f.claim} (${f.file}:${f.line}). Default real=false if unsure.`, {
            schema: z.object({ real: z.boolean(), reason: z.string() }),
            provider: "codex",
            key: `refute:${f.file}:${f.line}`,
          }),
        )
        .filter((verdict) => verdict.real)
        .map((_verdict, f) => f)
        .run(),
    );
    return { confirmed };
  },
);

const { output, journal, state } = await runWorkflow(review, {
  input: {},
  // ctx.git is fixtured — no git repo anywhere near this run
  git: {
    changedSince: {
      files: [
        { path: "a.ts", status: "M" },
        { path: "b.ts", status: "D" },
      ],
    },
  },
  provider: mock()
    .on({ key: "review:*" }, { findings: [{ file: "a.ts", line: 3, claim: "off-by-one" }] })
    .on({ key: "refute:*" }, (req) => ({ real: req.prompt.includes("off-by-one"), reason: "loop bound" })),
});

// typed output assertions
assert.equal(output.confirmed.length, 1);
assert.equal(output.confirmed[0]!.file, "a.ts");

// journal assertions: the graph itself is testable
assert.equal(journal.steps({ kind: "agent" }).length, 2); // deleted b.ts was never reviewed
assert.match(journal.step("refute:a.ts:3").prompt ?? "", /Default real=false/);
assert.equal(journal.step("refute:a.ts:3").route?.provider, "codex"); // cross-vendor grading
assert.deepEqual(
  state.phases.map((p) => p.name),
  ["Scope", "Find", "Verify"],
);

console.log("all assertions passed");
console.log("journal snapshot:", JSON.stringify(journal.toJSON(), null, 2));
