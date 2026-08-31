/** Curated author-facing context and builder contracts for the declaration-only DSL prototype. */

import type {
  AgentDefinitionInput,
  AgentOutputOf,
  AgentResult,
  AnyAgentDefinition,
  AnyRecipeDefinition,
  RecipeDefinition,
  RecipeInputOf,
  RecipeOutputOf,
} from "./core/agent.ts";
import type {
  ParallelOptions,
  ParallelItems,
  SequenceOptions,
} from "./core/composition.ts";
import type { DeliveryApi } from "./core/deliveries.ts";
import type {
  AnySchema,
  InferIn,
  InferOut,
  Settled,
  WorkspaceSnapshotRef,
} from "./core/shared.ts";
import type { OperationApi } from "./core/operations.ts";
import type {
  ApplyPatchesOptions,
  CaptureOptions,
  CheckoutLeaseOptions,
  NestedWorkspaceOptions,
} from "./core/workspace.ts";
import type { PatchRef } from "./core/agent.ts";
import type { TaskContract } from "./core/tasks.ts";
import type {
  Ctx as CoreCtx,
  CtxScopeOptions,
  PlainWorkflowMeta,
  WorkflowDefinition,
  WorkflowWorkspace,
  WorkspaceWorkflowMeta,
} from "./core/workflow.ts";

type CommonContextKey =
  | "agent"
  | "artifact"
  | "context"
  | "successes"
  | "all"
  | "recipe"
  | "workflow"
  | "policy"
  | "human"
  | "observe"
  | "paths"
  | "ui"
  | "fs"
  | "exec"
  | "bash"
  | "fetch"
  | "env"
  | "secret"
  | "git"
  | "check"
  | "review"
  | "integrate"
  | "discard"
  | "note"
  | "tasks"
  | "poll"
  | "signal"
  | "cancellation"
  | "sleep"
  | "now"
  | "random"
  | "uuid"
  | "log"
  | "budget"
  | "run";

/** Ordinary workflow context with one-shot protected effects and no explicit lifecycle methods. */
export interface AuthoringCtx<
  TaskInput = unknown,
  TaskOutput = TaskInput,
  Workspace extends boolean = false,
> extends Pick<CoreCtx<TaskInput, TaskOutput, Workspace>, CommonContextKey> {
  readonly parallel: ParallelFn<TaskInput, TaskOutput, Workspace>;
  readonly sequence: SequenceFn<TaskInput, TaskOutput, Workspace>;
  pipeline<Item>(items: ReadonlyArray<Item>): Pipeline<Item, Item, TaskInput, TaskOutput, Workspace>;
  scope(opts: CtxScopeOptions): AuthoringCtx<TaskInput, TaskOutput, Workspace>;
  step(key: string): AuthoringCtx<TaskInput, TaskOutput, Workspace>;
  step<Result>(
    key: string,
    run: (ctx: AuthoringCtx<TaskInput, TaskOutput, Workspace>) => Promise<Result> | Result,
  ): Promise<Result>;
  readonly operation: OperationApi;
  readonly delivery: DeliveryApi;
  readonly workspace: Workspace extends true
    ? ActiveWorkspaceApi<TaskInput, TaskOutput>
    : NestedWorkspaceApi<TaskInput, TaskOutput>;
}

/** Read-only ordinary workflow context. */
export type WorkflowCtx<TaskInput = unknown, TaskOutput = TaskInput> = AuthoringCtx<
  TaskInput,
  TaskOutput,
  false
>;

/** Ordinary workflow context bound to an engine-owned writable workspace. */
export type WorkspaceCtx<TaskInput = unknown, TaskOutput = TaskInput> = AuthoringCtx<
  TaskInput,
  TaskOutput,
  true
>;

/** Author-facing parallel lane; the lane itself is the scoped context. */
export interface ParallelLaneContext<
  TaskInput = unknown,
  TaskOutput = TaskInput,
  Workspace extends boolean = false,
> extends AuthoringCtx<TaskInput, TaskOutput, Workspace> {
  readonly itemKey: string;
  key(local: string): string;
}

/** Fail-fast and settled author-facing parallel fan-out. */
export interface ParallelFn<
  TaskInput = unknown,
  TaskOutput = TaskInput,
  Workspace extends boolean = false,
> {
  all<const Items extends ReadonlyArray<unknown>, Result>(
    items: ParallelItems<Items>,
    run: (
      item: Items[number],
      lane: ParallelLaneContext<TaskInput, TaskOutput, Workspace>,
      index: number,
    ) => Promise<Result> | Result,
    opts: ParallelOptions<Items[number]>,
  ): Promise<Result[]>;
  settled<const Items extends ReadonlyArray<unknown>, Result>(
    items: ParallelItems<Items>,
    run: (
      item: Items[number],
      lane: ParallelLaneContext<TaskInput, TaskOutput, Workspace>,
      index: number,
    ) => Promise<Result> | Result,
    opts: ParallelOptions<Items[number]>,
  ): Promise<Settled<Result>[]>;
}

/** Author-facing sequence item; the item itself is the scoped context. */
export interface SequenceItemContext<
  TaskInput = unknown,
  TaskOutput = TaskInput,
  Workspace extends boolean = false,
> extends AuthoringCtx<TaskInput, TaskOutput, Workspace> {
  readonly itemKey: string;
  key(local: string): string;
}

/** Ordered author-facing traversal with stable per-item key namespaces. */
export interface SequenceFn<
  TaskInput = unknown,
  TaskOutput = TaskInput,
  Workspace extends boolean = false,
> {
  <Item, Result>(
    items: ReadonlyArray<Item>,
    opts: SequenceOptions<Item>,
    run: (
      item: Item,
      scope: SequenceItemContext<TaskInput, TaskOutput, Workspace>,
      index: number,
    ) => Promise<Result> | Result,
  ): Promise<Result[]>;
  <Definition extends AnyAgentDefinition>(
    items: ReadonlyArray<AgentDefinitionInput<Definition>>,
    opts: SequenceOptions<AgentDefinitionInput<Definition>>,
    definition: Definition,
  ): Promise<AgentResult<AgentOutputOf<Definition>>[]>;
  <Definition extends AnyRecipeDefinition>(
    items: ReadonlyArray<RecipeInputOf<Definition>>,
    opts: SequenceOptions<RecipeInputOf<Definition>>,
    definition: Definition,
  ): Promise<RecipeOutputOf<Definition>[]>;
}

/** Pipeline with pure transforms, named effectful maps, and explicit settlement. */
export interface Pipeline<
  Item,
  Previous,
  TaskInput = unknown,
  TaskOutput = TaskInput,
  Workspace extends boolean = false,
> {
  mapEffect<Next>(
    key: string,
    fn: (
      previous: Previous,
      item: Item,
      lane: ParallelLaneContext<TaskInput, TaskOutput, Workspace>,
      index: number,
    ) => Promise<Next> | Next,
  ): Pipeline<Item, Next, TaskInput, TaskOutput, Workspace>;
  filter(fn: (previous: Previous, item: Item, index: number) => boolean): Pipeline<
    Item,
    Previous,
    TaskInput,
    TaskOutput,
    Workspace
  >;
  map<const Mapper extends (previous: Previous, item: Item, index: number) => unknown>(
    fn: Mapper & (Extract<ReturnType<Mapper>, PromiseLike<unknown>> extends never ? unknown : never),
  ): Pipeline<
    Item,
    ReturnType<Mapper>,
    TaskInput,
    TaskOutput,
    Workspace
  >;
  all(opts: ParallelOptions<Item>): Promise<Previous[]>;
  settled(opts: ParallelOptions<Item>): Promise<Settled<Previous>[]>;
}

/** Author-facing nested writable workspace with the same reduced protected-effect facade. */
export interface CandidateWorkspaceContext<TaskInput = unknown, TaskOutput = TaskInput>
  extends AuthoringCtx<TaskInput, TaskOutput, true> {
  apply(patches: ReadonlyArray<PatchRef>, opts: ApplyPatchesOptions): Promise<void>;
  capture(opts: CaptureOptions): Promise<PatchRef>;
}

/** Nested workspace capability that preserves the curated context inside callbacks. */
export interface NestedWorkspaceApi<TaskInput = unknown, TaskOutput = TaskInput> {
  with<Result>(
    opts: NestedWorkspaceOptions,
    run: (candidate: CandidateWorkspaceContext<TaskInput, TaskOutput>) => Promise<Result> | Result,
  ): Promise<Result>;
  lease<Result>(
    opts: CheckoutLeaseOptions,
    run: (workspace: CandidateWorkspaceContext<TaskInput, TaskOutput>) => Promise<Result> | Result,
  ): Promise<Result>;
}

/** Current workflow-owned workspace identity plus nested candidate workspaces. */
export interface ActiveWorkspaceApi<TaskInput = unknown, TaskOutput = TaskInput>
  extends NestedWorkspaceApi<TaskInput, TaskOutput> {
  readonly snapshot: WorkspaceSnapshotRef;
  readonly id: string;
  readonly path: string;
  readonly branch: string;
  readonly head: string;
  readonly tree: string;
  readonly generation: number;
}

type TaskInputOf<Tasks> = Tasks extends TaskContract<infer S extends AnySchema> ? InferIn<S> : unknown;
type TaskOutputOf<Tasks> = Tasks extends TaskContract<infer S extends AnySchema> ? InferOut<S> : unknown;

/** Public workflow builder using the curated ordinary-authoring context. */
export declare function defineWorkflow<
  InS extends AnySchema,
  OutS extends AnySchema,
  Tasks extends TaskContract<any> | undefined = undefined,
  const Id extends string = string,
>(
  meta: PlainWorkflowMeta<InS, OutS, Tasks, Id>,
  run: (
    ctx: WorkflowCtx<TaskInputOf<Tasks>, TaskOutputOf<Tasks>>,
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

/** Public workspace workflow builder using the curated ordinary-authoring context. */
export declare function defineWorkflow<
  InS extends AnySchema,
  OutS extends AnySchema,
  Tasks extends TaskContract<any> | undefined = undefined,
  Workspace extends WorkflowWorkspace<InferOut<InS>> = WorkflowWorkspace<InferOut<InS>>,
  const Id extends string = string,
>(
  meta: WorkspaceWorkflowMeta<InS, OutS, Tasks, Workspace, Id>,
  run: (
    ctx: WorkspaceCtx<TaskInputOf<Tasks>, TaskOutputOf<Tasks>>,
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

/** Recipe config whose callback receives the curated read-only context. */
export interface RecipeConfig<
  InputSchema extends AnySchema,
  OutputSchema extends AnySchema,
  Name extends string = string,
> {
  name: Name;
  description?: string;
  input: InputSchema;
  output: OutputSchema;
  run: (
    ctx: WorkflowCtx,
    input: InferOut<InputSchema>,
  ) => Promise<InferIn<OutputSchema>> | InferIn<OutputSchema>;
}

/** Public recipe builder using the curated read-only context. */
export declare function defineRecipe<
  InputSchema extends AnySchema,
  OutputSchema extends AnySchema,
  const Name extends string = string,
>(
  config: RecipeConfig<InputSchema, OutputSchema, Name>,
): RecipeDefinition<
  {
    input: InferIn<InputSchema>;
    parsedInput: InferOut<InputSchema>;
    output: InferOut<OutputSchema>;
    rawOutput: InferIn<OutputSchema>;
    inputSchema: InputSchema;
    outputSchema: OutputSchema;
  },
  Name
>;
