import { z } from "zod";

import {
  defineAgent,
  defineCheck,
  defineContextSource,
  definePathPolicy,
  definePrompt,
  defineTaskContract,
  defineTrigger,
  defineWorkflow,
  type PatchAgentResult,
  type PatchRef,
  prompt,
  type TriggerInputOf,
  type TriggerOutputOf,
  type TriggerRunProvenance,
  type WorkflowNode,
} from "../../core/index.ts";

/** Why: Makes compile-time workflow assertions readable without adding runtime behavior. Use: Pass inferred DSL values to it in this typechecked example. */
declare function expectType<Type>(value: Type): void;

// ---------------------------------------------------------------------------
// Runtime launch policy: owned by the scheduler, not by maintenance agents
// ---------------------------------------------------------------------------

const WORKFLOW_ID = "round-05-scheduled-monorepo-maintenance";
const SCHEDULE_ID = "weekly-monorepo-maintenance";
const SCHEDULE_REVISION = "v3";
const TRIGGER_NAME = "round-05-scheduled-maintenance-dispatch";
const TRIGGER_REVISION = "v1";
const TRIGGER_BINDING = "scheduler.scheduled-maintenance.dispatch";

/** Why: Names the deployment binding the scheduler must attest before a run starts. Use: Keep cadence and workflow routing out of the maintenance domain request. */
interface MaintenanceScheduleBinding {
  workflowId: typeof WORKFLOW_ID;
  scheduleId: typeof SCHEDULE_ID;
  revision: typeof SCHEDULE_REVISION;
  cadence: "0 3 * * 1";
  timezone: "UTC";
}

/** Why: Names host-enforced dispatch behavior separately from the work performed after launch. Use: Validate the scheduler snapshot before trusting dedupe or overlap claims. */
interface MaintenanceQueuePolicy {
  overlap: "coalesce-latest";
  dedupe: "schedule-repository-window";
  retry: "resume-same-run";
  maxConcurrentRuns: 1;
  targetConcurrency: 4;
  verificationConcurrency: 2;
}

const maintenanceSchedule = {
  workflowId: WORKFLOW_ID,
  scheduleId: SCHEDULE_ID,
  revision: SCHEDULE_REVISION,
  cadence: "0 3 * * 1",
  timezone: "UTC",
} satisfies MaintenanceScheduleBinding;

const maintenanceQueuePolicy = {
  overlap: "coalesce-latest",
  dedupe: "schedule-repository-window",
  retry: "resume-same-run",
  maxConcurrentRuns: 1,
  targetConcurrency: 4,
  verificationConcurrency: 2,
} satisfies MaintenanceQueuePolicy;

const ScheduledMaintenanceInput = z.object({
  dispatchToken: z.string().min(1),
});

const ScheduledMaintenanceDispatchEvent = z.object({
  kind: z.literal("scheduled-maintenance.dispatch"),
  workflowId: z.literal(WORKFLOW_ID),
  scheduleId: z.literal(SCHEDULE_ID),
  scheduleRevision: z.literal(SCHEDULE_REVISION),
  dispatchId: z.string().min(1),
  dispatchToken: z.string().min(1),
  dedupeKey: z.string().min(1),
});

const MaintenanceAction = z.enum([
  "format-sources",
  "refresh-generated-metadata",
  "remove-dead-configuration",
]);

const VerificationTarget = z.enum(["lint", "typecheck", "test"]);

// ---------------------------------------------------------------------------
// Domain contract: repository maintenance independent of how it was launched
// ---------------------------------------------------------------------------

const MaintenanceTarget = z.object({
  packageName: z
    .string()
    .min(1)
    .regex(/^@?[a-z0-9][a-z0-9._/-]*$/),
  packagePath: z.string().min(1),
  actions: z.array(MaintenanceAction).min(1),
  verification: VerificationTarget,
});

/** Why: Names one independently writable package selected by trusted repository discovery. Use: Preserve its stable package identity through fan-out and replay keys. */
type MaintenanceTargetValue = z.infer<typeof MaintenanceTarget>;

const MaintenanceRequest = z.object({
  repository: z.string().min(1),
  baseRef: z.string().min(1),
  windowKey: z.string().min(1),
  targets: z.array(MaintenanceTarget).min(1).max(40),
});

const ScheduleBinding = z.object({
  workflowId: z.literal(WORKFLOW_ID),
  scheduleId: z.literal(SCHEDULE_ID),
  revision: z.literal(SCHEDULE_REVISION),
  cadence: z.literal("0 3 * * 1"),
  timezone: z.literal("UTC"),
});

const QueuePolicy = z.object({
  overlap: z.literal("coalesce-latest"),
  dedupe: z.literal("schedule-repository-window"),
  retry: z.literal("resume-same-run"),
  maxConcurrentRuns: z.literal(1),
  targetConcurrency: z.literal(4),
  verificationConcurrency: z.literal(2),
});

const ScheduledMaintenanceLaunch = z.object({
  binding: ScheduleBinding,
  policy: QueuePolicy,
  dispatch: z.object({
    id: z.string().min(1),
    idempotencyKey: z.string().min(1),
    dedupeKey: z.string().min(1),
    dedupeSubject: z.object({
      scheduleId: z.literal(SCHEDULE_ID),
      repository: z.string().min(1),
      windowKey: z.string().min(1),
    }),
    scheduledFor: z.string().datetime(),
    enqueuedAt: z.string().datetime(),
    lease: z.object({
      ref: z.string().min(1),
      overlapGroup: z.string().min(1),
      scheduleId: z.literal(SCHEDULE_ID),
      repository: z.string().min(1),
      expiresAt: z.string().datetime(),
    }),
  }),
  coalescedScheduledFor: z.array(z.string().datetime()).min(1).max(32),
  request: MaintenanceRequest,
});

/** Why: Names the authoritative scheduler decision separately from the token accepted at the public workflow boundary. Use: Validate coherence before any durable task or agent effect. */
type ScheduledMaintenanceLaunchValue = z.infer<typeof ScheduledMaintenanceLaunch>;

const scheduledLaunchSource = defineContextSource({
  name: "round-05-scheduled-maintenance-launch",
  description:
    "Resolves an opaque dispatch token to one authoritative, leased, deduplicated scheduler launch.",
  input: ScheduledMaintenanceInput,
  output: ScheduledMaintenanceLaunch,
  binding: "scheduler.queued-workflow-launch.resolve",
  freshness: { maxAge: "30m", stale: "reject" },
  trust: { minimum: "authoritative", authorities: ["weft-scheduler"] },
});

/** Why: Rejects internally inconsistent scheduler output even after schema and source authentication. Use: Call immediately after resolving the launch snapshot. */
function assertCoherentLaunch(launch: ScheduledMaintenanceLaunchValue): void {
  if (
    launch.binding.workflowId !== maintenanceSchedule.workflowId ||
    launch.binding.scheduleId !== maintenanceSchedule.scheduleId ||
    launch.binding.revision !== maintenanceSchedule.revision ||
    launch.binding.cadence !== maintenanceSchedule.cadence ||
    launch.binding.timezone !== maintenanceSchedule.timezone
  ) {
    throw new Error("Scheduler launch is bound to a different workflow or schedule revision");
  }
  if (
    launch.policy.overlap !== maintenanceQueuePolicy.overlap ||
    launch.policy.dedupe !== maintenanceQueuePolicy.dedupe ||
    launch.policy.retry !== maintenanceQueuePolicy.retry ||
    launch.policy.maxConcurrentRuns !== maintenanceQueuePolicy.maxConcurrentRuns ||
    launch.policy.targetConcurrency !== maintenanceQueuePolicy.targetConcurrency ||
    launch.policy.verificationConcurrency !== maintenanceQueuePolicy.verificationConcurrency
  ) {
    throw new Error("Scheduler launch does not satisfy the workflow's fixed queue policy");
  }

  const targetNames = new Set(launch.request.targets.map(({ packageName }) => packageName));
  const targetPaths = new Set(launch.request.targets.map(({ packagePath }) => packagePath));
  if (
    targetNames.size !== launch.request.targets.length ||
    targetPaths.size !== launch.request.targets.length
  ) {
    throw new Error("Scheduled maintenance targets must have unique package names and paths");
  }
  if (
    launch.dispatch.dedupeSubject.repository !== launch.request.repository ||
    launch.dispatch.dedupeSubject.windowKey !== launch.request.windowKey ||
    launch.dispatch.lease.repository !== launch.request.repository
  ) {
    throw new Error("Queue dedupe or overlap lease is bound to a different maintenance subject");
  }
  if (new Set(launch.coalescedScheduledFor).size !== launch.coalescedScheduledFor.length) {
    throw new Error("Coalesced occurrence set contains duplicates");
  }
  if (!launch.coalescedScheduledFor.includes(launch.dispatch.scheduledFor)) {
    throw new Error("The effective occurrence must be present in the coalesced occurrence set");
  }
  const latestOccurrence = [...launch.coalescedScheduledFor].sort().at(-1);
  if (latestOccurrence !== launch.dispatch.scheduledFor) {
    throw new Error("coalesce-latest must dispatch the latest scheduled occurrence");
  }
  if (launch.dispatch.lease.expiresAt <= launch.dispatch.enqueuedAt) {
    throw new Error("Scheduler overlap lease expired before dispatch");
  }
}

/** Why: Cross-binds atomic trigger admission to the richer scheduler record resolved inside the run. Use: Reject token substitution before task or workspace effects. */
function assertTriggerMatchesLaunch(
  trigger: TriggerRunProvenance | undefined,
  launch: ScheduledMaintenanceLaunchValue,
): void {
  if (trigger === undefined) return;
  if (
    trigger.provenance.trigger !== TRIGGER_NAME ||
    trigger.provenance.revision !== TRIGGER_REVISION ||
    trigger.provenance.source !== TRIGGER_BINDING ||
    trigger.provenance.eventId !== launch.dispatch.id ||
    trigger.claim.triggerRevision !== TRIGGER_REVISION ||
    trigger.claim.dedupeKey !== launch.dispatch.dedupeKey
  ) {
    throw new Error("Trigger admission does not match the authoritative scheduler launch");
  }
}

const maintenanceWritePolicy = definePathPolicy({
  name: "round-05-scheduled-maintenance-writes",
  description: "Limits unattended maintenance to canonical package paths and excludes repository state.",
  revision: "v1",
  roots: ["packages"],
  deny: ["**/.git/**", "**/.weft/**", "**/node_modules/**", "**/.env*", "**/*secret*"],
  grantTtl: "2h",
});

const MaintenanceAgentInput = z.object({
  repository: z.string().min(1),
  baseRef: z.string().min(1),
  windowKey: z.string().min(1),
  target: MaintenanceTarget,
});

const MaintenanceEdit = z.object({
  packageName: z.string().min(1),
  summary: z.string().min(1),
  actionsApplied: z.array(MaintenanceAction),
  changedFiles: z.array(z.string().min(1)),
  skippedActions: z.array(z.object({ action: MaintenanceAction, reason: z.string().min(1) })),
});

/** Why: Names validated model output separately from its engine-captured patch envelope. Use: Assert fan-out inference and build the final package summary. */
type MaintenanceEditValue = z.infer<typeof MaintenanceEdit>;

const maintenancePrompt = definePrompt({
  name: "round-05-maintain-one-package",
  input: MaintenanceAgentInput,
  render: ({ repository, baseRef, windowKey, target }) => [
    `Perform scheduled maintenance for ${target.packageName} in ${repository} at ${baseRef}.`,
    prompt.json("Requested maintenance actions", target.actions),
    `Maintenance window: ${windowKey}.`,
    "Make only deterministic, repository-local changes; do not fetch, publish, commit, or broaden scope.",
    "Skip an action with a concrete reason when it cannot be completed safely from checked-in state.",
  ],
});

const packageMaintainer = defineAgent({
  name: "round-05-package-maintainer",
  description: "Produces one isolated package patch under a scheduler-approved maintenance request.",
  prompt: maintenancePrompt,
  schema: MaintenanceEdit,
  defaults: {
    provider: {
      id: "codex",
      effort: "high",
      options: { sandboxMode: "workspace-write", networkAccess: false, webSearch: "disabled" },
    },
    maxTurns: 16,
    timeout: "25m",
    repair: 1,
  },
});

const PackageVerificationInput = z.object({
  packageName: MaintenanceTarget.shape.packageName,
  target: VerificationTarget,
});

const packageMaintenanceVerification = defineCheck({
  name: "round-05-package-maintenance-verification",
  description: "Runs one fixed package-script family against the fully composed maintenance candidate.",
  input: PackageVerificationInput,
  command: ({ packageName, target }) => ["pnpm", "--filter", packageName, target],
  policy: "required",
  revision: "v1",
  defaults: { timeout: "20m" },
});

/** Why: Rejects captured or reported changes that escaped one target's package boundary. Use: Check every successful writer before composing patches. */
function assertBoundedMaintenance(
  target: MaintenanceTargetValue,
  edit: PatchAgentResult<MaintenanceEditValue>,
): void {
  if (edit.value.packageName !== target.packageName) {
    throw new Error(`Maintenance result belongs to ${edit.value.packageName}, not ${target.packageName}`);
  }
  const packagePrefix = `${target.packagePath}/`;
  const escapedFile = edit.files.find(
    (file) => file !== target.packagePath && !file.startsWith(packagePrefix),
  );
  if (escapedFile !== undefined) {
    throw new Error(`Maintenance changed ${escapedFile} outside ${target.packageName}`);
  }
  const unobservedClaim = edit.value.changedFiles.find((file) => !edit.files.includes(file));
  if (unobservedClaim !== undefined) {
    throw new Error(`Agent claimed an engine-unobserved change at ${unobservedClaim}`);
  }
}

const MaintenanceTaskExtension = z.object({
  kind: z.literal("scheduled-monorepo-maintenance"),
  scheduleId: z.literal(SCHEDULE_ID),
  scheduleRevision: z.literal(SCHEDULE_REVISION),
  dispatchId: z.string().min(1),
  idempotencyKey: z.string().min(1),
  repository: z.string().min(1),
  windowKey: z.string().min(1),
  runId: z.string().min(1),
  coalescedCount: z.number().int().positive(),
  outcome: z.enum(["running", "no-change", "completed"]),
  candidatePatchRef: z.string().min(1).nullable(),
});

/** Why: Gives cross-run dedupe records a validated domain payload without turning the task store into a scheduler lease. Use: Upsert by the host-attested dedupe key. */
type MaintenanceTaskExtensionValue = z.infer<typeof MaintenanceTaskExtension>;

const maintenanceTasks = defineTaskContract({
  schema: MaintenanceTaskExtension,
  agentAccess: false,
});

const RuntimeReceipt = z.object({
  scheduleId: z.literal(SCHEDULE_ID),
  scheduleRevision: z.literal(SCHEDULE_REVISION),
  dispatchId: z.string().min(1),
  idempotencyKey: z.string().min(1),
  dedupeKey: z.string().min(1),
  scheduledFor: z.string().datetime(),
  coalescedCount: z.number().int().positive(),
  schedulerEvidenceRef: z.string().min(1),
});

const ScheduledMaintenanceOutput = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("deduplicated"),
    runtime: RuntimeReceipt,
    priorTaskId: z.string().min(1),
    priorRunId: z.string().min(1),
    priorOutcome: z.enum(["no-change", "completed"]),
    candidatePatchRef: z.string().min(1).nullable(),
  }),
  z.object({
    status: z.literal("no-change"),
    runtime: RuntimeReceipt,
    taskId: z.string().min(1),
    packages: z.array(MaintenanceEdit).min(1),
  }),
  z.object({
    status: z.literal("completed"),
    runtime: RuntimeReceipt,
    taskId: z.string().min(1),
    packages: z.array(MaintenanceEdit).min(1),
    verification: z.array(
      z.object({
        packageName: z.string().min(1),
        target: VerificationTarget,
        status: z.literal("pass"),
        attestationRef: z.string().min(1),
      }),
    ),
    candidatePatch: z.object({
      ref: z.string().min(1),
      files: z.array(z.string()),
      baseTree: z.string().min(1),
    }),
  }),
]);

/** Why: Keeps the dedupe short-circuit and completed maintenance result narrowed to the public schema. Use: Annotate the workflow body across early returns. */
type ScheduledMaintenanceOutputValue = z.infer<typeof ScheduledMaintenanceOutput>;

/** Why: Names the verified candidate returned from a replay-stable composed workspace. Use: Keep patch capture and verification coupled until the final task update. */
interface VerifiedMaintenanceCandidate {
  patch: PatchRef;
  verification: Array<{
    packageName: string;
    target: z.infer<typeof VerificationTarget>;
    status: "pass";
    attestationRef: string;
  }>;
}

/** Why: Exercises a scheduler-owned queue feeding a replayable, bounded-concurrency coding workflow. Use: Launch only with an opaque scheduler dispatch token. */
const scheduledMaintenanceWorkflow = defineWorkflow(
  {
    id: WORKFLOW_ID,
    name: "Scheduled monorepo maintenance",
    description:
      "Consumes one authoritative queued launch, coalesces by scheduler policy, and produces a verified package-maintenance patch.",
    input: ScheduledMaintenanceInput,
    output: ScheduledMaintenanceOutput,
    tasks: maintenanceTasks,
  },
  async (ctx, input): Promise<ScheduledMaintenanceOutputValue> => {
    const launchSnapshot = await ctx.context(scheduledLaunchSource, input, {
      key: "resolve-scheduled-launch",
      label: "Resolve authoritative scheduler dispatch",
      maxAge: "15m",
    });
    const launch = launchSnapshot.value;
    assertCoherentLaunch(launch);
    assertTriggerMatchesLaunch(ctx.run.trigger, launch);

    const runtime = {
      scheduleId: launch.binding.scheduleId,
      scheduleRevision: launch.binding.revision,
      dispatchId: launch.dispatch.id,
      idempotencyKey: launch.dispatch.idempotencyKey,
      dedupeKey: launch.dispatch.dedupeKey,
      scheduledFor: launch.dispatch.scheduledFor,
      coalescedCount: launch.coalescedScheduledFor.length,
      schedulerEvidenceRef: launchSnapshot.evidence.ref,
    };

    const observed = await ctx.tasks.observe(
      { dedupeKeys: [launch.dispatch.dedupeKey], limit: 2 },
      { key: "observe-maintenance-dedupe" },
    );
    if (observed.tasks.length > 1) {
      throw new Error("Task store contains duplicate records for one scheduler dedupe key");
    }
    const priorTask = observed.tasks[0];
    if (priorTask?.status === "done") {
      if (priorTask.extensions?.outcome !== "completed" && priorTask.extensions?.outcome !== "no-change") {
        throw new Error("Completed maintenance task is missing its terminal outcome");
      }
      if (priorTask.extensions.outcome === "completed" && priorTask.extensions.candidatePatchRef == null) {
        throw new Error("Changed maintenance task is missing its candidate patch reference");
      }
      return {
        status: "deduplicated",
        runtime,
        priorTaskId: priorTask.id,
        priorRunId: priorTask.extensions.runId,
        priorOutcome: priorTask.extensions.outcome,
        candidatePatchRef: priorTask.extensions.candidatePatchRef,
      };
    }
    if (priorTask !== undefined) {
      if (priorTask.status !== "in_progress") {
        throw new Error(`Maintenance dedupe task is unexpectedly ${priorTask.status}`);
      }
      if (priorTask.extensions?.dispatchId !== launch.dispatch.id) {
        throw new Error("Scheduler dispatched overlapping runs despite its exclusive overlap lease");
      }
    } else {
      const taskExtension: MaintenanceTaskExtensionValue = {
        kind: "scheduled-monorepo-maintenance",
        scheduleId: launch.binding.scheduleId,
        scheduleRevision: launch.binding.revision,
        dispatchId: launch.dispatch.id,
        idempotencyKey: launch.dispatch.idempotencyKey,
        repository: launch.request.repository,
        windowKey: launch.request.windowKey,
        runId: ctx.run.id,
        coalescedCount: launch.coalescedScheduledFor.length,
        outcome: "running",
        candidatePatchRef: null,
      };
      await ctx.tasks.upsert({
        dedupeKey: launch.dispatch.dedupeKey,
        set: {
          title: `Scheduled maintenance: ${launch.request.repository}`,
          description: `Window ${launch.request.windowKey}; dispatch ${launch.dispatch.id}`,
          status: "in_progress",
          priority: "low",
          tags: ["scheduled-maintenance", launch.binding.scheduleId],
          relatedFiles: launch.request.targets.map(({ packagePath }) => packagePath),
          acceptanceCriteria: ["All package checks pass", "One bounded candidate patch is captured"],
          extensions: taskExtension,
        },
        note: `Coalesced ${launch.coalescedScheduledFor.length} scheduled occurrence(s).`,
      }, { key: "record-maintenance-dedupe" });
    }

    const claimed = await ctx.tasks.observe(
      { dedupeKeys: [launch.dispatch.dedupeKey], limit: 2 },
      { key: "observe-claimed-maintenance" },
    );
    if (claimed.tasks.length !== 1 || claimed.tasks[0] === undefined) {
      throw new Error("Could not establish one durable maintenance task");
    }
    const activeTask = claimed.tasks[0];
    if (activeTask.status !== "in_progress" || activeTask.extensions?.dispatchId !== launch.dispatch.id) {
      throw new Error("Durable maintenance task is not owned by this scheduler dispatch");
    }

    const edits = await ctx.parallel.all(
      launch.request.targets,
      async (target, lane) => {
        const writeScope = await lane.ctx.paths.resolve(
          maintenanceWritePolicy,
          { proposedPaths: [`${target.packagePath}/**`] },
          {
            key: `resolve-write:${target.packageName}`,
            label: `Resolve maintenance paths for ${target.packageName}`,
          },
        );
        return lane.ctx.agent(packageMaintainer, {
          repository: launch.request.repository,
          baseRef: launch.request.baseRef,
          windowKey: launch.request.windowKey,
          target,
        }, {
          key: `maintain:${target.packageName}`,
          label: `Maintain ${target.packageName}`,
          write: writeScope,
          context: [launchSnapshot],
        });
      },
      {
        key: "maintain-packages",
        keyOf: (target) => target.packageName,
        concurrency: launch.policy.targetConcurrency,
      },
    );
    expectType<Array<PatchAgentResult<MaintenanceEditValue>>>(edits);
    edits.forEach((edit, index) => {
      const target = launch.request.targets[index];
      if (target === undefined) throw new Error(`Maintenance result ${index} has no target`);
      assertBoundedMaintenance(target, edit);
    });

    const changedFiles = [...new Set(edits.flatMap(({ files }) => files))];
    if (changedFiles.length === 0) {
      await ctx.tasks.update(
        activeTask.id,
        {
          status: "done",
          ifRevision: activeTask.revision,
          extensions: {
            kind: "scheduled-monorepo-maintenance",
            scheduleId: launch.binding.scheduleId,
            scheduleRevision: launch.binding.revision,
            dispatchId: launch.dispatch.id,
            idempotencyKey: launch.dispatch.idempotencyKey,
            repository: launch.request.repository,
            windowKey: launch.request.windowKey,
            runId: ctx.run.id,
            coalescedCount: launch.coalescedScheduledFor.length,
            outcome: "no-change",
            candidatePatchRef: null,
          },
        },
        { key: "complete-no-change-maintenance-task" },
      );
      return {
        status: "no-change",
        runtime,
        taskId: activeTask.id,
        packages: edits.map(({ value }) => value),
      };
    }

    const candidate = await ctx.workspace.with(
      { key: "scheduled-maintenance-candidate", from: launch.request.baseRef },
      async (candidateCtx): Promise<VerifiedMaintenanceCandidate> => {
        await candidateCtx.apply(
          edits.map(({ patch }) => patch),
          { key: "apply-maintenance-edits", order: "sequential", onConflict: "fail" },
        );

        const verification = await candidateCtx.parallel.all(
          launch.request.targets,
          async (target, lane) => {
            const result = await lane.ctx.check(
              packageMaintenanceVerification,
              { packageName: target.packageName, target: target.verification },
              { key: `verify:${target.packageName}`, policy: "required" },
            );
            if (result.status !== "pass") {
              throw new Error(`Scheduled maintenance verification failed for ${target.packageName}`);
            }
            return {
              packageName: target.packageName,
              target: target.verification,
              status: "pass" as const,
              attestationRef: result.attestation.ref,
            };
          },
          {
            key: "verify-maintained-packages",
            keyOf: (target) => target.packageName,
            concurrency: launch.policy.verificationConcurrency,
          },
        );
        const captureScope = await candidateCtx.paths.resolve(
          maintenanceWritePolicy,
          { proposedPaths: changedFiles },
          { key: "resolve-maintenance-capture", label: "Resolve verified maintenance files" },
        );
        const patch = await candidateCtx.capture({
          key: "capture-maintenance-candidate",
          scope: captureScope,
        });
        return { patch, verification };
      },
    );

    await ctx.tasks.update(
      activeTask.id,
      {
        status: "done",
        ifRevision: activeTask.revision,
        extensions: {
          kind: "scheduled-monorepo-maintenance",
          scheduleId: launch.binding.scheduleId,
          scheduleRevision: launch.binding.revision,
          dispatchId: launch.dispatch.id,
          idempotencyKey: launch.dispatch.idempotencyKey,
          repository: launch.request.repository,
          windowKey: launch.request.windowKey,
          runId: ctx.run.id,
          coalescedCount: launch.coalescedScheduledFor.length,
          outcome: "completed",
          candidatePatchRef: candidate.patch.ref,
        },
      },
      { key: "complete-maintenance-task" },
    );

    await ctx.note({
      key: "record-maintenance-candidate",
      kind: "claim",
      text: `Scheduled maintenance produced candidate ${candidate.patch.ref}.`,
      evidence: `Scheduler: ${launchSnapshot.evidence.ref}\nTrigger: ${ctx.run.trigger?.admissionRef ?? "direct-authoritative-launch"}\nDispatch: ${launch.dispatch.id}\nDedupe: ${launch.dispatch.dedupeKey}`,
    });

    return {
      status: "completed",
      runtime,
      taskId: activeTask.id,
      packages: edits.map(({ value }) => value),
      verification: candidate.verification,
      candidatePatch: {
        ref: candidate.patch.ref,
        files: [...candidate.patch.files],
        baseTree: candidate.patch.baseTree,
      },
    };
  },
);

const scheduledMaintenanceTrigger = defineTrigger({
  name: TRIGGER_NAME,
  revision: TRIGGER_REVISION,
  description:
    "Authenticates scheduler dispatches and atomically admits one maintenance run per host-selected dedupe key.",
  source: { binding: TRIGGER_BINDING },
  event: ScheduledMaintenanceDispatchEvent,
  workflow: scheduledMaintenanceWorkflow,
  eventId: ({ dispatchId }) => dispatchId,
  dedupeKey: ({ dedupeKey }) => dedupeKey,
  map: ({ dispatchToken }) => ({ dispatchToken }),
});

expectType<WorkflowNode<"weft.workflow">>(scheduledMaintenanceWorkflow);
expectType<WorkflowNode<"weft.trigger">>(scheduledMaintenanceTrigger);
expectType<TriggerInputOf<typeof scheduledMaintenanceTrigger>>({
  kind: "scheduled-maintenance.dispatch",
  workflowId: WORKFLOW_ID,
  scheduleId: SCHEDULE_ID,
  scheduleRevision: SCHEDULE_REVISION,
  dispatchId: "dispatch-123",
  dispatchToken: "opaque-dispatch-token",
  dedupeKey: "weekly-monorepo-maintenance:repository:window",
});
declare const scheduledTriggerResult: TriggerOutputOf<typeof scheduledMaintenanceTrigger>;
expectType<TriggerOutputOf<typeof scheduledMaintenanceTrigger>>(scheduledTriggerResult);

// Round 5 reimplementation: `defineTrigger` now makes authenticated dispatch validation, event identity,
// revision-scoped dedupe, exact workflow mapping, and atomic claim/run/outbox admission registry-inspectable.
// Cadence, overlap leases, coalescing, and concurrency remain scheduler policy and are re-resolved authoritatively
// inside the run. The task dedupe key is retained only for durable reporting and completed-result convergence;
// it is not treated as the launch claim that the trigger engine already owns.
