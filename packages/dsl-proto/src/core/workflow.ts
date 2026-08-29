/** Declaration-only workflow surface for the Weft DSL prototype. */
import type { AgentExecutionOptions, AgentFn, PatchRef, RecipeDefinition } from "./agent.ts";
import type { ArtifactFn } from "./artifacts.ts";
import type { CheckFn } from "./checks.ts";
import type { ParallelFn, Pipeline, SequenceFn } from "./composition.ts";
import type { ContextFn } from "./context-sources.ts";
import type { DeliveryFn } from "./deliveries.ts";
import type {
  BashFn,
  EnvApi,
  ExecFn,
  FetchFn,
  FsApi,
  GitApi,
  GitReadApi,
  PollOptions,
  SecretHandle,
} from "./effects.ts";
import type { HumanApi, UiApi } from "./human.ts";
import type { ObserverFn } from "./observers.ts";
import type { OperationFn } from "./operations.ts";
import type { PathPolicyApi } from "./path-policies.ts";
import type { ReviewFn } from "./reviews.ts";
import type {
  AnySchema,
  Duration,
  EvidenceRef,
  HostBinding,
  InferIn,
  InferOut,
  Provider,
  Settled,
  WorkflowNode,
  WorkspaceSnapshotRef,
} from "./shared.ts";
import type { AgentTaskAccess, TaskContract, WorkflowTasksApi } from "./tasks.ts";
import type { TriggerRunProvenance } from "./triggers.ts";
import type {
  ActiveWorkspaceApi,
  GateRequest,
  GateResult,
  IntegrateOptions,
  IntegrationLedger,
  NestedWorkspaceApi,
  NoteInput,
} from "./workspace.ts";

// ---------------------------------------------------------------------------
// Workflow definitions and context
// ---------------------------------------------------------------------------

/**
 * Why: Makes accumulated and remaining token or cost limits visible to orchestration decisions.
 * Use: Read it from `ctx.budget` before choosing optional or expensive work.
 */
export interface BudgetView {
  spent: BudgetSpent;
  remaining: BudgetRemaining;
}

/**
 * Why: Gives the workflow DSL an explicit budget spent contract instead of relying on untyped values.
 * Use: Import it when declaring, configuring, or consuming the corresponding workflow API.
 */
export interface BudgetSpent {
  tokens: number;
  usd: number;
}

/**
 * Why: Gives the workflow DSL an explicit budget remaining contract instead of relying on untyped values.
 * Use: Import it when declaring, configuring, or consuming the corresponding workflow API.
 */
export interface BudgetRemaining {
  tokens: number | null;
  usd: number | null;
}

/**
 * Why: Gives the workflow DSL an explicit parallel scope defaults contract instead of relying on untyped values.
 * Use: Import it when declaring, configuring, or consuming the corresponding workflow API.
 */
export interface ParallelScopeDefaults {
  concurrency?: number;
  errors?: "settle" | "throw";
}

/**
 * Why: Gives the workflow DSL an explicit budget limits contract instead of relying on untyped values.
 * Use: Import it when declaring, configuring, or consuming the corresponding workflow API.
 */
export interface BudgetLimits {
  tokens?: number;
  usd?: number;
}

/**
 * Why: Gives the workflow DSL an explicit child workflow budget contract instead of relying on untyped values.
 * Use: Import it when declaring, configuring, or consuming the corresponding workflow API.
 */
export interface ChildWorkflowBudget extends BudgetLimits {
  fraction?: number;
}

/**
 * Why: Gives the workflow DSL an explicit run info contract instead of relying on untyped values.
 * Use: Import it when declaring, configuring, or consuming the corresponding workflow API.
 */
export interface RunInfo {
  id: string;
  cwd: string;
  baseRef?: string;
  depth: number;
  trigger?: TriggerRunProvenance;
}

/**
 * Why: Gives the workflow DSL an explicit ctx scope options contract instead of relying on untyped values.
 * Use: Import it when declaring, configuring, or consuming the corresponding workflow API.
 */
export interface CtxScopeOptions {
  agent?: Omit<AgentExecutionOptions, "key" | "label" | "write" | "goal" | "onError" | "tasks">;
  tasks?: false | AgentTaskAccess;
  parallel?: ParallelScopeDefaults;
  budget?: BudgetLimits;
  /** Prefixes every durable effect key bound through the returned scope and composes with nested prefixes. */
  keyPrefix?: string;
}

/**
 * Why: Gives the workflow DSL an explicit sub workflow options contract instead of relying on untyped values.
 * Use: Import it when declaring, configuring, or consuming the corresponding workflow API.
 */
export interface SubWorkflowOptions {
  key?: string;
  label?: string;
  budget?: ChildWorkflowBudget;
}

/**
 * Why: Gives the workflow DSL an explicit signal options contract instead of relying on untyped values.
 * Use: Import it when declaring, configuring, or consuming the corresponding workflow API.
 */
export interface SignalOptions {
  timeout?: Duration;
}

/**
 * Why: Distinguishes intentional terminal cancellation from worker loss, shutdown, and resumable interruption.
 * Use: Inspect the engine-minted reason for diagnostics; never convert a cancelled run into successful output.
 */
export type RunCancellationKind = "caller" | "parent" | "deadline" | "policy";

/**
 * Why: Prevents workflow input or caught errors from masquerading as the engine's terminal cancellation decision.
 * Use: Receive it from `ctx.cancellation.reason` after the engine admits cancellation.
 */
declare const runCancellationReasonBrand: unique symbol;

/**
 * Why: Carries the durable identity and cause of an engine-admitted terminal cancellation.
 * Use: Record it in diagnostics while allowing the engine to retain terminal-state authority.
 */
export interface RunCancellationReason {
  readonly kind: RunCancellationKind;
  readonly ref: string;
  readonly requestedAt: string;
  readonly detail?: string;
  readonly [runCancellationReasonBrand]: true;
}

/**
 * Why: Gives cooperative workflow code a standard cancellation signal without making cleanup callbacks authoritative.
 * Use: Pass `signal` to local work and call `throwIfRequested`; catching it cannot change the engine's cancelled state.
 */
export interface WorkflowCancellation {
  readonly signal: AbortSignal;
  readonly reason: RunCancellationReason | undefined;
  throwIfRequested(): void;
}

/**
 * Why: Prevents copied child IDs and digests from masquerading as the exact child invocation observed by the engine.
 * Use: Receive it from `ctx.workflow.detailed` and retain it as the attestation subject for downstream evidence.
 */
declare const workflowRunSubjectBrand: unique symbol;

/**
 * Why: Identifies one exact parent-to-child invocation independently from whether the child owned a workspace.
 * Use: Carry it unchanged with its receipt; workspace authority, when present, remains a separate nominal snapshot.
 */
export interface WorkflowRunSubject<
  Definition extends WorkflowDefinition<any, any, any, any, any, any, any> = WorkflowDefinition<
    any,
    any,
    any,
    any,
    any,
    any,
    any
  >,
> {
  readonly parentRunId: string;
  readonly childRunId: string;
  readonly definitionDigest: string;
  readonly inputDigest: string;
  readonly [workflowRunSubjectBrand]: Definition;
}

/**
 * Why: Prevents workflow-authored correlation fields from claiming engine-observed child-run lineage.
 * Use: Read it from a detailed receipt and verify it through the accompanying nominal EvidenceRef attestation.
 */
declare const workflowRunProvenanceBrand: unique symbol;

/**
 * Why: Records the resolved invocation key, exact digests, lifecycle timestamps, and optional child workspace subject.
 * Use: Audit a child result without treating a plain child as if it created workspace authority.
 */
export interface WorkflowRunProvenance<
  Definition extends WorkflowDefinition<any, any, any, any, any, any, any> = WorkflowDefinition<
    any,
    any,
    any,
    any,
    any,
    any,
    any
  >,
> {
  readonly parentRunId: string;
  readonly childRunId: string;
  readonly invocationKey: string;
  readonly definitionDigest: string;
  readonly inputDigest: string;
  readonly outputDigest: string;
  readonly workspace: WorkflowRunWorkspaceOf<Definition>;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly [workflowRunProvenanceBrand]: Definition;
}

/**
 * Why: Prevents a validated output-shaped object from claiming nominal child-run evidence or workspace provenance.
 * Use: Obtain it only from `ctx.workflow.detailed`; use `value` for domain data and retain the rest as evidence.
 */
declare const workflowRunReceiptBrand: unique symbol;

/**
 * Why: Returns validated child output with exact invocation identity, digests, optional workspace, and attestation.
 * Use: Prefer it when a parent must prove child lineage or preserve a child-owned workspace subject downstream.
 */
export interface WorkflowRunReceipt<
  Definition extends WorkflowDefinition<any, any, any, any, any, any, any>,
> {
  readonly value: InferWorkflowOutput<Definition>;
  readonly childRunId: string;
  readonly definitionDigest: string;
  readonly inputDigest: string;
  readonly outputDigest: string;
  readonly workspace: WorkflowRunWorkspaceOf<Definition>;
  readonly subject: WorkflowRunSubject<Definition>;
  readonly provenance: WorkflowRunProvenance<Definition>;
  readonly attestation: EvidenceRef<
    "workflow-run",
    WorkflowRunProvenance<Definition>,
    WorkflowRunSubject<Definition>
  >;
  readonly [workflowRunReceiptBrand]: Definition;
}

/**
 * Why: Preserves output-only child calls while exposing an exact-definition path for nominal child-run evidence.
 * Use: Call it directly for validated output, or use `.detailed` when downstream work needs trustworthy lineage.
 */
export interface WorkflowFn {
  <Definition extends WorkflowDefinition<any, any, any, any, any, any, any>>(
    definition: Definition,
    input: InferWorkflowInput<Definition>,
    opts?: SubWorkflowOptions,
  ): Promise<InferWorkflowOutput<Definition>>;
  detailed<Definition extends WorkflowDefinition<any, any, any, any, any, any, any>>(
    definition: Definition,
    input: InferWorkflowInput<Definition>,
    opts?: SubWorkflowOptions,
  ): Promise<WorkflowRunReceipt<Definition>>;
}

/**
 * Why: Centralizes every durable effect so replay can identify, validate, and resume workflow work.
 * Use: The engine passes it to workflow and recipe callbacks; call its methods instead of ambient side effects.
 */
export interface Ctx<
  TaskExtensionInput = unknown,
  TaskExtensions = TaskExtensionInput,
  Workspace extends boolean = false,
> {
  agent: AgentFn<Workspace>;
  artifact: ArtifactFn;
  context: ContextFn;
  parallel: ParallelFn;
  sequence: SequenceFn<TaskExtensionInput, TaskExtensions, Workspace>;
  pipeline<Item>(items: ReadonlyArray<Item>): Pipeline<Item, Item>;
  successes<T>(settled: ReadonlyArray<Settled<T>>): T[];
  all<T>(settled: ReadonlyArray<Settled<T>>): T[];
  recipe<Input, Output, ParsedInput, RawOutput>(
    definition: RecipeDefinition<Input, Output, ParsedInput, RawOutput>,
    input: Input,
  ): Promise<Output>;
  workflow: WorkflowFn;
  scope(opts: CtxScopeOptions): Ctx<TaskExtensionInput, TaskExtensions, Workspace>;
  phase(name: string): Ctx<TaskExtensionInput, TaskExtensions, Workspace>;
  phase<Result>(
    name: string,
    run: (ctx: Ctx<TaskExtensionInput, TaskExtensions, Workspace>) => Promise<Result> | Result,
  ): Promise<Result>;
  gate(req: GateRequest): Promise<GateResult>;
  human: HumanApi;
  observe: ObserverFn;
  operation: OperationFn;
  paths: PathPolicyApi;
  ui: UiApi;
  fs: FsApi;
  exec: ExecFn;
  bash: BashFn;
  fetch: FetchFn;
  env: EnvApi;
  secret(name: string): SecretHandle;
  git: Workspace extends true ? GitApi : GitReadApi;
  check: CheckFn;
  review: ReviewFn;
  delivery: DeliveryFn;
  integrate(patches: ReadonlyArray<PatchRef>, opts?: IntegrateOptions): Promise<IntegrationLedger>;
  discard(patches: ReadonlyArray<PatchRef>): Promise<void>;
  note(note: NoteInput): Promise<void>;
  tasks: WorkflowTasksApi<TaskExtensionInput, TaskExtensions>;
  workspace: Workspace extends true
    ? ActiveWorkspaceApi<TaskExtensionInput, TaskExtensions>
    : NestedWorkspaceApi<TaskExtensionInput, TaskExtensions>;
  poll<S extends AnySchema>(opts: PollOptions<S>): Promise<InferOut<S>>;
  signal<S extends AnySchema>(name: string, schema: S, opts?: SignalOptions): Promise<InferOut<S>>;
  cancellation: WorkflowCancellation;
  sleep(duration: Duration): Promise<void>;
  now(): Promise<number>;
  random(): Promise<number>;
  uuid(): Promise<string>;
  log(message: string): void;
  budget: BudgetView;
  run: RunInfo;
}

/**
 * Why: Gives the workflow DSL an explicit workflow workspace contract instead of relying on untyped values.
 * Use: Import it when declaring, configuring, or consuming the corresponding workflow API.
 */
export interface WorkflowWorkspaceFactoryInput<Input> {
  input: Input;
}

/**
 * Why: Selects one host-authorized saved project without treating caller-controlled repository text as authority.
 * Use: Put it in `WorkflowWorkspaceConfig.target`; the binding selects the project and `repository` declares the identity the host must verify.
 */
export interface WorkflowWorkspaceTarget {
  readonly binding: HostBinding;
  readonly repository: string;
}

/**
 * Why: Gives the workflow DSL an explicit workflow workspace config contract instead of relying on untyped values.
 * Use: Import it when declaring, configuring, or consuming the corresponding workflow API.
 */
export interface WorkflowWorkspaceConfig {
  branch?: string;
  from?: string;
  target?: WorkflowWorkspaceTarget;
}

/**
 * Why: Gives the workflow DSL an explicit workflow workspace factory contract instead of relying on untyped values.
 * Use: Import it when declaring, configuring, or consuming the corresponding workflow API.
 */
export type WorkflowWorkspaceFactory<Input> = (
  args: WorkflowWorkspaceFactoryInput<Input>,
) => WorkflowWorkspaceConfig;

/**
 * Why: Gives the workflow DSL an explicit workflow workspace contract instead of relying on untyped values.
 * Use: Import it when declaring, configuring, or consuming the corresponding workflow API.
 */
export type WorkflowWorkspace<Input> = true | WorkflowWorkspaceFactory<Input>;

/**
 * Why: Gives the workflow DSL an explicit workflow defaults contract instead of relying on untyped values.
 * Use: Import it when declaring, configuring, or consuming the corresponding workflow API.
 */
export interface WorkflowDefaults {
  provider?: Provider;
}

/**
 * Why: Collects the schemas, identity, defaults, tasks, UI, and workspace policy needed before a run starts.
 * Use: Pass it as the first argument to `defineWorkflow`.
 */
export interface WorkflowMeta<
  InS extends AnySchema,
  OutS extends AnySchema,
  Tasks extends TaskContract<any> | undefined = undefined,
  Workspace extends WorkflowWorkspace<InferOut<InS>> | undefined = undefined,
  Id extends string = string,
> {
  id: Id;
  name?: string;
  description?: string;
  input: InS;
  output: OutS;
  defaults?: WorkflowDefaults;
  tasks?: Tasks;
  workspace?: Workspace;
  status?: (value: unknown) => unknown;
  report?: (value: unknown) => unknown;
  ui?: unknown;
}

/**
 * Why: Carries a fully typed workflow contract that registries and child-workflow calls can inspect.
 * Use: Export the value returned by `defineWorkflow` or pass it to `ctx.workflow`.
 */
export interface WorkflowDefinition<
  Input = unknown,
  Output = unknown,
  TaskExtensions = unknown,
  RawInput = Input,
  TaskExtensionInput = TaskExtensions,
  InputSchema extends AnySchema = AnySchema,
  OutputSchema extends AnySchema = AnySchema,
  OwnsWorkspace extends boolean = boolean,
  Id extends string = string,
> extends WorkflowNode<"weft.workflow"> {
  readonly kind: "weft.workflow";
  readonly meta: WorkflowMeta<InputSchema, OutputSchema, any, any, Id>;
  readonly run: (ctx: Ctx<any, any, any>, input: Input) => Promise<Output>;
  readonly __input?: RawInput;
  readonly __output?: Output;
  readonly __taskExtensions?: TaskExtensions;
  readonly __taskExtensionInput?: TaskExtensionInput;
  readonly __ownsWorkspace?: OwnsWorkspace;
}

/**
 * Why: Recovers the stable literal identity retained by an exact workflow definition.
 * Use: Key registries and provenance-aware tooling from the definition instead of repeating its ID.
 */
export type WorkflowIdOf<Definition> =
  Definition extends WorkflowDefinition<any, any, any, any, any, any, any, any, infer Id> ? Id : never;

/**
 * Why: Names the minimal phantom metadata needed to recover whether one workflow definition owns a workspace.
 * Use: Keep workspace ownership available to detailed child-run receipts without exposing implementation state.
 */
interface WorkflowWorkspaceModeCarrier<OwnsWorkspace extends boolean> {
  readonly __ownsWorkspace?: OwnsWorkspace;
}

/**
 * Why: Recovers the exact workspace-ownership mode retained by a workflow definition.
 * Use: Distinguish plain child runs from workspace-owning child runs in generic orchestration helpers.
 */
export type WorkflowWorkspaceModeOf<Definition> =
  Definition extends WorkflowWorkspaceModeCarrier<infer OwnsWorkspace> ? OwnsWorkspace : boolean;

/**
 * Why: Makes a detailed child receipt expose workspace authority only when its exact definition owns a workspace.
 * Use: Plain workflows produce `undefined`; workspace workflows produce a nominal `WorkspaceSnapshotRef`.
 */
export type WorkflowRunWorkspaceOf<Definition> =
  WorkflowWorkspaceModeOf<Definition> extends infer OwnsWorkspace extends boolean
    ? OwnsWorkspace extends true
      ? WorkspaceSnapshotRef
      : undefined
    : never;

/**
 * Why: Names the minimal metadata projection needed to recover one workflow input schema.
 * Use: Keep schema extraction structural without introducing an anonymous declaration shape.
 */
interface WorkflowInputSchemaMeta<InputSchema extends AnySchema> {
  readonly input: InputSchema;
}

/**
 * Why: Recovers the exact runtime input schema retained on a workflow definition's metadata.
 * Use: Build schema-aware inspectors and validated registries without widening the schema to `AnySchema`.
 */
interface WorkflowInputSchemaCarrier<InputSchema extends AnySchema> {
  readonly meta: WorkflowInputSchemaMeta<InputSchema>;
}

/**
 * Why: Recovers the exact runtime input schema carried by a workflow definition.
 * Use: Apply it to a concrete definition when tooling needs both its raw and validated schema types.
 */
export type WorkflowInputSchemaOf<Definition> =
  Definition extends WorkflowInputSchemaCarrier<infer InputSchema> ? InputSchema : never;

/**
 * Why: Names the minimal metadata projection needed to recover one workflow output schema.
 * Use: Keep schema extraction structural without introducing an anonymous declaration shape.
 */
interface WorkflowOutputSchemaMeta<OutputSchema extends AnySchema> {
  readonly output: OutputSchema;
}

/**
 * Why: Recovers the exact runtime output schema retained on a workflow definition's metadata.
 * Use: Build schema-aware inspectors and validated registries without widening the schema to `AnySchema`.
 */
interface WorkflowOutputSchemaCarrier<OutputSchema extends AnySchema> {
  readonly meta: WorkflowOutputSchemaMeta<OutputSchema>;
}

/**
 * Why: Recovers the exact runtime output schema carried by a workflow definition.
 * Use: Apply it to a concrete definition when tooling needs its validated output contract.
 */
export type WorkflowOutputSchemaOf<Definition> =
  Definition extends WorkflowOutputSchemaCarrier<infer OutputSchema> ? OutputSchema : never;

/**
 * Why: Recovers the raw input type carried by a workflow definition for callers and test harnesses.
 * Use: Apply it to a `WorkflowDefinition` type when deriving launch inputs.
 */
interface WorkflowInputCarrier<Input> {
  readonly __input?: Input;
}

/**
 * Why: Recovers the raw input type carried by a workflow definition for callers and test harnesses.
 * Use: Apply it to a `WorkflowDefinition` type when deriving launch inputs.
 */
export type InferWorkflowInput<Definition> =
  Definition extends WorkflowInputCarrier<infer Input> ? Input : never;

/**
 * Why: Recovers the validated output type carried by a workflow definition.
 * Use: Apply it to a `WorkflowDefinition` type when consuming child-run or test results.
 */
interface WorkflowOutputCarrier<Output> {
  readonly __output?: Output;
}

/**
 * Why: Recovers the validated output type carried by a workflow definition.
 * Use: Apply it to a `WorkflowDefinition` type when consuming child-run or test results.
 */
export type InferWorkflowOutput<Definition> =
  Definition extends WorkflowOutputCarrier<infer Output> ? Output : never;

/**
 * Why: Centralizes the internal task input of relationship so adjacent public declarations infer consistently.
 * Use: It is used by the surrounding workflow types and is not a separate runtime feature.
 */
type TaskInputOf<Tasks> = Tasks extends TaskContract<infer S extends AnySchema> ? InferIn<S> : unknown;
/**
 * Why: Centralizes the internal task output of relationship so adjacent public declarations infer consistently.
 * Use: It is used by the surrounding workflow types and is not a separate runtime feature.
 */
type TaskOutputOf<Tasks> = Tasks extends TaskContract<infer S extends AnySchema> ? InferOut<S> : unknown;

/**
 * Why: Gives the workflow DSL an explicit plain workflow meta contract instead of relying on untyped values.
 * Use: Import it when declaring, configuring, or consuming the corresponding workflow API.
 */
export interface PlainWorkflowMeta<
  InS extends AnySchema,
  OutS extends AnySchema,
  Tasks extends TaskContract<any> | undefined,
  Id extends string = string,
> extends WorkflowMeta<InS, OutS, Tasks, undefined, Id> {
  workspace?: undefined;
}

/**
 * Why: Gives the workflow DSL an explicit workspace workflow meta contract instead of relying on untyped values.
 * Use: Import it when declaring, configuring, or consuming the corresponding workflow API.
 */
export interface WorkspaceWorkflowMeta<
  InS extends AnySchema,
  OutS extends AnySchema,
  Tasks extends TaskContract<any> | undefined,
  Workspace extends WorkflowWorkspace<InferOut<InS>>,
  Id extends string = string,
> extends WorkflowMeta<InS, OutS, Tasks, Workspace, Id> {
  workspace: Workspace;
}

/**
 * Why: Declares the durable schema boundary and typed program body for one workflow.
 * Use: Use the plain or workspace overload at module scope and export the resulting definition.
 */
export declare function defineWorkflow<
  InS extends AnySchema,
  OutS extends AnySchema,
  Tasks extends TaskContract<any> | undefined = undefined,
  const Id extends string = string,
>(
  meta: PlainWorkflowMeta<InS, OutS, Tasks, Id>,
  run: (
    ctx: Ctx<TaskInputOf<Tasks>, TaskOutputOf<Tasks>, false>,
    input: InferOut<InS>,
  ) => Promise<InferIn<OutS>>,
): WorkflowDefinition<
  InferOut<InS>,
  InferOut<OutS>,
  TaskOutputOf<Tasks>,
  InferIn<InS>,
  TaskInputOf<Tasks>,
  InS,
  OutS,
  false,
  Id
>;

/**
 * Why: Declares the durable schema boundary and typed program body for one workflow.
 * Use: Use the plain or workspace overload at module scope and export the resulting definition.
 */
export declare function defineWorkflow<
  InS extends AnySchema,
  OutS extends AnySchema,
  Tasks extends TaskContract<any> | undefined = undefined,
  Workspace extends WorkflowWorkspace<InferOut<InS>> = WorkflowWorkspace<InferOut<InS>>,
  const Id extends string = string,
>(
  meta: WorkspaceWorkflowMeta<InS, OutS, Tasks, Workspace, Id>,
  run: (
    ctx: Ctx<TaskInputOf<Tasks>, TaskOutputOf<Tasks>, true>,
    input: InferOut<InS>,
  ) => Promise<InferIn<OutS>>,
): WorkflowDefinition<
  InferOut<InS>,
  InferOut<OutS>,
  TaskOutputOf<Tasks>,
  InferIn<InS>,
  TaskInputOf<Tasks>,
  InS,
  OutS,
  true,
  Id
>;
