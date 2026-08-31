/** Declaration-only internal execution model for the Weft DSL prototype. */

import type {
  AgentOutcome,
  AgentOutputOf,
  AgentResult,
  AnyAgentCall,
  AnyDefinedAgentCall,
  GoalInvocationBase,
  InlineAgentCall,
  PatchAgentResult,
  WorkspaceWriteAgentResult,
} from "./agent.ts";
import type { ArtifactCaptureInputOf, ArtifactCaptureOptionsFor, ArtifactRefOf } from "./artifacts.ts";
import type {
  AnyCheckDefinition,
  CheckInputOf,
  CheckInvocationOptions,
  CheckResultOf,
  CheckSuiteInputOf,
  CheckSuiteInvocationOptions,
  CheckSuiteMembersOf,
  CheckSuiteResult,
  CheckWaiverAuthorizeOptions,
  CheckWaiverRef,
  FailedCheckResultOf,
  WaiverEligibleCheckDefinition,
} from "./checks.ts";
import type {
  ContextInvocationOptions,
  ContextSnapshotOf,
  ContextSourceDefinition,
  ContextSourceInputOf,
} from "./context-sources.ts";
import type {
  DeliveryAuthorizationRef,
  DeliveryAuthorizeOptions,
  DeliveryDefinition,
  DeliveryInvocationOptions,
  DeliveryPrepareOptions,
  DeliveryReceipt,
  DeliveryRunRequest,
  PromotionCandidateInput,
  PromotionCandidateRef,
} from "./deliveries.ts";
import type { GoalDefinition, GoalResult, GoalResultsOf } from "./goals.ts";
import type { UiViewRef } from "./human.ts";
import type {
  DetailedObserverResult,
  ObserverInputOf,
  ObserverInvocationOptions,
  ObserverInvocationOptionsOf,
  ObserverOutputOf,
} from "./observers.ts";
import type {
  DirectOperationDefinition,
  OperationAttemptCandidateOf,
  OperationAttemptIdempotencyOf,
  OperationAttemptPrimaryOf,
  OperationAttemptRecoveryOf,
  OperationAttemptRefMarker,
  OperationAttemptResult,
  OperationAuthorizationRef,
  OperationAuthorizeOptions,
  OperationCandidateRef,
  OperationInputOf,
  OperationInvocationOptions,
  OperationOutputOf,
  OperationPrepareOptions,
  OperationReceiptCompensationOf,
  OperationRecoveryCandidateRef,
  OperationRecoveryResult,
  ProtectedOperationDefinition,
  ProtectedOperationExecution,
  RecoverableOperationInvocationOptions,
  RecoverableOperationReceiptMarker,
} from "./operations.ts";
import type {
  PathPolicyDefinition,
  PathPolicyRequest,
  PathPolicyResolveOptions,
  WriteScope,
} from "./path-policies.ts";
import type { ReviewFindingOf, ReviewInputOf, ReviewInvocationOptions, ReviewResult } from "./reviews.ts";
import type {
  AnySchema,
  InferOut,
  InputOf,
  PromptDefinition,
  WorkflowNode,
  WorkspaceSnapshotRef,
} from "./shared.ts";
import type { TaskContract } from "./tasks.ts";
import type { TriggerInputOf, TriggerOutputOf } from "./triggers.ts";
import type {
  InferWorkflowInput,
  InferWorkflowOutput,
  WorkflowDefinition,
  WorkflowRunReceipt,
} from "./workflow.ts";

// ---------------------------------------------------------------------------
// Bound invocation identity and inference
// ---------------------------------------------------------------------------

/**
 * Why: Distinguishes runtime operations that may share one reusable definition kind, such as input and display views.
 * Use: Dispatch internal engine handlers exhaustively without changing the public `WorkflowNodeKind` contract.
 */
export type WorkflowInvocationKind =
  | "agent.run"
  | "artifact.capture"
  | "check.run"
  | "check.authorize"
  | "check-suite.run"
  | "context.resolve"
  | "delivery.authorize"
  | "delivery.prepare"
  | "delivery.run"
  | "goal.evaluate"
  | "observer.wait"
  | "operation.authorize"
  | "operation.prepare"
  | "operation.recoverable.register"
  | "operation.recoverable.run"
  | "operation.recovery.prepare"
  | "operation.recovery.run"
  | "operation.run"
  | "path-policy.resolve"
  | "prompt.render"
  | "review.run"
  | "task-contract.apply"
  | "trigger.admit"
  | "ui.request"
  | "ui.render"
  | "workflow.run";

/**
 * Why: Supplies the durable run, cancellation, and optional workspace generation shared by every bound operation.
 * Use: Capture it when a context method converts a reusable definition into a concrete invocation.
 */
export interface WorkflowExecutionContext {
  runId: string;
  parentStepKey?: string;
  signal: AbortSignal;
  snapshot?: WorkspaceSnapshotRef;
}

/**
 * Why: Gives pre-run trigger admission cancellation and host-delivery identity without inventing a workflow run ID.
 * Use: Bind it only while an authenticated source invokes `trigger.admit` before the child run exists.
 */
export interface TriggerExecutionContext {
  deliveryId: string;
  receivedAt: string;
  signal: AbortSignal;
}

/**
 * Why: Carries invocation input and output only at the type level so the executor can recover their exact relationship.
 * Use: It is stored under the private invocation brand and extracted through the public internal helper types.
 */
interface WorkflowInvocationTypes<Input, Output> {
  readonly input: Input;
  readonly output: Output;
}

/**
 * Why: Prevents workflow authors from constructing fake journaled invocations outside the engine binding layer.
 * Use: Only internal invocation builders supply this nominal property.
 */
declare const workflowInvocationBrand: unique symbol;

/**
 * Why: Represents one reusable definition bound to a concrete key, input, execution context, and result type.
 * Use: Make every internal operation extend this contract before passing it to `InternalEngine.execute`.
 */
export interface WorkflowInvocation<
  Kind extends WorkflowInvocationKind = WorkflowInvocationKind,
  Node extends WorkflowNode = WorkflowNode,
  Input = unknown,
  Output = unknown,
  Context extends WorkflowExecutionContext | TriggerExecutionContext = WorkflowExecutionContext,
> {
  readonly kind: Kind;
  readonly node: Node;
  readonly key: string;
  readonly input: Input;
  readonly context: Context;
  readonly [workflowInvocationBrand]: WorkflowInvocationTypes<Input, Output>;
}

/**
 * Why: Recovers the concrete input carried by any bound invocation without inspecting its definition kind.
 * Use: Apply it in handlers, tests, and adapters that need the exact input accepted by an invocation.
 */
export type WorkflowInvocationInput<Invocation> =
  Invocation extends WorkflowInvocation<
    WorkflowInvocationKind,
    WorkflowNode,
    infer Input,
    unknown,
    WorkflowExecutionContext | TriggerExecutionContext
  >
    ? Input
    : never;

/**
 * Why: Recovers the concrete result promised by an invocation so the generic executor does not erase it to `unknown`.
 * Use: Use it as the resolved type of `InternalEngine.execute` and specialized internal handlers.
 */
export type WorkflowInvocationOutput<Invocation> =
  Invocation extends WorkflowInvocation<
    WorkflowInvocationKind,
    WorkflowNode,
    unknown,
    infer Output,
    WorkflowExecutionContext | TriggerExecutionContext
  >
    ? Output
    : never;

// ---------------------------------------------------------------------------
// Prompt, check, and suite invocations
// ---------------------------------------------------------------------------

/**
 * Why: Recovers the raw input accepted by a reusable prompt definition before schema parsing.
 * Use: It supplies the input side of `PromptRenderInvocation`.
 */
export type PromptDefinitionInput<Node> =
  Node extends PromptDefinition<infer Input, infer _ParsedInput> ? Input : never;

/**
 * Why: Models prompt rendering as the pure transformation from typed input to stable prompt text.
 * Use: Bind it while preparing an agent invocation when the role references a reusable prompt.
 */
export type PromptRenderInvocation<Node extends WorkflowNode<"weft.prompt">> = WorkflowInvocation<
  "prompt.render",
  Node,
  PromptDefinitionInput<Node>,
  string
>;

/**
 * Why: Recovers the raw invocation input declared by a reusable deterministic check.
 * Use: It supplies the input side of `CheckInvocation`, including `void` for static checks.
 */
export type CheckDefinitionInput<Node> = CheckInputOf<Node>;

/**
 * Why: Adds check-specific policy overrides to the generic bound invocation without changing its domain input.
 * Use: The check binder copies `ctx.check` invocation options into this state for the check handler.
 */
export interface CheckInvocationState<
  Node extends AnyCheckDefinition = AnyCheckDefinition,
  Candidate extends WorkspaceSnapshotRef = WorkspaceSnapshotRef,
> {
  readonly options?: CheckInvocationOptions<Node, Candidate>;
}

/**
 * Why: Models one deterministic check as typed input translated into structured, generation-aware evidence.
 * Use: Create it behind `ctx.check` or while expanding a goal component.
 */
export type CheckInvocation<
  Node extends AnyCheckDefinition,
  Candidate extends WorkspaceSnapshotRef = WorkspaceSnapshotRef,
> = WorkflowInvocation<"check.run", Node, CheckDefinitionInput<Node>, CheckResultOf<Node, Candidate>> &
  CheckInvocationState<Node, Candidate>;

/**
 * Why: Carries the exact executed failure and bounded request used to authorize one eligible check exception.
 * Use: Bind it behind `ctx.check.authorizeWaiver`; the host derives policy fields from the definition, not this request.
 */
export interface CheckWaiverAuthorizationInput<
  Node extends WaiverEligibleCheckDefinition,
  Candidate extends WorkspaceSnapshotRef,
> {
  readonly failure: FailedCheckResultOf<Node, Candidate>;
  readonly options: CheckWaiverAuthorizeOptions;
}

/**
 * Why: Models waiver authorization as exact failed evidence translated into a nominal definition-bound capability.
 * Use: Execute it behind `ctx.check.authorizeWaiver` before invoking the matching eligible check with `waive`.
 */
export type CheckWaiverAuthorizationInvocation<
  Node extends WaiverEligibleCheckDefinition,
  Candidate extends WorkspaceSnapshotRef,
> = WorkflowInvocation<
  "check.authorize",
  Node,
  CheckWaiverAuthorizationInput<Node, Candidate>,
  CheckWaiverRef<Node, Candidate>
>;

/**
 * Why: Recovers the raw input declared by a parameterized check suite.
 * Use: It supplies the input side of `CheckSuiteInvocation`, including `void` for a static suite.
 */
export type CheckSuiteDefinitionInput<Node> = CheckSuiteInputOf<Node>;

/**
 * Why: Recovers the member map whose names and result types must remain visible after suite execution.
 * Use: It supplies the result side of `CheckSuiteInvocation`.
 */
export type CheckSuiteDefinitionMembers<Node> = CheckSuiteMembersOf<Node>;

/**
 * Why: Adds suite concurrency and policy overrides to its bound invocation.
 * Use: The suite binder copies `ctx.check` options here before the engine expands member checks.
 */
export interface CheckSuiteInvocationState<Candidate extends WorkspaceSnapshotRef = WorkspaceSnapshotRef> {
  readonly options?: CheckSuiteInvocationOptions<Candidate>;
}

/**
 * Why: Models a named check suite as typed input translated into independently visible member results.
 * Use: Create it behind the suite overload of `ctx.check` or while expanding a goal.
 */
export type CheckSuiteInvocation<
  Node extends WorkflowNode<"weft.check-suite">,
  Candidate extends WorkspaceSnapshotRef = WorkspaceSnapshotRef,
> = WorkflowInvocation<
  "check-suite.run",
  Node,
  CheckSuiteDefinitionInput<Node>,
  CheckSuiteResult<CheckSuiteDefinitionMembers<Node>, Candidate>
> &
  CheckSuiteInvocationState<Candidate>;

// ---------------------------------------------------------------------------
// Artifact, context, path-policy, operation, and observer invocations
// ---------------------------------------------------------------------------

/**
 * Why: Carries capture identity and presentation metadata beside an artifact's schema-derived content input.
 * Use: The artifact handler reads it when storing content and producing the immutable reference.
 */
export interface ArtifactInvocationState<
  Candidate extends WorkspaceSnapshotRef | undefined = WorkspaceSnapshotRef | undefined,
> {
  readonly options: ArtifactCaptureOptionsFor<Candidate>;
}

/**
 * Why: Models artifact capture as validated content and metadata translated into an immutable typed reference.
 * Use: Create it behind `ctx.artifact` before delegating storage to the generic executor.
 */
export type ArtifactInvocation<
  Node extends WorkflowNode<"weft.artifact">,
  Candidate extends WorkspaceSnapshotRef | undefined = WorkspaceSnapshotRef | undefined,
> = WorkflowInvocation<
  "artifact.capture",
  Node,
  ArtifactCaptureInputOf<Node>,
  ArtifactRefOf<Node, Candidate>
> &
  ArtifactInvocationState<Candidate>;

/**
 * Why: Carries freshness overrides beside a context source's schema-derived lookup input.
 * Use: The context handler merges it with source trust/freshness policy before resolving the host binding.
 */
export interface ContextSourceInvocationState {
  readonly options: ContextInvocationOptions;
}

/**
 * Why: Models a read-only context source as typed lookup translated into a nominal provenance-bearing snapshot.
 * Use: Create it behind `ctx.context` before delegating the host read to the generic executor.
 */
export type ContextSourceInvocation<Node extends ContextSourceDefinition<AnySchema, AnySchema, string>> =
  WorkflowInvocation<"context.resolve", Node, ContextSourceInputOf<Node>, ContextSnapshotOf<Node>> &
    ContextSourceInvocationState;

/**
 * Why: Carries durable resolution identity beside one untrusted path proposal.
 * Use: The path handler uses it while canonicalizing paths and minting a snapshot-bound grant.
 */
export interface PathPolicyInvocationState {
  readonly options: PathPolicyResolveOptions;
}

/**
 * Why: Models path policy resolution as an untrusted proposal translated into nominal write authority.
 * Use: Create it behind `ctx.paths.resolve` before any writer receives the returned scope.
 */
export type PathPolicyInvocation<Node extends PathPolicyDefinition> = WorkflowInvocation<
  "path-policy.resolve",
  Node,
  PathPolicyRequest,
  WriteScope<Node>
> &
  PathPolicyInvocationState;

/**
 * Why: Carries per-call authorization and retry limits beside an operation's schema-derived domain input.
 * Use: The operation handler merges it with definition defaults and host policy before execution.
 */
export interface OperationInvocationState {
  readonly options: OperationInvocationOptions;
}

/**
 * Why: Models an explicitly unprotected atomic operation as typed input translated into validated output.
 * Use: Create it only behind the direct `ctx.operation` overload for definitions with `mode: "none"`.
 */
export type OperationInvocation<Node extends DirectOperationDefinition> = WorkflowInvocation<
  "operation.run",
  Node,
  OperationInputOf<Node>,
  OperationOutputOf<Node>
> &
  OperationInvocationState;

/**
 * Why: Carries stable identity while the engine validates and freezes protected operation input.
 * Use: The preparation handler records it with the definition and input digests.
 */
export interface OperationPrepareInvocationState {
  readonly options: OperationPrepareOptions;
}

/**
 * Why: Models protected input preparation as raw typed input translated into a nominal immutable candidate.
 * Use: Create it during the internal prepare stage of a protected `ctx.operation` call.
 */
export type OperationPrepareInvocation<
  Node extends ProtectedOperationDefinition,
  Input extends OperationInputOf<Node> = OperationInputOf<Node>,
> = WorkflowInvocation<"operation.prepare", Node, Input, OperationCandidateRef<Node, Input>> &
  OperationPrepareInvocationState;

/**
 * Why: Carries candidate-specific presentation without changing protected operation policy.
 * Use: The authorization handler combines it with the frozen candidate and definition policy.
 */
export interface OperationAuthorizeInvocationState {
  readonly options: OperationAuthorizeOptions;
}

/**
 * Why: Models authorization as an immutable candidate translated into a candidate-bound capability token.
 * Use: Create it during internal authorization and consume the result only with that candidate.
 */
export type OperationAuthorizeInvocation<
  Node extends ProtectedOperationDefinition,
  Candidate extends OperationCandidateRef<Node>,
> = WorkflowInvocation<"operation.authorize", Node, Candidate, OperationAuthorizationRef<Node, Candidate>> &
  OperationAuthorizeInvocationState;

/**
 * Why: Models protected execution as matching candidate and authority translated into validated operation output.
 * Use: Create it during internal execution; the handler consumes authority and revalidates both digests.
 */
export type ProtectedOperationInvocation<
  Node extends ProtectedOperationDefinition,
  Candidate extends OperationCandidateRef<Node>,
> = WorkflowInvocation<
  "operation.run",
  Node,
  ProtectedOperationExecution<Node, Candidate>,
  OperationOutputOf<Node>
> &
  OperationInvocationState;

/**
 * Why: Carries exact frozen primary execution and normalized recovery state into pre-dispatch registration.
 * Use: Bind it inside a recoverable call; the handler commits it before any primary adapter dispatch.
 */
export interface RecoverableOperationRegistrationInput<Attempt extends OperationAttemptRefMarker> {
  readonly execution: ProtectedOperationExecution<
    OperationAttemptPrimaryOf<Attempt>,
    OperationAttemptCandidateOf<Attempt>
  >;
  readonly recovery: OperationAttemptRecoveryOf<Attempt>;
  readonly options: RecoverableOperationInvocationOptions<OperationAttemptIdempotencyOf<Attempt>>;
}

/**
 * Why: Models atomic recovery registration as normalized intent translated into a nominal pre-dispatch attempt.
 * Use: Execute it before `RecoverableOperationExecutionInvocation`; replay rehydrates the same attempt reference.
 */
export type RecoverableOperationRegistrationInvocation<Attempt extends OperationAttemptRefMarker> =
  WorkflowInvocation<
    "operation.recoverable.register",
    OperationAttemptPrimaryOf<Attempt>,
    RecoverableOperationRegistrationInput<Attempt>,
    Attempt
  >;

/**
 * Why: Models one registered remote dispatch as a nominal attempt translated into host-classified commit evidence.
 * Use: Execute it in the recoverable dispatch stage; ambiguity includes automatic cancellation evidence.
 */
export type RecoverableOperationExecutionInvocation<Attempt extends OperationAttemptRefMarker> =
  WorkflowInvocation<
    "operation.recoverable.run",
    OperationAttemptPrimaryOf<Attempt>,
    Attempt,
    OperationAttemptResult<Attempt>
  >;

/**
 * Why: Models registered success-receipt mapping as exact receipt input translated into a compensation candidate.
 * Use: Execute it during recovery preparation; attempts without success receipts cannot enter this path.
 */
export type OperationRecoveryPrepareInvocation<Receipt extends RecoverableOperationReceiptMarker> =
  WorkflowInvocation<
    "operation.recovery.prepare",
    OperationReceiptCompensationOf<Receipt>,
    Receipt,
    OperationRecoveryCandidateRef<Receipt>
  > &
    OperationPrepareInvocationState;

/**
 * Why: Carries explicit protected compensation state without letting receipt or candidate relationships be swapped.
 * Use: Bind it during recovery after authorization of the receipt-derived candidate.
 */
export interface OperationRecoveryExecutionInput<
  Receipt extends RecoverableOperationReceiptMarker,
  Candidate extends OperationRecoveryCandidateRef<Receipt>,
  IdempotencyKey extends string,
> {
  readonly receipt: Receipt;
  readonly execution: ProtectedOperationExecution<OperationReceiptCompensationOf<Receipt>, Candidate>;
  readonly options: RecoverableOperationInvocationOptions<IdempotencyKey>;
}

/**
 * Why: Models explicit compensation as receipt-bound authorized input translated into classified recovery evidence.
 * Use: Execute it in the recovery stage; ordinary primary output cannot authorize this invocation.
 */
export type OperationRecoveryInvocation<
  Receipt extends RecoverableOperationReceiptMarker,
  Candidate extends OperationRecoveryCandidateRef<Receipt>,
  IdempotencyKey extends string,
> = WorkflowInvocation<
  "operation.recovery.run",
  OperationReceiptCompensationOf<Receipt>,
  OperationRecoveryExecutionInput<Receipt, Candidate, IdempotencyKey>,
  OperationRecoveryResult<Receipt, Candidate, IdempotencyKey>
>;

/**
 * Why: Carries durable identity and wait overrides beside an observer's schema-derived lookup input.
 * Use: The observer handler merges it with source configuration and definition defaults.
 */
export interface ObserverInvocationState<
  Options extends ObserverInvocationOptions = ObserverInvocationOptions,
  Mode extends "output" | "detailed" = "output" | "detailed",
> {
  readonly options: Options;
  readonly mode: Mode;
}

/**
 * Why: Models durable observation as typed lookup input translated into validated terminal external state.
 * Use: Create it behind `ctx.observe` before the executor polls or suspends for a host signal.
 */
export type ObserverInvocation<Node extends WorkflowNode<"weft.observer">> = WorkflowInvocation<
  "observer.wait",
  Node,
  ObserverInputOf<Node>,
  ObserverOutputOf<Node>
> &
  ObserverInvocationState<ObserverInvocationOptionsOf<Node>, "output">;

/**
 * Why: Models the same durable wait with its engine-minted subject, provenance, and evidence retained.
 * Use: Create it behind `ctx.observe.detailed` when downstream decisions require more than parsed output.
 */
export type DetailedObserverInvocation<Node extends WorkflowNode<"weft.observer">> = WorkflowInvocation<
  "observer.wait",
  Node,
  ObserverInputOf<Node>,
  DetailedObserverResult<Node>
> &
  ObserverInvocationState<ObserverInvocationOptionsOf<Node>, "detailed">;

// ---------------------------------------------------------------------------
// Review and verified-delivery invocations
// ---------------------------------------------------------------------------

/**
 * Why: Carries the exact candidate and durable identity used to guard one reusable review evaluation.
 * Use: The review handler verifies the candidate before and after nested evaluator effects.
 */
export interface ReviewInvocationState<Candidate extends WorkspaceSnapshotRef = WorkspaceSnapshotRef> {
  readonly options: ReviewInvocationOptions<Candidate>;
}

/**
 * Why: Models review as typed input translated into a candidate-bound verdict and nominal attestation.
 * Use: Create it behind `ctx.review` while keeping any later rework in ordinary workflow code.
 */
export type ReviewInvocation<
  Node extends WorkflowNode<"weft.review">,
  Candidate extends WorkspaceSnapshotRef = WorkspaceSnapshotRef,
> = WorkflowInvocation<
  "review.run",
  Node,
  ReviewInputOf<Node>,
  ReviewResult<ReviewFindingOf<Node>, Candidate>
> &
  ReviewInvocationState<Candidate>;

/**
 * Why: Carries the stable key used while validating evidence and freezing delivery input.
 * Use: The promotion handler records it beside the candidate minting step.
 */
export interface DeliveryPrepareInvocationState {
  readonly options: DeliveryPrepareOptions;
}

/**
 * Why: Models promotion preparation as proof-bearing input translated into a nominal candidate reference.
 * Use: Create it during the internal delivery prepare stage before authorization is requested.
 */
export type DeliveryPrepareInvocation<
  Node extends DeliveryDefinition<any, any>,
  Candidate extends WorkspaceSnapshotRef = WorkspaceSnapshotRef,
> = WorkflowInvocation<
  "delivery.prepare",
  Node,
  PromotionCandidateInput<Node, Candidate>,
  PromotionCandidateRef<Node, Candidate>
> &
  DeliveryPrepareInvocationState;

/**
 * Why: Carries candidate-specific authorization presentation without changing the frozen candidate.
 * Use: The authorization handler combines it with the delivery definition's non-weakenable policy.
 */
export interface DeliveryAuthorizeInvocationState {
  readonly options: DeliveryAuthorizeOptions;
}

/**
 * Why: Models authorization as one promotion candidate translated into a candidate-specific capability token.
 * Use: Create it during internal delivery authorization and consume it only in the matching run request.
 */
export type DeliveryAuthorizeInvocation<
  Node extends DeliveryDefinition<any, any>,
  Candidate extends PromotionCandidateRef<Node, WorkspaceSnapshotRef>,
> = WorkflowInvocation<"delivery.authorize", Node, Candidate, DeliveryAuthorizationRef<Node, Candidate>> &
  DeliveryAuthorizeInvocationState;

/**
 * Why: Carries bounded retry and stable identity for one atomic delivery execution.
 * Use: The delivery handler applies it only after revalidating candidate and authorization references.
 */
export interface DeliveryRunInvocationState {
  readonly options: DeliveryInvocationOptions;
}

/**
 * Why: Models atomic delivery as authorized candidate state translated into a generation-bound receipt.
 * Use: Create it behind callable `ctx.delivery` after preparation and authorization both succeed.
 */
export type DeliveryRunInvocation<
  Node extends DeliveryDefinition<any, any>,
  Candidate extends PromotionCandidateRef<Node, WorkspaceSnapshotRef>,
> = WorkflowInvocation<
  "delivery.run",
  Node,
  DeliveryRunRequest<Node, Candidate>,
  DeliveryReceipt<Node, Candidate>
> &
  DeliveryRunInvocationState;

// ---------------------------------------------------------------------------
// Agent and goal invocations
// ---------------------------------------------------------------------------

/**
 * Why: Recovers the exact reusable agent node referenced by a complete defined-agent call.
 * Use: It binds the public call envelope back to the `WorkflowNode` executed internally.
 */
export type AgentNodeOf<Call extends AnyDefinedAgentCall> = Call["agent"];

/**
 * Why: Recovers the schema-validated domain value produced by the agent role in a complete call.
 * Use: It is the value inside the agent result envelope selected for the invocation policy.
 */
export type AgentValueOf<Call extends AnyAgentCall> =
  Call extends InlineAgentCall<infer Schema>
    ? InferOut<Schema>
    : Call extends AnyDefinedAgentCall
      ? AgentOutputOf<Call["agent"]>
      : never;

/**
 * Why: Names the structural carrier used to detect a goal attached to an agent invocation.
 * Use: It lets `AgentGoalOf` infer accepted goal evidence without using an inline object type.
 */
interface AgentGoalCarrier<Definition extends GoalDefinition<any, any>> {
  goal: GoalInvocationBase<Definition>;
}

/**
 * Why: Recovers the accepted goal result only when the concrete agent call attaches a goal definition.
 * Use: It controls whether the agent result contains a required `goal` field.
 */
export type AgentGoalOf<Call extends AnyAgentCall> =
  Call extends AgentGoalCarrier<infer Definition>
    ? Definition extends GoalDefinition<any, any>
      ? GoalResult<GoalResultsOf<Definition>>
      : undefined
    : undefined;

/**
 * Why: Names the structural carrier used to detect write authority on an agent invocation.
 * Use: It lets the result type distinguish ordinary, patch-producing, and workspace-writing calls.
 */
interface AgentWriteCarrier {
  write: WriteScope;
}

/**
 * Why: Names the structural carrier used to detect explicitly returned agent failure.
 * Use: It lets the result type return an exhaustive outcome only when the concrete call requests `failure: "return"`.
 */
interface ReturnedAgentFailureCarrier {
  failure: "return";
}

/**
 * Why: Selects the correct patch semantics from the concrete agent call and its bound workspace mode.
 * Use: It forms the successful result side of `AgentInvocationOutput`.
 */
export type AgentInvocationEnvelope<
  Call extends AnyAgentCall,
  Workspace extends boolean,
> = Call extends AgentWriteCarrier
  ? Workspace extends true
    ? WorkspaceWriteAgentResult<AgentValueOf<Call>, AgentGoalOf<Call>>
    : PatchAgentResult<AgentValueOf<Call>, AgentGoalOf<Call>>
  : AgentResult<AgentValueOf<Call>, AgentGoalOf<Call>>;

/**
 * Why: Preserves returned-failure behavior as part of the invocation's exact output rather than the reusable agent node.
 * Use: It is the output extracted when `InternalEngine.execute` receives a defined or inline agent invocation.
 */
export type AgentInvocationOutput<
  Call extends AnyAgentCall,
  Workspace extends boolean,
> = Call extends ReturnedAgentFailureCarrier
  ? AgentOutcome<AgentValueOf<Call>, AgentGoalOf<Call>, AgentInvocationEnvelope<Call, Workspace>>
  : AgentInvocationEnvelope<Call, Workspace>;

/**
 * Why: Records whether writes occur in an owned workspace or must produce an isolated patch.
 * Use: The agent handler uses it together with the concrete call to enforce the correct mutation contract.
 */
export interface AgentInvocationState<Workspace extends boolean> {
  readonly workspace: Workspace;
}

/**
 * Why: Binds a reusable agent role to the complete call whose options determine its exact result envelope.
 * Use: Create it behind the defined-role overload of `ctx.agent` before passing it to the generic executor.
 */
export type DefinedAgentInvocation<
  Call extends AnyDefinedAgentCall,
  Workspace extends boolean,
> = WorkflowInvocation<"agent.run", AgentNodeOf<Call>, Call, AgentInvocationOutput<Call, Workspace>> &
  AgentInvocationState<Workspace>;

/**
 * Why: Gives an inline `ctx.agent` call an engine-normalized node without requiring authors to define a reusable role.
 * Use: The context binder creates it internally from the inline schema before generic execution.
 */
export interface InlineAgentNode<Schema extends AnySchema = AnySchema> extends WorkflowNode<"weft.agent"> {
  readonly kind: "weft.agent";
  readonly name: "inline-agent";
  readonly schema: Schema;
}

/**
 * Why: Recovers the exact engine-normalized node for an inline agent call.
 * Use: Preserve the inline result schema while keeping the closed invocation union node-backed.
 */
export type InlineAgentNodeOf<Call extends InlineAgentCall<any>> =
  Call extends InlineAgentCall<infer Schema> ? InlineAgentNode<Schema> : never;

/**
 * Why: Binds a complete inline agent call to the same exact input-to-output execution path as reusable agent roles.
 * Use: Create it behind the inline `ctx.agent` overload before passing it to `InternalEngine.execute`.
 */
export type InlineAgentInvocation<
  Call extends InlineAgentCall<any>,
  Workspace extends boolean,
> = WorkflowInvocation<"agent.run", InlineAgentNodeOf<Call>, Call, AgentInvocationOutput<Call, Workspace>> &
  AgentInvocationState<Workspace>;

/**
 * Why: Identifies the owning implementation session whose candidate a goal must evaluate or continue.
 * Use: Bind it to a goal invocation so rejection feedback returns to the correct agent session.
 */
export interface GoalOwnerSession {
  sessionId: string;
  attempt: number;
}

/**
 * Why: Supplies both domain goal input and the exact candidate generation that its evidence must observe.
 * Use: Construct it whenever an agent proposal reaches its attached completion goal.
 */
export interface GoalEvaluationInput<Input> {
  value: Input;
  candidate: WorkspaceSnapshotRef;
  owner: GoalOwnerSession;
}

/**
 * Why: Recovers the domain input expected by a named goal definition.
 * Use: It specializes `GoalEvaluationInput` for the selected goal node.
 */
export type GoalDefinitionInput<Node> = Node extends GoalDefinition<any, any> ? InputOf<Node> : never;

/**
 * Why: Recovers the accepted component result map produced by a named goal definition.
 * Use: It specializes the final `GoalResult` returned by goal execution.
 */
export type GoalDefinitionResults<Node> = Node extends GoalDefinition<any, any> ? GoalResultsOf<Node> : never;

/**
 * Why: Models bounded goal evaluation as a candidate-bound input translated into accepted, generation-scoped evidence.
 * Use: Create it inside a goal-backed agent invocation; rejected attempts remain internal substeps until acceptance or failure.
 */
export type GoalEvaluationInvocation<Node extends WorkflowNode<"weft.goal">> = WorkflowInvocation<
  "goal.evaluate",
  Node,
  GoalEvaluationInput<GoalDefinitionInput<Node>>,
  GoalResult<GoalDefinitionResults<Node>>
>;

// ---------------------------------------------------------------------------
// UI, task contract, and workflow invocations
// ---------------------------------------------------------------------------

/**
 * Why: Recovers validated props accepted by either an interactive or display-only view.
 * Use: It supplies the input side of both UI invocation modes.
 */
export type UiViewProps<Node> =
  Node extends UiViewRef<infer Props, infer _Answer, infer _Mode> ? Props : never;

/**
 * Why: Recovers the validated answer returned by an interactive input view.
 * Use: It supplies the output side of `UiRequestInvocation`.
 */
export type UiViewAnswer<Node> =
  Node extends UiViewRef<infer _Props, infer Answer, infer Mode>
    ? Mode extends "input"
      ? Answer
      : never
    : never;

/**
 * Why: Models host-controlled interactive presentation as validated props translated into a validated answer.
 * Use: Create it behind human ask or review when a custom input view is bound.
 */
export type UiRequestInvocation<Node extends WorkflowNode<"weft.ui-view">> = WorkflowInvocation<
  "ui.request",
  Node,
  UiViewProps<Node>,
  UiViewAnswer<Node>
>;

/**
 * Why: Models read-only result presentation as validated props translated into completed rendering.
 * Use: Create it behind `ctx.ui.render`; its `void` result makes the absence of a submitted answer explicit.
 */
export type UiRenderInvocation<Node extends WorkflowNode<"weft.ui-view">> = WorkflowInvocation<
  "ui.render",
  Node,
  UiViewProps<Node>,
  void
>;

/**
 * Why: Names the raw extension payload that must be validated by a task contract.
 * Use: Bind it when a workflow reads or writes task extensions at the host boundary.
 */
export interface TaskContractInvocationInput {
  extensions: unknown;
}

/**
 * Why: Recovers the schema-validated extension type produced by a task contract.
 * Use: It supplies the output side of `TaskContractInvocation`.
 */
export type TaskContractOutput<Node> =
  Node extends TaskContract<infer Schema extends AnySchema> ? InferOut<Schema> : never;

/**
 * Why: Models a task contract as raw extensions translated into their validated representation.
 * Use: Create it inside task observation and mutation boundaries rather than treating the contract as a journaled task itself.
 */
export type TaskContractInvocation<Node extends WorkflowNode<"weft.task-contract">> = WorkflowInvocation<
  "task-contract.apply",
  Node,
  TaskContractInvocationInput,
  TaskContractOutput<Node>
>;

/**
 * Why: Models authenticated external admission as raw event input translated into an atomic launch decision.
 * Use: Create it only in the host ingress layer; running workflows cannot invoke triggers through `Ctx`.
 */
export type TriggerAdmissionInvocation<Node extends WorkflowNode<"weft.trigger">> = WorkflowInvocation<
  "trigger.admit",
  Node,
  TriggerInputOf<Node>,
  TriggerOutputOf<Node>,
  TriggerExecutionContext
>;

/**
 * Why: Records whether a workflow invocation owns a root lifecycle or delegates a child run from a parent.
 * Use: The workflow handler uses it to establish the correct journal, budget, status, and task boundaries.
 */
export interface WorkflowRunInvocationState<Mode extends "output" | "detailed" = "output" | "detailed"> {
  readonly lifecycle: "root" | "child";
  readonly mode: Mode;
}

/**
 * Why: Models a workflow as validated launch input translated into its validated durable run output.
 * Use: Create it at the host entrypoint or behind `ctx.workflow` before generic execution.
 */
export type WorkflowRunInvocation<Node extends WorkflowDefinition<any, any>> = WorkflowInvocation<
  "workflow.run",
  Node,
  InferWorkflowInput<Node>,
  InferWorkflowOutput<Node>
> &
  WorkflowRunInvocationState<"output">;

/**
 * Why: Models a child run whose validated output retains engine-minted invocation lineage and optional workspace.
 * Use: Create it behind `ctx.workflow.detailed`; root launches remain host-owned entrypoint invocations.
 */
export type DetailedWorkflowRunInvocation<Node extends WorkflowDefinition<any, any>> = WorkflowInvocation<
  "workflow.run",
  Node,
  InferWorkflowInput<Node>,
  WorkflowRunReceipt<Node>
> &
  WorkflowRunInvocationState<"detailed">;

// ---------------------------------------------------------------------------
// Generic engine boundary
// ---------------------------------------------------------------------------

/**
 * Why: Gives the dispatcher an erased prompt invocation member while exact callers retain their concrete generic type.
 * Use: It participates in the closed `AnyWorkflowInvocation` union used by the internal executor.
 */
type AnyPromptRenderInvocation = WorkflowInvocation<
  "prompt.render",
  WorkflowNode<"weft.prompt">,
  unknown,
  string
>;

/**
 * Why: Gives the dispatcher an erased artifact capture member with its storage options visible.
 * Use: It participates in the closed `AnyWorkflowInvocation` union used by the internal executor.
 */
type AnyArtifactInvocation = WorkflowInvocation<
  "artifact.capture",
  WorkflowNode<"weft.artifact">,
  unknown,
  unknown
> &
  ArtifactInvocationState;

/**
 * Why: Gives the dispatcher an erased read-only context member with freshness options visible.
 * Use: It participates in the closed `AnyWorkflowInvocation` union used by the internal executor.
 */
type AnyContextSourceInvocation = WorkflowInvocation<
  "context.resolve",
  WorkflowNode<"weft.context-source">,
  unknown,
  unknown
> &
  ContextSourceInvocationState;

/**
 * Why: Gives the dispatcher an erased path-policy member with resolution identity visible.
 * Use: It participates in the closed `AnyWorkflowInvocation` union used by the internal executor.
 */
type AnyPathPolicyInvocation = WorkflowInvocation<
  "path-policy.resolve",
  WorkflowNode<"weft.path-policy">,
  PathPolicyRequest,
  unknown
> &
  PathPolicyInvocationState;

/**
 * Why: Gives the dispatcher an erased operation member with authorization and retry options visible.
 * Use: It participates in the closed `AnyWorkflowInvocation` union used by the internal executor.
 */
type AnyOperationInvocation = WorkflowInvocation<
  "operation.run",
  WorkflowNode<"weft.operation">,
  unknown,
  unknown
> &
  OperationInvocationState;

/**
 * Why: Gives the dispatcher an erased protected-operation preparation member with durable options visible.
 * Use: It participates in the closed `AnyWorkflowInvocation` union used by the internal executor.
 */
type AnyOperationPrepareInvocation = WorkflowInvocation<
  "operation.prepare",
  WorkflowNode<"weft.operation">,
  unknown,
  unknown
> &
  OperationPrepareInvocationState;

/**
 * Why: Gives the dispatcher an erased protected-operation authorization member with presentation options visible.
 * Use: It participates in the closed `AnyWorkflowInvocation` union used by the internal executor.
 */
type AnyOperationAuthorizeInvocation = WorkflowInvocation<
  "operation.authorize",
  WorkflowNode<"weft.operation">,
  unknown,
  unknown
> &
  OperationAuthorizeInvocationState;

/**
 * Why: Gives the dispatcher an erased pre-dispatch recovery-registration member.
 * Use: It participates in the closed union while exact callers retain attempt and recovery relationships.
 */
type AnyRecoverableOperationRegistrationInvocation = WorkflowInvocation<
  "operation.recoverable.register",
  WorkflowNode<"weft.operation">,
  unknown,
  unknown
>;

/**
 * Why: Gives the dispatcher an erased recoverable primary-dispatch member.
 * Use: It participates in the closed union while exact callers retain host-classified attempt results.
 */
type AnyRecoverableOperationExecutionInvocation = WorkflowInvocation<
  "operation.recoverable.run",
  WorkflowNode<"weft.operation">,
  unknown,
  unknown
>;

/**
 * Why: Gives the dispatcher an erased receipt-bound compensation-preparation member.
 * Use: It participates in the closed union while exact callers retain their nominal recovery candidate.
 */
type AnyOperationRecoveryPrepareInvocation = WorkflowInvocation<
  "operation.recovery.prepare",
  WorkflowNode<"weft.operation">,
  unknown,
  unknown
> &
  OperationPrepareInvocationState;

/**
 * Why: Gives the dispatcher an erased explicit compensation-execution member.
 * Use: It participates in the closed union while exact callers retain classified recovery evidence.
 */
type AnyOperationRecoveryInvocation = WorkflowInvocation<
  "operation.recovery.run",
  WorkflowNode<"weft.operation">,
  unknown,
  unknown
>;

/**
 * Why: Gives the dispatcher an erased observer member with durable wait options visible.
 * Use: It participates in the closed `AnyWorkflowInvocation` union used by the internal executor.
 */
type AnyObserverInvocation = WorkflowInvocation<
  "observer.wait",
  WorkflowNode<"weft.observer">,
  unknown,
  unknown
> &
  ObserverInvocationState;

/**
 * Why: Gives the dispatcher an erased review member with exact-candidate guard options visible.
 * Use: It participates in the closed `AnyWorkflowInvocation` union used by the internal executor.
 */
type AnyReviewInvocation = WorkflowInvocation<"review.run", WorkflowNode<"weft.review">, unknown, unknown> &
  ReviewInvocationState;

/**
 * Why: Gives the dispatcher an erased candidate-preparation member with its durable options visible.
 * Use: It participates in the closed `AnyWorkflowInvocation` union used by the internal executor.
 */
type AnyDeliveryPrepareInvocation = WorkflowInvocation<
  "delivery.prepare",
  WorkflowNode<"weft.delivery">,
  unknown,
  unknown
> &
  DeliveryPrepareInvocationState;

/**
 * Why: Gives the dispatcher an erased candidate-authorization member with its presentation options visible.
 * Use: It participates in the closed `AnyWorkflowInvocation` union used by the internal executor.
 */
type AnyDeliveryAuthorizeInvocation = WorkflowInvocation<
  "delivery.authorize",
  WorkflowNode<"weft.delivery">,
  unknown,
  unknown
> &
  DeliveryAuthorizeInvocationState;

/**
 * Why: Gives the dispatcher an erased delivery execution member with retry options visible.
 * Use: It participates in the closed `AnyWorkflowInvocation` union used by the internal executor.
 */
type AnyDeliveryRunInvocation = WorkflowInvocation<
  "delivery.run",
  WorkflowNode<"weft.delivery">,
  unknown,
  unknown
> &
  DeliveryRunInvocationState;

/**
 * Why: Gives the dispatcher an erased check invocation member with the state required by its handler.
 * Use: It participates in the closed `AnyWorkflowInvocation` union used by the internal executor.
 */
type AnyCheckInvocation = WorkflowInvocation<"check.run", WorkflowNode<"weft.check">, unknown, unknown> &
  CheckInvocationState;

/**
 * Why: Gives the dispatcher an erased waiver-authorization member while exact callers retain definition and candidate.
 * Use: It participates in the closed internal invocation union beside ordinary check execution.
 */
type AnyCheckWaiverAuthorizationInvocation = WorkflowInvocation<
  "check.authorize",
  WorkflowNode<"weft.check">,
  unknown,
  unknown
>;

/**
 * Why: Gives the dispatcher an erased suite invocation member with the state required by its handler.
 * Use: It participates in the closed `AnyWorkflowInvocation` union used by the internal executor.
 */
type AnyCheckSuiteInvocation = WorkflowInvocation<
  "check-suite.run",
  WorkflowNode<"weft.check-suite">,
  unknown,
  unknown
> &
  CheckSuiteInvocationState;

/**
 * Why: Gives the dispatcher an erased agent invocation member with its workspace mode still visible.
 * Use: It participates in the closed `AnyWorkflowInvocation` union used by the internal executor.
 */
type AnyAgentInvocation = WorkflowInvocation<"agent.run", WorkflowNode<"weft.agent">, unknown, unknown> &
  AgentInvocationState<boolean>;

/**
 * Why: Gives the dispatcher an erased goal evaluation member while exact accepted evidence stays available to callers.
 * Use: It participates in the closed `AnyWorkflowInvocation` union used by the internal executor.
 */
type AnyGoalEvaluationInvocation = WorkflowInvocation<
  "goal.evaluate",
  WorkflowNode<"weft.goal">,
  unknown,
  unknown
>;

/**
 * Why: Gives the dispatcher an erased interactive UI member distinct from display-only rendering.
 * Use: It participates in the closed `AnyWorkflowInvocation` union used by the internal executor.
 */
type AnyUiRequestInvocation = WorkflowInvocation<
  "ui.request",
  WorkflowNode<"weft.ui-view">,
  unknown,
  unknown
>;

/**
 * Why: Gives the dispatcher an erased display UI member whose result is always `void`.
 * Use: It participates in the closed `AnyWorkflowInvocation` union used by the internal executor.
 */
type AnyUiRenderInvocation = WorkflowInvocation<"ui.render", WorkflowNode<"weft.ui-view">, unknown, void>;

/**
 * Why: Gives the dispatcher an erased task-contract member while retaining its named operation input.
 * Use: It participates in the closed `AnyWorkflowInvocation` union used by the internal executor.
 */
type AnyTaskContractInvocation = WorkflowInvocation<
  "task-contract.apply",
  WorkflowNode<"weft.task-contract">,
  TaskContractInvocationInput,
  unknown
>;

/**
 * Why: Gives the dispatcher an erased external-admission member with its pre-run context still visible.
 * Use: It participates in the closed union while concrete trigger callers retain exact event and result types.
 */
type AnyTriggerAdmissionInvocation = WorkflowInvocation<
  "trigger.admit",
  WorkflowNode<"weft.trigger">,
  unknown,
  unknown,
  TriggerExecutionContext
>;

/**
 * Why: Gives the dispatcher an erased workflow-run member with lifecycle state visible to its handler.
 * Use: It participates in the closed `AnyWorkflowInvocation` union used by the internal executor.
 */
type AnyWorkflowRunInvocation = WorkflowInvocation<
  "workflow.run",
  WorkflowNode<"weft.workflow">,
  unknown,
  unknown
> &
  WorkflowRunInvocationState;

/**
 * Why: Closes the node-backed execution surface over every current definition, inline agent, and UI mode.
 * Use: Constrain the definition dispatcher; primitive context effects remain a separate host/journal layer.
 */
export type AnyWorkflowInvocation =
  | AnyPromptRenderInvocation
  | AnyArtifactInvocation
  | AnyContextSourceInvocation
  | AnyPathPolicyInvocation
  | AnyOperationInvocation
  | AnyOperationPrepareInvocation
  | AnyOperationAuthorizeInvocation
  | AnyRecoverableOperationRegistrationInvocation
  | AnyRecoverableOperationExecutionInvocation
  | AnyOperationRecoveryPrepareInvocation
  | AnyOperationRecoveryInvocation
  | AnyObserverInvocation
  | AnyReviewInvocation
  | AnyDeliveryPrepareInvocation
  | AnyDeliveryAuthorizeInvocation
  | AnyDeliveryRunInvocation
  | AnyCheckInvocation
  | AnyCheckWaiverAuthorizationInvocation
  | AnyCheckSuiteInvocation
  | AnyAgentInvocation
  | AnyGoalEvaluationInvocation
  | AnyUiRequestInvocation
  | AnyUiRenderInvocation
  | AnyTaskContractInvocation
  | AnyTriggerAdmissionInvocation
  | AnyWorkflowRunInvocation;

/**
 * Why: Provides one internal execution entrypoint while preserving the exact result carried by each bound invocation.
 * Use: Context methods bind their semantic request first, then delegate the resulting invocation to `execute`.
 */
export interface InternalEngine {
  execute<const Invocation extends AnyWorkflowInvocation>(
    invocation: Invocation,
  ): Promise<WorkflowInvocationOutput<Invocation>>;
}

/**
 * Why: Represents the single declaration-only internal executor used to demonstrate convergence of all invocation kinds.
 * Use: Import it only in internal prototypes or compile-time examples; public workflow authors keep using `ctx.*` APIs.
 */
export declare const internalEngine: InternalEngine;
