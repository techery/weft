import {
  type DetailedObserverResult,
  defineObserver,
  defineOperation,
  defineWorkflow,
  type ObserverOutputOf,
  type OperationInputOf,
  type OperationOutputOf,
  type WorkflowNode,
  z,
} from "../../index.ts";

/** Why: Makes compile-time contract assertions visible without adding runtime test behavior. Use: Pass inferred DSL values to it in this typechecked example. */
declare function expectType<T>(value: T): void;

const ArtifactPointer = z.object({
  ref: z.string().min(1),
  sha256: z.string().min(1),
});

const DeploymentTarget = z.object({
  repository: z.string().min(1),
  environment: z.enum(["staging", "production"]),
  head: z.string().min(1),
  artifact: ArtifactPointer,
});

const DeploymentObservationInput = DeploymentTarget.extend({
  changeTicket: z.string().min(1),
});

const TriggerDeploymentInput = DeploymentTarget.extend({
  workflowRunId: z.string().min(1),
  idempotencyKey: z.string().min(1),
  changeTicket: z.string().min(1),
  onWorkflowCancellation: z.literal("request-provider-cancel"),
});

const DeploymentTriggerReceipt = DeploymentTarget.extend({
  provenance: z.literal("host-attested"),
  workflowRunId: z.string().min(1),
  idempotencyKey: z.string().min(1),
  triggerId: z.string().min(1),
  correlationId: z.string().min(1),
  providerDeploymentId: z.string().min(1),
  requestedAt: z.string().datetime(),
  signal: z.object({
    name: z.string().min(1),
    subscriptionRef: z.string().min(1),
  }),
  poll: z.object({
    lookupRef: z.string().min(1),
  }),
  cancellation: z.object({
    registrationRef: z.string().min(1),
    onWorkflowCancellation: z.literal("request-provider-cancel"),
    expiresAt: z.string().datetime(),
  }),
  attestation: z.string().min(1),
});

/** Why: Names the exact target and lifecycle registration returned by the trigger host. Use: Correlate every later event and completion proof against it. */
type DeploymentTriggerReceiptValue = z.infer<typeof DeploymentTriggerReceipt>;

const triggerDeployment = defineOperation({
  name: "round-05-trigger-ci-deployment",
  description:
    "Idempotently starts CI and deployment and atomically registers signal, polling, and workflow-cancellation routes for one exact artifact.",
  input: TriggerDeploymentInput,
  output: DeploymentTriggerReceipt,
  binding: "delivery.ci-deployment.trigger",
  capabilities: ["network", "secrets:read", "integration:ci", "integration:deployment"],
  defaults: { timeout: "5m", attempts: 1 },
  authorization: {
    mode: "required",
    action: "Start CI and deploy one exact artifact",
    risk: "high",
    timeout: "30m",
  },
});

const ObservationEnvelope = DeploymentTarget.extend({
  triggerId: z.string().min(1),
  correlationId: z.string().min(1),
  providerDeploymentId: z.string().min(1),
  eventId: z.string().min(1),
  sequence: z.number().int().nonnegative(),
  observedAt: z.string().datetime(),
});

const ProgressObservation = ObservationEnvelope.extend({
  kind: z.literal("progress"),
  phase: z.enum(["queued", "ci", "deployment"]),
  state: z.enum(["pending", "running"]),
  detail: z.string().min(1),
});

const TerminalObservationBase = ObservationEnvelope.extend({
  kind: z.literal("terminal"),
  evidence: ArtifactPointer,
});

const SuccessfulObservation = TerminalObservationBase.extend({
  outcome: z.literal("succeeded"),
  completedAt: z.string().datetime(),
  ci: z.object({
    runId: z.string().min(1),
    url: z.string().url(),
    evidence: ArtifactPointer,
  }),
  deployment: z.object({
    deploymentId: z.string().min(1),
    url: z.string().url(),
    evidence: ArtifactPointer,
  }),
});

const FailedObservation = TerminalObservationBase.extend({
  outcome: z.literal("failed"),
  failedAt: z.string().datetime(),
  phase: z.enum(["ci", "deployment"]),
  reason: z.string().min(1),
  diagnostics: ArtifactPointer,
});

const CancelledObservation = TerminalObservationBase.extend({
  outcome: z.literal("cancelled"),
  cancelledAt: z.string().datetime(),
  cancelledBy: z.string().min(1),
  reason: z.string().min(1),
  cancellationEvidence: ArtifactPointer,
});

const TerminalObservation = z.discriminatedUnion("outcome", [
  SuccessfulObservation,
  FailedObservation,
  CancelledObservation,
]);

const DeploymentObservationState = z.union([
  ProgressObservation,
  SuccessfulObservation,
  FailedObservation,
  CancelledObservation,
]);

/** Why: Gives identity and completion callbacks one named union for every accepted provider state. Use: Derive correlation, event identity, and monotonic sequence before completion is evaluated. */
type DeploymentObservationStateValue = z.infer<typeof DeploymentObservationState>;

/** Why: Names the only provider terminal outcomes the workflow may report. Use: Carry it with engine-minted observation evidence instead of re-reading the same authoritative state. */
type TerminalObservationValue = z.infer<typeof TerminalObservation>;

/** Why: Names fields shared by trigger receipts and observation events. Use: Derive one canonical identity across both trusted endpoints. */
interface DeploymentCorrelation {
  repository: string;
  environment: "staging" | "production";
  head: string;
  artifact: { ref: string; sha256: string };
  triggerId: string;
  correlationId: string;
  providerDeploymentId: string;
}

/** Why: Produces an unambiguous engine-comparable key for one exact deployment and artifact. Use: Supply it from both sides of the observer identity contract. */
function deploymentCorrelation(value: DeploymentCorrelation): string {
  return JSON.stringify([
    value.repository,
    value.environment,
    value.head,
    value.artifact.ref,
    value.artifact.sha256,
    value.triggerId,
    value.correlationId,
    value.providerDeploymentId,
  ]);
}

/** Why: Fails closed if accepted state names a different trigger or artifact. Use: Defend completion mapping in addition to the engine identity check. */
function requireSameCorrelation(expected: DeploymentCorrelation, actual: DeploymentCorrelation): void {
  if (deploymentCorrelation(expected) !== deploymentCorrelation(actual)) {
    throw new Error("Observation did not match the exact triggered deployment");
  }
}

/** Why: Prevents the trigger adapter from redirecting an authorized request to different bytes or lifecycle behavior. Use: Validate the receipt before starting either observation endpoint. */
function requireReceiptMatchesRequest(
  request: OperationInputOf<typeof triggerDeployment>,
  receipt: DeploymentTriggerReceiptValue,
): void {
  if (
    receipt.repository !== request.repository ||
    receipt.environment !== request.environment ||
    receipt.head !== request.head ||
    receipt.artifact.ref !== request.artifact.ref ||
    receipt.artifact.sha256 !== request.artifact.sha256 ||
    receipt.workflowRunId !== request.workflowRunId ||
    receipt.idempotencyKey !== request.idempotencyKey ||
    receipt.cancellation.onWorkflowCancellation !== request.onWorkflowCancellation
  ) {
    throw new Error("Deployment trigger receipt did not preserve the authorized request");
  }
}

/** Why: Resolves the durable signal route registered by the trigger adapter. Use: Give the signal-first observer a host-bound signal name without rebuilding it in workflow code. */
function deploymentSignalName(input: DeploymentTriggerReceiptValue): string {
  return input.signal.name;
}

/** Why: Normalizes a completed provider state while leaving progress incomplete. Use: Share one completion policy across signal and polling delivery. */
function completeDeploymentObservation(
  state: DeploymentObservationStateValue,
  input: DeploymentTriggerReceiptValue,
): z.input<typeof TerminalObservation> | null {
  requireSameCorrelation(input, state);
  return state.kind === "progress" ? null : state;
}

const signalBinding = "delivery.ci-deployment.signal" as const;
const pollBinding = "delivery.ci-deployment.observe" as const;
const signalAuthority = "delivery-provider.events" as const;
const pollAuthority = "delivery-provider.records" as const;

const waitForDeploymentCompletion = defineObserver({
  name: "round-05-deployment-completion",
  description:
    "Waits on authoritative deployment events, activates authoritative polling after grace, and accepts one identity-checked terminal winner.",
  input: DeploymentTriggerReceipt,
  state: DeploymentObservationState,
  output: TerminalObservation,
  source: {
    kind: "signal-first",
    signal: {
      binding: signalBinding,
      signal: deploymentSignalName,
      trust: { minimum: "authoritative", authorities: [signalAuthority] },
    },
    fallback: {
      binding: pollBinding,
      every: "30s",
      trust: { minimum: "authoritative", authorities: [pollAuthority] },
    },
    grace: "5m",
  },
  identity: {
    inputCorrelation: deploymentCorrelation,
    stateCorrelation: deploymentCorrelation,
    eventId: (state) => state.eventId,
    sequence: (state) => state.sequence,
  },
  defaults: { timeout: "2h" },
  complete: completeDeploymentObservation,
});

/** Why: Names the nominal result minted by the observer engine for this exact definition. Use: Require it before projecting completion evidence into serializable workflow output. */
type DeploymentObservationDetail = DetailedObserverResult<typeof waitForDeploymentCompletion>;

const DeploymentCompletionEvidence = z.object({
  kind: z.literal("observer"),
  ref: z.string().min(1),
  sha256: z.string().min(1),
  createdAt: z.string().datetime(),
  subject: z.object({
    observer: z.literal("round-05-deployment-completion"),
    definitionDigest: z.string().min(1),
    inputDigest: z.string().min(1),
    correlation: z.string().min(1),
  }),
  provenance: z.object({
    observer: z.literal("round-05-deployment-completion"),
    strategy: z.literal("signal-first"),
    endpoint: z.enum(["signal", "poll"]),
    binding: z.string().min(1),
    authority: z.string().min(1),
    trust: z.literal("authoritative"),
    eventId: z.string().min(1),
    sequence: z.number().int().nonnegative(),
    startedAt: z.string().datetime(),
    completedAt: z.string().datetime(),
    fallbackActivatedAt: z.string().datetime().optional(),
  }),
});

/** Why: Names the serializable projection of nominal engine evidence returned to callers. Use: Preserve its digest, exact subject, endpoint, authority, and accepted event identity. */
type DeploymentCompletionEvidenceValue = z.infer<typeof DeploymentCompletionEvidence>;

/** Why: Fails closed unless detailed evidence proves authoritative, identity-matched completion through a declared endpoint. Use: Project nominal evidence only after checking the engine-minted provenance. */
function requireTrustedCompletionEvidence(
  receipt: DeploymentTriggerReceiptValue,
  terminal: TerminalObservationValue,
  detail: DeploymentObservationDetail,
): DeploymentCompletionEvidenceValue {
  requireSameCorrelation(receipt, terminal);

  const { evidence, provenance, subject } = detail;
  const correlation = deploymentCorrelation(receipt);
  const expectedBinding = provenance.endpoint === "signal" ? signalBinding : pollBinding;
  const expectedAuthority = provenance.endpoint === "signal" ? signalAuthority : pollAuthority;

  if (
    provenance.strategy !== "signal-first" ||
    (provenance.endpoint !== "signal" && provenance.endpoint !== "poll") ||
    provenance.binding !== expectedBinding ||
    provenance.trust?.level !== "authoritative" ||
    provenance.trust.authority !== expectedAuthority ||
    provenance.identity?.correlation !== correlation ||
    provenance.identity.eventId !== terminal.eventId ||
    provenance.identity.sequence !== terminal.sequence ||
    subject.correlation !== correlation ||
    evidence.subject.definitionDigest !== subject.definitionDigest ||
    evidence.subject.inputDigest !== subject.inputDigest ||
    evidence.subject.correlation !== subject.correlation
  ) {
    throw new Error("Observer evidence did not prove the exact authoritative terminal event");
  }

  if (provenance.endpoint === "poll" && provenance.fallback === undefined) {
    throw new Error("Polling completion lacked engine-recorded fallback activation");
  }

  return {
    kind: evidence.kind,
    ref: evidence.ref,
    sha256: evidence.sha256,
    createdAt: evidence.createdAt,
    subject: {
      observer: subject.observer,
      definitionDigest: subject.definitionDigest,
      inputDigest: subject.inputDigest,
      correlation,
    },
    provenance: {
      observer: provenance.observer,
      strategy: provenance.strategy,
      endpoint: provenance.endpoint,
      binding: provenance.binding,
      authority: provenance.trust.authority,
      trust: provenance.trust.level,
      eventId: provenance.identity.eventId,
      sequence: provenance.identity.sequence,
      startedAt: provenance.startedAt,
      completedAt: provenance.completedAt,
      ...(provenance.fallback === undefined ? {} : { fallbackActivatedAt: provenance.fallback.activatedAt }),
    },
  };
}

const DeploymentObservationOutput = z.object({
  observationMode: z.enum(["signal", "poll"]),
  receipt: DeploymentTriggerReceipt,
  terminal: TerminalObservation,
  completionEvidence: DeploymentCompletionEvidence,
});

/** Why: Keeps trigger identity, terminal state, and engine-minted completion proof in one handoff. Use: Annotate the workflow return so no terminal branch or provenance field widens. */
type DeploymentObservationOutputValue = z.infer<typeof DeploymentObservationOutput>;

/** Why: Demonstrates one durable signal-first deployment wait with nominal completion evidence. Use: Launch it for an exact built artifact and audit which trusted endpoint won. */
const deploymentObservationWorkflow = defineWorkflow(
  {
    id: "round-05-deployment-observation",
    name: "Signal-first CI and deployment observation",
    description:
      "Triggers one exact deployment and uses one engine-owned signal-first observer to return authoritative, identity-checked terminal evidence.",
    input: DeploymentObservationInput,
    output: DeploymentObservationOutput,
  },
  async (ctx, input): Promise<DeploymentObservationOutputValue> => {
    const triggerInput: OperationInputOf<typeof triggerDeployment> = {
      repository: input.repository,
      environment: input.environment,
      head: input.head,
      artifact: input.artifact,
      workflowRunId: ctx.run.id,
      idempotencyKey: `${ctx.run.id}:${input.repository}:${input.environment}:${input.artifact.sha256}`,
      changeTicket: input.changeTicket,
      onWorkflowCancellation: "request-provider-cancel",
    };

    const triggerCandidate = await ctx.operation.prepare(triggerDeployment, triggerInput, {
      key: "prepare-deployment-trigger",
      label: "Freeze exact CI and deployment request",
    });
    const triggerAuthorization = await ctx.operation.authorize(triggerDeployment, triggerCandidate, {
      key: "authorize-deployment-trigger",
      detail: `Deploy artifact ${input.artifact.sha256} from ${input.head} to ${input.environment}.`,
    });
    const receipt = await ctx.operation.execute(
      triggerDeployment,
      { candidate: triggerCandidate, authorization: triggerAuthorization },
      { key: "trigger-deployment", attempts: 1 },
    );
    expectType<OperationOutputOf<typeof triggerDeployment>>(receipt);
    requireReceiptMatchesRequest(triggerInput, receipt);

    // Do not catch this wait: engine timeout and caller cancellation abort the whole signal-first state machine;
    // only the grace deadline activates polling, and the first valid terminal result cancels its losing endpoint.
    const observed = await ctx.observe.detailed(waitForDeploymentCompletion, receipt, {
      key: "wait-for-deployment-completion",
      label: `Wait for ${receipt.providerDeploymentId} terminal state`,
      timeout: "2h",
      grace: "5m",
      fallbackEvery: "30s",
    });
    expectType<DeploymentObservationDetail>(observed);
    expectType<ObserverOutputOf<typeof waitForDeploymentCompletion>>(observed.output);

    const terminal = observed.output;
    const completionEvidence = requireTrustedCompletionEvidence(receipt, terminal, observed);
    const observationMode = completionEvidence.provenance.endpoint;

    await ctx.note({
      kind: terminal.outcome === "succeeded" ? "claim" : "risk",
      text: `${receipt.providerDeploymentId} completed with ${terminal.outcome} via authoritative ${observationMode} observation.`,
      evidence: observed.evidence.ref,
    });

    return { observationMode, receipt, terminal, completionEvidence };
  },
);

expectType<WorkflowNode<"weft.workflow">>(deploymentObservationWorkflow);

// SOLVED: source-specific host binding and authoritative trust now cover both signal and polling, while the identity
// contract makes correlation, event-ID conflict/replay rejection, and monotonic sequence checks engine responsibilities.
// Detailed observation returns nominal evidence, so a second read of the same provider terminal state is redundant.
//
// SOLVED: signal grace, overall timeout, and caller cancellation are distinct in one engine-owned state machine. Grace
// starts polling; timeout or cancellation aborts both endpoints; exactly one valid terminal winner cancels its loser.
//
// DEFERRED UNSOUND GAP: observer cancellation stops both waiting endpoints but does not type the remote deployment's
// cancellation lifecycle. The trigger atomically registers a host-side workflow-cancellation action as a sound local
// workaround; a small durable `defineTrigger({ start, cancel })` lease would expose that provider effect to inspection.
