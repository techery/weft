/** Declaration-only internal execution model for the Weft DSL prototype. */

import type {
  AgentDefinition,
  AgentResult,
  AnyDefinedAgentCall,
  GoalInvocationBase,
  PatchAgentResult,
  RecipeDefinition,
  WorkspaceWriteAgentResult,
  WriteScope,
} from "./agent.ts";
import type { ArtifactCaptureInputOf, ArtifactCaptureOptions, ArtifactRefOf } from "./artifacts.ts";
import type {
  CheckDefinition,
  CheckInvocationOptions,
  CheckResultOf,
  CheckSuiteDefinition,
  CheckSuiteInvocationOptions,
  CheckSuiteResult,
} from "./checks.ts";
import type { GoalDefinition, GoalResult, WorkspaceSubject } from "./goals.ts";
import type { UiViewRef } from "./human.ts";
import type {
  ObserverInputOf,
  ObserverInvocationOptions,
  ObserverInvocationOptionsOf,
  ObserverOutputOf,
} from "./observers.ts";
import type { OperationInputOf, OperationInvocationOptions, OperationOutputOf } from "./operations.ts";
import type { AnySchema, InferOut, PromptDefinition, WorkflowNode } from "./shared.ts";
import type { TaskContract } from "./tasks.ts";
import type { InferWorkflowInput, InferWorkflowOutput } from "./workflow.ts";

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
  | "check-suite.run"
  | "goal.evaluate"
  | "observer.wait"
  | "operation.run"
  | "prompt.render"
  | "recipe.run"
  | "task-contract.apply"
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
  subject?: WorkspaceSubject;
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
> {
  readonly kind: Kind;
  readonly node: Node;
  readonly key: string;
  readonly input: Input;
  readonly context: WorkflowExecutionContext;
  readonly [workflowInvocationBrand]: WorkflowInvocationTypes<Input, Output>;
}

/**
 * Why: Recovers the concrete input carried by any bound invocation without inspecting its definition kind.
 * Use: Apply it in handlers, tests, and adapters that need the exact input accepted by an invocation.
 */
export type WorkflowInvocationInput<Invocation> =
  Invocation extends WorkflowInvocation<WorkflowInvocationKind, WorkflowNode, infer Input, unknown>
    ? Input
    : never;

/**
 * Why: Recovers the concrete result promised by an invocation so the generic executor does not erase it to `unknown`.
 * Use: Use it as the resolved type of `InternalEngine.execute` and specialized internal handlers.
 */
export type WorkflowInvocationOutput<Invocation> =
  Invocation extends WorkflowInvocation<WorkflowInvocationKind, WorkflowNode, unknown, infer Output>
    ? Output
    : never;

// ---------------------------------------------------------------------------
// Prompt, recipe, check, and suite invocations
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
 * Why: Recovers the raw input carried by a schema-backed recipe definition.
 * Use: It supplies the input side of `RecipeInvocation` without widening the recipe result.
 */
export type RecipeDefinitionInput<Node> =
  Node extends RecipeDefinition<infer Input, infer _Output, infer _ParsedInput, infer _RawOutput>
    ? Input
    : never;

/**
 * Why: Recovers the validated output carried by a schema-backed recipe definition.
 * Use: It supplies the output side of `RecipeInvocation` after the recipe's output boundary validates.
 */
export type RecipeDefinitionOutput<Node> =
  Node extends RecipeDefinition<infer _Input, infer Output, infer _ParsedInput, infer _RawOutput>
    ? Output
    : never;

/**
 * Why: Models transparent recipe composition as a typed input-to-output operation in the current run.
 * Use: Create it behind `ctx.recipe`, sequence, or parallel composition before generic execution.
 */
export type RecipeInvocation<Node extends WorkflowNode<"weft.recipe">> = WorkflowInvocation<
  "recipe.run",
  Node,
  RecipeDefinitionInput<Node>,
  RecipeDefinitionOutput<Node>
>;

/**
 * Why: Recovers the raw invocation input declared by a reusable deterministic check.
 * Use: It supplies the input side of `CheckInvocation`, including `void` for static checks.
 */
export type CheckDefinitionInput<Node> =
  Node extends CheckDefinition<infer Input, infer _Name, infer _ParsedInput, infer _Result> ? Input : never;

/**
 * Why: Adds check-specific policy overrides to the generic bound invocation without changing its domain input.
 * Use: The check binder copies `ctx.check` invocation options into this state for the check handler.
 */
export interface CheckInvocationState {
  readonly options?: CheckInvocationOptions;
}

/**
 * Why: Models one deterministic check as typed input translated into structured, generation-aware evidence.
 * Use: Create it behind `ctx.check` or while expanding a goal component.
 */
export type CheckInvocation<Node extends WorkflowNode<"weft.check">> = WorkflowInvocation<
  "check.run",
  Node,
  CheckDefinitionInput<Node>,
  CheckResultOf<Node>
> &
  CheckInvocationState;

/**
 * Why: Recovers the raw input declared by a parameterized check suite.
 * Use: It supplies the input side of `CheckSuiteInvocation`, including `void` for a static suite.
 */
export type CheckSuiteDefinitionInput<Node> =
  Node extends CheckSuiteDefinition<infer Input, infer _Members, infer _ParsedInput> ? Input : never;

/**
 * Why: Recovers the member map whose names and result types must remain visible after suite execution.
 * Use: It supplies the result side of `CheckSuiteInvocation`.
 */
export type CheckSuiteDefinitionMembers<Node> =
  Node extends CheckSuiteDefinition<infer _Input, infer Members, infer _ParsedInput> ? Members : never;

/**
 * Why: Adds suite concurrency and policy overrides to its bound invocation.
 * Use: The suite binder copies `ctx.check` options here before the engine expands member checks.
 */
export interface CheckSuiteInvocationState {
  readonly options?: CheckSuiteInvocationOptions;
}

/**
 * Why: Models a named check suite as typed input translated into independently visible member results.
 * Use: Create it behind the suite overload of `ctx.check` or while expanding a goal.
 */
export type CheckSuiteInvocation<Node extends WorkflowNode<"weft.check-suite">> = WorkflowInvocation<
  "check-suite.run",
  Node,
  CheckSuiteDefinitionInput<Node>,
  CheckSuiteResult<CheckSuiteDefinitionMembers<Node>>
> &
  CheckSuiteInvocationState;

// ---------------------------------------------------------------------------
// Artifact, operation, and observer invocations
// ---------------------------------------------------------------------------

/**
 * Why: Carries capture identity and presentation metadata beside an artifact's schema-derived content input.
 * Use: The artifact handler reads it when storing content and producing the immutable reference.
 */
export interface ArtifactInvocationState {
  readonly options: ArtifactCaptureOptions;
}

/**
 * Why: Models artifact capture as validated content and metadata translated into an immutable typed reference.
 * Use: Create it behind `ctx.artifact` before delegating storage to the generic executor.
 */
export type ArtifactInvocation<Node extends WorkflowNode<"weft.artifact">> = WorkflowInvocation<
  "artifact.capture",
  Node,
  ArtifactCaptureInputOf<Node>,
  ArtifactRefOf<Node>
> &
  ArtifactInvocationState;

/**
 * Why: Carries per-call authorization and retry limits beside an operation's schema-derived domain input.
 * Use: The operation handler merges it with definition defaults and host policy before execution.
 */
export interface OperationInvocationState {
  readonly options: OperationInvocationOptions;
}

/**
 * Why: Models an authorized atomic operation as typed input translated into a validated integration result.
 * Use: Create it behind `ctx.operation` before invoking the generic executor.
 */
export type OperationInvocation<Node extends WorkflowNode<"weft.operation">> = WorkflowInvocation<
  "operation.run",
  Node,
  OperationInputOf<Node>,
  OperationOutputOf<Node>
> &
  OperationInvocationState;

/**
 * Why: Carries durable identity and wait overrides beside an observer's schema-derived lookup input.
 * Use: The observer handler merges it with source configuration and definition defaults.
 */
export interface ObserverInvocationState<
  Options extends ObserverInvocationOptions = ObserverInvocationOptions,
> {
  readonly options: Options;
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
  ObserverInvocationState<ObserverInvocationOptionsOf<Node>>;

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
export type AgentValueOf<Call extends AnyDefinedAgentCall> =
  Call["agent"] extends AgentDefinition<infer _Input, infer Schema, infer _ParsedInput>
    ? InferOut<Schema>
    : never;

/**
 * Why: Names the structural carrier used to detect a goal attached to an agent invocation.
 * Use: It lets `AgentGoalOf` infer accepted goal evidence without using an inline object type.
 */
interface AgentGoalCarrier<Definition extends GoalDefinition<unknown, unknown, unknown>> {
  goal: GoalInvocationBase<Definition>;
}

/**
 * Why: Recovers the accepted goal result only when the concrete agent call attaches a goal definition.
 * Use: It controls whether the agent result contains a required `goal` field.
 */
export type AgentGoalOf<Call extends AnyDefinedAgentCall> =
  Call extends AgentGoalCarrier<infer Definition>
    ? Definition extends GoalDefinition<unknown, infer Results, unknown>
      ? GoalResult<Results>
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
 * Why: Names the structural carrier used to detect deliberately nullable agent failure policy.
 * Use: It lets the result type add `null` only when the concrete call requests `onError: "null"`.
 */
interface NullableAgentCarrier {
  onError: "null";
}

/**
 * Why: Selects the correct patch semantics from the concrete agent call and its bound workspace mode.
 * Use: It forms the non-null result side of `AgentInvocationOutput`.
 */
export type AgentInvocationEnvelope<
  Call extends AnyDefinedAgentCall,
  Workspace extends boolean,
> = Call extends AgentWriteCarrier
  ? Workspace extends true
    ? WorkspaceWriteAgentResult<AgentValueOf<Call>, AgentGoalOf<Call>>
    : PatchAgentResult<AgentValueOf<Call>, AgentGoalOf<Call>>
  : AgentResult<AgentValueOf<Call>, AgentGoalOf<Call>>;

/**
 * Why: Preserves nullable failure behavior as part of the invocation's exact output rather than the reusable agent node.
 * Use: It is the output extracted when `InternalEngine.execute` receives a defined-agent invocation.
 */
export type AgentInvocationOutput<
  Call extends AnyDefinedAgentCall,
  Workspace extends boolean,
> = Call extends NullableAgentCarrier
  ? AgentInvocationEnvelope<Call, Workspace> | null
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
  subject: WorkspaceSubject;
  owner: GoalOwnerSession;
}

/**
 * Why: Recovers the domain input expected by a named goal definition.
 * Use: It specializes `GoalEvaluationInput` for the selected goal node.
 */
export type GoalDefinitionInput<Node> =
  Node extends GoalDefinition<infer Input, infer _Results, infer _ParsedInput> ? Input : never;

/**
 * Why: Recovers the accepted component result map produced by a named goal definition.
 * Use: It specializes the final `GoalResult` returned by goal execution.
 */
export type GoalDefinitionResults<Node> =
  Node extends GoalDefinition<infer _Input, infer Results, infer _ParsedInput> ? Results : never;

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
 * Why: Names the raw extension payload and optional source version needed to validate or migrate a task contract.
 * Use: Bind it when a workflow reads or writes durable task extensions across a contract version boundary.
 */
export interface TaskContractInvocationInput {
  extensions: unknown;
  fromVersion?: number;
}

/**
 * Why: Recovers the schema-validated extension type produced by a task contract.
 * Use: It supplies the output side of `TaskContractInvocation`.
 */
export type TaskContractOutput<Node> =
  Node extends TaskContract<infer Schema extends AnySchema> ? InferOut<Schema> : never;

/**
 * Why: Models a task contract as raw/versioned extensions translated into their current validated representation.
 * Use: Create it inside task observation and mutation boundaries rather than treating the contract as a journaled task itself.
 */
export type TaskContractInvocation<Node extends WorkflowNode<"weft.task-contract">> = WorkflowInvocation<
  "task-contract.apply",
  Node,
  TaskContractInvocationInput,
  TaskContractOutput<Node>
>;

/**
 * Why: Records whether a workflow invocation owns a root lifecycle or delegates a child run from a parent.
 * Use: The workflow handler uses it to establish the correct journal, budget, status, and task boundaries.
 */
export interface WorkflowRunInvocationState {
  readonly lifecycle: "root" | "child";
}

/**
 * Why: Models a workflow as validated launch input translated into its validated durable run output.
 * Use: Create it at the host entrypoint or behind `ctx.workflow` before generic execution.
 */
export type WorkflowRunInvocation<Node extends WorkflowNode<"weft.workflow">> = WorkflowInvocation<
  "workflow.run",
  Node,
  InferWorkflowInput<Node>,
  InferWorkflowOutput<Node>
> &
  WorkflowRunInvocationState;

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
 * Why: Gives the dispatcher an erased recipe invocation member while exact callers retain their concrete generic type.
 * Use: It participates in the closed `AnyWorkflowInvocation` union used by the internal executor.
 */
type AnyRecipeInvocation = WorkflowInvocation<"recipe.run", WorkflowNode<"weft.recipe">, unknown, unknown>;

/**
 * Why: Gives the dispatcher an erased check invocation member with the state required by its handler.
 * Use: It participates in the closed `AnyWorkflowInvocation` union used by the internal executor.
 */
type AnyCheckInvocation = WorkflowInvocation<"check.run", WorkflowNode<"weft.check">, unknown, unknown> &
  CheckInvocationState;

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
 * Why: Closes the internal execution surface over every current `define*` result and UI execution mode.
 * Use: Constrain the generic executor and exhaustively dispatch on `invocation.kind` when implementing the engine.
 */
export type AnyWorkflowInvocation =
  | AnyPromptRenderInvocation
  | AnyArtifactInvocation
  | AnyOperationInvocation
  | AnyObserverInvocation
  | AnyRecipeInvocation
  | AnyCheckInvocation
  | AnyCheckSuiteInvocation
  | AnyAgentInvocation
  | AnyGoalEvaluationInvocation
  | AnyUiRequestInvocation
  | AnyUiRenderInvocation
  | AnyTaskContractInvocation
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
