import {
  type CheckCommand,
  type ContextSnapshotOf,
  defineAgent,
  defineArtifact,
  defineCheck,
  defineCheckSuite,
  defineContextSource,
  defineDelivery,
  definePathPolicy,
  definePrompt,
  defineReview,
  defineWorkflow,
  type ReviewCtx,
  type WorkspaceCtx,
  z,
} from "../../index.ts";

const MigrationRequestSchema = z
  .object({
    repository: z.string().min(1),
    dependency: z.string().min(1),
    targetVersion: z.string().min(1),
    packageScope: z.array(z.string().min(1)).min(1).optional(),
  })
  .strict();
const RepositoryPackageSchema = z
  .object({ name: z.string().min(1), path: z.string().min(1), usesDependency: z.boolean() })
  .strict();
const RepositoryStateSchema = z
  .object({
    repository: z.string().min(1),
    defaultBranch: z.string().min(1),
    headSha: z.string().min(1),
    packageManager: z.literal("pnpm"),
    packages: z.array(RepositoryPackageSchema).min(1),
  })
  .strict();
const PackageReleaseSchema = z
  .object({
    name: z.string().min(1),
    version: z.string().min(1),
    deprecated: z.boolean(),
    breaking: z.boolean(),
    migrationNotes: z.array(z.string()),
  })
  .strict();
const ReviewFindingSchema = z
  .object({ code: z.string().min(1), message: z.string().min(1), path: z.string().optional() })
  .strict();
const MigrationPlanSchema = z
  .object({
    affectedPackages: z.array(z.string().min(1)).min(1),
    breaking: z.boolean(),
    rationale: z.string().min(1),
    steps: z.array(z.string().min(1)).min(1),
  })
  .strict();
const ImplementationReportSchema = z
  .object({ summary: z.string().min(1), compatibilityNotes: z.array(z.string()) })
  .strict();
const ImplementationInputSchema = z
  .object({
    request: MigrationRequestSchema,
    repository: RepositoryStateSchema,
    release: PackageReleaseSchema,
    plan: MigrationPlanSchema,
    blockingFindings: z.array(ReviewFindingSchema),
  })
  .strict();
const ReviewInputSchema = z
  .object({
    request: MigrationRequestSchema,
    baseHead: z.string().min(1),
    candidateHead: z.string().min(1),
    plan: MigrationPlanSchema,
    changedFiles: z.array(z.string().min(1)).min(1),
  })
  .strict();
const ReviewEvaluationSchema = z.object({
  assessments: z.array(
    z.object({
      finding: ReviewFindingSchema,
      disposition: z.enum(["blocking", "advisory", "refuted"]),
      sources: z.array(z.string().min(1)).min(1),
      rationale: z.string().min(1),
    }),
  ),
  summary: z.string().min(1),
});
const MigrationDossierSchema = z.object({
  request: MigrationRequestSchema,
  plan: MigrationPlanSchema,
  changedFiles: z.array(z.string().min(1)).min(1),
  candidate: z.object({
    branch: z.string().min(1),
    head: z.string().min(1),
  }),
});
const DeliveryInputSchema = z.object({
  repository: z.string().min(1),
  baseBranch: z.string().min(1),
  expectedBaseHead: z.string().min(1),
  branch: z.string().min(1),
  head: z.string().min(1),
  dossierRef: z.string().min(1),
  dossierSha256: z.string().min(1),
});
const DeliveryOutputSchema = z.object({
  pullRequestNumber: z.number().int().positive(),
  url: z.string().url(),
});
const MigrationOutputSchema = z.object({
  branch: z.string().min(1),
  head: z.string().min(1),
  dossierRef: z.string().min(1),
  pullRequestNumber: z.number().int().positive(),
  pullRequestUrl: z.string().url(),
});

/** Why: Names caller routing input without treating it as repository authority. Use: Verify it against both host sources. */
type MigrationRequest = z.infer<typeof MigrationRequestSchema>;

/** Why: Carries canonical package paths into write-policy resolution. Use: Never accept a model-generated path. */
type RepositoryPackage = z.infer<typeof RepositoryPackageSchema>;

/** Why: Names canonical registry metadata used to build a deterministic plan. Use: Keep model output out of scope selection. */
type PackageRelease = z.infer<typeof PackageReleaseSchema>;

/** Why: Keeps the validated plan stable across writing, review, evidence, and delivery. Use: Validate its names first. */
type MigrationPlan = z.infer<typeof MigrationPlanSchema>;

/** Why: Gives bounded rework the review's exact blocker shape. Use: Pass only blocking findings to the writer. */
type ReviewFinding = z.infer<typeof ReviewFindingSchema>;

/** Why: Names input bound to one committed candidate. Use: Rebuild it after rework changes the head. */
type ReviewInput = z.infer<typeof ReviewInputSchema>;
/** Why: Restricts writer helpers to the workflow-owned isolated tree. Use: Do not pass a plain run context. */
type MigrationWorkspace = WorkspaceCtx;
const repositorySource = defineContextSource({
  name: "refined-dependency-repository",
  input: z.object({ repository: z.string(), dependency: z.string() }),
  output: RepositoryStateSchema,
  binding: "repository.inventory",
  freshness: { maxAge: "5m", stale: "reject" },
  trust: { minimum: "authoritative", authorities: ["code-host"] },
});
const releaseSource = defineContextSource({
  name: "refined-dependency-release",
  input: z.object({ dependency: z.string(), version: z.string() }),
  output: PackageReleaseSchema,
  binding: "package-registry.release",
  freshness: { maxAge: "15m", stale: "reject" },
  trust: { minimum: "authoritative", authorities: ["package-registry"] },
});
/** Why: Retains source-specific provenance after bounded parallel discovery. Use: Supply it to agents and artifacts. */
interface DiscoveryBundle {
  repository: ContextSnapshotOf<typeof repositorySource>;
  release: ContextSnapshotOf<typeof releaseSource>;
}
/** Why: Preserves either exact snapshot through one bounded parallel result. Use: Narrow by its literal source name. */
type DiscoverySnapshot = DiscoveryBundle["repository"] | DiscoveryBundle["release"];

/** Why: Compensates for broad returned trust metadata. Use: Guard every consequential consumer of system-of-record data. */
function requireAuthority(snapshot: DiscoverySnapshot, authority: string): void {
  if (snapshot.trust.level !== "authoritative" || snapshot.trust.authority !== authority) {
    throw new Error(`Expected authoritative context from ${authority}`);
  }
}
/** Why: Resolves independent repository and registry facts in bounded parallel lanes. Use: Run before planning and review. */
async function discoverContext(
  ctx: Pick<ReviewCtx, "context" | "parallel">,
  request: MigrationRequest,
  key: string,
): Promise<DiscoveryBundle> {
  const snapshots = await ctx.parallel.all(
    ["repository", "release"] as const,
    async (query, lane): Promise<DiscoverySnapshot> =>
      query === "repository"
        ? lane.context(
            repositorySource,
            { repository: request.repository, dependency: request.dependency },
            { key: "read" },
          )
        : lane.context(
            releaseSource,
            { dependency: request.dependency, version: request.targetVersion },
            { key: "read" },
          ),
    {
      key,
      keyOf: (query) => query,
      concurrency: 2,
    },
  );
  let repository: DiscoveryBundle["repository"] | undefined;
  let release: DiscoveryBundle["release"] | undefined;
  for (const snapshot of snapshots) {
    if (snapshot.source === repositorySource.name) repository = snapshot;
    else release = snapshot;
  }
  if (repository === undefined || release === undefined) throw new Error("Incomplete discovery");
  requireAuthority(repository, "code-host");
  requireAuthority(release, "package-registry");
  if (repository.value.repository !== request.repository) throw new Error("Repository identity mismatch");
  if (release.value.name !== request.dependency || release.value.version !== request.targetVersion) {
    throw new Error("Release identity mismatch");
  }
  if (release.value.deprecated) throw new Error("Refusing a deprecated release");
  return { repository, release };
}
/** Why: Limits planning to canonical direct dependents or an explicit known scope. Use: Reject empty or unknown scope. */
function eligiblePackages(
  request: MigrationRequest,
  packages: readonly RepositoryPackage[],
): RepositoryPackage[] {
  const byName = new Map(packages.map((item) => [item.name, item]));
  const names =
    request.packageScope ?? packages.filter((item) => item.usesDependency).map((item) => item.name);
  const selected = names.map((name) => byName.get(name));
  if (selected.length === 0 || selected.some((item) => item === undefined)) {
    throw new Error("Migration scope is empty or unknown");
  }
  return selected as RepositoryPackage[];
}
/** Why: Builds scope deterministically from authoritative facts rather than model-selected paths. Use: Pass it unchanged through writing and review. */
function buildPlan(
  request: MigrationRequest,
  release: PackageRelease,
  packages: readonly RepositoryPackage[],
): MigrationPlan {
  return {
    affectedPackages: packages.map((item) => item.name),
    breaking: release.breaking,
    rationale: `Upgrade ${request.dependency} to registry release ${release.version}`,
    steps:
      release.migrationNotes.length === 0
        ? ["Update manifests and lockfile", "Apply required compatibility edits"]
        : release.migrationNotes,
  };
}
/** Why: Derives write proposals solely from authoritative paths. Use: Resolve again after writes change generation. */
function proposedPaths(packages: readonly RepositoryPackage[]): string[] {
  return [
    "package.json",
    "pnpm-lock.yaml",
    ...packages.flatMap((item) => (item.path === "." ? [] : [`${item.path}/**`])),
  ];
}
const writePolicy = definePathPolicy({
  name: "refined-dependency-writes",
  revision: "v1",
  roots: ["package.json", "pnpm-lock.yaml", "packages", "apps"],
  deny: ["**/.git/**", "**/node_modules/**", "**/dist/**"],
  grantTtl: "45m",
});
const implementationPrompt = definePrompt({
  name: "refined-dependency-implementation",
  input: ImplementationInputSchema,
  render: (input) => [
    `Upgrade exactly to ${input.request.dependency}@${input.request.targetVersion}.`,
    `Plan: ${JSON.stringify(input.plan)}`,
    `Blocking rework: ${JSON.stringify(input.blockingFindings)}`,
    "Update the pnpm lockfile; do not commit, push, or weaken checks.",
  ],
});
const implementer = defineAgent({
  name: "refined-dependency-implementer",
  prompt: implementationPrompt,
  schema: ImplementationReportSchema,
  defaults: { maxTurns: 24, timeout: "35m", repair: 1 },
});
/** Why: Keeps every migration command required and unwaivable. Use: Define the fixed candidate suite without repetition. */
function requiredCommand<const Name extends string>(name: Name, command: CheckCommand) {
  return defineCheck({ name, command, policy: "required", waiver: { mode: "never" } });
}
const typecheck = requiredCommand("refined-dependency-typecheck", ["pnpm", "-r", "typecheck"]);
const tests = requiredCommand("refined-dependency-tests", ["pnpm", "-r", "test"]);
const lockfile = requiredCommand("refined-dependency-lockfile", [
  "pnpm",
  "install",
  "--lockfile-only",
  "--frozen-lockfile",
  "--ignore-scripts",
]);
const checks = defineCheckSuite({
  name: "refined-dependency-quality",
  checks: [lockfile, typecheck, tests],
  concurrency: 2,
});
const reviewPrompt = definePrompt({
  name: "refined-dependency-review",
  input: ReviewInputSchema,
  render: (input) => [
    `Review candidate ${input.candidateHead} against base ${input.baseHead}.`,
    `Plan: ${JSON.stringify(input.plan)}`,
    `Changed files: ${input.changedFiles.join(", ")}`,
    "Mark only actionable correctness or scope defects as blocking.",
  ],
});
const reviewer = defineAgent({
  name: "refined-dependency-reviewer",
  prompt: reviewPrompt,
  schema: ReviewEvaluationSchema,
  defaults: { maxTurns: 14, timeout: "15m" },
});
const review = defineReview({
  name: "refined-dependency-candidate-review",
  input: ReviewInputSchema,
  finding: ReviewFindingSchema,
  evaluate: async (ctx, input) => {
    const current = await discoverContext(ctx, input.request, "review-context");
    if (current.repository.value.headSha !== input.baseHead) throw new Error("Base advanced before review");
    const result = await ctx.agent(reviewer, input, {
      key: "review-agent",
      context: [current.repository, current.release],
    });
    return {
      ...result.value,
      sourceEvidence: [current.repository.evidence, current.release.evidence],
    };
  },
  accept: (result) => result.assessments.every((item) => item.disposition !== "blocking"),
});
/** Why: Applies one path-authorized writer pass and commits only engine-reported files. Use: Invoke once initially and once for rework. */
async function writeAndCommit(
  ctx: MigrationWorkspace,
  request: MigrationRequest,
  discovery: DiscoveryBundle,
  plan: MigrationPlan,
  packages: readonly RepositoryPackage[],
  findings: readonly ReviewFinding[],
  key: string,
) {
  ctx.cancellation.throwIfRequested();
  const scope = await ctx.paths.resolve(
    writePolicy,
    { proposedPaths: proposedPaths(packages) },
    { key: `${key}:paths` },
  );
  const result = await ctx.agent(
    implementer,
    {
      request,
      repository: discovery.repository.value,
      release: discovery.release.value,
      plan,
      blockingFindings: [...findings],
    },
    {
      key,
      context: [discovery.repository, discovery.release],
      write: scope,
    },
  );
  const paths = [...new Set(result.files)];
  if (paths.length === 0) throw new Error("Writer produced no changes");
  await ctx.git.add({ key: `${key}:git-add`, paths });
  const commit = await ctx.git.commit({
    key: `${key}:git-commit`,
    message: `${key === "implement" ? "chore" : "fix"}(deps): ${request.dependency} ${request.targetVersion}`,
    paths,
  });
  return commit.sha;
}
/** Why: Binds required checks and review to one candidate generation. Use: Repeat after rework creates a new generation. */
async function verifyCandidate(ctx: MigrationWorkspace, input: ReviewInput, key: string) {
  const snapshot = ctx.workspace.snapshot;
  const quality = await ctx.check(checks, {
    key: `${key}:checks`,
    policy: "required",
    candidate: snapshot,
  });
  if (!quality.passed) throw new Error("Required checks failed");
  const assessment = await ctx.review(review, input, { key: `${key}:review`, candidate: snapshot });
  return { snapshot, quality, assessment };
}
const dossierDefinition = defineArtifact({
  name: "refined-dependency-dossier",
  mediaType: "application/json",
  extension: ".json",
  content: MigrationDossierSchema,
});
const pullRequest = defineDelivery({
  name: "refined-dependency-pull-request",
  binding: "code-host.pull-request",
  input: DeliveryInputSchema,
  output: DeliveryOutputSchema,
  capabilities: ["git:write", "network", "integration:code-host"],
  defaults: {
    timeout: "10m",
    attempts: 2,
    authorization: { action: "Publish verified dependency migration", risk: "high" },
  },
});
/** Why: Produces a stable Git-safe branch segment. Use: Repository authority still comes from the host target binding. */
function segment(value: string): string {
  return (
    value
      .toLowerCase()
      .replaceAll(/[^a-z0-9]+/g, "-")
      .replaceAll(/^-|-$/g, "") || "unknown"
  );
}
/** Why: Demonstrates the shortest sound path from authoritative discovery to exact-candidate delivery. Use: Launch one exact package migration. */
const dependencyMigrationWorkflow = defineWorkflow(
  {
    id: "refined-dependency-migration",
    input: MigrationRequestSchema,
    output: MigrationOutputSchema,
    workspace: ({ input }) => ({
      branch: `deps/${segment(input.dependency)}-${segment(input.targetVersion)}`,
      target: { binding: "repository.checkout", repository: input.repository },
    }),
  },
  async (ctx, input) => {
    const discovery = await discoverContext(ctx, input, "initial-context");
    if (ctx.workspace.head !== discovery.repository.value.headSha) throw new Error("Workspace head mismatch");

    const eligible = eligiblePackages(input, discovery.repository.value.packages);
    const plan = buildPlan(input, discovery.release.value, eligible);
    let head = await writeAndCommit(ctx, input, discovery, plan, eligible, [], "implement");
    let changed = await ctx.git.changedSince(discovery.repository.value.headSha, {
      key: "initial-changed-since-base",
    });
    let reviewInput: ReviewInput = {
      request: input,
      baseHead: discovery.repository.value.headSha,
      candidateHead: head,
      plan,
      changedFiles: changed.files.map((file) => file.path),
    };
    let candidate = await verifyCandidate(ctx, reviewInput, "initial");

    if (candidate.assessment.status === "rework") {
      const repaired = await writeAndCommit(
        ctx,
        input,
        discovery,
        plan,
        eligible,
        candidate.assessment.blocking,
        "rework",
      );
      head = repaired;
      changed = await ctx.git.changedSince(discovery.repository.value.headSha, {
        key: "rework-changed-since-base",
      });
      reviewInput = {
        ...reviewInput,
        candidateHead: head,
        changedFiles: changed.files.map((file) => file.path),
      };
      candidate = await verifyCandidate(ctx, reviewInput, "rework");
    }
    if (candidate.assessment.status !== "accepted") throw new Error("Review still requires rework");
    const status = await ctx.git.status({ key: "delivery-git-status" });
    if (!status.clean || status.branch !== ctx.workspace.branch || changed.files.length === 0) {
      throw new Error("Delivery requires a clean, non-empty workflow branch");
    }
    const dossier = await ctx.artifact(
      dossierDefinition,
      {
        content: {
          request: input,
          plan,
          changedFiles: changed.files.map((file) => file.path),
          candidate: {
            branch: ctx.workspace.branch,
            head,
          },
        },
      },
      {
        key: "dossier",
        candidate: candidate.snapshot,
        sources: [
          discovery.repository.evidence,
          discovery.release.evidence,
          ...candidate.assessment.sourceEvidence,
          candidate.quality.attestation,
          candidate.assessment.attestation,
        ],
      },
    );

    ctx.cancellation.throwIfRequested();
    const delivered = await ctx.delivery(
      pullRequest,
      {
        repository: input.repository,
        baseBranch: discovery.repository.value.defaultBranch,
        expectedBaseHead: discovery.repository.value.headSha,
        branch: ctx.workspace.branch,
        head,
        dossierRef: dossier.ref,
        dossierSha256: dossier.sha256,
      },
      {
        key: "publish-pull-request",
        candidate: candidate.snapshot,
        proofs: [candidate.quality.proof, candidate.assessment.proof],
        artifacts: [dossier],
        authorization: { detail: `Publish checked and reviewed commit ${head}.` },
        attempts: 2,
      },
    );
    return {
      branch: ctx.workspace.branch,
      head,
      dossierRef: dossier.ref,
      pullRequestNumber: delivered.value.pullRequestNumber,
      pullRequestUrl: delivered.value.url,
    };
  },
);

void dependencyMigrationWorkflow;

// Runtime identity checks still defend external values even though source policy literals are preserved statically.
