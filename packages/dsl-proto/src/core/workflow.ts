/** Declaration-only workflow surface for the Weft DSL prototype. */
import type { AgentExecutionOptions, AgentFn, PatchRef, RecipeDefinition } from "./agent.ts";
import type { ArtifactFn } from "./artifacts.ts";
import type { CheckFn } from "./checks.ts";
import type { ParallelFn, Pipeline, SequenceFn } from "./composition.ts";
import type { BashFn, EnvApi, ExecFn, FetchFn, FsApi, GitApi, PollOptions, SecretHandle } from "./effects.ts";
import type { HumanApi, UiApi } from "./human.ts";
import type { ObserverFn } from "./observers.ts";
import type { OperationFn } from "./operations.ts";
import type { AnySchema, Duration, InferIn, InferOut, Provider, Settled, WorkflowNode } from "./shared.ts";
import type { AgentTaskAccess, TaskContract, WorkflowTasksApi } from "./tasks.ts";
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
  parallel: ParallelFn;
  sequence: SequenceFn<TaskExtensionInput, TaskExtensions>;
  pipeline<Item>(items: ReadonlyArray<Item>): Pipeline<Item, Item>;
  successes<T>(settled: ReadonlyArray<Settled<T>>): T[];
  all<T>(settled: ReadonlyArray<Settled<T>>): T[];
  recipe<Input, Output, ParsedInput, RawOutput>(
    definition: RecipeDefinition<Input, Output, ParsedInput, RawOutput>,
    input: Input,
  ): Promise<Output>;
  workflow<Definition extends WorkflowDefinition<any, any, any, any, any>>(
    definition: Definition,
    input: InferWorkflowInput<Definition>,
    opts?: SubWorkflowOptions,
  ): Promise<InferWorkflowOutput<Definition>>;
  workflow(name: string, input: unknown, opts?: SubWorkflowOptions): Promise<unknown>;
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
  ui: UiApi;
  fs: FsApi;
  exec: ExecFn;
  bash: BashFn;
  fetch: FetchFn;
  env: EnvApi;
  secret(name: string): SecretHandle;
  git: GitApi;
  check: CheckFn;
  integrate(patches: ReadonlyArray<PatchRef>, opts?: IntegrateOptions): Promise<IntegrationLedger>;
  discard(patches: ReadonlyArray<PatchRef>): Promise<void>;
  note(note: NoteInput): Promise<void>;
  tasks: WorkflowTasksApi<TaskExtensionInput, TaskExtensions>;
  workspace: Workspace extends true
    ? ActiveWorkspaceApi<TaskExtensionInput, TaskExtensions>
    : NestedWorkspaceApi<TaskExtensionInput, TaskExtensions>;
  poll<S extends AnySchema>(opts: PollOptions<S>): Promise<InferOut<S>>;
  signal<S extends AnySchema>(name: string, schema: S, opts?: SignalOptions): Promise<InferOut<S>>;
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
 * Why: Gives the workflow DSL an explicit workflow workspace config contract instead of relying on untyped values.
 * Use: Import it when declaring, configuring, or consuming the corresponding workflow API.
 */
export interface WorkflowWorkspaceConfig {
  branch?: string;
  from?: string;
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
> {
  id?: string;
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
> extends WorkflowNode<"weft.workflow"> {
  readonly kind: "weft.workflow";
  readonly meta: WorkflowMeta<any, any, any, any>;
  readonly run: (ctx: Ctx<any, any, any>, input: Input) => Promise<Output>;
  readonly __input?: RawInput;
  readonly __output?: Output;
  readonly __taskExtensions?: TaskExtensions;
  readonly __taskExtensionInput?: TaskExtensionInput;
}

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
> extends WorkflowMeta<InS, OutS, Tasks, undefined> {
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
> extends WorkflowMeta<InS, OutS, Tasks, Workspace> {
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
>(
  meta: PlainWorkflowMeta<InS, OutS, Tasks>,
  run: (
    ctx: Ctx<TaskInputOf<Tasks>, TaskOutputOf<Tasks>, false>,
    input: InferOut<InS>,
  ) => Promise<InferIn<OutS>>,
): WorkflowDefinition<InferOut<InS>, InferOut<OutS>, TaskOutputOf<Tasks>, InferIn<InS>, TaskInputOf<Tasks>>;

/**
 * Why: Declares the durable schema boundary and typed program body for one workflow.
 * Use: Use the plain or workspace overload at module scope and export the resulting definition.
 */
export declare function defineWorkflow<
  InS extends AnySchema,
  OutS extends AnySchema,
  Tasks extends TaskContract<any> | undefined = undefined,
  Workspace extends WorkflowWorkspace<InferOut<InS>> = WorkflowWorkspace<InferOut<InS>>,
>(
  meta: WorkspaceWorkflowMeta<InS, OutS, Tasks, Workspace>,
  run: (
    ctx: Ctx<TaskInputOf<Tasks>, TaskOutputOf<Tasks>, true>,
    input: InferOut<InS>,
  ) => Promise<InferIn<OutS>>,
): WorkflowDefinition<InferOut<InS>, InferOut<OutS>, TaskOutputOf<Tasks>, InferIn<InS>, TaskInputOf<Tasks>>;
