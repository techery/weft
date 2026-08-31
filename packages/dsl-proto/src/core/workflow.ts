/** Declaration-only workflow surface for the Weft DSL prototype. */
import type {
  AgentExecutionOptions,
  AgentFn,
  AnyRecipeDefinition,
  PatchRef,
  ReadOnlyAgentApi,
  RecipeInputOf,
  RecipeOutputOf,
} from "./agent.ts";
import type { ArtifactFn } from "./artifacts.ts";
import type { CheckFn } from "./checks.ts";
import type { ParallelFn, Pipeline, ReviewParallelFn, SequenceFn } from "./composition.ts";
import type { ContextFn } from "./context-sources.ts";
import type { DeliveryFn } from "./deliveries.ts";
import type {
  BashFn,
  DurableEffectOptions,
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
  DefinitionTypeCarrier,
  Duration,
  EvidenceRef,
  HostBinding,
  InferIn,
  InferOut,
  NominalValue,
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
  PolicyApi,
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

/** Budget spent. */
export interface BudgetSpent {
  tokens: number;
  usd: number;
}

/** Budget remaining. */
export interface BudgetRemaining {
  tokens: number | null;
  usd: number | null;
}

/** Parallel scope defaults. */
export interface ParallelScopeDefaults {
  concurrency?: number;
}

/** Budget limits. */
export interface BudgetLimits {
  tokens?: number;
  usd?: number;
}

/** Child workflow budget. */
export interface ChildWorkflowBudget extends BudgetLimits {
  fraction?: number;
}

/** Run info. */
export interface RunInfo {
  id: string;
  cwd: string;
  baseRef?: string;
  depth: number;
  trigger?: TriggerRunProvenance;
}

/** Ctx scope options. */
export interface CtxScopeOptions {
  agent?: Omit<AgentExecutionOptions, "key" | "label" | "write" | "tasks">;
  tasks?: false | AgentTaskAccess;
  parallel?: ParallelScopeDefaults;
  budget?: BudgetLimits;
  /** Prefixes every durable effect key bound through the returned scope and composes with nested prefixes. */
  keyPrefix?: string;
}

/** Sub workflow options. */
export interface SubWorkflowOptions {
  key: string;
  label?: string;
  budget?: ChildWorkflowBudget;
}

/** Signal options. */
export interface SignalOptions {
  key: string;
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
export interface RunCancellationReason extends NominalValue<"run-cancellation-reason"> {
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
  Definition extends AnyWorkflowDefinition = AnyWorkflowDefinition,
> extends NominalValue<readonly ["workflow-run-subject", Definition]> {
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
 * Why: Records the resolved invocation key, exact digests, lifecycle timestamps, and optional child workspace snapshot.
 * Use: Audit a child result without treating a plain child as if it created workspace authority.
 */
export interface WorkflowRunProvenance<
  Definition extends AnyWorkflowDefinition = AnyWorkflowDefinition,
> extends NominalValue<readonly ["workflow-run-provenance", Definition]> {
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
 * Use: Prefer it when a parent must prove child lineage or preserve a child-owned workspace snapshot downstream.
 */
export interface WorkflowRunReceipt<
  Definition extends AnyWorkflowDefinition,
> extends NominalValue<readonly ["workflow-run-receipt", Definition]> {
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
  <Definition extends AnyWorkflowDefinition>(
    definition: Definition,
    input: InferWorkflowInput<Definition>,
    opts: SubWorkflowOptions,
  ): Promise<InferWorkflowOutput<Definition>>;
  detailed<Definition extends AnyWorkflowDefinition>(
    definition: Definition,
    input: InferWorkflowInput<Definition>,
    opts: SubWorkflowOptions,
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
  parallel: ParallelFn<TaskExtensionInput, TaskExtensions, Workspace>;
  sequence: SequenceFn<TaskExtensionInput, TaskExtensions, Workspace>;
  pipeline<Item>(items: ReadonlyArray<Item>): Pipeline<
    Item,
    Item,
    TaskExtensionInput,
    TaskExtensions,
    Workspace
  >;
  successes<T>(settled: ReadonlyArray<Settled<T>>): T[];
  all<T>(settled: ReadonlyArray<Settled<T>>): T[];
  recipe<Definition extends AnyRecipeDefinition>(
    definition: Definition,
    input: RecipeInputOf<Definition>,
  ): Promise<RecipeOutputOf<Definition>>;
  workflow: WorkflowFn;
  scope(opts: CtxScopeOptions): Ctx<TaskExtensionInput, TaskExtensions, Workspace>;
  step(key: string): Ctx<TaskExtensionInput, TaskExtensions, Workspace>;
  step<Result>(
    key: string,
    run: (ctx: Ctx<TaskExtensionInput, TaskExtensions, Workspace>) => Promise<Result> | Result,
  ): Promise<Result>;
  policy: PolicyApi;
  /** @deprecated Use `policy.decide`; a gate result is not candidate-bound authorization. */
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
  secret(name: string, opts: DurableEffectOptions): SecretHandle;
  git: Workspace extends true ? GitApi : GitReadApi;
  check: CheckFn;
  review: ReviewFn;
  delivery: DeliveryFn;
  integrate(patches: ReadonlyArray<PatchRef>, opts: IntegrateOptions): Promise<IntegrationLedger>;
  discard(patches: ReadonlyArray<PatchRef>, opts: DurableEffectOptions): Promise<void>;
  note(note: NoteInput): Promise<void>;
  tasks: WorkflowTasksApi<TaskExtensionInput, TaskExtensions>;
  workspace: Workspace extends true
    ? ActiveWorkspaceApi<TaskExtensionInput, TaskExtensions>
    : NestedWorkspaceApi<TaskExtensionInput, TaskExtensions>;
  poll<S extends AnySchema>(opts: PollOptions<S>): Promise<InferOut<S>>;
  signal<S extends AnySchema>(name: string, schema: S, opts: SignalOptions): Promise<InferOut<S>>;
  cancellation: WorkflowCancellation;
  sleep(duration: Duration, opts: DurableEffectOptions): Promise<void>;
  now(opts: DurableEffectOptions): Promise<number>;
  random(opts: DurableEffectOptions): Promise<number>;
  uuid(opts: DurableEffectOptions): Promise<string>;
  log(message: string): void;
  budget: BudgetView;
  run: RunInfo;
}

/**
 * Why: Gives ordinary workflow and recipe orchestration a concise read-only repository context name.
 * Use: Prefer it to `Ctx<..., false>` in exported helper and definition signatures.
 */
export type WorkflowCtx<TaskInput = unknown, TaskOutput = TaskInput> = Ctx<
  TaskInput,
  TaskOutput,
  false
>;

/**
 * Why: Gives workflow-owned and candidate workspaces a concise direct-write context name.
 * Use: Prefer it to `Ctx<..., true>` in helpers that intentionally require isolated workspace mutation.
 */
export type WorkspaceCtx<TaskInput = unknown, TaskOutput = TaskInput> = Ctx<
  TaskInput,
  TaskOutput,
  true
>;

/**
 * Why: Restricts reusable review evaluators to observation, read-only agents, and diagnostics rather than delivery or mutation authority.
 * Use: It is supplied to `defineReview` evaluators; consequential effects remain in the calling workflow.
 */
export interface ReviewCtx
  extends Pick<
    WorkflowCtx,
    "context" | "fs" | "observe" | "cancellation" | "log" | "budget" | "run"
  > {
  readonly agent: ReadOnlyAgentApi;
  readonly parallel: ReviewParallelFn;
  readonly git: GitReadApi;
}

/** Workflow workspace. */
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

/** Workflow workspace config. */
export interface WorkflowWorkspaceConfig {
  branch?: string;
  from?: string;
  target?: WorkflowWorkspaceTarget;
}

/** Workflow workspace factory. */
export type WorkflowWorkspaceFactory<Input> = (
  args: WorkflowWorkspaceFactoryInput<Input>,
) => WorkflowWorkspaceConfig;

/** Workflow workspace. */
export type WorkflowWorkspace<Input> = true | WorkflowWorkspaceFactory<Input>;

/** Workflow defaults. */
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
}

/** Public, inert metadata retained on a workflow definition. */
export interface WorkflowMetaView<
  InS extends AnySchema,
  OutS extends AnySchema,
  Id extends string = string,
> {
  readonly id: Id;
  readonly name?: string;
  readonly description?: string;
  readonly input: InS;
  readonly output: OutS;
  readonly defaults?: Readonly<WorkflowDefaults>;
}

/**
 * Why: Names the hidden schema, input, output, task, and workspace relationships carried by one workflow definition.
 * Use: Workflow builders construct it; authors normally consume its fields through the concise extractor types.
 */
export interface WorkflowTypes {
  readonly input: unknown;
  readonly parsedInput: unknown;
  readonly rawOutput: unknown;
  readonly output: unknown;
  readonly taskInput: unknown;
  readonly tasks: unknown;
  readonly workspace: boolean;
  readonly inputSchema: AnySchema;
  readonly outputSchema: AnySchema;
}

/**
 * Why: Carries a fully typed workflow contract through one hidden type bag without exposing its executable callback.
 * Use: Export the value returned by `defineWorkflow` or pass it to `ctx.workflow` and public extractor types.
 */
export interface WorkflowDefinition<
  Types extends WorkflowTypes = WorkflowTypes,
  Id extends string = string,
> extends WorkflowNode<"weft.workflow">,
    DefinitionTypeCarrier<Types> {
  readonly kind: "weft.workflow";
  readonly id: Id;
  readonly meta: WorkflowMetaView<Types["inputSchema"], Types["outputSchema"], Id>;
}

/**
 * Why: Names the erased workflow-definition family for registries and engine dispatch without positional generic noise.
 * Use: Prefer an exact `typeof workflow`; use this only when code intentionally accepts any workflow contract.
 */
export type AnyWorkflowDefinition = WorkflowDefinition<any, string>;

/**
 * Why: Gives exported factories a compact workflow annotation when `typeof` inference is not available at the declaration boundary.
 * Use: Prefer `typeof workflow` for concrete values; use this only for factory or registry contracts that must name a shape first.
 */
export type WorkflowContract<
  Input,
  Output,
  TaskInput = unknown,
  Tasks = TaskInput,
  Workspace extends boolean = boolean,
  Id extends string = string,
> = WorkflowDefinition<
  {
    input: Input;
    parsedInput: Input;
    rawOutput: Output;
    output: Output;
    taskInput: TaskInput;
    tasks: Tasks;
    workspace: Workspace;
    inputSchema: AnySchema;
    outputSchema: AnySchema;
  },
  Id
>;

/**
 * Why: Recovers the complete hidden type bag from one exact workflow definition.
 * Use: Prefer the narrower workflow extractors unless generic infrastructure needs several related fields.
 */
export type WorkflowTypesOf<Definition> =
  Definition extends WorkflowDefinition<infer Types, any> ? Types : never;

/**
 * Why: Recovers the stable literal identity retained by an exact workflow definition.
 * Use: Key registries and provenance-aware tooling from the definition instead of repeating its ID.
 */
export type WorkflowIdOf<Definition> =
  Definition extends WorkflowDefinition<any, infer Id> ? Id : never;

/**
 * Why: Recovers the exact workspace-ownership mode retained by a workflow definition.
 * Use: Distinguish plain child runs from workspace-owning child runs in generic orchestration helpers.
 */
export type WorkflowWorkspaceModeOf<Definition> =
  WorkflowTypesOf<Definition> extends { readonly workspace: infer OwnsWorkspace extends boolean }
    ? OwnsWorkspace
    : boolean;

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
 * Why: Recovers the exact runtime input schema carried by a workflow definition.
 * Use: Apply it to a concrete definition when tooling needs both its raw and validated schema types.
 */
export type WorkflowInputSchemaOf<Definition> =
  WorkflowTypesOf<Definition> extends { readonly inputSchema: infer InputSchema extends AnySchema }
    ? InputSchema
    : never;

/**
 * Why: Recovers the exact runtime output schema carried by a workflow definition.
 * Use: Apply it to a concrete definition when tooling needs its validated output contract.
 */
export type WorkflowOutputSchemaOf<Definition> =
  WorkflowTypesOf<Definition> extends { readonly outputSchema: infer OutputSchema extends AnySchema }
    ? OutputSchema
    : never;

/**
 * Why: Recovers the raw launch input carried by one workflow definition through its hidden type bag.
 * Use: Apply it to `typeof workflow` when naming a public workflow input type.
 */
export type WorkflowInputOf<Definition> =
  WorkflowTypesOf<Definition> extends { readonly input: infer Input } ? Input : never;

/**
 * Why: Recovers the raw input type carried by a workflow definition for callers and test harnesses.
 * Use: Apply it to a `WorkflowDefinition` type when deriving launch inputs.
 */
export type InferWorkflowInput<Definition> =
  WorkflowInputOf<Definition>;

/**
 * Why: Recovers the validated result value carried by one workflow definition through its hidden type bag.
 * Use: Apply it to `typeof workflow` when naming a public workflow output type.
 */
export type WorkflowOutputOf<Definition> =
  WorkflowTypesOf<Definition> extends { readonly output: infer Output } ? Output : never;

/**
 * Why: Recovers the validated output type carried by a workflow definition.
 * Use: Apply it to a `WorkflowDefinition` type when consuming child-run or test results.
 */
export type InferWorkflowOutput<Definition> =
  WorkflowOutputOf<Definition>;

/** Input inferred from a task contract. */
type TaskInputOf<Tasks> = Tasks extends TaskContract<infer S extends AnySchema> ? InferIn<S> : unknown;
/** Output inferred from a task contract. */
type TaskOutputOf<Tasks> = Tasks extends TaskContract<infer S extends AnySchema> ? InferOut<S> : unknown;

/** Plain workflow meta. */
export interface PlainWorkflowMeta<
  InS extends AnySchema,
  OutS extends AnySchema,
  Tasks extends TaskContract<any> | undefined,
  Id extends string = string,
> extends WorkflowMeta<InS, OutS, Tasks, undefined, Id> {
  workspace?: undefined;
}

/** Workspace workflow meta. */
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
  {
    input: InferIn<InS>;
    parsedInput: InferOut<InS>;
    rawOutput: InferIn<OutS>;
    output: InferOut<OutS>;
    taskInput: TaskInputOf<Tasks>;
    tasks: TaskOutputOf<Tasks>;
    workspace: false;
    inputSchema: InS;
    outputSchema: OutS;
  },
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
  {
    input: InferIn<InS>;
    parsedInput: InferOut<InS>;
    rawOutput: InferIn<OutS>;
    output: InferOut<OutS>;
    taskInput: TaskInputOf<Tasks>;
    tasks: TaskOutputOf<Tasks>;
    workspace: true;
    inputSchema: InS;
    outputSchema: OutS;
  },
  Id
>;
