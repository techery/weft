/** Declaration-only composition surface for the Weft DSL prototype. */
import type {
  AgentDefinitionInput,
  AgentOutputOf,
  AgentResult,
  AnyAgentDefinition,
  AnyRecipeDefinition,
  RecipeInputOf,
  RecipeOutputOf,
} from "./agent.ts";
import type { Settled } from "./shared.ts";
import type { Ctx } from "./workflow.ts";

// ---------------------------------------------------------------------------
// Composition
// ---------------------------------------------------------------------------

/** Parallel options. */
export interface ParallelOptions<Item = unknown> {
  key: string;
  keyOf: (item: Item, index: number) => string;
  concurrency?: number;
}

/** Rejects fan-out inputs containing already-started promises. */
export type ParallelItems<Items extends ReadonlyArray<unknown>> =
  Extract<Items[number], PromiseLike<unknown>> extends never ? Items : never;

/**
 * Why: Gives each parallel item a stable durable-key namespace and the same capability mode as its enclosing context.
 * Use: Invoke effects directly through the lane; its durable namespace derives from the parent key and `keyOf` result.
 */
export interface ParallelLaneContext<
  TaskInput = unknown,
  TaskOutput = TaskInput,
  Workspace extends boolean = false,
> extends Ctx<TaskInput, TaskOutput, Workspace> {
  /** @deprecated The lane itself is the scoped context; use `lane.agent`, `lane.context`, and other capabilities directly. */
  readonly ctx: Ctx<TaskInput, TaskOutput, Workspace>;
  readonly itemKey: string;
  key(local: string): string;
}

/**
 * Why: Separates fail-fast and settled fan-out at the method boundary and never accepts already-started promises.
 * Use: Choose `all` for required lanes or `settled` when workflow code will inspect each failure explicitly.
 */
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

/** Review-lane context without mutation, operation, or delivery authority. */
export interface ReviewParallelLaneContext {
  readonly agent: import("./agent.ts").ReadOnlyAgentApi;
  readonly context: import("./context-sources.ts").ContextFn;
  readonly parallel: ReviewParallelFn;
  readonly fs: import("./effects.ts").FsApi;
  readonly git: import("./effects.ts").GitReadApi;
  readonly observe: import("./observers.ts").ObserverFn;
  readonly cancellation: import("./workflow.ts").WorkflowCancellation;
  readonly log: (message: string) => void;
  readonly budget: import("./workflow.ts").BudgetView;
  readonly run: import("./workflow.ts").RunInfo;
  readonly itemKey: string;
  key(local: string): string;
}

/** Read-only parallel fan-out available inside reusable reviews. */
export interface ReviewParallelFn {
  all<const Items extends ReadonlyArray<unknown>, Result>(
    items: ParallelItems<Items>,
    run: (
      item: Items[number],
      lane: ReviewParallelLaneContext,
      index: number,
    ) => Promise<Result> | Result,
    opts: ParallelOptions<Items[number]>,
  ): Promise<Result[]>;
  settled<const Items extends ReadonlyArray<unknown>, Result>(
    items: ParallelItems<Items>,
    run: (
      item: Items[number],
      lane: ReviewParallelLaneContext,
      index: number,
    ) => Promise<Result> | Result,
    opts: ParallelOptions<Items[number]>,
  ): Promise<Settled<Result>[]>;
}

/** Ordered traversal options with stable identity and optional presentation labels. */
export interface SequenceOptions<Item> {
  key: string;
  keyOf: (item: Item, index: number) => string;
  /** Presentation only; durable identity continues to derive from `key` and `keyOf`. */
  labelOf?: (item: Item, index: number) => string;
}

/** Sequence item context. */
export interface SequenceItemContext<
  TaskInput = unknown,
  TaskOutput = TaskInput,
  Workspace extends boolean = false,
> {
  readonly ctx: Ctx<TaskInput, TaskOutput, Workspace>;
  readonly itemKey: string;
  key(local: string): string;
}

/**
 * Why: Defines ordered item traversal with stable item identities and nested key namespaces.
 * Use: Use `ctx.sequence` when later items may depend on changes produced by earlier items.
 */
export interface SequenceFn<TaskInput = unknown, TaskOutput = TaskInput, Workspace extends boolean = false> {
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

/**
 * Why: Keeps multi-step processing independent per input item while preserving settlement semantics.
 * Use: Build one with `ctx.pipeline(items)`, add named effectful maps and pure filters/maps, then choose `all` or `settled`.
 */
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
