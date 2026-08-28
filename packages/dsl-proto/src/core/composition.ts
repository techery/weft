/** Declaration-only composition surface for the Weft DSL prototype. */
import type { AgentDefinition, AgentResult, RecipeDefinition } from "./agent.ts";
import type { AnySchema, InferOut, Settled } from "./shared.ts";
import type { Ctx } from "./workflow.ts";

// ---------------------------------------------------------------------------
// Composition
// ---------------------------------------------------------------------------

/**
 * Why: Gives the composition DSL an explicit parallel options contract instead of relying on untyped values.
 * Use: Import it when declaring, configuring, or consuming the corresponding composition API.
 */
export interface ParallelOptions<Item = unknown> {
  key?: string;
  keyOf?: (item: Item, index: number) => string;
  concurrency?: number;
  errors?: "settle" | "throw";
}

/**
 * Why: Defines bounded independent fan-out while settling lanes in deterministic input order.
 * Use: Use `ctx.parallel` with callbacks, agent definitions, recipes, or prebuilt tasks.
 */
export interface ParallelFn {
  <Result>(
    tasks: ReadonlyArray<Promise<Result> | (() => Promise<Result> | Result)>,
    opts?: Omit<ParallelOptions, "keyOf">,
  ): Promise<Settled<Result>[]>;
  <Item, Result>(
    items: ReadonlyArray<Item>,
    run: (item: Item, index: number) => Promise<Result> | Result,
    opts?: ParallelOptions<Item>,
  ): Promise<Settled<Result>[]>;
  <Input, S extends AnySchema, ParsedInput>(
    items: ReadonlyArray<Input>,
    definition: AgentDefinition<Input, S, ParsedInput>,
    opts?: ParallelOptions<Input>,
  ): Promise<Settled<AgentResult<InferOut<S>>>[]>;
  <Input, Output, ParsedInput, RawOutput>(
    items: ReadonlyArray<Input>,
    definition: RecipeDefinition<Input, Output, ParsedInput, RawOutput>,
    opts?: ParallelOptions<Input>,
  ): Promise<Settled<Output>[]>;
}

/**
 * Why: Gives the composition DSL an explicit sequence options contract instead of relying on untyped values.
 * Use: Import it when declaring, configuring, or consuming the corresponding composition API.
 */
export interface SequenceOptions<Item> {
  key: string;
  keyOf: (item: Item, index: number) => string;
  phase?: (item: Item, index: number) => string;
}

/**
 * Why: Gives the composition DSL an explicit sequence item context contract instead of relying on untyped values.
 * Use: Import it when declaring, configuring, or consuming the corresponding composition API.
 */
export interface SequenceItemContext<TaskInput = unknown, TaskOutput = TaskInput> {
  ctx: Ctx<TaskInput, TaskOutput>;
  itemKey: string;
  key(local: string): string;
}

/**
 * Why: Defines ordered item traversal with stable item identities and nested key namespaces.
 * Use: Use `ctx.sequence` when later items may depend on changes produced by earlier items.
 */
export interface SequenceFn<TaskInput = unknown, TaskOutput = TaskInput> {
  <Item, Result>(
    items: ReadonlyArray<Item>,
    opts: SequenceOptions<Item>,
    run: (
      item: Item,
      scope: SequenceItemContext<TaskInput, TaskOutput>,
      index: number,
    ) => Promise<Result> | Result,
  ): Promise<Result[]>;
  <Input, S extends AnySchema, ParsedInput>(
    items: ReadonlyArray<Input>,
    opts: SequenceOptions<Input>,
    definition: AgentDefinition<Input, S, ParsedInput>,
  ): Promise<AgentResult<InferOut<S>>[]>;
  <Input, Output, ParsedInput, RawOutput>(
    items: ReadonlyArray<Input>,
    opts: SequenceOptions<Input>,
    definition: RecipeDefinition<Input, Output, ParsedInput, RawOutput>,
  ): Promise<Output[]>;
}

/**
 * Why: Keeps multi-stage processing independent per input item while preserving settlement semantics.
 * Use: Build one with `ctx.pipeline(items)`, add steps, filters, or maps, then call `run`.
 */
export interface Pipeline<Item, Previous> {
  step<Next>(
    fn: (previous: Previous, item: Item, index: number) => Promise<Next> | Next,
  ): Pipeline<Item, Next>;
  filter(
    fn: (previous: Previous, item: Item, index: number) => Promise<boolean> | boolean,
  ): Pipeline<Item, Previous>;
  map<Next>(
    fn: (previous: Previous, item: Item, index: number) => Promise<Next> | Next,
  ): Pipeline<Item, Next>;
  run(opts?: ParallelOptions<Item>): Promise<Settled<Previous>[]>;
}
