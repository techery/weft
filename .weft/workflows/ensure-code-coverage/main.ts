/**
 * ensure-code-coverage — measure Weft's real source coverage, bootstrap the
 * Vitest coverage provider when absent, add behavior-focused tests in isolated
 * worktrees, and fail closed until both numeric and test-quality gates pass.
 *
 *   weft run ensure-code-coverage --base main --watch
 */
import { type Ctx, defineWorkflow, z } from "@techery/weft-sdk";

const Provider = z
  .enum(["claude", "codex"])
  .describe("Weft provider assigned to planning, test authoring, or independent test-quality verification.");

const Metric = z.object({
  covered: z.number().int().min(0).describe("Number of measured coverage items executed by the test suite."),
  total: z
    .number()
    .int()
    .min(0)
    .describe("Total number of measured coverage items in the configured source scope."),
  pct: z
    .number()
    .min(0)
    .max(100)
    .describe("Coverage percentage reported for this metric, from zero to one hundred."),
});

const MetricSet = z.object({
  statements: Metric.describe("Statement coverage totals for the configured Weft source scope."),
  branches: Metric.describe("Branch coverage totals for the configured Weft source scope."),
  functions: Metric.describe("Function coverage totals for the configured Weft source scope."),
  lines: Metric.describe("Line coverage totals for the configured Weft source scope."),
});

const FileCoverage = z.object({
  path: z.string().describe("Repository-relative Weft source file represented by this coverage record."),
  statements: z.number().min(0).max(100).describe("Statement coverage percentage for this source file."),
  branches: z.number().min(0).max(100).describe("Branch coverage percentage for this source file."),
  functions: z.number().min(0).max(100).describe("Function coverage percentage for this source file."),
  lines: z.number().min(0).max(100).describe("Line coverage percentage for this source file."),
});

const CoverageMeasurement = z.object({
  ready: z
    .boolean()
    .describe(
      "Whether the coverage provider ran and produced a parseable machine-readable coverage summary.",
    ),
  passed: z
    .boolean()
    .describe("Whether tests passed and every aggregate coverage metric met its configured threshold."),
  exitCode: z.number().int().describe("Exit code returned by the underlying Vitest coverage command."),
  totals: MetricSet.describe("Aggregate statements, branches, functions, and lines coverage for Weft."),
  files: z
    .array(
      FileCoverage.describe(
        "One repository source file with the four measured coverage percentages used for prioritization.",
      ),
    )
    .describe("Lowest-coverage source files, ordered from weakest to strongest for agent prioritization."),
  failure: z
    .string()
    .describe("Actionable command failure or threshold evidence; empty only when the measurement passed."),
});
type CoverageMeasurement = z.infer<typeof CoverageMeasurement>;

const BootstrapResult = z.object({
  summary: z.string().describe("What coverage tooling was added or repaired and why it was required."),
  commands: z
    .array(
      z
        .string()
        .describe("Exact deterministic package or validation command executed by the bootstrap agent."),
    )
    .describe("Deterministic package or validation commands executed during bootstrap."),
  files: z
    .array(
      z.string().describe("Repository-relative manifest or lockfile path changed by the bootstrap agent."),
    )
    .describe("Repository files the bootstrap agent believes it changed."),
});

const CoverageTarget = z.object({
  id: z
    .string()
    .regex(/^[a-z0-9][a-z0-9._-]*$/)
    .describe("Stable lowercase identifier used as the replay key for this independent coverage target."),
  priority: z
    .enum(["critical", "high", "medium"])
    .describe("Relative importance of closing this behavioral coverage gap in the current round."),
  sourceFiles: z
    .array(
      z
        .string()
        .describe("Repository-relative production source path whose behavior needs focused coverage."),
    )
    .min(1)
    .describe("Current Weft implementation files whose uncovered behavior this target must exercise."),
  testFiles: z
    .array(
      z
        .string()
        .describe("Repository-relative existing or proposed test path suitable for this coverage target."),
    )
    .describe("Existing or proposed test files most appropriate for covering the specified source behavior."),
  behaviors: z
    .array(
      z
        .string()
        .describe("Observable behavior, branch, error path, or invariant that a regression test must prove."),
    )
    .min(1)
    .describe("Concrete observable behaviors, branches, errors, or invariants that tests must demonstrate."),
  rationale: z
    .string()
    .describe("Evidence connecting the coverage report and current implementation to this test target."),
});

const CoveragePlan = z.object({
  summary: z
    .string()
    .describe("Evidence-based explanation of the smallest useful set of coverage targets for this round."),
  targets: z
    .array(
      CoverageTarget.describe(
        "One non-overlapping, behavior-focused coverage target assigned to an isolated test author.",
      ),
    )
    .describe(
      "Non-overlapping behavior-focused targets to implement concurrently; empty only when no repair is possible.",
    ),
});

const TestChange = z.object({
  summary: z
    .string()
    .describe("Behavioral tests added or corrected for this target and why they are meaningful."),
  tests: z
    .array(
      z
        .string()
        .describe("Observable regression behavior asserted by a test added or updated for this target."),
    )
    .min(1)
    .describe("Test cases added or updated, expressed as observable behavior claims."),
  sourceFiles: z
    .array(z.string().describe("Repository-relative production source path exercised by the authored tests."))
    .min(1)
    .describe("Production source files whose behavior is exercised by the authored tests."),
  files: z
    .array(
      z.string().describe("Repository-relative test or fixture path changed by the test-authoring agent."),
    )
    .describe("Test or fixture files the author believes it changed."),
});

const QualityFinding = z.object({
  severity: z
    .enum(["blocking", "major", "minor"])
    .describe("Impact of this test defect on whether the measured coverage can be trusted."),
  file: z.string().describe("Repository-relative test file containing the substantiated quality defect."),
  message: z.string().describe("Specific test-quality problem that must be corrected before acceptance."),
  evidence: z
    .string()
    .describe("Concrete source and test behavior proving the test is weak, misleading, or incorrect."),
});

const QualityAudit = z.object({
  pass: z
    .boolean()
    .describe(
      "True only when generated tests assert meaningful behavior and contain no substantiated findings.",
    ),
  summary: z
    .string()
    .describe("Independent conclusion about whether the new coverage is behaviorally trustworthy."),
  findings: z
    .array(
      QualityFinding.describe(
        "One independently substantiated defect that prevents generated coverage from being trusted.",
      ),
    )
    .describe(
      "Substantiated defects such as assertion-free execution, implementation mirroring, or false-positive tests.",
    ),
});
type QualityAudit = z.infer<typeof QualityAudit>;

const Thresholds = z
  .object({
    statements: z
      .number()
      .min(0)
      .max(100)
      .default(90)
      .describe("Minimum aggregate statement coverage percentage."),
    branches: z
      .number()
      .min(0)
      .max(100)
      .default(85)
      .describe("Minimum aggregate branch coverage percentage."),
    functions: z
      .number()
      .min(0)
      .max(100)
      .default(90)
      .describe("Minimum aggregate function coverage percentage."),
    lines: z.number().min(0).max(100).default(90).describe("Minimum aggregate line coverage percentage."),
  })
  .describe("Coverage percentages that the final deterministic Vitest run must satisfy.");

const WorkflowOutput = z.object({
  sourceSha: z.string().describe("Weft Git commit used as the source identity for this coverage run."),
  baseline: CoverageMeasurement.describe(
    "First valid coverage measurement after any required tooling bootstrap.",
  ),
  final: CoverageMeasurement.describe("Last coverage measurement before the required acceptance gate."),
  rounds: z
    .number()
    .int()
    .min(0)
    .describe("Number of plan-author-integrate-verify coverage repair rounds executed."),
  changedFiles: z
    .array(
      z
        .string()
        .describe("Repository-relative tooling, test, or fixture path integrated by this coverage run."),
    )
    .describe("Actual files captured from integrated tooling and test-authoring patches during this run."),
  qualityVerified: z
    .boolean()
    .describe("Whether an independent verifier accepted all tests generated during this workflow run."),
  summary: z
    .string()
    .describe("Final coverage and test-quality outcome suitable for the generated Weft report."),
});

const DEFAULT_INCLUDE = ["packages/*/src/**/*.ts", "apps/ui/src/**/*.{ts,tsx}"] as const;
const DEFAULT_EXCLUDE = [
  "**/*.d.ts",
  "**/*.test.{ts,tsx}",
  "**/test/**",
  "**/__tests__/**",
  "apps/ui/src/test/**",
] as const;
const TEST_WRITE_SCOPE = [
  "packages/*/test/**",
  "apps/ui/src/**/*.test.ts",
  "apps/ui/src/**/*.test.tsx",
] as const;

export default defineWorkflow(
  {
    id: "ensure-weft-code-coverage",
    description:
      "Measure Weft code coverage, add meaningful tests for real gaps, and fail closed until numeric and quality gates pass.",
    input: z.object({
      base: z
        .string()
        .default("main")
        .describe("Git ref used to prioritize changed Weft source during gap planning."),
      include: z
        .array(
          z
            .string()
            .describe("Source glob whose matching Weft files must be included in coverage measurement."),
        )
        .min(1)
        .default([...DEFAULT_INCLUDE])
        .describe(
          "Source glob patterns included in coverage, including files not loaded by the current tests.",
        ),
      exclude: z
        .array(
          z
            .string()
            .describe(
              "Source glob intentionally excluded from coverage because it is not production behavior.",
            ),
        )
        .default([...DEFAULT_EXCLUDE])
        .describe(
          "Source glob patterns intentionally excluded from coverage measurement with no runtime mutation.",
        ),
      thresholds: Thresholds.default({ statements: 90, branches: 85, functions: 90, lines: 90 }).describe(
        "Required aggregate coverage thresholds for the completed workflow.",
      ),
      maxRounds: z
        .number()
        .int()
        .min(0)
        .max(5)
        .default(3)
        .describe("Maximum bounded test-authoring rounds before unresolved coverage causes failure."),
      maxTargetsPerRound: z
        .number()
        .int()
        .min(1)
        .max(12)
        .default(4)
        .describe("Maximum independent coverage targets the planner may schedule in one round."),
      concurrency: z
        .number()
        .int()
        .min(1)
        .max(8)
        .default(4)
        .describe("Maximum number of isolated test-authoring agents allowed to run concurrently."),
      plannerWith: Provider.default("codex").describe(
        "Provider that analyzes coverage evidence and selects test targets.",
      ),
      writerWith: Provider.default("codex").describe(
        "Provider that authors behavior-focused tests in isolated worktrees.",
      ),
      verifyWith: Provider.default("codex").describe(
        "Provider that independently audits generated test quality.",
      ),
    }),
    output: WorkflowOutput,
    defaults: { effort: "medium" },
  },
  async (
    ctx,
    {
      base,
      include,
      exclude,
      thresholds,
      maxRounds,
      maxTargetsPerRound,
      concurrency,
      plannerWith,
      writerWith,
      verifyWith,
    },
  ) => {
    ctx.phase("Inventory");
    const [{ sha: sourceSha }, changed] = await Promise.all([ctx.git.head(), ctx.git.changedSince(base)]);
    const changedSource = changed.files
      .filter((file) => file.status !== "D" && isCoveredSource(file.path))
      .map((file) => file.path)
      .sort(compare);
    const args = measurementArgs(include, exclude, thresholds);

    ctx.phase("Baseline");
    let current = await measure(ctx, args, "coverage:baseline");
    const changedFiles: string[] = [];
    if (!current.ready) {
      ctx.phase("Bootstrap");
      const bootstrap = await ctx.agent.detailed(bootstrapPrompt(current), {
        schema: BootstrapResult,
        provider: writerWith,
        effort: "medium",
        key: "coverage:bootstrap",
        isolation: "worktree",
        write: { paths: ["package.json", "pnpm-lock.yaml"], mode: "strict" },
        maxTurns: 12,
        timeout: "8m",
        repair: 1,
        tasks: false,
      });
      changedFiles.push(...bootstrap.files);
      const ledger = await ctx.integrate([bootstrap], { order: "sequential", onConflict: "fail" });
      assertIntegratedWhenChanged("coverage:bootstrap", bootstrap.files, ledger.merged, ledger.quarantined);
      current = await measure(ctx, args, "coverage:after-bootstrap");
      if (!current.ready) throw new Error(`coverage tooling is still unavailable: ${current.failure}`);
    }
    const baseline = current;

    let round = 0;
    let quality: QualityAudit = {
      pass: true,
      summary: "No generated tests require independent quality review.",
      findings: [],
    };
    let roundChanged: string[] = [];

    while ((!current.passed || !quality.pass) && round < maxRounds) {
      round += 1;
      ctx.phase(`Plan ${round}`);
      const plan = await ctx.agent(planPrompt(current, quality, changedSource, maxTargetsPerRound, round), {
        schema: CoveragePlan,
        provider: plannerWith,
        effort: "medium",
        key: `coverage:plan:${round}`,
        maxTurns: 12,
        timeout: "8m",
        repair: 1,
        tasks: false,
      });
      const targets = plan.targets.slice(0, maxTargetsPerRound);
      assertUniqueTargets(targets);
      if (targets.length === 0) {
        throw new Error(`coverage planner produced no repair targets: ${plan.summary}`);
      }

      ctx.phase(`Author ${round}`);
      const settled = await ctx.parallel(
        targets.map(
          (target) => () =>
            ctx.agent.detailed(testPrompt(target, current, quality), {
              schema: TestChange,
              provider: writerWith,
              effort: "medium",
              key: `coverage:test:${round}:${target.id}`,
              isolation: "worktree",
              write: { paths: [...TEST_WRITE_SCOPE], mode: "strict" },
              maxTurns: 16,
              timeout: "10m",
              repair: 1,
              tasks: false,
            }),
        ),
        { concurrency },
      );
      const failures = settled.filter((result) => !result.ok);
      if (failures.length > 0) {
        throw new Error(
          `coverage test authoring failed: ${failures
            .map((result) => (result.ok ? "" : result.error.message))
            .join("; ")}`,
        );
      }
      const patches = settled.flatMap((result) => (result.ok ? [result.value] : []));
      roundChanged = unique(patches.flatMap((patch) => patch.files));
      changedFiles.push(...roundChanged);
      const ledger = await ctx.integrate(patches, { order: "sequential", onConflict: "fail" });
      for (const patch of patches) {
        assertIntegratedWhenChanged(
          patch.patch?.key ?? "coverage test patch",
          patch.files,
          ledger.merged,
          ledger.quarantined,
        );
      }

      ctx.phase(`Measure ${round}`);
      current = await measure(ctx, args, `coverage:measure:${round}`);
      if (!current.ready)
        throw new Error(`coverage measurement failed after round ${round}: ${current.failure}`);

      ctx.phase(`Audit ${round}`);
      quality = await ctx.agent(auditPrompt(roundChanged, current), {
        schema: QualityAudit,
        provider: verifyWith,
        effort: "medium",
        key: `coverage:audit:${round}`,
        maxTurns: 12,
        timeout: "8m",
        repair: 1,
        tasks: false,
      });
      if (quality.findings.length > 0) quality = { ...quality, pass: false };
    }

    ctx.phase("Accept");
    const finalGate = await ctx.check("coverage:final", {
      exec: ["node", ".weft/scripts/measure-coverage.mjs", ...args],
      required: true,
      timeout: "10m",
    });
    if (finalGate.status !== "pass" || !current.passed || !quality.pass) {
      await ctx.note({
        kind: "risk",
        text: "Weft coverage failed closed",
        evidence: [
          finalGate.evidence ?? "final coverage command failed",
          current.failure,
          ...quality.findings.map((finding) => `${finding.file}: ${finding.message}`),
        ]
          .filter(Boolean)
          .join("\n"),
      });
      throw new Error(`coverage remains below threshold or untrusted after ${round} round(s)`);
    }

    const dedupedChanged = unique(changedFiles).sort(compare);
    const summary = coverageSummary(current, thresholds, quality.summary);
    await ctx.note({
      kind: "claim",
      text: "Weft coverage thresholds and generated-test quality passed",
      evidence: summary,
    });
    const output: z.infer<typeof WorkflowOutput> = {
      sourceSha,
      baseline,
      final: current,
      rounds: round,
      changedFiles: dedupedChanged,
      qualityVerified: quality.pass,
      summary,
    };
    return output;
  },
);

async function measure(ctx: Ctx, args: string[], key: string): Promise<CoverageMeasurement> {
  return ctx.exec("node", [".weft/scripts/measure-coverage.mjs", ...args], {
    schema: CoverageMeasurement,
    key,
    timeout: "10m",
  });
}

function measurementArgs(
  include: string[],
  exclude: string[],
  thresholds: z.infer<typeof Thresholds>,
): string[] {
  return [
    "--statements",
    String(thresholds.statements),
    "--branches",
    String(thresholds.branches),
    "--functions",
    String(thresholds.functions),
    "--lines",
    String(thresholds.lines),
    ...include.flatMap((pattern) => ["--include", pattern]),
    ...exclude.flatMap((pattern) => ["--exclude", pattern]),
  ];
}

function bootstrapPrompt(measurement: CoverageMeasurement): string {
  return [
    "Bootstrap the missing coverage provider for this Weft monorepo.",
    "Read package.json, pnpm-lock.yaml, and the installed Vitest version. Add the matching @vitest/coverage-v8",
    "development dependency at the workspace root using pnpm so both manifest and lockfile stay coherent.",
    "Do not change coverage thresholds, production source, tests, scripts, or unrelated dependencies.",
    "Run the smallest command needed to prove the provider resolves.",
    "",
    `Observed failure:\n${clip(measurement.failure, 12_000)}`,
  ].join("\n");
}

function planPrompt(
  measurement: CoverageMeasurement,
  quality: QualityAudit,
  changedSource: string[],
  maxTargets: number,
  round: number,
): string {
  return [
    `Plan coverage repair round ${round} for Weft. Select at most ${maxTargets} non-overlapping targets.`,
    "Inspect the cited low-coverage files, their current tests, and nearby contracts yourself.",
    "Prioritize changed source, public/runtime invariants, error paths, replay behavior, and meaningful branches.",
    "Do not propose production-code edits, exclusions, ignored lines, threshold reductions, snapshot-only tests,",
    "assertion-free execution, or tests that merely duplicate implementation details.",
    "",
    `Changed source since the requested base:\n${lines(changedSource, "(none)")}`,
    `Coverage measurement:\n${clip(JSON.stringify(measurement, null, 2), 40_000)}`,
    `Prior quality audit:\n${clip(JSON.stringify(quality, null, 2), 16_000)}`,
  ].join("\n");
}

function testPrompt(
  target: z.infer<typeof CoverageTarget>,
  measurement: CoverageMeasurement,
  quality: QualityAudit,
): string {
  return [
    `Add focused behavioral tests for coverage target ${target.id} (${target.priority}).`,
    `Source files: ${target.sourceFiles.join(", ")}.`,
    `Candidate test files: ${target.testFiles.join(", ") || "choose the nearest existing test suite"}.`,
    `Required behaviors:\n${lines(target.behaviors, "(none)")}`,
    `Rationale: ${target.rationale}`,
    "",
    "Read the current source and tests. Exercise observable contracts and meaningful branches, including failures where relevant.",
    "Tests must fail if the intended behavior regresses. Do not edit production code, coverage configuration, manifests,",
    "thresholds, ignore directives, or unrelated tests. Run the focused tests you changed before finishing.",
    "",
    `Current totals: ${JSON.stringify(measurement.totals)}`,
    `Unresolved quality findings: ${clip(JSON.stringify(quality.findings), 8_000)}`,
  ].join("\n");
}

function auditPrompt(changedFiles: string[], measurement: CoverageMeasurement): string {
  return [
    "Independently audit the tests generated by this coverage round. Read each changed test and the production source it targets.",
    "Reject tests that merely execute code, mirror implementation, assert snapshots without behavior, mock away the contract,",
    "depend on ordering or timing accidentally, or can pass while the claimed behavior is broken. Do not report style preferences.",
    "Set pass=true only when findings is empty and every new assertion provides meaningful regression protection.",
    "",
    `Changed test files:\n${lines(changedFiles, "(none; fail because no test patch was integrated)")}`,
    `Post-change coverage:\n${clip(JSON.stringify(measurement, null, 2), 32_000)}`,
  ].join("\n");
}

function assertUniqueTargets(targets: Array<z.infer<typeof CoverageTarget>>): void {
  const ids = new Set<string>();
  for (const target of targets) {
    if (ids.has(target.id)) throw new Error(`coverage target id must be unique: ${target.id}`);
    ids.add(target.id);
  }
}

function assertIntegratedWhenChanged(
  key: string,
  files: string[],
  merged: string[],
  quarantined: string[],
): void {
  if (files.length === 0) return;
  if (!merged.includes(key) || quarantined.includes(key)) {
    throw new Error(`${key} changed files but its patch was not integrated`);
  }
}

function coverageSummary(
  measurement: CoverageMeasurement,
  thresholds: z.infer<typeof Thresholds>,
  qualitySummary: string,
): string {
  const totals = measurement.totals;
  return [
    `statements ${totals.statements.pct}% >= ${thresholds.statements}%`,
    `branches ${totals.branches.pct}% >= ${thresholds.branches}%`,
    `functions ${totals.functions.pct}% >= ${thresholds.functions}%`,
    `lines ${totals.lines.pct}% >= ${thresholds.lines}%`,
    qualitySummary,
  ].join("; ");
}

function isCoveredSource(path: string): boolean {
  return (
    (path.startsWith("packages/") && path.includes("/src/") && path.endsWith(".ts")) ||
    (path.startsWith("apps/ui/src/") && (path.endsWith(".ts") || path.endsWith(".tsx")))
  );
}

function lines(values: string[], empty: string): string {
  return values.length === 0 ? empty : values.map((value) => `- ${value}`).join("\n");
}

function clip(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max)}\n...[truncated]`;
}

function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
