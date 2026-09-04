/** Declaration-only composition surface for the Weft DSL prototype. */
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
  readonly itemKey: string;
}

/**
 * Why: Separates fail-fast and settled fan-out at the method boundary and never accepts already-started promises.
 * Use: Choose `all` for required lanes or `settled` when workflow code will inspect each failure explicitly.
 */
export interface ParallelFn<TaskInput = unknown, TaskOutput = TaskInput, Workspace extends boolean = false> {
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
}

/** Read-only parallel fan-out available inside reusable reviews. */
export interface ReviewParallelFn {
  all<const Items extends ReadonlyArray<unknown>, Result>(
    items: ParallelItems<Items>,
    run: (item: Items[number], lane: ReviewParallelLaneContext, index: number) => Promise<Result> | Result,
    opts: ParallelOptions<Items[number]>,
  ): Promise<Result[]>;
  settled<const Items extends ReadonlyArray<unknown>, Result>(
    items: ParallelItems<Items>,
    run: (item: Items[number], lane: ReviewParallelLaneContext, index: number) => Promise<Result> | Result,
    opts: ParallelOptions<Items[number]>,
  ): Promise<Settled<Result>[]>;
}
