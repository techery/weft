import { z } from "zod";
import { defineWorkflow as definePublicWorkflow } from "../../index.ts";

import {
  type AcceptedReviewResult,
  type AgentCallOptionsBase,
  type AgentFailure,
  type AgentOutcome,
  type AgentResult,
  type ArtifactRefOf,
  bindGoal,
  type CheckSuiteMembersOf,
  type CheckWaiverRef,
  type ContextSnapshotOf,
  type Ctx,
  type DefinedAgentCall,
  type DeliveryAuthorizationRef,
  type DirectOperationDefinition,
  defineAgent,
  defineArtifact,
  defineCheck,
  defineCheckSuite,
  defineContextSource,
  defineDelivery,
  defineGoal,
  defineOperation,
  definePrompt,
  defineReview,
  type FailedCheckResultOf,
  type FailedCheckSuiteResult,
  type GoalBinding,
  type GoalResult,
  type OperationAttemptAmbiguous,
  type OperationAttemptNotCommitted,
  type OperationAttemptRef,
  type OperationAttemptRefMarker,
  type OperationAuthorizationRef,
  type OperationCandidateRef,
  type OperationRecoveryStateMarker,
  type PatchAgentResult,
  type PatchRef,
  type PassedCheckSuiteResult,
  type PromotionCandidateInput,
  type PromotionCandidateRef,
  type PromotionProofs,
  type Provider,
  type ReviewFindingOf,
  type ReworkReviewResult,
  type ReviewCtx,
  type RecoverableOperationReceiptMarker,
  type Settled,
  type WorkspaceSnapshotRef,
  type WriteScope,
  withRecovery,
} from "../../core/index.ts";

/** Why: Makes positive and negative compile-time assertions visible without runtime behavior. Use: Exercise the six confirmed type-safety regressions. */
declare function expectType<Type>(value: Type): void;
declare function rewrite<Value extends object, Updates extends object>(
  value: Value,
  updates: Updates,
): Value & Updates;

// ---------------------------------------------------------------------------
// Definition-form input presence and correlated goals
// ---------------------------------------------------------------------------

const optionalInputPrompt = definePrompt({
  name: "round-11-optional-input-prompt",
  input: z.string().optional(),
  render: (input) => input ?? "explicit undefined",
});

const AgentOutput = z.object({ summary: z.string() }).strict();
type AgentOutputValue = z.infer<typeof AgentOutput>;

const optionalInputAgent = defineAgent({
  name: "round-11-optional-input-agent",
  prompt: optionalInputPrompt,
  schema: AgentOutput,
});

const goalCheck = defineCheck({
  name: "round-11-goal-check",
  policy: "required",
  command: ["pnpm", "test"],
});

const waivableCheck = defineCheck({
  name: "round-11-waivable-check",
  policy: "required",
  revision: "v1",
  waiver: {
    mode: "eligible",
    binding: "round-11.check-waiver",
    action: "Waive one exact failed Round 11 check",
    risk: "high",
    maxTtl: "5m",
  },
  command: ["pnpm", "test"],
});

const requiredInputGoal = defineGoal({
  name: "round-11-required-input-goal",
  input: z.object({ id: z.number().int() }).strict(),
  components: (_input, use) => ({ quality: use.check(goalCheck) }),
});

const alternateRequiredInputGoal = defineGoal({
  name: "round-11-alternate-required-input-goal",
  input: z.object({ slug: z.string() }).strict(),
  components: (_input, use) => ({ quality: use.check(goalCheck) }),
});

const optionalValueGoal = defineGoal({
  name: "round-11-optional-value-goal",
  input: z.string().optional(),
  components: (_input, use) => ({ quality: use.check(goalCheck) }),
});

const optionalValueCheck = defineCheck({
  name: "round-11-optional-value-check",
  policy: "required",
  input: z.string().optional(),
  command: (input) => ["printf", "%s", input ?? "explicit undefined"],
});

bindGoal(requiredInputGoal, { id: 11 });
// @ts-expect-error A goal definition and its input remain correlated.
bindGoal(requiredInputGoal, "wrong-goal-input");
bindGoal(optionalValueGoal, "explicit value");
bindGoal(optionalValueGoal, undefined);
// @ts-expect-error Schema-backed goals require the input argument even when its value type includes undefined.
bindGoal(optionalValueGoal);

type RequiredGoalUnion = typeof requiredInputGoal | typeof alternateRequiredInputGoal;
// @ts-expect-error A union goal binding remains a correlated union, not a Cartesian product of definitions and inputs.
const mismatchedUnionGoal: GoalBinding<RequiredGoalUnion> = {
  definition: requiredInputGoal,
  input: { slug: "belongs-to-the-other-goal" },
};
expectType<GoalBinding<RequiredGoalUnion>>(mismatchedUnionGoal);

const alternateInputPrompt = definePrompt({
  name: "round-11-alternate-input-prompt",
  input: z.number(),
  render: (input) => String(input),
});
const alternateInputAgent = defineAgent({
  name: "round-11-alternate-input-agent",
  prompt: alternateInputPrompt,
  schema: AgentOutput,
});
type RequiredAgentUnion = typeof optionalInputAgent | typeof alternateInputAgent;
// @ts-expect-error A union agent call remains correlated with the selected definition's input.
const mismatchedUnionAgent: DefinedAgentCall<RequiredAgentUnion> = {
  key: "mismatched-union-agent",
  agent: optionalInputAgent,
  input: 11,
};
expectType<DefinedAgentCall<RequiredAgentUnion>>(mismatchedUnionAgent);

// ---------------------------------------------------------------------------
// Provider branches remain disjoint
// ---------------------------------------------------------------------------

// @ts-expect-error Built-in provider IDs cannot escape their registry-typed options through the dynamic branch.
const invalidBuiltInProvider: Provider = {
  id: "claude",
  options: { definitelyNotClaude: true },
};
expectType<Provider>(invalidBuiltInProvider);

const dynamicProvider: Provider = {
  kind: "dynamic",
  id: "runtime-selected-provider",
  options: { adapterSpecific: true },
};
expectType<Provider>(dynamicProvider);

const authenticatedContext = defineContextSource({
  name: "round-11-authenticated-context",
  input: z.object({ id: z.string() }).strict(),
  output: z.object({ value: z.string() }).strict(),
  binding: "round-11.context",
  freshness: { maxAge: "30s", stale: "reject" },
  trust: { minimum: "authenticated", authorities: ["round-11-authority"] },
});
const auditArtifact = defineArtifact({
  name: "round-11-audit-artifact",
  content: z.object({ report: z.string() }).strict(),
  mediaType: "application/json",
});
declare const genuineContextSnapshot: ContextSnapshotOf<typeof authenticatedContext>;
const rewrittenContextSnapshot = {
  ...genuineContextSnapshot,
  value: { value: "rewritten after observation" },
};
// @ts-expect-error Object spread cannot retain host-observed context identity while rewriting its value.
const invalidContextSnapshot: typeof genuineContextSnapshot = rewrittenContextSnapshot;
expectType<typeof genuineContextSnapshot>(invalidContextSnapshot);

// ---------------------------------------------------------------------------
// Positive promotion proof versus negative evidence
// ---------------------------------------------------------------------------

const qualitySuite = defineCheckSuite({
  name: "round-11-quality-suite",
  checks: [goalCheck],
});

type QualityMembers = CheckSuiteMembersOf<typeof qualitySuite>;

const ReviewFinding = z.object({ message: z.string() }).strict();
const candidateReview = defineReview({
  name: "round-11-candidate-review",
  input: z.object({ objective: z.string() }).strict(),
  finding: ReviewFinding,
  evaluate: (_ctx, input) => ({
    assessments: [
      {
        finding: { message: input.objective },
        disposition: "advisory" as const,
        sources: ["candidate"],
        rationale: "Compile-time review fixture",
      },
    ],
  }),
  accept: ({ assessments }) => assessments.every(({ disposition }) => disposition !== "blocking"),
});

const publishDelivery = defineDelivery({
  name: "round-11-publish",
  binding: "git.publish",
  input: z.object({ expectedHead: z.string() }).strict(),
  output: z.object({ url: z.string().url() }).strict(),
  capabilities: ["git:write"],
  defaults: {
    authorization: { action: "Publish verified Round 11 candidate", risk: "high" },
  },
});
// @ts-expect-error Engine-minted delivery policy is immutable on the returned definition.
publishDelivery.defaults.authorization.risk = "low";

const protectedOperation = defineOperation({
  name: "round-11-protected-operation",
  binding: "round-11.protected",
  input: z.object({ id: z.string() }).strict(),
  output: z.object({ accepted: z.boolean() }).strict(),
  capabilities: ["network"],
  authorization: { mode: "required", action: "Run protected Round 11 effect", risk: "high" },
});

const cancelProtectedOperation = defineOperation({
  name: "round-11-cancel-protected-operation",
  binding: "round-11.cancel-protected",
  input: z.object({ attemptRef: z.string(), primaryIdempotencyKey: z.string() }).strict(),
  output: z.object({ cancelled: z.boolean() }).strict(),
  capabilities: ["network"],
  authorization: { mode: "none" },
});

const recoverableProtectedOperation = withRecovery(protectedOperation, {
  cancel: {
    operation: cancelProtectedOperation,
    map: (attempt) => ({
      attemptRef: attempt.ref,
      primaryIdempotencyKey: attempt.idempotencyKey,
    }),
    idempotencyKey: (attempt) => `cancel:${attempt.idempotencyKey}`,
  },
});

declare const operationCandidate: OperationCandidateRef<
  typeof protectedOperation,
  { id: string }
>;
declare const operationAuthorization: OperationAuthorizationRef<
  typeof protectedOperation,
  typeof operationCandidate
>;
declare const operationAttempt: OperationAttemptRef<
  typeof protectedOperation,
  typeof operationCandidate,
  "round-11-attempt",
  OperationRecoveryStateMarker
>;
declare const ambiguousOperationOutcome: OperationAttemptAmbiguous<typeof operationAttempt>;

const rewrittenOperationCandidate = { ...operationCandidate, inputDigest: "rewritten" };
// @ts-expect-error Object spread cannot retain frozen operation-candidate identity while rewriting its digest.
const invalidOperationCandidate: typeof operationCandidate = rewrittenOperationCandidate;
expectType<typeof operationCandidate>(invalidOperationCandidate);

const rewrittenOperationAuthorization = { ...operationAuthorization, expiresAt: "rewritten" };
// @ts-expect-error Object spread cannot retain candidate-bound operation authority while rewriting its terms.
const invalidOperationAuthorization: typeof operationAuthorization = rewrittenOperationAuthorization;
expectType<typeof operationAuthorization>(invalidOperationAuthorization);

const rewrittenOperationAttempt = { ...operationAttempt, ref: "rewritten" };
// @ts-expect-error Object spread cannot retain a journaled attempt's dispatch and recovery authority.
const invalidOperationAttempt: OperationAttemptRefMarker = rewrittenOperationAttempt;
expectType<OperationAttemptRefMarker>(invalidOperationAttempt);

const relabeledOperationOutcome = {
  ...ambiguousOperationOutcome,
  status: "retryable" as const,
  commit: "not-committed" as const,
};
// @ts-expect-error Object spread cannot relabel may-have-committed evidence as a safe retry.
const invalidOperationOutcome: OperationAttemptNotCommitted<
  typeof operationAttempt,
  "retryable"
> = relabeledOperationOutcome;
expectType<OperationAttemptNotCommitted<typeof operationAttempt, "retryable">>(
  invalidOperationOutcome,
);

declare const recoverableReceipt: RecoverableOperationReceiptMarker;
const rewrittenRecoverableReceipt = { ...recoverableReceipt, ref: "rewritten" };
// @ts-expect-error Object spread cannot retain successful primary-effect evidence used for compensation.
const invalidRecoverableReceipt: RecoverableOperationReceiptMarker = rewrittenRecoverableReceipt;
expectType<RecoverableOperationReceiptMarker>(invalidRecoverableReceipt);

declare const deliveryCandidate: PromotionCandidateRef<typeof publishDelivery, CandidateSubject>;
declare const deliveryAuthorization: DeliveryAuthorizationRef<
  typeof publishDelivery,
  typeof deliveryCandidate
>;

const rewrittenDeliveryCandidate = { ...deliveryCandidate, inputDigest: "rewritten" };
// @ts-expect-error Object spread cannot retain verified promotion-candidate identity while rewriting its digest.
const invalidDeliveryCandidate: typeof deliveryCandidate = rewrittenDeliveryCandidate;
expectType<typeof deliveryCandidate>(invalidDeliveryCandidate);

const rewrittenDeliveryAuthorization = { ...deliveryAuthorization, risk: "low" as const };
// @ts-expect-error Object spread cannot retain candidate-bound delivery authority while rewriting its risk.
const invalidDeliveryAuthorization: typeof deliveryAuthorization = rewrittenDeliveryAuthorization;
expectType<typeof deliveryAuthorization>(invalidDeliveryAuthorization);

const spreadWeakenedOperation = {
  ...protectedOperation,
  authorization: { mode: "none" as const },
};
// @ts-expect-error Object spread cannot retain definition identity while changing authorization mode.
const directAfterSpread: DirectOperationDefinition = spreadWeakenedOperation;

const publicFacadeWorkflow = definePublicWorkflow(
  {
    id: "round-11-public-facade",
    input: z.object({ id: z.string() }).strict(),
    output: z.object({ id: z.string() }).strict(),
    workspace: true,
  },
  async (ctx, input) => {
    // @ts-expect-error Explicit candidate preparation is available only from the advanced workflow context.
    ctx.operation.prepare;
    // @ts-expect-error Explicit delivery authorization is available only from the advanced workflow context.
    ctx.delivery.authorize;
    expectType<WorkspaceSnapshotRef>(ctx.workspace.snapshot);
    // @ts-expect-error Cross-snapshot comparison is an advanced diagnostic, not ordinary workflow ceremony.
    ctx.workspace.sameSnapshot;
    // @ts-expect-error Freshness is enforced atomically by candidate-bound effects on the ordinary facade.
    ctx.workspace.assertUnchanged;
    return input;
  },
);
expectType<"weft.workflow">(publicFacadeWorkflow.kind);
// @ts-expect-error Definition metadata cannot expose task contracts as an `any` proof escape hatch.
publicFacadeWorkflow.meta.tasks;
// @ts-expect-error Definition metadata does not expose an executable workspace factory.
publicFacadeWorkflow.meta.workspace;

type CandidateSubject = WorkspaceSnapshotRef & {
  readonly workspaceId: "round-11-candidate";
  readonly generation: 11;
};

type ReviewFindingValue = ReviewFindingOf<typeof candidateReview>;

declare const candidateSubject: CandidateSubject;
declare const genuineArtifact: ArtifactRefOf<typeof auditArtifact, CandidateSubject>;
const rewrittenArtifact = { ...genuineArtifact, sha256: "rewritten" };
// @ts-expect-error Object spread cannot retain immutable artifact identity while rewriting its digest.
const invalidArtifact: typeof genuineArtifact = rewrittenArtifact;
expectType<typeof genuineArtifact>(invalidArtifact);
declare const genuineWaiver: CheckWaiverRef<typeof waivableCheck, CandidateSubject>;
declare const failedWaivableCheck: FailedCheckResultOf<typeof waivableCheck, CandidateSubject>;
// @ts-expect-error Engine-minted check diagnostics are shallowly immutable.
failedWaivableCheck.summary = "rewritten after execution";
const rewrittenFailedCheck = { ...failedWaivableCheck, summary: "rewritten after execution" };
// @ts-expect-error Object spread cannot retain engine-minted failed-check identity for waiver authorization.
const invalidFailedCheck: typeof failedWaivableCheck = rewrittenFailedCheck;
expectType<typeof failedWaivableCheck>(invalidFailedCheck);
type OtherCandidateSubject = WorkspaceSnapshotRef & {
  readonly workspaceId: "round-11-other-candidate";
  readonly generation: 12;
};
declare const otherCandidateSubject: OtherCandidateSubject;
declare const passedSuite: PassedCheckSuiteResult<QualityMembers, CandidateSubject>;
declare const failedSuite: FailedCheckSuiteResult<QualityMembers, CandidateSubject>;
declare const acceptedReview: AcceptedReviewResult<ReviewFindingValue, CandidateSubject>;
declare const reworkReview: ReworkReviewResult<ReviewFindingValue, CandidateSubject>;
declare const metGoal: GoalResult<Record<string, unknown>, CandidateSubject>;

const positiveProofs: PromotionProofs<CandidateSubject> = [
  passedSuite.proof,
  acceptedReview.proof,
  metGoal.proof,
];
expectType<PromotionProofs<CandidateSubject>>(positiveProofs);

const retargetedProof = { ...passedSuite.proof, candidate: otherCandidateSubject };
const retargetedProofs: PromotionProofs<OtherCandidateSubject> = [
  // @ts-expect-error Object spread cannot preserve proof identity while retargeting its candidate.
  retargetedProof,
];
expectType<PromotionProofs<OtherCandidateSubject>>(retargetedProofs);

const failedCheckProofs: PromotionProofs<CandidateSubject> = [
  // @ts-expect-error A failed check attestation is evidence, not positive promotion proof.
  failedSuite.attestation,
];
expectType<PromotionProofs<CandidateSubject>>(failedCheckProofs);

const reworkProofs: PromotionProofs<CandidateSubject> = [
  // @ts-expect-error A rework attestation is evidence, not positive promotion proof.
  reworkReview.attestation,
];
expectType<PromotionProofs<CandidateSubject>>(reworkProofs);

const promotionInput: PromotionCandidateInput<typeof publishDelivery, CandidateSubject> = {
  snapshot: candidateSubject,
  input: { expectedHead: candidateSubject.treeHash },
  proofs: positiveProofs,
};
expectType<PromotionCandidateInput<typeof publishDelivery, CandidateSubject>>(promotionInput);

// ---------------------------------------------------------------------------
// Widened unified options remain safe
// ---------------------------------------------------------------------------

async function exerciseAgentSafety(ctx: Ctx, writeScope: WriteScope): Promise<void> {
  // @ts-expect-error Agent intent is expressed through one callable API, not a separate read method.
  ctx.agent.run;
  // @ts-expect-error Writing is selected with the `write` option on the same callable API.
  ctx.agent.write;
  // @ts-expect-error Returned failure is selected with `failure: "return"` on the same callable API.
  ctx.agent.try;

  await ctx.check(optionalValueCheck, "explicit value", { key: "optional-check-string" });
  await ctx.check(optionalValueCheck, undefined, { key: "optional-check-undefined" });
  // @ts-expect-error Schema-backed checks require the input argument even when its value type includes undefined.
  await ctx.check(optionalValueCheck, { key: "optional-check-omitted" });

  const explicitString = await ctx.agent(optionalInputAgent, "explicit string", {
    key: "optional-input-string",
  });
  expectType<AgentResult<AgentOutputValue>>(explicitString);

  const explicitUndefined = await ctx.agent(optionalInputAgent, undefined, {
    key: "optional-input-undefined",
  });
  expectType<AgentResult<AgentOutputValue>>(explicitUndefined);

  // @ts-expect-error Schema-backed agents require the input property even when its value type includes undefined.
  await ctx.agent(optionalInputAgent, { key: "optional-input-omitted" });

  const goalBound = await ctx.agent(optionalInputAgent, "goal-bound", {
    key: "correlated-goal",
    goal: bindGoal(requiredInputGoal, { id: 11 }),
  });
  expectType<"met">(goalBound.goal.status);

  await ctx.agent(optionalInputAgent, "goal-bound", {
    key: "wrong-correlated-goal",
    // @ts-expect-error An inline goal binding must use the definition's exact input.
    goal: { definition: requiredInputGoal, input: "wrong-goal-input" },
  });

  const written = await ctx.agent(optionalInputAgent, "write", {
    key: "exact-write",
    write: writeScope,
  });
  expectType<PatchAgentResult<AgentOutputValue>>(written);
  expectType<PatchRef>(written.patch);

  const outcome = await ctx.agent(optionalInputAgent, "try", {
    key: "typed-failure",
    failure: "return",
  });
  expectType<AgentOutcome<AgentOutputValue>>(outcome);
  if (outcome.ok) {
    expectType<AgentResult<AgentOutputValue>>(outcome.result);
  } else {
    expectType<AgentFailure>(outcome.error);
  }

  const widenedOptions: AgentCallOptionsBase = {
    key: "widened-options",
    write: writeScope,
    failure: "return",
  };
  const widened = await ctx.agent(optionalInputAgent, "widened", widenedOptions);
  type WidenedSuccess = AgentResult<AgentOutputValue> | PatchAgentResult<AgentOutputValue>;
  expectType<WidenedSuccess | AgentOutcome<AgentOutputValue, undefined, WidenedSuccess>>(widened);
  // @ts-expect-error A widened failure policy must be guarded before reading a successful result.
  widened.value;

  const spreadWriteScope = { ...writeScope, paths: ["outside-policy"] };
  await ctx.agent(optionalInputAgent, "write", {
    key: "spread-write-scope",
    // @ts-expect-error Object spread cannot retain nominal write authority while replacing allowed paths.
    write: spreadWriteScope,
  });
}

expectType<(ctx: Ctx, writeScope: WriteScope) => Promise<void>>(exerciseAgentSafety);

// ---------------------------------------------------------------------------
// Additive facade and immutable-reference regressions
// ---------------------------------------------------------------------------

async function exerciseFacadeSafety(ctx: Ctx): Promise<void> {
  // @ts-expect-error Durable grouping uses `step`; there is no parallel `phase` concept.
  ctx.phase;
  // @ts-expect-error Effectful pipeline transforms use the explicit `mapEffect` name.
  ctx.pipeline([1]).stage;

  const rewrittenWaiver = { ...genuineWaiver, reason: "rewritten after authorization" };
  // @ts-expect-error Object spread cannot retain host-minted waiver authority while rewriting visible terms.
  await ctx.check(waivableCheck, {
    key: "spread-waiver",
    candidate: candidateSubject,
    waive: rewrittenWaiver,
  });

  const protectedResult = await ctx.operation.run(
    protectedOperation,
    { id: "candidate" },
    {
      key: "protected-operation",
      authorization: { detail: "Authorize the frozen candidate input" },
    },
  );
  expectType<{ accepted: boolean }>(protectedResult);

  const recoverableResult = await ctx.operation.runRecoverable(
    recoverableProtectedOperation,
    { id: "recoverable-candidate" },
    {
      key: "recoverable-operation",
      idempotencyKey: "round-11:recoverable-candidate",
      authorization: { detail: "Authorize the frozen recoverable candidate" },
    },
  );
  if (recoverableResult.status === "succeeded") {
    expectType<boolean>(recoverableResult.receipt.output.accepted);
  }

  const genericallyDowngradedOperation = rewrite(protectedOperation, {
    authorization: { mode: "none" as const },
  });
  // @ts-expect-error Hidden definition policy survives generic intersections and keeps the direct path closed.
  await ctx.operation(genericallyDowngradedOperation, { id: "candidate" }, { key: "generic-downgrade" });

  const weakenedAuthorization = {
    detail: "Attempt to weaken fixed policy",
    action: "Harmless",
    risk: "low" as const,
  };
  await ctx.operation.run(protectedOperation, { id: "candidate" }, {
    key: "weakened-operation-authorization",
    // @ts-expect-error Widened authorization presentation cannot override definition-fixed action or risk.
    authorization: weakenedAuthorization,
  });

  // @ts-expect-error Protected operations cannot bypass candidate-specific authorization through the direct call.
  await ctx.operation(protectedOperation, { id: "candidate" }, { key: "unsafe-direct-call" });

  const delivered = await ctx.delivery.run(publishDelivery, {
    key: "publish",
    candidate: candidateSubject,
    input: { expectedHead: candidateSubject.treeHash },
    proofs: positiveProofs,
    authorization: { detail: "Publish the positively verified candidate" },
  });
  expectType<CandidateSubject>(delivered.snapshot);
  await ctx.delivery.run(publishDelivery, {
    key: "weakened-delivery-authorization",
    candidate: candidateSubject,
    input: { expectedHead: candidateSubject.treeHash },
    proofs: positiveProofs,
    // @ts-expect-error Delivery presentation cannot carry widened action or risk overrides.
    authorization: weakenedAuthorization,
  });

  const decision = await ctx.policy.decide({
    key: "branch-only",
    action: "Continue the workflow branch",
    risk: "low",
  });
  expectType<"allow" | "deny">(decision.outcome);
  // @ts-expect-error A policy branch decision is not candidate-bound delivery authorization.
  await ctx.delivery.execute(decision, {});

  const confirmed = await ctx.human.confirm({
    key: "confirm-branch",
    action: "Continue optional analysis",
  });
  expectType<boolean>(confirmed.confirmed);

  const all = await ctx.parallel.all(
    ["a", "bb"],
    (item, lane) => {
      expectType<Ctx>(lane);
      return item.length;
    },
    { key: "lengths", keyOf: (item) => item },
  );
  expectType<number[]>(all);

  const settled = await ctx.parallel.settled(
    ["a", "bb"],
    (item) => item.length,
    { key: "settled-lengths", keyOf: (item) => item },
  );
  expectType<Settled<number>[]>(settled);

  // @ts-expect-error Parallel fan-out is method-based and never accepts already-started promises.
  await ctx.parallel([Promise.resolve(1)], { key: "started", keyOf: (_item, index) => `${index}` });

  await ctx.parallel.all(
    // @ts-expect-error Method-based fan-out also rejects promise items before the concurrency limiter starts.
    [Promise.resolve(1)],
    (started) => started,
    { key: "already-started-items", keyOf: (_item, index) => `${index}` },
  );

  ctx.pipeline([1, 2]).map(
    // @ts-expect-error Pipeline map is synchronous; asynchronous work belongs in `mapEffect`.
    async (value) => value + 1,
  );
  ctx.pipeline([1, 2]).map(
    // @ts-expect-error A widened union containing Promise still belongs in `mapEffect`.
    (value): number | Promise<number> => value,
  );

  // @ts-expect-error Engine-minted patch file lists are immutable.
  (null as unknown as PatchRef).files.push("mutable.ts");
}

expectType<(ctx: Ctx) => Promise<void>>(exerciseFacadeSafety);

async function exerciseReviewLaneSafety(ctx: ReviewCtx): Promise<void> {
  await ctx.agent(optionalInputAgent, "candidate", {
    key: "review-read-only-task-context",
    tasks: { mode: "read" },
  });
  await ctx.agent(optionalInputAgent, "candidate", {
    key: "review-task-write-escape",
    // @ts-expect-error Review agents cannot regain durable task mutation authority.
    tasks: { mode: "write" },
  });
  await ctx.agent(optionalInputAgent, "candidate", {
    key: "review-operation-tool-escape",
    // @ts-expect-error Review agents cannot receive arbitrary operation tools.
    tools: [protectedOperation],
  });

  await ctx.parallel.all(
    ["candidate"],
    (_item, lane) => {
      // @ts-expect-error Review fan-out lanes cannot regain protected operation authority.
      lane.operation;
      // @ts-expect-error Review fan-out lanes cannot publish a delivery.
      lane.delivery;
      return lane.git.status({ key: lane.key("status") });
    },
    { key: "review-lanes", keyOf: (item) => item },
  );
}

expectType<(ctx: ReviewCtx) => Promise<void>>(exerciseReviewLaneSafety);
