import { z } from "zod";

import {
  type CheckCommand,
  type CheckExecutionResult,
  type CheckResult,
  type CommandCheckEvidence,
  type CommandResult,
  defineAgent,
  defineArtifact,
  defineCheck,
  defineCheckSuite,
  defineGoal,
  definePathPolicy,
  definePrompt,
  defineWorkflow,
} from "../../core/index.ts";

// This example deliberately uses a workflow-owned branch. The implementation
// agent writes into that durable workspace, so its successful result has no
// detached patch to integrate.

const DependencyMigrationInput = z.object({
  dependency: z.string().min(1),
  targetVersion: z.string().min(1),
  baseRef: z.string().min(1).default("main"),
  packageScope: z.array(z.string().min(1)).min(1).optional(),
});

const dependencyMigrationPaths = definePathPolicy({
  name: "dependency-migration-paths",
  description: "Limits dependency upgrades to monorepo manifests, lockfile, apps, and packages.",
  revision: "v1",
  roots: ["package.json", "pnpm-lock.yaml", "apps", "packages"],
  deny: ["**/node_modules/**"],
  grantTtl: "1h",
});

const WorkspacePackage = z.object({
  name: z.string().min(1),
  path: z.string().min(1),
});

const WorkspaceGraph = z.array(WorkspacePackage);

const RegistryRelease = z.object({
  name: z.string().min(1),
  version: z.string().min(1),
  deprecated: z.string().nullable().optional(),
  peerDependencies: z.record(z.string(), z.string()).default({}),
});

const PackageTarget = z.object({
  name: z.string().min(1),
  path: z.string().min(1),
  testPattern: z.string().min(1).optional(),
  migrationNotes: z.array(z.string()),
});

const MigrationPlan = z.object({
  affectedPackages: z.array(PackageTarget).min(1),
  breaking: z.boolean(),
  confidence: z.enum(["high", "medium", "low"]),
  rationale: z.string().min(1),
  releaseNotes: z.array(z.string()),
});

const MigrationAnalysisInput = z.object({
  dependency: z.string().min(1),
  targetVersion: z.string().min(1),
  requestedPackages: z.array(z.string()),
  release: RegistryRelease,
  workspace: WorkspaceGraph,
});

const MigrationImplementationInput = z.object({
  dependency: z.string().min(1),
  targetVersion: z.string().min(1),
  packageManager: z.literal("pnpm"),
  release: RegistryRelease,
  plan: MigrationPlan,
});

const MigrationEdit = z.object({
  summary: z.string().min(1),
  manifestsUpdated: z.array(z.string()),
  sourceFilesUpdated: z.array(z.string()),
  installCommand: z.string().min(1),
});

const PackageCheckInput = z.object({
  packageName: z.string().min(1),
  testPattern: z.string().min(1).optional(),
});

const MigrationQualityInput = z.object({
  packages: z.array(PackageTarget).min(1),
});

const CheckSummary = z.object({
  name: z.string().min(1),
  status: z.enum(["pass", "fail"]),
  disposition: z.enum(["executed", "trusted", "waived"]),
  summary: z.string(),
});

const ChangedFile = z.object({
  path: z.string().min(1),
  status: z.enum(["A", "M", "D", "R"]),
});

const MigrationEvidenceContent = z.object({
  release: RegistryRelease,
  plan: MigrationPlan,
  implementation: MigrationEdit,
  verification: z.object({
    passed: z.boolean(),
    attempts: z.number().int().positive(),
    goalEvidence: z.string(),
    checks: z.array(CheckSummary),
  }),
  changedFiles: z.array(ChangedFile),
  commit: z.string().min(1),
});

const MigrationEvidenceMetadata = z.object({
  dependency: z.string().min(1),
  targetVersion: z.string().min(1),
  branch: z.string().min(1),
  workspaceId: z.string().min(1),
  workspaceGeneration: z.number().int().nonnegative(),
});

const DependencyMigrationOutput = z.object({
  dependency: z.string().min(1),
  targetVersion: z.string().min(1),
  branch: z.string().min(1),
  commit: z.string().min(1),
  affectedPackages: z.array(z.string()),
  breaking: z.boolean(),
  evidenceRef: z.string().min(1),
  evidenceSha256: z.string().min(1),
  summary: z.string().min(1),
});

/**
 * Why: Names the parsed workspace graph entry used to reject planner hallucinations.
 * Use: Supply values returned by the schema-validated workspace discovery command.
 */
type WorkspacePackageValue = z.infer<typeof WorkspacePackage>;

/**
 * Why: Names the validated plan shared by approval, implementation, and verification.
 * Use: Pass the analysis agent result through the rest of the workflow without rebuilding its shape.
 */
type MigrationPlanValue = z.infer<typeof MigrationPlan>;

/**
 * Why: Names one affected package so check inputs can preserve optional test patterns safely.
 * Use: Convert it with `toPackageCheckInput` before binding package checks.
 */
type PackageTargetValue = z.infer<typeof PackageTarget>;

/**
 * Why: Names the exact raw input expected by each package-level check.
 * Use: Return it from `toPackageCheckInput` instead of relying on an inline object type.
 */
type PackageCheckInputValue = z.input<typeof PackageCheckInput>;

/**
 * Why: Names the compact check projection stored in the immutable evidence artifact.
 * Use: Return it from `summarizeChecks` after the implementation goal succeeds.
 */
type CheckSummaryValue = z.infer<typeof CheckSummary>;

/**
 * Why: Produces a deterministic Git-safe branch segment from untrusted workflow input.
 * Use: Build the workflow-owned dependency branch in `workspace` metadata.
 */
function toBranchSegment(value: string): string {
  const segment = value
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, "-")
    .replaceAll(/^-|-$/g, "");
  return segment || "unknown";
}

/**
 * Why: Preserves exact optional-property semantics when a package has no focused test pattern.
 * Use: Bind the result to lint, typecheck, and test check definitions.
 */
function toPackageCheckInput(target: PackageTargetValue): PackageCheckInputValue {
  return target.testPattern === undefined
    ? { packageName: target.name }
    : { packageName: target.name, testPattern: target.testPattern };
}

/**
 * Why: Makes every package command use the same argument-array form and avoids shell interpolation.
 * Use: Construct lint, typecheck, and test commands for one pnpm workspace package.
 */
function pnpmPackageCommand(
  packageName: string,
  script: "lint" | "typecheck" | "test",
  trailingArguments: readonly string[] = [],
): CheckCommand {
  return ["pnpm", "--filter", packageName, script, ...trailingArguments];
}

/**
 * Why: Normalizes process output into structured, durable check evidence.
 * Use: Reuse it as the parser for every package command check.
 */
function parseCommandResult(result: CommandResult): CheckExecutionResult<readonly CommandCheckEvidence[]> {
  const output = [result.stdout, result.stderr].filter(Boolean).join("\n");
  const evidence: CommandCheckEvidence = {
    kind: "command",
    exitCode: result.exitCode,
    ...(output === "" ? {} : { output }),
  };

  return {
    status: result.exitCode === 0 ? "pass" : "fail",
    summary: result.exitCode === 0 ? "Command passed" : `Command failed with exit ${result.exitCode}`,
    evidence: output,
    details: [evidence],
  };
}

/**
 * Why: Keeps agent writes bounded to manifests, the lockfile, and packages named by validated analysis.
 * Use: Pass the returned paths to the implementation agent's strict write scope.
 */
function migrationWritePaths(plan: MigrationPlanValue): string[] {
  return [
    "package.json",
    "pnpm-lock.yaml",
    "packages/**/package.json",
    ...plan.affectedPackages.map((target) => `${target.path}/**`),
  ];
}

/**
 * Why: Prevents a model-generated package path from silently expanding mutation authority.
 * Use: Validate the plan against the journaled workspace graph before approval or edits.
 */
function assertKnownPackages(plan: MigrationPlanValue, workspace: readonly WorkspacePackageValue[]): void {
  const knownPackages = new Map(workspace.map((entry) => [entry.name, entry.path]));
  const unknownTarget = plan.affectedPackages.find(
    (target) => knownPackages.get(target.name) !== target.path,
  );

  if (unknownTarget !== undefined) {
    throw new Error(
      `Analysis returned an unknown package path: ${unknownTarget.name} at ${unknownTarget.path}`,
    );
  }
}

/**
 * Why: Escalates only migrations whose compatibility risk cannot be accepted automatically.
 * Use: Request explicit human approval for breaking or low-confidence plans.
 */
function needsHumanApproval(plan: MigrationPlanValue): boolean {
  return plan.breaking || plan.confidence === "low";
}

/**
 * Why: Projects a dynamic suite result into stable, artifact-friendly evidence entries.
 * Use: Store the named verdicts without coupling the artifact schema to mapped suite-member types.
 */
function summarizeChecks(results: Readonly<Record<string, CheckResult>>): CheckSummaryValue[] {
  return Object.entries(results).map(([name, result]) => ({
    name,
    status: result.status,
    disposition: result.disposition,
    summary: result.summary ?? "No summary was returned",
  }));
}

const migrationAnalysisPrompt = definePrompt({
  name: "dependency-migration-analysis",
  input: MigrationAnalysisInput,
  render: (input) => [
    "Analyze this dependency upgrade before any files are changed.",
    `Dependency: ${input.dependency}@${input.targetVersion}`,
    `Registry metadata: ${JSON.stringify(input.release)}`,
    `Requested package scope: ${input.requestedPackages.join(", ") || "auto-detect"}`,
    `Workspace packages: ${JSON.stringify(input.workspace)}`,
    "Return only packages from the supplied workspace graph and explain migration-sensitive changes.",
  ],
});

const dependencyMigrationAnalyst = defineAgent({
  name: "dependency-migration-analyst",
  description: "Plans a repository-grounded dependency upgrade without modifying files.",
  prompt: migrationAnalysisPrompt,
  schema: MigrationPlan,
  defaults: { maxTurns: 12, timeout: "15m" },
});

const migrationImplementationPrompt = definePrompt({
  name: "dependency-migration-implementation",
  input: MigrationImplementationInput,
  render: (input) => [
    `Upgrade ${input.dependency} to exactly ${input.targetVersion} with ${input.packageManager}.`,
    `Validated release metadata: ${JSON.stringify(input.release)}`,
    `Approved migration plan: ${JSON.stringify(input.plan)}`,
    "Update manifests and the lockfile, make only required source migrations, and keep changes minimal.",
    "Do not commit, push, or weaken checks. The workflow owns Git delivery and verification.",
  ],
});

const dependencyMigrationDeveloper = defineAgent({
  name: "dependency-migration-developer",
  description: "Applies a bounded dependency and source migration in the workflow workspace.",
  prompt: migrationImplementationPrompt,
  schema: MigrationEdit,
  defaults: { maxTurns: 30, timeout: "45m", repair: 1 },
});

const packageLint = defineCheck({
  name: "package-lint",
  description: "Runs repository lint policy for one affected package.",
  revision: "pnpm-filter-v1",
  policy: "required",
  defaults: { timeout: "5m" },
  input: PackageCheckInput,
  command: ({ packageName }) => pnpmPackageCommand(packageName, "lint"),
  parse: parseCommandResult,
});

const packageTypecheck = defineCheck({
  name: "package-typecheck",
  description: "Runs strict TypeScript validation for one affected package.",
  revision: "pnpm-filter-v1",
  policy: "required",
  defaults: { timeout: "10m" },
  input: PackageCheckInput,
  command: ({ packageName }) => pnpmPackageCommand(packageName, "typecheck"),
  parse: parseCommandResult,
});

const packageTests = defineCheck({
  name: "package-tests",
  description: "Runs the package test suite or an explicitly focused migration pattern.",
  revision: "pnpm-filter-v1",
  policy: "required",
  defaults: { timeout: "20m" },
  input: PackageCheckInput,
  command: ({ packageName, testPattern }) =>
    pnpmPackageCommand(packageName, "test", testPattern === undefined ? [] : [testPattern]),
  parse: parseCommandResult,
});

const migrationQuality = defineCheckSuite({
  name: "dependency-migration-quality",
  description: "Keeps lint, typecheck, and tests independently visible for every affected package.",
  input: MigrationQualityInput,
  checks: ({ packages }, use) =>
    Object.fromEntries(
      packages.flatMap((target) => {
        const checkInput = toPackageCheckInput(target);
        return [
          [`${target.name}:lint`, use(packageLint, checkInput)],
          [`${target.name}:typecheck`, use(packageTypecheck, checkInput)],
          [`${target.name}:tests`, use(packageTests, checkInput)],
        ];
      }),
    ),
  concurrency: 4,
});

const migrationGoal = defineGoal({
  name: "dependency-migration-complete",
  check: migrationQuality,
  defaults: { attempts: 3 },
});

const migrationEvidence = defineArtifact({
  name: "dependency-migration-evidence",
  mediaType: "application/json",
  extension: ".json",
  content: MigrationEvidenceContent,
  metadata: MigrationEvidenceMetadata,
});

/**
 * Why: Demonstrates a complete dependency migration with analysis, bounded edits, per-package proof, and provenance.
 * Use: Launch it with a dependency/version pair; optionally constrain analysis to named workspace packages.
 */
defineWorkflow(
  {
    id: "round-01-dependency-migration",
    name: "Dependency migration",
    description: "Upgrade a monorepo dependency on a workflow-owned branch and retain verification evidence.",
    input: DependencyMigrationInput,
    output: DependencyMigrationOutput,
    workspace: ({ input }) => ({
      branch: `deps/${toBranchSegment(input.dependency)}-${toBranchSegment(input.targetVersion)}`,
      from: input.baseRef,
    }),
  },
  async (ctx, input) => {
    const packageManager =
      (await ctx.env.get("WEFT_PACKAGE_MANAGER", { key: "read-package-manager" })) ?? "pnpm";
    if (packageManager !== "pnpm") {
      throw new Error(`Unsupported package manager: ${packageManager}`);
    }

    const release = await ctx.exec("pnpm", ["view", `${input.dependency}@${input.targetVersion}`, "--json"], {
      key: "registry-release",
      schema: RegistryRelease,
      timeout: "2m",
    });
    const workspace = await ctx.exec("pnpm", ["-r", "list", "--depth", "-1", "--json"], {
      key: "workspace-graph",
      schema: WorkspaceGraph,
      timeout: "2m",
    });

    const analysis = await ctx.step("analyze", (step) =>
      step.agent(
        dependencyMigrationAnalyst,
        {
          dependency: input.dependency,
          targetVersion: input.targetVersion,
          requestedPackages: input.packageScope ?? [],
          release,
          workspace,
        },
        {
          key: "migration-analysis",
        },
      ),
    );
    const plan = analysis.value;
    assertKnownPackages(plan, workspace);

    if (needsHumanApproval(plan)) {
      const approval = await ctx.human.approve({
        key: "approve-risky-migration",
        action: `Apply ${input.dependency}@${input.targetVersion} migration`,
        detail: `${plan.rationale}\n\nAffected packages: ${plan.affectedPackages
          .map((target) => target.name)
          .join(", ")}`,
        timeout: "24h",
        onTimeout: "escalate",
      });

      if (!approval.approved) {
        throw new Error("Dependency migration was not approved");
      }

      await ctx.note({
        key: "record-migration-approval",
        kind: "decision",
        text: "A human approved the breaking or low-confidence dependency migration.",
        evidence: approval.note ?? `Approved by ${approval.reviewer.id}`,
      });
    }

    const implementation = await ctx.step("implement-and-verify", async (step) => {
      const writeScope = await step.paths.resolve(
        dependencyMigrationPaths,
        { proposedPaths: migrationWritePaths(plan) },
        { key: "migration-write-scope", label: "Resolve dependency migration paths" },
      );
      return step.agent(
        dependencyMigrationDeveloper,
        {
          dependency: input.dependency,
          targetVersion: input.targetVersion,
          packageManager,
          release,
          plan,
        },
        {
          key: "migration-implementation",
          write: writeScope,
          goal: {
            definition: migrationGoal,
            input: { packages: plan.affectedPackages },
          },
        },
      );
    });

    const verification = implementation.goal.results.check;
    if (!verification.passed) {
      throw new Error("The implementation goal returned without passing its required quality suite");
    }

    const changed = await ctx.git.changedSince(input.baseRef, {
      key: "migration-changes-since-base",
    });
    if (changed.files.length === 0) {
      throw new Error("The dependency migration produced no repository changes");
    }

    const changedPaths = changed.files.map((file) => file.path);
    await ctx.git.add({ key: "stage-migration-changes", paths: changedPaths });
    const commit = await ctx.git.commit({
      key: "commit-migration",
      message: `chore(deps): upgrade ${input.dependency} to ${input.targetVersion}`,
      paths: changedPaths,
    });

    const evidence = await ctx.artifact(
      migrationEvidence,
      {
        content: {
          release,
          plan,
          implementation: implementation.value,
          verification: {
            passed: verification.passed,
            attempts: implementation.goal.attempts,
            goalEvidence: implementation.goal.evidence,
            checks: summarizeChecks(verification.results),
          },
          changedFiles: changed.files,
          commit: commit.sha,
        },
        metadata: {
          dependency: input.dependency,
          targetVersion: input.targetVersion,
          branch: ctx.workspace.branch,
          workspaceId: ctx.workspace.id,
          workspaceGeneration: ctx.workspace.generation,
        },
      },
      { key: "migration-evidence", label: "Dependency migration proof" },
    );

    await ctx.note({
      key: "record-migration-verification",
      kind: "claim",
      text: `${input.dependency}@${input.targetVersion} passed all required package checks.`,
      evidence: evidence.ref,
    });

    return {
      dependency: input.dependency,
      targetVersion: input.targetVersion,
      branch: ctx.workspace.branch,
      commit: commit.sha,
      affectedPackages: plan.affectedPackages.map((target) => target.name),
      breaking: plan.breaking,
      evidenceRef: evidence.ref,
      evidenceSha256: evidence.sha256,
      summary: implementation.value.summary,
    };
  },
);
