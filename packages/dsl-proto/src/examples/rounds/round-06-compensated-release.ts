import {
  type Ctx,
  defineArtifact,
  defineObserver,
  defineOperation,
  defineWorkflow,
  type WorkflowNode,
  z,
} from "../../index.ts";

/** Why: Makes the final definition contract visible without runtime test behavior. Use: Assert workflow inference. */
declare function expectType<Type>(value: Type): void;

// The operation lifecycle journals recovery before dispatch. An ambiguous deployment start therefore carries
// engine-run conditional cancellation evidence, while a validated success receipt is the only authority from
// which this workflow may prepare protected rollback.

const ArtifactSpecSchema = z.object({
  uri: z.string().min(1),
  sha256: z.string().min(1),
});

const ServiceReleaseSchema = z.object({
  service: z.string().min(1),
  artifact: ArtifactSpecSchema,
});

const ReleaseInputSchema = z.object({
  releaseId: z.string().min(1),
  environment: z.enum(["staging", "production"]),
  services: z.array(ServiceReleaseSchema).min(2),
});

/** Why: Names one validated service target. Use: Derive stable workflow and remote idempotency keys. */
type ServiceRelease = z.infer<typeof ServiceReleaseSchema>;

const DeploymentHandleSchema = z.object({
  handleRef: z.string().min(1),
  providerDeploymentId: z.string().min(1),
  provider: z.string().min(1),
  releaseId: z.string().min(1),
  environment: z.string().min(1),
  service: z.string().min(1),
  artifactSha256: z.string().min(1),
  previousArtifactSha256: z.string().min(1),
  primaryIdempotencyKey: z.string().min(1),
  acceptedAt: z.string().min(1),
});

/** Why: Names host-validated provider identity returned only through successful primary execution. Use: Observe and compensate that exact deployment. */
type DeploymentHandle = z.infer<typeof DeploymentHandleSchema>;

const StartDeploymentInputSchema = z.object({
  releaseId: z.string().min(1),
  environment: z.string().min(1),
  service: z.string().min(1),
  artifact: ArtifactSpecSchema,
  primaryIdempotencyKey: z.string().min(1),
});

const startDeployment = defineOperation({
  name: "start-coordinated-deployment",
  description: "Starts or returns one idempotent remote deployment.",
  input: StartDeploymentInputSchema,
  output: DeploymentHandleSchema,
  binding: "deployment.release.start",
  capabilities: ["network", "integration:deployment"],
  defaults: { timeout: "3m", attempts: 3 },
  authorization: {
    mode: "required",
    action: "start one service deployment in a coordinated release",
    risk: "high",
    timeout: "24h",
  },
});

const ConditionalCancellationInputSchema = z.object({
  primaryIdempotencyKey: z.string().min(1),
  cancellationIdempotencyKey: z.string().min(1),
});

const ConditionalCancellationOutputSchema = z.object({
  status: z.enum(["cancelled", "already-cancelled", "not-started"]),
  primaryIdempotencyKey: z.string().min(1),
  cancellationIdempotencyKey: z.string().min(1),
  providerOperationId: z.string().min(1),
  completedAt: z.string().min(1),
});

const cancelAmbiguousDeployment = defineOperation({
  name: "cancel-ambiguous-deployment",
  description:
    "Conditionally finds and idempotently cancels a deployment by its primary remote idempotency key.",
  input: ConditionalCancellationInputSchema,
  output: ConditionalCancellationOutputSchema,
  binding: "deployment.release.conditional-cancel",
  capabilities: ["network", "integration:deployment"],
  defaults: { timeout: "3m", attempts: 5 },
  authorization: { mode: "none" },
});

const RollbackDeploymentInputSchema = z.object({
  handle: DeploymentHandleSchema,
  compensationIdempotencyKey: z.string().min(1),
});

const RollbackDeploymentOutputSchema = z.object({
  status: z.literal("rolled-back"),
  handleRef: z.string().min(1),
  restoredArtifactSha256: z.string().min(1),
  compensationIdempotencyKey: z.string().min(1),
  providerOperationId: z.string().min(1),
  completedAt: z.string().min(1),
});

/** Why: Names exact provider evidence that one committed deployment was restored. Use: Validate it against the primary success receipt. */
type RollbackDeploymentOutput = z.infer<typeof RollbackDeploymentOutputSchema>;

const rollbackDeployment = defineOperation({
  name: "rollback-committed-deployment",
  description: "Restores the artifact preceding one successfully started deployment.",
  input: RollbackDeploymentInputSchema,
  output: RollbackDeploymentOutputSchema,
  binding: "deployment.release.rollback",
  capabilities: ["network", "integration:deployment"],
  defaults: { timeout: "5m", attempts: 3 },
  authorization: {
    mode: "required",
    action: "restore the previous service artifact after a partial release",
    risk: "high",
    timeout: "24h",
  },
});

const QueuedDeploymentStateSchema = z.object({
  status: z.literal("queued"),
  handleRef: z.string().min(1),
  providerDeploymentId: z.string().min(1),
  artifactSha256: z.string().min(1),
});

const RunningDeploymentStateSchema = z.object({
  status: z.literal("running"),
  handleRef: z.string().min(1),
  providerDeploymentId: z.string().min(1),
  artifactSha256: z.string().min(1),
});

const SucceededDeploymentSchema = z.object({
  status: z.literal("succeeded"),
  handleRef: z.string().min(1),
  providerDeploymentId: z.string().min(1),
  artifactSha256: z.string().min(1),
  completedAt: z.string().min(1),
});

const FailedDeploymentSchema = z.object({
  status: z.literal("failed"),
  handleRef: z.string().min(1),
  providerDeploymentId: z.string().min(1),
  artifactSha256: z.string().min(1),
  failedAt: z.string().min(1),
  reason: z.string().min(1),
});

const DeploymentTerminalSchema = z.discriminatedUnion("status", [
  SucceededDeploymentSchema,
  FailedDeploymentSchema,
]);

/** Why: Names schema-validated provider completion separately from the primary receipt. Use: Reject evidence for a different handle or artifact. */
type DeploymentTerminal = z.infer<typeof DeploymentTerminalSchema>;

const DeploymentStateSchema = z.discriminatedUnion("status", [
  QueuedDeploymentStateSchema,
  RunningDeploymentStateSchema,
  SucceededDeploymentSchema,
  FailedDeploymentSchema,
]);

const waitForDeployment = defineObserver({
  name: "wait-for-coordinated-deployment",
  description: "Polls one exact deployment handle until it succeeds or fails.",
  input: DeploymentHandleSchema,
  state: DeploymentStateSchema,
  output: DeploymentTerminalSchema,
  source: { kind: "poll", every: "20s", binding: "deployment.release.status" },
  defaults: { timeout: "45m" },
  complete: (state) => (state.status === "queued" || state.status === "running" ? null : state),
});

const AttemptEvidenceSchema = z.object({
  order: z.number().int().nonnegative(),
  service: z.string().min(1),
  attemptRef: z.string().min(1),
  candidateRef: z.string().min(1),
  authorizationRef: z.string().min(1),
  definitionDigest: z.string().min(1),
  inputDigest: z.string().min(1),
  primaryIdempotencyKey: z.string().min(1),
  cancellationRegistrationRef: z.string().min(1),
  cancellationInputDigest: z.string().min(1),
  cancellationIdempotencyKey: z.string().min(1),
});

/** Why: Projects durable pre-dispatch attempt identity without copying nominal authority into an artifact. Use: Audit replay and automatic cleanup registration. */
type AttemptEvidence = z.infer<typeof AttemptEvidenceSchema>;

const DeploymentEvidenceSchema = z.object({
  order: z.number().int().nonnegative(),
  service: z.string().min(1),
  attemptRef: z.string().min(1),
  receiptRef: z.string().min(1),
  outputDigest: z.string().min(1),
  handle: DeploymentHandleSchema,
  terminal: SucceededDeploymentSchema,
});

/** Why: Projects a provider-confirmed deployment and the nominal lifecycle references behind it. Use: Report the completed prefix. */
type DeploymentEvidence = z.infer<typeof DeploymentEvidenceSchema>;

const CancellationEvidenceSchema = z.object({
  status: z.enum(["succeeded", "retryable", "terminal", "ambiguous"]),
  attemptRef: z.string().min(1),
  definitionDigest: z.string().min(1),
  inputDigest: z.string().min(1),
  idempotencyKey: z.string().min(1),
  output: ConditionalCancellationOutputSchema.nullable(),
  failureReason: z.string().nullable(),
  verified: z.boolean(),
});

/** Why: Names engine-run cleanup evidence for an ambiguous primary dispatch. Use: Decide whether manual reconciliation remains. */
type CancellationEvidence = z.infer<typeof CancellationEvidenceSchema>;

const ReleaseFailureSchema = z.object({
  order: z.number().int().nonnegative(),
  service: z.string().min(1),
  stage: z.enum(["registration", "dispatch", "observe", "terminal"]),
  classification: z.enum(["workflow-error", "retryable", "terminal", "ambiguous", "deployment-failed"]),
  commit: z.enum(["not-started", "not-committed", "may-have-committed", "committed"]),
  attemptRef: z.string().nullable(),
  reason: z.string().min(1),
});

/** Why: Names the first failure that stops forward deployment. Use: Preserve the exact commit classification supplied by the engine. */
type ReleaseFailure = z.infer<typeof ReleaseFailureSchema>;

const CompensationActionSchema = z.object({
  sequence: z.number().int().nonnegative(),
  order: z.number().int().nonnegative(),
  service: z.string().min(1),
  primaryReceiptRef: z.string().min(1),
  candidateRef: z.string().min(1),
  authorizationRef: z.string().min(1),
  recoveryReceiptRef: z.string().min(1),
  definitionDigest: z.string().min(1),
  inputDigest: z.string().min(1),
  outputDigest: z.string().min(1),
  idempotencyKey: z.string().min(1),
  output: RollbackDeploymentOutputSchema,
});

/** Why: Names exact successful compensation evidence in actual reverse execution order. Use: Prove which committed services were restored. */
type CompensationAction = z.infer<typeof CompensationActionSchema>;

const ManualInterventionSchema = z.object({
  sequence: z.number().int().nonnegative(),
  kind: z.enum(["cancellation", "compensation"]),
  order: z.number().int().nonnegative(),
  service: z.string().min(1),
  status: z.enum(["retryable", "terminal", "ambiguous", "workflow-error"]),
  commit: z.enum(["not-committed", "may-have-committed", "unknown"]),
  subjectRef: z.string().min(1),
  candidateRef: z.string().nullable(),
  authorizationRef: z.string().nullable(),
  idempotencyKey: z.string().min(1),
  reason: z.string().min(1),
});

/** Why: Makes unresolved cleanup or compensation explicit and durable. Use: Continue reverse recovery and return every remaining reconciliation item. */
type ManualIntervention = z.infer<typeof ManualInterventionSchema>;

const ReleaseEvidenceContentSchema = z.object({
  outcome: z.enum(["released", "compensated", "compensation-failed"]),
  request: ReleaseInputSchema,
  attempts: z.array(AttemptEvidenceSchema),
  deployments: z.array(DeploymentEvidenceSchema),
  failure: ReleaseFailureSchema.nullable(),
  cancellation: CancellationEvidenceSchema.nullable(),
  compensations: z.array(CompensationActionSchema),
  manualIntervention: z.array(ManualInterventionSchema),
});

const ReleaseEvidenceMetadataSchema = z.object({
  releaseId: z.string().min(1),
  environment: z.string().min(1),
  workflowRunId: z.string().min(1),
  recordedAt: z.number(),
});

const releaseEvidence = defineArtifact({
  name: "recoverable-release-evidence",
  mediaType: "application/json",
  extension: ".json",
  content: ReleaseEvidenceContentSchema,
  metadata: ReleaseEvidenceMetadataSchema,
});

const EvidencePointerSchema = z.object({
  ref: z.string().min(1),
  sha256: z.string().min(1),
});

const ReleasedOutputSchema = z.object({
  status: z.literal("released"),
  releaseId: z.string().min(1),
  deployedServices: z.array(z.string().min(1)).min(2),
  evidence: EvidencePointerSchema,
});

const CompensatedOutputSchema = z.object({
  status: z.literal("compensated"),
  releaseId: z.string().min(1),
  failedService: z.string().min(1),
  compensatedServices: z.array(z.string().min(1)),
  automaticallyCancelledService: z.string().nullable(),
  evidence: EvidencePointerSchema,
});

const CompensationFailedOutputSchema = z.object({
  status: z.literal("compensation-failed"),
  releaseId: z.string().min(1),
  failedService: z.string().min(1),
  recoveredServices: z.array(z.string().min(1)),
  manualIntervention: z.array(ManualInterventionSchema).min(1),
  evidence: EvidencePointerSchema,
});

const ReleaseOutputSchema = z.discriminatedUnion("status", [
  ReleasedOutputSchema,
  CompensatedOutputSchema,
  CompensationFailedOutputSchema,
]);

/** Why: Produces bounded replay-stable key segments from service order and name. Use: Prefix deployment and compensation effects. */
function serviceNameStepKey(service: string, order: number): string {
  const suffix = service
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, "-")
    .replaceAll(/^-|-$/g, "");
  return `${order}:${suffix || "service"}`;
}

/** Why: Adapts a validated release target to its stable key. Use: Keep forward deployment call sites concise. */
function serviceStepKey(service: ServiceRelease, order: number): string {
  return serviceNameStepKey(service.service, order);
}

/** Why: Rejects ambiguous release plans whose duplicate service intents could collide remotely. Use: Call before the first protected effect. */
function assertUniqueServices(services: readonly ServiceRelease[]): void {
  const names = new Set(services.map(({ service }) => service));
  if (names.size !== services.length) throw new Error("Release service names must be unique");
}

/** Why: Creates one provider identity stable across workflow runs and transport response loss. Use: Bind primary attempt, handle, and automatic cancellation. */
function primaryIdempotencyKey(releaseId: string, environment: string, service: ServiceRelease): string {
  return `deploy:${environment}:${releaseId}:${service.service}:${service.artifact.sha256}`;
}

/** Why: Creates a stable cancellation identity from the primary remote intent alone. Use: Register automatic cleanup before dispatch. */
function cancellationIdempotencyKey(primaryKey: string): string {
  return `cancel:${primaryKey}`;
}

/** Why: Creates a stable compensation identity from successful primary evidence alone. Use: Reuse across recovery retries and replay. */
function compensationIdempotencyKey(primaryKey: string): string {
  return `rollback:${primaryKey}`;
}

/** Why: Rejects a returned provider handle for another release intent. Use: Validate immediately after a succeeded attempt. */
function assertHandleMatches(
  handle: DeploymentHandle,
  releaseId: string,
  environment: string,
  service: ServiceRelease,
  idempotencyKey: string,
): void {
  if (
    handle.releaseId !== releaseId ||
    handle.environment !== environment ||
    handle.service !== service.service ||
    handle.artifactSha256 !== service.artifact.sha256 ||
    handle.primaryIdempotencyKey !== idempotencyKey
  ) {
    throw new Error(`Deployment handle identity mismatch for ${service.service}`);
  }
}

/** Why: Rejects terminal observation evidence detached from the exact success receipt handle. Use: Validate before marking a service deployed. */
function assertTerminalMatches(handle: DeploymentHandle, terminal: DeploymentTerminal): void {
  if (
    terminal.handleRef !== handle.handleRef ||
    terminal.providerDeploymentId !== handle.providerDeploymentId ||
    terminal.artifactSha256 !== handle.artifactSha256
  ) {
    throw new Error(`Terminal deployment evidence mismatch for ${handle.service}`);
  }
}

/** Why: Rejects compensation output for another primary receipt or previous artifact. Use: Validate typed recovery success before recording it. */
function assertRollbackMatches(handle: DeploymentHandle, output: RollbackDeploymentOutput): void {
  if (
    output.handleRef !== handle.handleRef ||
    output.restoredArtifactSha256 !== handle.previousArtifactSha256 ||
    output.compensationIdempotencyKey !== compensationIdempotencyKey(handle.primaryIdempotencyKey)
  ) {
    throw new Error(`Rollback evidence mismatch for ${handle.service}`);
  }
}

/** Why: Preserves useful workflow failure text without claiming remote commit state. Use: Project only non-provider exceptions. */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown workflow error";
}

/** Why: Atomically registers recovery without dispatching the protected adapter. Use: Make registration failure safely `not-started`. */
async function registerDeployment(
  ctx: Ctx,
  releaseId: string,
  environment: string,
  service: ServiceRelease,
  order: number,
) {
  const stepKey = serviceStepKey(service, order);
  const primaryKey = primaryIdempotencyKey(releaseId, environment, service);
  const cancelKey = cancellationIdempotencyKey(primaryKey);
  const candidate = await ctx.operation.prepare(
    startDeployment,
    {
      releaseId,
      environment,
      service: service.service,
      artifact: service.artifact,
      primaryIdempotencyKey: primaryKey,
    },
    { key: `${stepKey}:deploy:prepare`, label: `Prepare ${service.service}` },
  );
  const authorization = await ctx.operation.authorize(startDeployment, candidate, {
    key: `${stepKey}:deploy:authorize`,
    label: `Authorize ${service.service}`,
    detail: `Deploy ${service.artifact.sha256} to ${environment} for release ${releaseId}.`,
  });
  const attempt = await ctx.operation.recoverable(
    startDeployment,
    { candidate, authorization },
    {
      cancellation: {
        operation: cancelAmbiguousDeployment,
        map: (intent) => ({
          primaryIdempotencyKey: intent.idempotencyKey,
          cancellationIdempotencyKey: cancellationIdempotencyKey(intent.idempotencyKey),
        }),
        options: {
          key: `${stepKey}:deploy:auto-cancel`,
          idempotencyKey: cancelKey,
          attempts: 5,
          timeout: "3m",
        },
      },
      compensation: {
        operation: rollbackDeployment,
        map: (receipt) => ({
          handle: receipt.output,
          compensationIdempotencyKey: compensationIdempotencyKey(receipt.idempotencyKey),
        }),
      },
    },
    {
      key: `${stepKey}:deploy:attempt`,
      label: `Journal recoverable deployment of ${service.service}`,
      idempotencyKey: primaryKey,
      attempts: 3,
      timeout: "3m",
    },
  );
  return attempt;
}

/** Why: Names the pre-dispatch nominal attempt used for exact cancellation projections. Use: Keep its recovery state intact. */
type DeploymentAttempt = Awaited<ReturnType<typeof registerDeployment>>;

/** Why: Dispatches only an already journaled attempt. Use: Receive the engine's exhaustive provider commit classification. */
async function executeDeployment(ctx: Ctx, attempt: DeploymentAttempt) {
  return ctx.operation.executeRecoverable(startDeployment, attempt);
}

/** Why: Names the exhaustive host-minted dispatch result. Use: Derive success and ambiguity branches. */
type DeploymentResult = Awaited<ReturnType<typeof executeDeployment>>;

/** Why: Keeps one attempt adjacent to its classified outcome in ordinary workflow code. Use: Drive evidence projection and recovery. */
interface DeploymentDispatch {
  attempt: DeploymentAttempt;
  result: DeploymentResult;
}

/** Why: Names only the succeeded branch carrying compensation authority. Use: Extract its nominal receipt. */
type DeploymentSucceeded = Extract<DeploymentResult, { status: "succeeded" }>;

/** Why: Names exact successful primary evidence stored in the reverse compensation ledger. Use: Prepare rollback without copied handles. */
type DeploymentReceipt = DeploymentSucceeded["receipt"];

/** Why: Names only the ambiguous branch whose engine-run cancellation must be audited. Use: Project cancellation and manual intervention. */
type AmbiguousDeployment = Extract<DeploymentResult, { status: "ambiguous" }>;

/** Why: Proves pre-dispatch intent is not post-success compensation authority. Use: Keep the nominal boundary regression-tested at compile time. */
async function proveAttemptCannotCompensate(ctx: Ctx, attempt: DeploymentAttempt): Promise<void> {
  // @ts-expect-error An attempt has no validated primary output and cannot prepare compensation.
  await ctx.operation.prepareRecovery(attempt, rollbackDeployment, { key: "type-proof" });
}

void proveAttemptCannotCompensate;

/** Why: Names an exact committed primary receipt plus release order. Use: Compensate the ledger in reverse ordinary-TypeScript order. */
interface CommittedDeployment {
  order: number;
  service: string;
  receipt: DeploymentReceipt;
}

/** Why: Represents provider-confirmed compensation. Use: Append its action and continue reverse recovery. */
interface SuccessfulCompensation {
  ok: true;
  action: CompensationAction;
}

/** Why: Represents compensation still requiring reconciliation. Use: Append its evidence and continue earlier recovery. */
interface UnresolvedCompensation {
  ok: false;
  failure: ManualIntervention;
}

/** Why: Makes every compensation attempt exhaustively branchable without stopping the reverse loop. Use: Narrow on `ok`. */
type CompensationOutcome = SuccessfulCompensation | UnresolvedCompensation;

/** Why: Projects nominal attempt fields and frozen automatic cleanup evidence. Use: Persist exact replay identity. */
function projectAttempt(attempt: DeploymentAttempt, order: number, service: string): AttemptEvidence {
  return {
    order,
    service,
    attemptRef: attempt.ref,
    candidateRef: attempt.candidateRef,
    authorizationRef: attempt.authorizationRef,
    definitionDigest: attempt.definitionDigest,
    inputDigest: attempt.inputDigest,
    primaryIdempotencyKey: attempt.idempotencyKey,
    cancellationRegistrationRef: attempt.recovery.cancellation.ref,
    cancellationInputDigest: attempt.recovery.cancellation.inputDigest,
    cancellationIdempotencyKey: attempt.recovery.cancellation.idempotencyKey,
  };
}

/** Why: Projects the engine-run direct cleanup result without weakening its host classification. Use: Audit ambiguous dispatch. */
function projectCancellation(
  result: AmbiguousDeployment["cancellation"],
  attempt: DeploymentAttempt,
): CancellationEvidence {
  if (result.status === "succeeded") {
    const verified =
      result.output.primaryIdempotencyKey === attempt.idempotencyKey &&
      result.output.cancellationIdempotencyKey === result.idempotencyKey;
    return {
      status: result.status,
      attemptRef: result.attemptRef,
      definitionDigest: result.definitionDigest,
      inputDigest: result.inputDigest,
      idempotencyKey: result.idempotencyKey,
      output: result.output,
      failureReason: verified ? null : "Conditional cancellation identity mismatch",
      verified,
    };
  }
  return {
    status: result.status,
    attemptRef: result.attemptRef,
    definitionDigest: result.definitionDigest,
    inputDigest: result.inputDigest,
    idempotencyKey: result.idempotencyKey,
    output: null,
    failureReason: result.failure.reason,
    verified: false,
  };
}

/** Why: Executes one receipt-bound protected rollback and preserves typed failure classifications. Use: Call sequentially over the reversed ledger. */
async function compensateDeployment(
  ctx: Ctx,
  deployment: CommittedDeployment,
  sequence: number,
): Promise<CompensationOutcome> {
  const { receipt } = deployment;
  const handle = receipt.output;
  const stepKey = `${serviceNameStepKey(deployment.service, deployment.order)}:rollback`;
  const idempotencyKey = compensationIdempotencyKey(receipt.idempotencyKey);
  let stage: "prepare" | "authorize" | "recover" = "prepare";
  let candidateRef: string | null = null;
  let authorizationRef: string | null = null;
  try {
    const candidate = await ctx.operation.prepareRecovery(receipt, rollbackDeployment, {
      key: `${stepKey}:prepare`,
      label: `Prepare rollback of ${deployment.service}`,
    });
    candidateRef = candidate.ref;
    stage = "authorize";
    const authorization = await ctx.operation.authorize(rollbackDeployment, candidate, {
      key: `${stepKey}:authorize`,
      label: `Authorize rollback of ${deployment.service}`,
      detail: `Restore ${handle.previousArtifactSha256} after a partial coordinated release.`,
    });
    authorizationRef = authorization.ref;
    stage = "recover";
    const result = await ctx.operation.recover(
      receipt,
      rollbackDeployment,
      { candidate, authorization },
      {
        key: `${stepKey}:execute`,
        idempotencyKey,
        attempts: 3,
        timeout: "5m",
      },
    );
    if (result.status === "succeeded") {
      assertRollbackMatches(handle, result.receipt.output);
      return {
        ok: true,
        action: {
          sequence,
          order: deployment.order,
          service: deployment.service,
          primaryReceiptRef: receipt.ref,
          candidateRef: result.candidateRef,
          authorizationRef: result.authorizationRef,
          recoveryReceiptRef: result.receipt.ref,
          definitionDigest: result.definitionDigest,
          inputDigest: result.inputDigest,
          outputDigest: result.receipt.outputDigest,
          idempotencyKey: result.idempotencyKey,
          output: result.receipt.output,
        },
      };
    }
    return {
      ok: false,
      failure: {
        sequence,
        kind: "compensation",
        order: deployment.order,
        service: deployment.service,
        status: result.status,
        commit: result.commit,
        subjectRef: receipt.ref,
        candidateRef: result.candidateRef,
        authorizationRef: result.authorizationRef,
        idempotencyKey: result.idempotencyKey,
        reason: result.failure.reason,
      },
    };
  } catch (error) {
    return {
      ok: false,
      failure: {
        sequence,
        kind: "compensation",
        order: deployment.order,
        service: deployment.service,
        status: "workflow-error",
        commit: stage === "recover" ? "unknown" : "not-committed",
        subjectRef: receipt.ref,
        candidateRef,
        authorizationRef,
        idempotencyKey,
        reason: `${stage}: ${errorMessage(error)}`,
      },
    };
  }
}

const compensatedReleaseWorkflow = defineWorkflow(
  {
    id: "round-06-compensated-release",
    name: "Release multiple services with recoverable operations",
    description:
      "Registers cancellation before dispatch and compensates committed deployments in reverse order.",
    input: ReleaseInputSchema,
    output: ReleaseOutputSchema,
  },
  async (ctx, input) => {
    assertUniqueServices(input.services);
    const attempts: AttemptEvidence[] = [];
    const deployments: DeploymentEvidence[] = [];
    const committed: CommittedDeployment[] = [];
    const compensations: CompensationAction[] = [];
    const manualIntervention: ManualIntervention[] = [];
    let failure: ReleaseFailure | null = null;
    let cancellation: CancellationEvidence | null = null;

    for (const [order, service] of input.services.entries()) {
      let attempt: DeploymentAttempt;
      try {
        attempt = await registerDeployment(ctx, input.releaseId, input.environment, service, order);
      } catch (error) {
        failure = {
          order,
          service: service.service,
          stage: "registration",
          classification: "workflow-error",
          commit: "not-started",
          attemptRef: null,
          reason: errorMessage(error),
        };
        break;
      }

      attempts.push(projectAttempt(attempt, order, service.service));
      const result = await executeDeployment(ctx, attempt);
      const dispatch: DeploymentDispatch = { attempt, result };
      if (result.status === "retryable" || result.status === "terminal") {
        failure = {
          order,
          service: service.service,
          stage: "dispatch",
          classification: result.status,
          commit: result.commit,
          attemptRef: dispatch.attempt.ref,
          reason: result.failure.reason,
        };
        break;
      }

      if (result.status === "ambiguous") {
        cancellation = projectCancellation(result.cancellation, dispatch.attempt);
        if (!cancellation.verified) {
          const cancellationSucceeded = result.cancellation.status === "succeeded";
          manualIntervention.push({
            sequence: 0,
            kind: "cancellation",
            order,
            service: service.service,
            status: cancellationSucceeded ? "workflow-error" : result.cancellation.status,
            commit:
              result.cancellation.status === "ambiguous"
                ? "may-have-committed"
                : cancellationSucceeded
                  ? "unknown"
                  : "not-committed",
            subjectRef: dispatch.attempt.ref,
            candidateRef: null,
            authorizationRef: null,
            idempotencyKey: result.cancellation.idempotencyKey,
            reason:
              cancellation.failureReason ?? "Conditional cancellation returned mismatched identity evidence",
          });
        }
        failure = {
          order,
          service: service.service,
          stage: "dispatch",
          classification: result.status,
          commit: result.commit,
          attemptRef: dispatch.attempt.ref,
          reason: result.failure.reason,
        };
        break;
      }

      const receipt = result.receipt;
      const handle = receipt.output;
      assertHandleMatches(
        handle,
        input.releaseId,
        input.environment,
        service,
        dispatch.attempt.idempotencyKey,
      );
      committed.push({ order, service: service.service, receipt });
      let terminal: DeploymentTerminal;
      try {
        terminal = await ctx.observe(waitForDeployment, handle, {
          key: `${serviceStepKey(service, order)}:deploy:observe`,
          every: "20s",
          timeout: "45m",
        });
        assertTerminalMatches(handle, terminal);
      } catch (error) {
        failure = {
          order,
          service: service.service,
          stage: "observe",
          classification: "workflow-error",
          commit: "committed",
          attemptRef: dispatch.attempt.ref,
          reason: errorMessage(error),
        };
        break;
      }

      if (terminal.status === "failed") {
        failure = {
          order,
          service: service.service,
          stage: "terminal",
          classification: "deployment-failed",
          commit: "committed",
          attemptRef: dispatch.attempt.ref,
          reason: terminal.reason,
        };
        break;
      }

      deployments.push({
        order,
        service: service.service,
        attemptRef: dispatch.attempt.ref,
        receiptRef: receipt.ref,
        outputDigest: receipt.outputDigest,
        handle,
        terminal,
      });
    }

    if (failure !== null) {
      let sequence = manualIntervention.length;
      for (const deployment of [...committed].reverse()) {
        const recovery = await compensateDeployment(ctx, deployment, sequence);
        sequence += 1;
        if (recovery.ok) compensations.push(recovery.action);
        else manualIntervention.push(recovery.failure);
      }
    }

    const outcome =
      failure === null
        ? ("released" as const)
        : manualIntervention.length === 0
          ? ("compensated" as const)
          : ("compensation-failed" as const);
    const recordedAt = await ctx.now();
    const evidence = await ctx.artifact(
      releaseEvidence,
      {
        content: {
          outcome,
          request: input,
          attempts,
          deployments,
          failure,
          cancellation,
          compensations,
          manualIntervention,
        },
        metadata: {
          releaseId: input.releaseId,
          environment: input.environment,
          workflowRunId: ctx.run.id,
          recordedAt,
        },
      },
      { key: "release-evidence", label: `Release evidence for ${input.releaseId}` },
    );
    const evidencePointer = { ref: evidence.ref, sha256: evidence.sha256 };

    if (failure === null) {
      return {
        status: "released" as const,
        releaseId: input.releaseId,
        deployedServices: deployments.map(({ service }) => service),
        evidence: evidencePointer,
      };
    }

    const recoveredServices = compensations.map(({ service }) => service);
    if (manualIntervention.length === 0) {
      return {
        status: "compensated" as const,
        releaseId: input.releaseId,
        failedService: failure.service,
        compensatedServices: recoveredServices,
        automaticallyCancelledService:
          cancellation?.status === "succeeded" && cancellation.verified ? failure.service : null,
        evidence: evidencePointer,
      };
    }

    return {
      status: "compensation-failed" as const,
      releaseId: input.releaseId,
      failedService: failure.service,
      recoveredServices,
      manualIntervention,
      evidence: evidencePointer,
    };
  },
);

expectType<WorkflowNode<"weft.workflow">>(compensatedReleaseWorkflow);

// Round 6 DX findings:
// 1. Soundness: nominal attempts and success receipts now close the response-loss gap; cancellation no longer needs
//    a copied provider handle, and compensation cannot be prepared from an attempt or output-shaped value.
// 2. Soundness: `ConditionalCleanupOperationDefinition` makes later authority unnecessary, but idempotent conditional
//    behavior is still a host-binding invariant rather than something TypeScript can prove about the provider.
// 3. Convenience: the lifecycle is intentionally explicit but verbose; a typed saga helper could assemble stable
//    keys and evidence projections while leaving `recoverable`, `executeRecoverable`, and `recover` journal-visible.
