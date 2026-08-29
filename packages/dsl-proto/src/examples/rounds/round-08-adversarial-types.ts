import {
  type CheckInvocationOptions,
  type CheckWaiverRef,
  type ContextSnapshotOf,
  type Ctx,
  type DetailedObserverResult,
  defineCheck,
  defineContextSource,
  defineDelivery,
  defineObserver,
  defineOperation,
  definePathPolicy,
  defineResultView,
  defineReview,
  defineTaskContract,
  defineTrigger,
  defineUiView,
  defineWorkflow,
  type FailedCheckResultOf,
  type InferWorkflowInput,
  type InferWorkflowOutput,
  type ObserverInputOf,
  type ObserverInvocationOptionsOf,
  type ObserverOutputOf,
  type OperationAttemptCancellationIdempotencyOf,
  type OperationAttemptIdempotencyOf,
  type OperationAuthorizationOf,
  type OperationCandidateRef,
  type OperationInputOf,
  type OperationNameOf,
  type OperationOutputOf,
  type PathGrantRef,
  type PromotionCandidateInput,
  type ReviewFindingOf,
  type ReviewInputOf,
  type ReviewNameOf,
  type TriggerInputOf,
  type TriggerOutputOf,
  type TriggerRunProvenance,
  type WorkflowIdOf,
  type WorkflowInputSchemaOf,
  type WorkflowNode,
  type WorkflowOutputSchemaOf,
  type WorkspaceSnapshotRef,
  type WriteScope,
  z,
} from "../../index.ts";

/** Why: Makes positive and negative compile-time assertions visible without adding runtime behavior. Use: Exercise exact inferred DSL contracts. */
declare function expectType<Type>(value: Type): void;

// ---------------------------------------------------------------------------
// Trigger mapping, provenance, and workflow schema metadata
// ---------------------------------------------------------------------------

const CodingInput = z
  .object({
    repository: z.string().min(1),
    baseRef: z.string().min(1).default("main"),
    issueNumber: z.number().int().positive(),
  })
  .strict();

const CodingOutput = z
  .object({
    status: z.literal("queued"),
    repository: z.string().min(1),
    issueNumber: z.number().int().positive(),
  })
  .strict();

/** Why: Names the validated child output used by trigger and schema-helper assertions. Use: Confirm exact workflow output inference. */
type CodingOutputValue = z.infer<typeof CodingOutput>;

const codingWorkflow = defineWorkflow(
  {
    id: "round-08-coding-workflow",
    input: CodingInput,
    output: CodingOutput,
  },
  async (_ctx, input): Promise<CodingOutputValue> => ({
    status: "queued",
    repository: input.repository,
    issueNumber: input.issueNumber,
  }),
);

const workspaceCodingWorkflow = defineWorkflow(
  {
    id: "round-08-workspace-coding-workflow",
    input: CodingInput,
    output: CodingOutput,
    workspace: true,
  },
  async (_ctx, input): Promise<CodingOutputValue> => ({
    status: "queued",
    repository: input.repository,
    issueNumber: input.issueNumber,
  }),
);

defineWorkflow(
  // @ts-expect-error Every workflow definition requires a stable host-visible ID.
  { input: CodingInput, output: CodingOutput },
  async (_ctx, input): Promise<CodingOutputValue> => ({
    status: "queued",
    repository: input.repository,
    issueNumber: input.issueNumber,
  }),
);

const PullRequestEvent = z
  .object({
    deliveryId: z.string().min(1),
    repository: z.string().min(1),
    baseRef: z.string().min(1).default("main"),
    issueNumber: z.number().int().positive(),
  })
  .strict();

const codingTrigger = defineTrigger({
  name: "round-08-pull-request",
  revision: "github-v2",
  source: { binding: "github.webhook" },
  event: PullRequestEvent,
  workflow: codingWorkflow,
  eventId: (event) => event.deliveryId,
  dedupeKey: (event) => `${event.repository}:${event.deliveryId}`,
  map: (event) => ({
    repository: event.repository,
    baseRef: event.baseRef,
    issueNumber: event.issueNumber,
  }),
});

defineTrigger({
  name: "round-08-invalid-map",
  revision: "github-v2",
  source: { binding: "github.webhook" },
  event: PullRequestEvent,
  workflow: codingWorkflow,
  eventId: (event) => event.deliveryId,
  dedupeKey: (event) => event.deliveryId,
  // @ts-expect-error Trigger mapping must supply the child workflow's complete raw input.
  map: (event) => ({ repository: event.repository, baseRef: event.baseRef }),
});

declare const rawTriggerInput: TriggerInputOf<typeof codingTrigger>;
declare const rawEventInput: z.input<typeof PullRequestEvent>;
declare const triggerOutput: TriggerOutputOf<typeof codingTrigger>;
expectType<z.input<typeof PullRequestEvent>>(rawTriggerInput);
expectType<TriggerInputOf<typeof codingTrigger>>(rawEventInput);
expectType<TriggerOutputOf<typeof codingTrigger>>(triggerOutput);
expectType<"round-08-pull-request">(codingTrigger.name);
expectType<"github-v2">(codingTrigger.revision);

expectType<typeof CodingInput>(codingWorkflow.meta.input);
expectType<typeof CodingOutput>(codingWorkflow.meta.output);
expectType<"round-08-coding-workflow">(codingWorkflow.meta.id);
expectType<WorkflowIdOf<typeof codingWorkflow>>("round-08-coding-workflow");
expectType<"round-08-workspace-coding-workflow">(workspaceCodingWorkflow.meta.id);
expectType<WorkflowIdOf<typeof workspaceCodingWorkflow>>("round-08-workspace-coding-workflow");
expectType<WorkflowInputSchemaOf<typeof codingWorkflow>>(CodingInput);
expectType<WorkflowOutputSchemaOf<typeof codingWorkflow>>(CodingOutput);
expectType<InferWorkflowInput<typeof codingWorkflow>>({
  repository: "techery/weft",
  issueNumber: 8,
});
declare const inferredCodingOutput: InferWorkflowOutput<typeof codingWorkflow>;
expectType<CodingOutputValue>(inferredCodingOutput);
// @ts-expect-error Input and output schema helpers must not collapse to a common schema type.
expectType<WorkflowInputSchemaOf<typeof codingWorkflow>>(CodingOutput);
// @ts-expect-error A different string literal cannot impersonate this workflow definition's stable ID.
expectType<WorkflowIdOf<typeof codingWorkflow>>("round-08-other-workflow");

// ---------------------------------------------------------------------------
// UI and task definition identity
// ---------------------------------------------------------------------------

const workflowApprovalView = defineUiView({
  id: "round-08-workflow-approval",
  revision: "approval-v2",
  props: z.object({ summary: z.string().min(1) }).strict(),
  answer: z.object({ approved: z.boolean() }).strict(),
  component: ({ props }) => props.summary,
});

const workflowResultView = defineResultView({
  id: "round-08-workflow-result",
  props: z.object({ status: z.literal("complete") }).strict(),
  component: ({ props }) => props.status,
});

const workflowTaskContract = defineTaskContract({
  schema: z.object({ owner: z.string().min(1) }).strict(),
  revision: "tasks-v3",
  version: 3,
});

const defaultVersionTaskContract = defineTaskContract({
  schema: z.object({ queue: z.string().min(1) }).strict(),
  revision: "tasks-v4",
});

expectType<"round-08-workflow-approval">(workflowApprovalView.id);
expectType<typeof workflowApprovalView.id>("round-08-workflow-approval");
expectType<"approval-v2">(workflowApprovalView.revision);
expectType<typeof workflowApprovalView.revision>("approval-v2");
expectType<"round-08-workflow-result">(workflowResultView.id);
expectType<string>(workflowResultView.revision);
expectType<"tasks-v3">(workflowTaskContract.revision);
expectType<typeof workflowTaskContract.revision>("tasks-v3");
expectType<3>(workflowTaskContract.version);
expectType<typeof workflowTaskContract.version>(3);
expectType<"tasks-v4">(defaultVersionTaskContract.revision);
expectType<number>(defaultVersionTaskContract.version);
// @ts-expect-error A different view ID cannot satisfy the exact input-view identity.
expectType<typeof workflowApprovalView.id>("round-08-other-view");
// @ts-expect-error A different supplied revision cannot satisfy the exact view revision.
expectType<typeof workflowApprovalView.revision>("approval-v3");
// @ts-expect-error A different task revision cannot satisfy the exact contract revision.
expectType<typeof workflowTaskContract.revision>("tasks-v4");
// @ts-expect-error A different supplied task version cannot satisfy the exact contract version.
expectType<typeof workflowTaskContract.version>(4);

const fakeTriggerProvenance = {
  admissionRef: "admission",
  transactionRef: "transaction",
  provenance: {
    trigger: codingTrigger.name,
    revision: codingTrigger.revision,
    definitionDigest: "definition",
    source: codingTrigger.source.binding,
    eventId: "delivery-8",
    payloadDigest: "payload",
    receivedAt: "2026-08-29T10:00:00.000Z",
  },
  claim: {
    triggerDefinitionDigest: "definition",
    triggerRevision: codingTrigger.revision,
    dedupeKey: "techery/weft:delivery-8",
  },
};
// @ts-expect-error Schema-shaped trigger metadata cannot impersonate engine-minted run provenance.
expectType<TriggerRunProvenance<typeof codingTrigger>>(fakeTriggerProvenance);

// ---------------------------------------------------------------------------
// Context trust and nominal path authority
// ---------------------------------------------------------------------------

const RepositoryPolicy = z
  .object({
    repository: z.string().min(1),
    protectedBranch: z.string().min(1),
  })
  .strict();

const repositoryPolicySource = defineContextSource({
  name: "round-08-repository-policy",
  input: z.object({ repository: z.string().min(1) }).strict(),
  output: RepositoryPolicy,
  binding: "github.repository-policy",
  freshness: { maxAge: "5m", stale: "reject" },
  trust: { minimum: "authoritative", authorities: ["github"] },
});

declare const policySnapshot: ContextSnapshotOf<typeof repositoryPolicySource>;
expectType<z.infer<typeof RepositoryPolicy>>(policySnapshot.value);
expectType<"round-08-repository-policy">(policySnapshot.source);
expectType<"untrusted" | "authenticated" | "authoritative">(policySnapshot.trust.level);
// @ts-expect-error The authoritative definition floor is currently widened on returned snapshot metadata.
expectType<"authoritative">(policySnapshot.trust.level);

const fakeContextSnapshot = {
  source: repositoryPolicySource.name,
  value: { repository: "techery/weft", protectedBranch: "main" },
  freshness: {
    observedAt: "2026-08-29T10:00:00.000Z",
    expiresAt: "2026-08-29T10:05:00.000Z",
    status: "fresh" as const,
  },
  trust: { level: "authoritative" as const, authority: "github" },
};
// @ts-expect-error Values and trust labels without nominal evidence are not context snapshots.
expectType<ContextSnapshotOf<typeof repositoryPolicySource>>(fakeContextSnapshot);

const sourceWritePolicy = definePathPolicy({
  name: "round-08-source-writes",
  revision: "v1",
  roots: ["packages"],
  deny: ["**/dist/**", "**/.git/**"],
  grantTtl: "30m",
});

const docsWritePolicy = definePathPolicy({
  name: "round-08-docs-writes",
  revision: "v2",
  roots: ["docs"],
  deny: ["**/.git/**"],
  grantTtl: "15m",
});

declare const sourceScope: WriteScope<typeof sourceWritePolicy>;
declare const docsScope: WriteScope<typeof docsWritePolicy>;
declare const sourceGrant: PathGrantRef<typeof sourceWritePolicy>;
expectType<WriteScope<typeof sourceWritePolicy>>(sourceScope);
expectType<PathGrantRef<typeof sourceWritePolicy>>(sourceScope.grant);
expectType<PathGrantRef<typeof sourceWritePolicy>>(sourceGrant);
// @ts-expect-error An ordinary path list is a proposal, not nominal write authority.
expectType<WriteScope<typeof sourceWritePolicy>>(["packages/dsl-proto/src/index.ts"]);
// @ts-expect-error A grant for a different policy name and revision cannot cross write scopes.
expectType<WriteScope<typeof sourceWritePolicy>>(docsScope);

// ---------------------------------------------------------------------------
// Protected and recoverable operation type states
// ---------------------------------------------------------------------------

const publishOperation = defineOperation({
  name: "round-08-publish-candidate",
  input: z.object({ repository: z.string(), releaseId: z.string() }).strict(),
  output: z.object({ remoteId: z.string(), releaseId: z.string() }).strict(),
  binding: "release.publish",
  capabilities: ["network"],
  authorization: { mode: "required", action: "Publish release candidate", risk: "high" },
});

const otherProtectedOperation = defineOperation({
  name: "round-08-delete-preview",
  input: z.object({ previewId: z.string() }).strict(),
  output: z.object({ deleted: z.boolean() }).strict(),
  binding: "preview.delete",
  capabilities: ["network"],
  authorization: { mode: "required", action: "Delete preview", risk: "medium" },
});

const cancelPublishOperation = defineOperation({
  name: "round-08-cancel-publish",
  input: z.object({ attemptRef: z.string(), primaryIdempotencyKey: z.string() }).strict(),
  output: z.object({ cancelled: z.boolean() }).strict(),
  binding: "release.cancel",
  capabilities: ["network"],
  authorization: { mode: "none" },
});

const compensatePublishOperation = defineOperation({
  name: "round-08-compensate-publish",
  input: z.object({ remoteId: z.string() }).strict(),
  output: z.object({ withdrawn: z.boolean() }).strict(),
  binding: "release.withdraw",
  capabilities: ["network"],
  authorization: { mode: "required", action: "Withdraw published candidate", risk: "high" },
});

expectType<"round-08-publish-candidate">(null as unknown as OperationNameOf<typeof publishOperation>);

/** Why: Exercises protected execution, pre-dispatch cleanup, success-only compensation, and exact nominal pairing. Use: Typecheck only; hosts supply the operation implementation. */
async function exerciseOperationTypes(ctx: Ctx): Promise<void> {
  const input = { repository: "techery/weft", releaseId: "release-8" };
  const candidate = await ctx.operation.prepare(publishOperation, input, { key: "prepare-publish" });
  expectType<OperationCandidateRef<typeof publishOperation, typeof input>>(candidate);
  expectType<OperationInputOf<typeof publishOperation>>(input);

  const authorization = await ctx.operation.authorize(publishOperation, candidate, {
    key: "authorize-publish",
  });
  const output = await ctx.operation.execute(
    publishOperation,
    { candidate, authorization },
    { key: "execute-publish" },
  );
  expectType<OperationOutputOf<typeof publishOperation>>(output);

  // @ts-expect-error Protected operations cannot use the direct invocation overload.
  await ctx.operation(publishOperation, input, { key: "unsafe-direct-publish" });

  const otherCandidate = await ctx.operation.prepare(
    otherProtectedOperation,
    { previewId: "preview-8" },
    { key: "prepare-other" },
  );
  const otherAuthorization = await ctx.operation.authorize(otherProtectedOperation, otherCandidate, {
    key: "authorize-other",
  });
  await ctx.operation.execute(
    publishOperation,
    {
      candidate,
      // @ts-expect-error Authority for another definition and candidate cannot authorize publication.
      authorization: otherAuthorization,
    },
    { key: "execute-mismatched" },
  );

  const attempt = await ctx.operation.recoverable(
    publishOperation,
    { candidate, authorization },
    {
      cancellation: {
        operation: cancelPublishOperation,
        map: (intent) => ({
          attemptRef: intent.ref,
          primaryIdempotencyKey: intent.idempotencyKey,
        }),
        options: {
          key: "cancel-publish",
          idempotencyKey: "cancel:release-8",
        },
      },
      compensation: {
        operation: compensatePublishOperation,
        map: (receipt) => ({ remoteId: receipt.output.remoteId }),
      },
    },
    {
      key: "register-publish",
      idempotencyKey: "publish:release-8",
    },
  );
  expectType<"publish:release-8">(null as unknown as OperationAttemptIdempotencyOf<typeof attempt>);
  expectType<"cancel:release-8">(
    null as unknown as OperationAttemptCancellationIdempotencyOf<typeof attempt>,
  );

  const result = await ctx.operation.executeRecoverable(publishOperation, attempt);
  if (result.status === "succeeded") {
    expectType<string>(result.receipt.output.remoteId);
    // @ts-expect-error Only the compensation registered on this exact receipt can be prepared.
    await ctx.operation.prepareRecovery(result.receipt, otherProtectedOperation, { key: "wrong-recovery" });

    const recoveryCandidate = await ctx.operation.prepareRecovery(
      result.receipt,
      compensatePublishOperation,
      { key: "prepare-withdrawal" },
    );
    const recoveryAuthorization = await ctx.operation.authorize(
      compensatePublishOperation,
      recoveryCandidate,
      { key: "authorize-withdrawal" },
    );
    await ctx.operation.recover(
      result.receipt,
      compensatePublishOperation,
      { candidate: recoveryCandidate, authorization: recoveryAuthorization },
      {
        key: "withdraw-publication",
        idempotencyKey: "withdraw:release-8",
      },
    );
  }
}
expectType<(ctx: Ctx) => Promise<void>>(exerciseOperationTypes);

// ---------------------------------------------------------------------------
// Detailed observer evidence and source-specific options
// ---------------------------------------------------------------------------

const deploymentObserver = defineObserver({
  name: "round-08-deployment",
  input: z.object({ deploymentId: z.string().min(1) }).strict(),
  state: z
    .object({
      deploymentId: z.string().min(1),
      eventId: z.string().min(1),
      sequence: z.number().int().nonnegative(),
      status: z.enum(["pending", "ready"]),
    })
    .strict(),
  output: z.object({ deploymentId: z.string(), status: z.literal("ready") }).strict(),
  source: {
    kind: "signal-first",
    signal: {
      binding: "deployments.signal",
      signal: (input) => `deployment:${input.deploymentId}`,
      trust: { minimum: "authoritative", authorities: ["deployment-control-plane"] },
    },
    fallback: {
      binding: "deployments.read",
      every: "30s",
      trust: { minimum: "authoritative", authorities: ["deployment-control-plane"] },
    },
    grace: "10s",
  },
  identity: {
    inputCorrelation: (input) => input.deploymentId,
    stateCorrelation: (state) => state.deploymentId,
    eventId: (state) => state.eventId,
    sequence: (state) => state.sequence,
  },
  defaults: { timeout: "30m" },
  complete: (state) =>
    state.status === "ready" ? { deploymentId: state.deploymentId, status: "ready" as const } : null,
});

declare const detailedDeployment: DetailedObserverResult<typeof deploymentObserver>;
expectType<ObserverInputOf<typeof deploymentObserver>>({ deploymentId: "deployment-8" });
expectType<ObserverOutputOf<typeof deploymentObserver>>(detailedDeployment.output);
expectType<"round-08-deployment">(detailedDeployment.subject.observer);
expectType<"round-08-deployment">(detailedDeployment.provenance.observer);
expectType<"poll" | "signal" | "signal-first">(detailedDeployment.provenance.strategy);
// @ts-expect-error Detailed provenance does not currently retain the definition's static signal-first strategy.
expectType<"signal-first">(detailedDeployment.provenance.strategy);
expectType<"signal" | "poll" | "implemented-poll">(detailedDeployment.provenance.endpoint);
// @ts-expect-error A bound signal-first definition cannot complete through a locally implemented polling endpoint.
expectType<"signal" | "poll">(detailedDeployment.provenance.endpoint);

expectType<ObserverInvocationOptionsOf<typeof deploymentObserver>>({
  key: "wait-for-deployment",
  grace: "5s",
  fallbackEvery: "15s",
});
expectType<ObserverInvocationOptionsOf<typeof deploymentObserver>>({
  key: "invalid-signal-first-options",
  // @ts-expect-error Signal-first observers expose `fallbackEvery`, never the polling-only `every` field.
  every: "5s",
});

const fakeDetailedObservation = {
  output: { deploymentId: "deployment-8", status: "ready" as const },
  subject: {
    observer: deploymentObserver.name,
    definitionDigest: "definition",
    inputDigest: "input",
    correlation: "deployment-8",
  },
};
// @ts-expect-error Output and subject-shaped records lack engine-minted provenance, evidence, and nominal brands.
expectType<DetailedObserverResult<typeof deploymentObserver>>(fakeDetailedObservation);

// ---------------------------------------------------------------------------
// Review, delivery, and exact workspace subjects
// ---------------------------------------------------------------------------

const candidateReview = defineReview({
  name: "round-08-candidate-review",
  input: z.object({ objective: z.string().min(1) }).strict(),
  finding: z.object({ code: z.string().min(1), message: z.string().min(1) }).strict(),
  evaluate: (_ctx, input) => ({
    assessments: [
      {
        finding: { code: "reviewed", message: input.objective },
        disposition: "advisory" as const,
        sources: ["candidate"],
        rationale: "Type-system fixture",
      },
    ],
  }),
  accept: (evaluation) => evaluation.assessments.every((item) => item.disposition !== "blocking"),
});

expectType<"round-08-candidate-review">(null as unknown as ReviewNameOf<typeof candidateReview>);

const publishDelivery = defineDelivery({
  name: "round-08-publish-delivery",
  description: "Publishes one exact reviewed workspace generation.",
  binding: "git.publish",
  input: z.object({ branch: z.string().min(1), expectedHead: z.string().min(1) }).strict(),
  output: z.object({ url: z.string().url(), head: z.string().min(1) }).strict(),
  capabilities: ["git:write", "network"],
  defaults: {
    authorization: { action: "Publish reviewed candidate", risk: "high" },
  },
});
expectType<"round-08-publish-delivery">(publishDelivery.name);

/** Why: Refines one engine subject so compile-time generation mismatch tests remain distinguishable. Use: Test generic identity propagation only. */
type CandidateSubject = WorkspaceSnapshotRef & {
  readonly workspaceId: "candidate-workspace";
  readonly generation: 8;
};

/** Why: Refines a different engine subject for adversarial cross-generation assertions. Use: It must never satisfy `CandidateSubject`. */
type OtherSubject = WorkspaceSnapshotRef & {
  readonly workspaceId: "other-workspace";
  readonly generation: 9;
};

/** Why: Exercises review subject retention and delivery candidate/authorization pairing. Use: Also records the evidence-subject inference hole that still compiles. */
async function exerciseSubjectTypes(
  ctx: Ctx,
  candidateSubject: CandidateSubject,
  otherSubject: OtherSubject,
) {
  const reviewInput: ReviewInputOf<typeof candidateReview> = { objective: "Ship Round 8" };
  const candidateResult = await ctx.review(candidateReview, reviewInput, {
    key: "review-candidate",
    subject: candidateSubject,
  });
  const otherResult = await ctx.review(candidateReview, reviewInput, {
    key: "review-other",
    subject: otherSubject,
  });
  expectType<CandidateSubject>(candidateResult.subject);
  const firstAssessment = candidateResult.assessments[0];
  if (firstAssessment === undefined) {
    throw new Error("Review fixture must retain its assessment");
  }
  expectType<ReviewFindingOf<typeof candidateReview>>(firstAssessment.finding);
  // @ts-expect-error A review of generation 8 cannot be treated as a review of generation 9.
  expectType<OtherSubject>(candidateResult.subject);

  const mixedSubjectEvidence: PromotionCandidateInput<typeof publishDelivery, CandidateSubject> = {
    subject: candidateSubject,
    input: { branch: "round-8", expectedHead: candidateSubject.treeHash },
    // @ts-expect-error Promotion evidence must name the candidate's exact subject.
    evidence: [otherResult.attestation],
  };
  expectType<PromotionCandidateInput<typeof publishDelivery, CandidateSubject>>(mixedSubjectEvidence);

  await ctx.delivery.prepare(
    publishDelivery,
    {
      subject: candidateSubject,
      input: { branch: "round-8", expectedHead: candidateSubject.treeHash },
      // @ts-expect-error Evidence cannot widen the subject inferred from the explicit candidate subject.
      evidence: [otherResult.attestation],
    },
    { key: "prepare-with-mixed-subject-evidence" },
  );

  const candidate = await ctx.delivery.prepare(
    publishDelivery,
    {
      subject: candidateSubject,
      input: { branch: "round-8", expectedHead: candidateSubject.treeHash },
      evidence: [candidateResult.attestation],
    },
    { key: "prepare-candidate-delivery" },
  );
  const otherCandidate = await ctx.delivery.prepare(
    publishDelivery,
    {
      subject: otherSubject,
      input: { branch: "other", expectedHead: otherSubject.treeHash },
      evidence: [otherResult.attestation],
    },
    { key: "prepare-other-delivery" },
  );
  const authorization = await ctx.delivery.authorize(publishDelivery, candidate, {
    key: "authorize-candidate-delivery",
  });
  const otherAuthorization = await ctx.delivery.authorize(publishDelivery, otherCandidate, {
    key: "authorize-other-delivery",
  });
  const receipt = await ctx.delivery(
    publishDelivery,
    { candidate, authorization },
    { key: "publish-candidate" },
  );
  expectType<CandidateSubject>(receipt.subject);

  await ctx.delivery(
    publishDelivery,
    {
      candidate,
      // @ts-expect-error Authorization is nominally tied to the other exact candidate and subject.
      authorization: otherAuthorization,
    },
    { key: "publish-with-wrong-authority" },
  );
}
expectType<(ctx: Ctx, candidateSubject: CandidateSubject, otherSubject: OtherSubject) => Promise<void>>(
  exerciseSubjectTypes,
);

// ---------------------------------------------------------------------------
// Waiver definition, revision, and subject matching
// ---------------------------------------------------------------------------

const eligibleFreezeCheck = defineCheck({
  name: "round-08-production-freeze",
  revision: "freeze-v8",
  policy: "required",
  waiver: {
    mode: "eligible",
    binding: "policy.check-waiver",
    action: "Waive one production freeze failure",
    risk: "high",
    maxTtl: "30m",
  },
  input: z.object({ releaseId: z.string().min(1) }).strict(),
  run: () => false,
});

const eligibleLicenseCheck = defineCheck({
  name: "round-08-license-policy",
  revision: "license-v3",
  policy: "required",
  waiver: {
    mode: "eligible",
    binding: "policy.check-waiver",
    action: "Waive one license-policy failure",
    risk: "medium",
    maxTtl: "15m",
  },
  input: z.object({ packageName: z.string().min(1) }).strict(),
  run: () => false,
});

const unwaivableIntegrityCheck = defineCheck({
  name: "round-08-artifact-integrity",
  policy: "required",
  waiver: { mode: "never" },
  input: z.object({ digest: z.string().min(1) }).strict(),
  run: () => true,
});

/** Why: Exercises exact failed-result authorization and definition/subject-matched invocation. Use: Typecheck nominal waiver safety only. */
async function exerciseWaiverTypes(
  ctx: Ctx,
  freezeFailure: FailedCheckResultOf<typeof eligibleFreezeCheck, CandidateSubject>,
  licenseFailure: FailedCheckResultOf<typeof eligibleLicenseCheck, CandidateSubject>,
): Promise<void> {
  const waiver = await ctx.check.authorize(eligibleFreezeCheck, freezeFailure, {
    key: "authorize-freeze-waiver",
    reason: "Emergency production repair approved for this exact failed check.",
    ttl: "15m",
  });
  expectType<CheckWaiverRef<typeof eligibleFreezeCheck, CandidateSubject>>(waiver);
  expectType<"freeze-v8">(waiver.revision);

  expectType<CheckInvocationOptions<typeof eligibleFreezeCheck, CandidateSubject>>({ waive: waiver });
  // @ts-expect-error A freeze waiver cannot satisfy another eligible check definition.
  expectType<CheckInvocationOptions<typeof eligibleLicenseCheck, CandidateSubject>>({ waive: waiver });
  // @ts-expect-error A generation-8 waiver cannot satisfy a generation-9 invocation contract.
  expectType<CheckInvocationOptions<typeof eligibleFreezeCheck, OtherSubject>>({ waive: waiver });
  expectType<CheckInvocationOptions<typeof unwaivableIntegrityCheck, CandidateSubject>>({
    // @ts-expect-error An unwaivable definition has no invocation branch accepting nominal waiver authority.
    waive: waiver,
  });

  // @ts-expect-error Authorization requires a failure branded for this exact check definition.
  await ctx.check.authorize(eligibleFreezeCheck, licenseFailure, {
    key: "authorize-mismatched-failure",
    reason: "This failure belongs to another check.",
    ttl: "5m",
  });
}
expectType<
  (
    ctx: Ctx,
    freezeFailure: FailedCheckResultOf<typeof eligibleFreezeCheck, CandidateSubject>,
    licenseFailure: FailedCheckResultOf<typeof eligibleLicenseCheck, CandidateSubject>,
  ) => Promise<void>
>(exerciseWaiverTypes);

// ---------------------------------------------------------------------------
// Heterogeneous node unions and literal retention
// ---------------------------------------------------------------------------

const newerNodes = [
  codingWorkflow,
  codingTrigger,
  repositoryPolicySource,
  sourceWritePolicy,
  publishOperation,
  cancelPublishOperation,
  deploymentObserver,
  candidateReview,
  publishDelivery,
  eligibleFreezeCheck,
] as const satisfies readonly WorkflowNode[];

/** Why: Names every definition in the adversarial heterogeneous registry. Use: Test `kind` extraction without erasing concrete members. */
type NewerNode = (typeof newerNodes)[number];

/** Why: Derives the closed node-kind union represented by the registry. Use: Detect accidental collapse to the global `WorkflowNodeKind`. */
type NewerNodeKind = NewerNode["kind"];

/** Why: Extracts the optional human-readable `name` from a heterogeneous member. Use: Expose identity literal widening across definition families. */
type NodeName<Node> = Node extends { readonly name: infer Name } ? Name : never;

/** Why: Collects registry member names after distributive extraction. Use: Demonstrate that string-widened nodes collapse otherwise literal identities. */
type NewerNodeName = NodeName<NewerNode>;

declare const newerNodeKind: NewerNodeKind;
declare const newerNodeName: NewerNodeName;
expectType<
  | "weft.workflow"
  | "weft.trigger"
  | "weft.context-source"
  | "weft.path-policy"
  | "weft.operation"
  | "weft.observer"
  | "weft.review"
  | "weft.delivery"
  | "weft.check"
>(newerNodeKind);
expectType<string>(newerNodeName);
expectType<
  | "round-08-pull-request"
  | "round-08-repository-policy"
  | "round-08-source-writes"
  | "round-08-publish-candidate"
  | "round-08-cancel-publish"
  | "round-08-deployment"
  | "round-08-candidate-review"
  | "round-08-publish-delivery"
  | "round-08-production-freeze"
>(newerNodeName);

/** Why: Extracts both direct and protected operation policies from the heterogeneous node union. Use: Confirm authorization branches survive same-kind unioning. */
type RegistryOperationAuthorization = OperationAuthorizationOf<
  Extract<NewerNode, WorkflowNode<"weft.operation">>
>;

declare const registryOperationAuthorization: RegistryOperationAuthorization;
expectType<{ readonly mode: "none" } | { readonly mode: "required" }>(registryOperationAuthorization);

const structuralWorkflowNode = { kind: "weft.workflow" as const };
// @ts-expect-error A kind discriminator alone cannot forge a nominal workflow node.
expectType<WorkflowNode<"weft.workflow">>(structuralWorkflowNode);

// Round 8 ranked findings (maximum five):
// 1. Workflow IDs, UI IDs/revisions, and task revisions/supplied versions now remain exact; requiring every workflow ID
//    closes anonymous definition identity while omitted UI revisions and task versions stay intentionally broad.
// 2. Static trust/strategy facts widen in returned evidence: an authoritative context source returns broad trust metadata,
//    and a signal-first observer returns broad strategy/endpoint provenance even though the definition fixes both.
// 3. Eligible check revisions remain exact through `CheckDefinition` and `CheckWaiverRef`, completing static definition,
//    revision, and subject matching without a serializable-projection workaround.
// 4. Appended defaulted name generics retain operation and review literals without breaking older explicit arities;
//    the heterogeneous registry's name union remains closed across all represented definition families.
// 5. Subject generics reject cross-generation values only when callers carry explicit refined `WorkspaceSnapshotRef`
//    subtypes; ordinary engine subjects share one type, making exact static tests verbose while runtime brands do the work.
