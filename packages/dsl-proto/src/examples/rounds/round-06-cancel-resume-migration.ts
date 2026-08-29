import {
  defineAgent,
  defineCheck,
  defineOperation,
  definePathPolicy,
  definePrompt,
  defineTaskContract,
  defineWorkflow,
  type OperationInputOf,
  type OperationOutputOf,
  type PatchRef,
  type WorkflowNode,
  type WorkflowTaskSummary,
  type WorkspaceWriteAgentResult,
  z,
} from "../../index.ts";

/** Why: Makes compile-time contract assertions visible without adding runtime behavior. Use: Pass inferred DSL values to it in this typechecked example. */
declare function expectType<Type>(value: Type): void;

const VerificationCommand = z.tuple([z.string().min(1)]).rest(z.string());

const CancelResumeMigrationInput = z.object({
  repository: z.string().min(1),
  migrationId: z.string().min(1),
  objective: z.string().min(1),
  baseRef: z.string().min(1).default("main"),
  packageScope: z.array(z.string().min(1)).max(64).default([]),
  batchSize: z.number().int().min(1).max(5).default(4),
  concurrency: z.number().int().min(1).max(3).default(2),
});

const MigrationUnit = z.object({
  id: z.string().min(1),
  ordinal: z.number().int().nonnegative(),
  packageName: z.string().min(1),
  packagePath: z.string().min(1),
  dependsOn: z.array(z.string().min(1)),
  proposedPaths: z.array(z.string().min(1)).min(1).max(16),
  instruction: z.string().min(1),
  verificationCommand: VerificationCommand,
});

const MigrationPlanRequest = z.object({
  repository: z.string().min(1),
  migrationId: z.string().min(1),
  objective: z.string().min(1),
  baseRef: z.string().min(1),
  packageScope: z.array(z.string().min(1)).max(64),
});

const MigrationPlan = z.object({
  repository: z.string().min(1),
  migrationId: z.string().min(1),
  objective: z.string().min(1),
  baseRef: z.string().min(1),
  planDigest: z.string().min(1),
  units: z.array(MigrationUnit).min(1).max(64),
});

/** Why: Names one validated, topologically ordered migration unit. Use: Carry it through batching, task identity, path resolution, editing, and verification. */
type MigrationUnitValue = z.infer<typeof MigrationUnit>;

/** Why: Names the host-discovered migration plan consumed by all later durable effects. Use: Validate its identity and topology before acquiring resources. */
type MigrationPlanValue = z.infer<typeof MigrationPlan>;

const migrationWritePolicy = definePathPolicy({
  name: "round-06-cancel-resume-migration-writes",
  description: "Limits migration writers and final capture to application and package source trees.",
  revision: "v1",
  roots: ["apps", "packages"],
  deny: ["**/.git/**", "**/.weft/**", "**/node_modules/**", "**/dist/**", "**/*.lock"],
  grantTtl: "4h",
});

const discoverMigrationPlan = defineOperation({
  name: "round-06-discover-code-migration-plan",
  description:
    "Reads one exact repository base and returns a bounded, dependency-ordered migration plan with canonical paths.",
  input: MigrationPlanRequest,
  output: MigrationPlan,
  binding: "repository.code-migration.plan",
  capabilities: ["filesystem:read", "git:read", "workspace:read", "process"],
  defaults: { timeout: "10m", attempts: 3 },
  authorization: { mode: "none" },
});

/** Why: Rejects plan drift, duplicate identities, and dependencies that would cross a future batch boundary backward. Use: Call before creating task or workspace state. */
function requireCoherentPlan(
  request: OperationInputOf<typeof discoverMigrationPlan>,
  plan: MigrationPlanValue,
): void {
  if (
    plan.repository !== request.repository ||
    plan.migrationId !== request.migrationId ||
    plan.objective !== request.objective ||
    plan.baseRef !== request.baseRef
  ) {
    throw new Error("Migration plan did not preserve the requested repository identity");
  }

  const ordinals = new Set<number>();
  const unitIds = new Set<string>();
  const unitOrdinals = new Map(plan.units.map((unit) => [unit.id, unit.ordinal]));
  for (const [index, unit] of plan.units.entries()) {
    if (unitIds.has(unit.id) || unit.ordinal !== index || ordinals.has(unit.ordinal)) {
      throw new Error(`Migration unit ${unit.id} has duplicate identity or a non-canonical ordinal`);
    }
    unitIds.add(unit.id);
    ordinals.add(unit.ordinal);

    if (request.packageScope.length > 0 && !request.packageScope.includes(unit.packageName)) {
      throw new Error(`Migration unit ${unit.id} escaped the requested package scope`);
    }
    const packagePrefix = `${unit.packagePath}/`;
    const escapedProposal = unit.proposedPaths.find(
      (path) => path !== unit.packagePath && !path.startsWith(packagePrefix),
    );
    if (escapedProposal !== undefined) {
      throw new Error(`Migration unit ${unit.id} proposed ${escapedProposal} outside its package`);
    }

    const invalidDependency = unit.dependsOn.find((dependency) => {
      const dependencyOrdinal = unitOrdinals.get(dependency);
      return dependencyOrdinal === undefined || dependencyOrdinal >= unit.ordinal;
    });
    if (invalidDependency !== undefined) {
      throw new Error(`Migration unit ${unit.id} has invalid dependency ${invalidDependency}`);
    }
  }
}

/** Why: Splits a validated topology into small sequential checkpoints while preserving unit order. Use: Bound memory, concurrent writers, and replay work independently of total migration size. */
function batchMigrationUnits(
  units: readonly MigrationUnitValue[],
  batchSize: number,
): MigrationUnitValue[][] {
  const batches: MigrationUnitValue[][] = [];
  let batch: MigrationUnitValue[] = [];
  let batchUnitIds = new Set<string>();
  for (const unit of units) {
    const dependsOnCurrentBatch = unit.dependsOn.some((dependency) => batchUnitIds.has(dependency));
    if (batch.length >= batchSize || dependsOnCurrentBatch) {
      batches.push(batch);
      batch = [];
      batchUnitIds = new Set<string>();
    }
    batch.push(unit);
    batchUnitIds.add(unit.id);
  }
  if (batch.length > 0) batches.push(batch);
  return batches;
}

const MigrationAgentInput = z.object({
  repository: z.string().min(1),
  migrationId: z.string().min(1),
  planDigest: z.string().min(1),
  baseRef: z.string().min(1),
  unit: MigrationUnit,
});

const MigrationEdit = z.object({
  unitId: z.string().min(1),
  planDigest: z.string().min(1),
  summary: z.string().min(1),
  changedFiles: z.array(z.string().min(1)).min(1),
  testsChanged: z.array(z.string().min(1)),
  retryClass: z.literal("replay-safe-isolated"),
});

/** Why: Names validated model output separately from its nominal patch envelope. Use: Compare claims against the unit and engine-captured files. */
type MigrationEditValue = z.infer<typeof MigrationEdit>;

const migrationPrompt = definePrompt({
  name: "round-06-migrate-one-code-unit",
  input: MigrationAgentInput,
  render: ({ repository, migrationId, planDigest, baseRef, unit }) => [
    `Implement migration ${migrationId} unit ${unit.id} in ${repository} at ${baseRef}.`,
    `Plan digest: ${planDigest}. Package: ${unit.packageName} at ${unit.packagePath}.`,
    `Instruction: ${unit.instruction}`,
    `Allowed proposed paths: ${unit.proposedPaths.join(", ")}`,
    `Dependencies already composed: ${unit.dependsOn.join(", ") || "none"}.`,
    "Make only repository-local edits, update focused tests, and do not commit, publish, fetch, or call external tools.",
    "Return retryClass replay-safe-isolated; the engine captures this attempt as a detached patch.",
  ],
});

const migrationAgent = defineAgent({
  name: "round-06-bounded-code-migrator",
  description: "Produces one path-bounded detached patch that is safe to retry before composition.",
  prompt: migrationPrompt,
  schema: MigrationEdit,
  defaults: {
    provider: {
      id: "codex",
      model: "gpt-5.6-sol",
      effort: "high",
      options: { sandboxMode: "workspace-write", networkAccess: false, webSearch: "disabled" },
    },
    maxTurns: 20,
    timeout: "30m",
    repair: 1,
  },
});

const UnitVerificationInput = z.object({
  unitId: z.string().min(1),
  verificationCommand: VerificationCommand,
});

const verifyMigrationUnit = defineCheck({
  name: "round-06-verify-migration-unit",
  description: "Runs a repository-discovered command against the accumulated migration candidate.",
  input: UnitVerificationInput,
  command: ({ verificationCommand }) => verificationCommand,
  policy: "required",
  revision: "v1",
  defaults: { timeout: "20m" },
});

/** Why: Rejects model claims that belong to another unit, plan, or package boundary. Use: Check every detached writer result before applying it. */
function requireBoundedEdit(
  unit: MigrationUnitValue,
  planDigest: string,
  edit: WorkspaceWriteAgentResult<MigrationEditValue>,
): void {
  if (edit.value.unitId !== unit.id || edit.value.planDigest !== planDigest) {
    throw new Error(`Migration writer returned the wrong identity for ${unit.id}`);
  }
  const packagePrefix = `${unit.packagePath}/`;
  const escapedFile = edit.files.find((file) => file !== unit.packagePath && !file.startsWith(packagePrefix));
  if (escapedFile !== undefined) {
    throw new Error(`Migration writer changed ${escapedFile} outside ${unit.packagePath}`);
  }
  const unobservedClaim = edit.value.changedFiles.find((file) => !edit.files.includes(file));
  if (unobservedClaim !== undefined) {
    throw new Error(`Migration writer claimed engine-unobserved change ${unobservedClaim}`);
  }
}

const MigrationCheckpoint = z.enum(["planned", "batch-verified", "published"]);

const MigrationTaskExtension = z.object({
  kind: z.literal("cancel-resume-code-migration"),
  repository: z.string().min(1),
  migrationId: z.string().min(1),
  planDigest: z.string().min(1),
  runId: z.string().min(1),
  unitId: z.string().min(1),
  ordinal: z.number().int().nonnegative(),
  batchIndex: z.number().int().nonnegative(),
  checkpoint: MigrationCheckpoint,
  retryClass: z.literal("replay-safe-isolated"),
  agentPatchRef: z.string().min(1).nullable(),
  verificationRef: z.string().min(1).nullable(),
  publicationReceiptRef: z.string().min(1).nullable(),
});

/** Why: Names the domain checkpoint stored for one migration unit. Use: Report progress and reject cross-run ownership without treating strings as patch authority. */
type MigrationTaskExtensionValue = z.infer<typeof MigrationTaskExtension>;

/** Why: Keeps task identity, optimistic revision, and parsed migration checkpoint together. Use: Update each unit exactly once per domain transition. */
type MigrationTaskSummary = WorkflowTaskSummary<MigrationTaskExtensionValue>;

const migrationTasks = defineTaskContract({
  schema: MigrationTaskExtension,
  revision: "cancel-resume-code-migration-v1",
  version: 1,
  agentAccess: "read",
});

/** Why: Derives one stable task key from immutable plan identity. Use: Converge registration and agent task context during same-run replay. */
function migrationTaskKey(plan: MigrationPlanValue, unit: MigrationUnitValue): string {
  return `${plan.migrationId}:${plan.planDigest}:${unit.id}`;
}

/** Why: Creates the first domain checkpoint without pretending a patch already exists. Use: Upsert it before any writer starts. */
function plannedTaskExtension(
  plan: MigrationPlanValue,
  unit: MigrationUnitValue,
  runId: string,
  batchIndex: number,
): MigrationTaskExtensionValue {
  return {
    kind: "cancel-resume-code-migration",
    repository: plan.repository,
    migrationId: plan.migrationId,
    planDigest: plan.planDigest,
    runId,
    unitId: unit.id,
    ordinal: unit.ordinal,
    batchIndex,
    checkpoint: "planned",
    retryClass: "replay-safe-isolated",
    agentPatchRef: null,
    verificationRef: null,
    publicationReceiptRef: null,
  };
}

/** Why: Proves task records belong to this exact run and plan before their revisions influence updates. Use: Never use a prior run's string patch references to resume execution. */
function indexOwnedTasks(
  tasks: readonly MigrationTaskSummary[],
  plan: MigrationPlanValue,
  runId: string,
): Map<string, MigrationTaskSummary> {
  const indexed = new Map<string, MigrationTaskSummary>();
  for (const task of tasks) {
    const extension = task.extensions;
    if (
      task.dedupeKey === undefined ||
      extension === undefined ||
      extension.repository !== plan.repository ||
      extension.migrationId !== plan.migrationId ||
      extension.planDigest !== plan.planDigest ||
      extension.runId !== runId
    ) {
      throw new Error("Migration task is not owned by this exact durable run and plan");
    }
    if (indexed.has(extension.unitId)) {
      throw new Error(`Duplicate durable task for migration unit ${extension.unitId}`);
    }
    indexed.set(extension.unitId, task);
  }
  return indexed;
}

const OpenMigrationLeaseInput = z.object({
  repository: z.string().min(1),
  migrationId: z.string().min(1),
  planDigest: z.string().min(1),
  runId: z.string().min(1),
  baseRef: z.string().min(1),
  idempotencyKey: z.string().min(1),
  workspaceKey: z.string().min(1),
});

const MigrationLease = OpenMigrationLeaseInput.extend({
  leaseId: z.string().min(1),
  openedAt: z.string().datetime(),
  cleanup: z.object({
    registrationRef: z.string().min(1),
    onTerminalRun: z.literal("cleanup-unpublished-resources"),
    onSameRunReplay: z.literal("retain-and-reconstruct"),
    expiresAt: z.string().datetime(),
  }),
});

/** Why: Names the host receipt that distinguishes resumable interruption from terminal cleanup. Use: Bind the candidate workspace and all finalization operations to one lease. */
type MigrationLeaseValue = z.infer<typeof MigrationLease>;

const openMigrationLease = defineOperation({
  name: "round-06-open-migration-lease",
  description:
    "Idempotently allocates transient migration resources and atomically registers terminal-run cleanup while retaining same-run replay state.",
  input: OpenMigrationLeaseInput,
  output: MigrationLease,
  binding: "repository.code-migration.open-lease",
  capabilities: ["workspace:write", "filesystem:write"],
  defaults: { timeout: "2m", attempts: 2 },
  authorization: { mode: "none" },
});

const PublishMigrationInput = z.object({
  lease: MigrationLease,
  candidate: z.object({
    patchRef: z.string().min(1),
    baseTree: z.string().min(1),
    files: z.array(z.string().min(1)).min(1),
    verificationRefs: z.array(z.string().min(1)).min(1),
  }),
  idempotencyKey: z.string().min(1),
});

const PublicationReceipt = z.object({
  repository: z.string().min(1),
  migrationId: z.string().min(1),
  planDigest: z.string().min(1),
  runId: z.string().min(1),
  patchRef: z.string().min(1),
  idempotencyKey: z.string().min(1),
  status: z.enum(["published", "already-published"]),
  branch: z.string().min(1),
  commit: z.string().min(1),
  url: z.string().url(),
  receiptRef: z.string().min(1),
  publishedAt: z.string().datetime(),
});

/** Why: Names the result of the single non-idempotent external boundary. Use: Validate the provider receipt before completing tasks or releasing resources. */
type PublicationReceiptValue = z.infer<typeof PublicationReceipt>;

const publishMigration = defineOperation({
  name: "round-06-publish-code-migration",
  description:
    "Publishes one verified candidate through a host idempotency ledger; automatic retries are disabled at the external mutation boundary.",
  input: PublishMigrationInput,
  output: PublicationReceipt,
  binding: "repository.code-migration.publish",
  capabilities: ["git:write", "network", "secrets:read", "integration:code-host"],
  defaults: { timeout: "10m", attempts: 1 },
  authorization: {
    mode: "required",
    action: "Publish one verified code migration branch",
    risk: "high",
    timeout: "1h",
  },
});

const ReleaseMigrationLeaseInput = z.object({
  lease: MigrationLease,
  publicationReceiptRef: z.string().min(1),
  temporaryPatchRefs: z.array(z.string().min(1)),
});

const ReleaseMigrationLeaseOutput = z.object({
  leaseId: z.string().min(1),
  status: z.enum(["released", "already-released"]),
  cleanupReceiptRef: z.string().min(1),
  releasedAt: z.string().datetime(),
});

const releaseMigrationLease = defineOperation({
  name: "round-06-release-migration-lease",
  description:
    "Idempotently releases unpublished workspaces and temporary patch storage after the publication receipt is durable.",
  input: ReleaseMigrationLeaseInput,
  output: ReleaseMigrationLeaseOutput,
  binding: "repository.code-migration.release-lease",
  capabilities: ["workspace:write", "filesystem:write"],
  defaults: { timeout: "2m", attempts: 3 },
  authorization: { mode: "none" },
});

/** Why: Rejects a lease returned for another run or plan before any workspace is opened. Use: Bind host cleanup behavior to the exact idempotent request. */
function requireLeaseMatches(
  request: OperationInputOf<typeof openMigrationLease>,
  lease: MigrationLeaseValue,
): void {
  if (
    lease.repository !== request.repository ||
    lease.migrationId !== request.migrationId ||
    lease.planDigest !== request.planDigest ||
    lease.runId !== request.runId ||
    lease.baseRef !== request.baseRef ||
    lease.idempotencyKey !== request.idempotencyKey ||
    lease.workspaceKey !== request.workspaceKey
  ) {
    throw new Error("Migration lease did not preserve its idempotent request");
  }
}

/** Why: Rejects a publication receipt that does not name the authorized candidate and lease. Use: Call before task completion or cleanup. */
function requirePublicationMatches(
  input: OperationInputOf<typeof publishMigration>,
  receipt: PublicationReceiptValue,
): void {
  if (
    receipt.repository !== input.lease.repository ||
    receipt.migrationId !== input.lease.migrationId ||
    receipt.planDigest !== input.lease.planDigest ||
    receipt.runId !== input.lease.runId ||
    receipt.patchRef !== input.candidate.patchRef ||
    receipt.idempotencyKey !== input.idempotencyKey
  ) {
    throw new Error("Publication receipt did not preserve the authorized candidate identity");
  }
}

const BatchCheckpoint = z.object({
  batchIndex: z.number().int().nonnegative(),
  unitIds: z.array(z.string().min(1)).min(1),
  verificationRefs: z.array(z.string().min(1)).min(1),
});

/** Why: Records one completed bounded batch without embedding nominal patch or check authority in domain state. Use: Return it with the final candidate for progress reporting. */
type BatchCheckpointValue = z.infer<typeof BatchCheckpoint>;

/** Why: Keeps the cumulative candidate patch, source patches, edits, and per-batch proof together until publication. Use: Return it from the single reconstructed candidate-workspace scope. */
interface PreparedMigrationCandidate {
  patch: PatchRef;
  sourcePatches: PatchRef[];
  edits: MigrationEditValue[];
  batches: BatchCheckpointValue[];
  finalVerificationRefs: string[];
}

/** Why: Couples one in-place unit result to the nominal patch captured from its disposable nested workspace. Use: Compose independent unit patches into the accumulated candidate only after scope checks. */
interface CapturedMigrationEdit {
  edit: WorkspaceWriteAgentResult<MigrationEditValue>;
  patch: PatchRef;
}

const CancelResumeMigrationOutput = z.object({
  migrationId: z.string().min(1),
  planDigest: z.string().min(1),
  runId: z.string().min(1),
  unitCount: z.number().int().positive(),
  batches: z.array(BatchCheckpoint).min(1),
  candidate: z.object({
    patchRef: z.string().min(1),
    baseTree: z.string().min(1),
    files: z.array(z.string().min(1)).min(1),
    verificationRefs: z.array(z.string().min(1)).min(1),
  }),
  publication: PublicationReceipt,
  cleanup: ReleaseMigrationLeaseOutput,
  retryPolicy: z.object({
    planning: z.literal("read-only-retryable"),
    editing: z.literal("isolated-replay-safe"),
    publication: z.literal("at-most-once-manual-reconcile"),
  }),
});

/** Why: Names the completed workflow handoff across batches, publication, and cleanup. Use: Keep every literal retry policy and receipt field narrowed. */
type CancelResumeMigrationOutputValue = z.infer<typeof CancelResumeMigrationOutput>;

const cancelResumeMigrationWorkflow = defineWorkflow(
  {
    id: "round-06-cancel-resume-code-migration",
    name: "Cancellable and same-run resumable code migration",
    description:
      "Migrates a large codebase in bounded batches, journals replay-safe effects, checkpoints domain progress, and publishes through one at-most-once boundary.",
    input: CancelResumeMigrationInput,
    output: CancelResumeMigrationOutput,
    tasks: migrationTasks,
  },
  async (ctx, input): Promise<CancelResumeMigrationOutputValue> => {
    const planRequest: OperationInputOf<typeof discoverMigrationPlan> = {
      repository: input.repository,
      migrationId: input.migrationId,
      objective: input.objective,
      baseRef: input.baseRef,
      packageScope: input.packageScope,
    };
    const plan = await ctx.operation(discoverMigrationPlan, planRequest, {
      key: "discover-migration-plan",
      label: `Discover migration ${input.migrationId}`,
      attempts: 3,
    });
    expectType<OperationOutputOf<typeof discoverMigrationPlan>>(plan);
    requireCoherentPlan(planRequest, plan);

    const leaseRequest: OperationInputOf<typeof openMigrationLease> = {
      repository: plan.repository,
      migrationId: plan.migrationId,
      planDigest: plan.planDigest,
      runId: ctx.run.id,
      baseRef: plan.baseRef,
      idempotencyKey: `${ctx.run.id}:${plan.planDigest}:lease`,
      workspaceKey: `migration:${plan.migrationId}:${plan.planDigest}`,
    };
    const lease = await ctx.operation(openMigrationLease, leaseRequest, {
      key: "open-migration-lease",
      label: "Open resumable migration resources",
      attempts: 2,
    });
    requireLeaseMatches(leaseRequest, lease);

    const batches = batchMigrationUnits(plan.units, input.batchSize);
    const taskKeys = plan.units.map((unit) => migrationTaskKey(plan, unit));
    const existing = await ctx.tasks.observe(
      { dedupeKeys: taskKeys, limit: plan.units.length },
      { key: "observe-existing-migration-checkpoints" },
    );
    indexOwnedTasks(existing.tasks, plan, ctx.run.id);

    for (const [batchIndex, batch] of batches.entries()) {
      for (const unit of batch) {
        if (existing.tasks.some((task) => task.dedupeKey === migrationTaskKey(plan, unit))) continue;
        await ctx.tasks.upsert({
          key: `register-unit:${unit.id}`,
          dedupeKey: migrationTaskKey(plan, unit),
          set: {
            title: `Migrate ${unit.packageName}: ${unit.id}`,
            description: unit.instruction,
            status: "in_progress",
            priority: "high",
            tags: ["code-migration", plan.migrationId, `batch-${batchIndex}`],
            dependencies: [],
            relatedFiles: unit.proposedPaths,
            acceptanceCriteria: ["Detached patch captured", "Accumulated candidate verification passes"],
            extensions: plannedTaskExtension(plan, unit, ctx.run.id, batchIndex),
          },
          note: "Registered as a domain checkpoint; same-run execution remains journal-owned.",
        });
      }
    }

    const registered = await ctx.tasks.observe(
      { dedupeKeys: taskKeys, limit: plan.units.length },
      { key: "observe-registered-migration-checkpoints" },
    );
    const registeredByUnit = indexOwnedTasks(registered.tasks, plan, ctx.run.id);
    if (registeredByUnit.size !== plan.units.length) {
      throw new Error("Could not establish one durable task for every migration unit");
    }

    for (const unit of plan.units) {
      const task = registeredByUnit.get(unit.id);
      if (task === undefined) throw new Error(`Migration unit ${unit.id} has no registered task`);
      const dependencyTaskIds = unit.dependsOn.map((dependency) => {
        const dependencyTask = registeredByUnit.get(dependency);
        if (dependencyTask === undefined) {
          throw new Error(`Migration unit ${unit.id} has no task for dependency ${dependency}`);
        }
        return dependencyTask.id;
      });
      if (dependencyTaskIds.length === 0) continue;
      await ctx.tasks.update(
        task.id,
        { dependencies: dependencyTaskIds, ifRevision: task.revision },
        { key: `link-unit-dependencies:${unit.id}` },
      );
    }

    const linked = await ctx.tasks.observe(
      { dedupeKeys: taskKeys, limit: plan.units.length },
      { key: "observe-linked-migration-checkpoints" },
    );
    const activeByUnit = indexOwnedTasks(linked.tasks, plan, ctx.run.id);

    // Do not skip keyed agent/check effects from task strings. During same-run replay the engine journal returns the
    // original nominal patches and attestations; the task store remains a domain progress projection only.
    const candidate = await ctx.workspace.with(
      { key: lease.workspaceKey, from: plan.baseRef },
      async (candidateCtx): Promise<PreparedMigrationCandidate> => {
        const sourcePatches: PatchRef[] = [];
        const edits: MigrationEditValue[] = [];
        const checkpoints: BatchCheckpointValue[] = [];

        for (const [batchIndex, batch] of batches.entries()) {
          const batchEdits = ctx.all(
            await ctx.parallel(
              batch,
              async (unit) => {
                return candidateCtx.workspace.with(
                  { key: `unit-workspace:${unit.id}` },
                  async (unitCtx): Promise<CapturedMigrationEdit> => {
                    const writeScope = await unitCtx.paths.resolve(
                      migrationWritePolicy,
                      { proposedPaths: unit.proposedPaths },
                      {
                        key: `resolve-write:${unit.id}`,
                        label: `Resolve write paths for ${unit.id}`,
                      },
                    );
                    const edit = await unitCtx.agent({
                      key: `edit-unit:${unit.id}`,
                      label: `Migrate ${unit.packageName}`,
                      agent: migrationAgent,
                      input: {
                        repository: plan.repository,
                        migrationId: plan.migrationId,
                        planDigest: plan.planDigest,
                        baseRef: plan.baseRef,
                        unit,
                      },
                      write: writeScope,
                      retry: { attempts: 2, backoff: "10s" },
                      tasks: {
                        mode: "read",
                        dedupeKeys: [migrationTaskKey(plan, unit)],
                        limit: 1,
                      },
                    });
                    requireBoundedEdit(unit, plan.planDigest, edit);
                    const captureScope = await unitCtx.paths.resolve(
                      migrationWritePolicy,
                      { proposedPaths: edit.files },
                      {
                        key: `resolve-unit-capture:${unit.id}`,
                        label: `Resolve captured files for ${unit.id}`,
                      },
                    );
                    const patch = await unitCtx.capture({ scope: captureScope });
                    return { edit, patch };
                  },
                );
              },
              {
                key: `edit-batch:${batchIndex}`,
                keyOf: (unit) => unit.id,
                concurrency: input.concurrency,
                errors: "throw",
              },
            ),
          );
          expectType<CapturedMigrationEdit[]>(batchEdits);

          for (const [index, captured] of batchEdits.entries()) {
            const unit = batch[index];
            if (unit === undefined) throw new Error(`Writer ${index} has no batch unit`);
            requireBoundedEdit(unit, plan.planDigest, captured.edit);
          }

          await candidateCtx.apply(
            batchEdits.map(({ patch }) => patch),
            { order: "sequential", onConflict: "fail" },
          );

          const verification = ctx.all(
            await candidateCtx.parallel(
              batch,
              async (unit) => {
                const result = await candidateCtx.check(
                  verifyMigrationUnit,
                  { unitId: unit.id, verificationCommand: unit.verificationCommand },
                  { key: `verify-unit:${unit.id}`, policy: "required" },
                );
                if (result.status !== "pass") {
                  throw new Error(`Accumulated candidate verification failed for ${unit.id}`);
                }
                return result;
              },
              {
                key: `verify-batch:${batchIndex}`,
                keyOf: (unit) => unit.id,
                concurrency: input.concurrency,
                errors: "throw",
              },
            ),
          );

          for (const [index, unit] of batch.entries()) {
            const task = activeByUnit.get(unit.id);
            const captured = batchEdits[index];
            const checked = verification[index];
            if (task === undefined || captured === undefined || checked === undefined) {
              throw new Error(`Batch checkpoint ${unit.id} is missing task, edit, or verification state`);
            }
            await candidateCtx.tasks.update(
              task.id,
              {
                status: "in_progress",
                ifRevision: task.revision,
                extensions: {
                  ...plannedTaskExtension(plan, unit, ctx.run.id, batchIndex),
                  checkpoint: "batch-verified",
                  agentPatchRef: captured.patch.ref,
                  verificationRef: checked.attestation.ref,
                },
              },
              { key: `checkpoint-verified:${unit.id}` },
            );
          }

          sourcePatches.push(...batchEdits.map(({ patch }) => patch));
          edits.push(...batchEdits.map(({ edit }) => edit.value));
          checkpoints.push({
            batchIndex,
            unitIds: batch.map(({ id }) => id),
            verificationRefs: verification.map(({ attestation }) => attestation.ref),
          });
        }

        const changedFiles = [...new Set(sourcePatches.flatMap(({ files }) => files))];
        if (changedFiles.length === 0) throw new Error("Migration candidate contains no changed files");
        const finalVerification = ctx.all(
          await candidateCtx.parallel(
            plan.units,
            async (unit) => {
              const result = await candidateCtx.check(
                verifyMigrationUnit,
                { unitId: unit.id, verificationCommand: unit.verificationCommand },
                { key: `final-verify-unit:${unit.id}`, policy: "required" },
              );
              if (result.status !== "pass") {
                throw new Error(`Final accumulated candidate verification failed for ${unit.id}`);
              }
              return result;
            },
            {
              key: "verify-final-candidate",
              keyOf: (unit) => unit.id,
              concurrency: input.concurrency,
              errors: "throw",
            },
          ),
        );
        const captureScope = await candidateCtx.paths.resolve(
          migrationWritePolicy,
          { proposedPaths: changedFiles },
          { key: "resolve-final-capture", label: "Resolve final migration candidate files" },
        );
        const patch = await candidateCtx.capture({ scope: captureScope });
        return {
          patch,
          sourcePatches,
          edits,
          batches: checkpoints,
          finalVerificationRefs: finalVerification.map(({ attestation }) => attestation.ref),
        };
      },
    );

    const publishInput: OperationInputOf<typeof publishMigration> = {
      lease,
      candidate: {
        patchRef: candidate.patch.ref,
        baseTree: candidate.patch.baseTree,
        files: candidate.patch.files,
        verificationRefs: candidate.finalVerificationRefs,
      },
      idempotencyKey: `${ctx.run.id}:${plan.planDigest}:publish`,
    };
    const publishCandidate = await ctx.operation.prepare(publishMigration, publishInput, {
      key: "prepare-publication",
      label: "Freeze verified migration candidate",
    });
    const publicationAuthority = await ctx.operation.authorize(publishMigration, publishCandidate, {
      key: "authorize-publication",
      detail: `Publish ${candidate.patch.files.length} files for migration ${plan.migrationId}.`,
    });
    const publication = await ctx.operation.execute(
      publishMigration,
      { candidate: publishCandidate, authorization: publicationAuthority },
      { key: "publish-migration", attempts: 1 },
    );
    requirePublicationMatches(publishInput, publication);

    const verifiedTasks = await ctx.tasks.observe(
      { dedupeKeys: taskKeys, limit: plan.units.length },
      { key: "observe-verified-migration-checkpoints" },
    );
    const verifiedByUnit = indexOwnedTasks(verifiedTasks.tasks, plan, ctx.run.id);
    for (const unit of plan.units) {
      const task = verifiedByUnit.get(unit.id);
      if (task?.extensions?.checkpoint !== "batch-verified") {
        throw new Error(`Migration unit ${unit.id} is not verified at publication completion`);
      }
      await ctx.tasks.update(
        task.id,
        {
          status: "done",
          ifRevision: task.revision,
          extensions: {
            ...task.extensions,
            checkpoint: "published",
            publicationReceiptRef: publication.receiptRef,
          },
        },
        { key: `checkpoint-published:${unit.id}` },
      );
    }

    const cleanup = await ctx.operation(
      releaseMigrationLease,
      {
        lease,
        publicationReceiptRef: publication.receiptRef,
        temporaryPatchRefs: [...candidate.sourcePatches.map(({ ref }) => ref), candidate.patch.ref],
      },
      { key: "release-migration-lease", attempts: 3 },
    );
    if (cleanup.leaseId !== lease.leaseId) {
      throw new Error("Cleanup receipt belongs to another migration lease");
    }

    await ctx.note({
      kind: "claim",
      text: `Migration ${plan.migrationId} published ${plan.units.length} units in ${candidate.batches.length} bounded batches.`,
      evidence: publication.receiptRef,
    });

    return {
      migrationId: plan.migrationId,
      planDigest: plan.planDigest,
      runId: ctx.run.id,
      unitCount: plan.units.length,
      batches: candidate.batches,
      candidate: publishInput.candidate,
      publication,
      cleanup,
      retryPolicy: {
        planning: "read-only-retryable",
        editing: "isolated-replay-safe",
        publication: "at-most-once-manual-reconcile",
      },
    };
  },
);

expectType<WorkflowNode<"weft.workflow">>(cancelResumeMigrationWorkflow);

// WORKFLOW-DOMAIN POLICY, SOLVED: bounded sequential batches and optimistic task checkpoints expose progress, while
// stable per-unit effect keys deliberately rehydrate nominal patches/check attestations from the same run journal.
// Task patch-reference strings are never treated as engine checkpoints or mutation authority.
//
// ENGINE-LIFECYCLE GAP: workflows cannot observe a typed caller-cancellation reason or register a guaranteed `defer`.
// The closest sound workaround is an idempotent host lease that atomically distinguishes resumable interruption from
// terminal-run cleanup; cancellation is not caught or converted into a domain task status.
//
// RETRY-SAFETY GAP: operation retries have a count but no typed idempotency/failure classifier. Read-only planning,
// isolated agents, and cleanup retry safely; publication uses prepare/authorize/execute with attempts=1 and a host
// idempotency ledger. An ambiguous publish failure must stop for reconciliation rather than be retried automatically.
