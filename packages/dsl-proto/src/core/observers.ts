/** Declaration-only durable observer surface for the Weft DSL prototype. */

import type { AnySchema, Duration, InferIn, InferOut, WorkflowNode } from "./shared.ts";

// ---------------------------------------------------------------------------
// Durable external observation
// ---------------------------------------------------------------------------

/**
 * Why: Gives a polling observer cancellation and attempt information for one replayable observation.
 * Use: Read it inside `source.observe` to stop promptly and record attempt-aware diagnostics.
 */
export interface ObserverRunContext {
  signal: AbortSignal;
  attempt: number;
}

/**
 * Why: Names a pure input-to-signal-name mapper for host-delivered observer events.
 * Use: Supply it when different observer inputs wait on different durable signal names.
 */
export type ObserverSignalName<Input> = string | ((input: Input) => string);

/**
 * Why: Describes a pull-based source that repeatedly produces schema-bound external state.
 * Use: Select it for CI, deployment, or remote-system APIs that must be polled.
 */
export interface PollObserverSource<ParsedInput, RawState> {
  kind: "poll";
  every: Duration;
  observe: (input: ParsedInput, context: ObserverRunContext) => Promise<RawState> | RawState;
}

/**
 * Why: Describes a push-based source whose payload is delivered and authenticated by the host.
 * Use: Select it when an external connector can resume the workflow with a durable signal.
 */
export interface SignalObserverSource<ParsedInput> {
  kind: "signal";
  signal: ObserverSignalName<ParsedInput>;
}

/**
 * Why: Unifies pull and push observation behind one node while keeping their source-specific fields discriminated.
 * Use: Narrow it by `kind` inside observer binders and engine handlers.
 */
export type ObserverSource<ParsedInput, RawState> =
  | PollObserverSource<ParsedInput, RawState>
  | SignalObserverSource<ParsedInput>;

/**
 * Why: Centralizes the maximum durable wait shared by polling and signal-backed observers.
 * Use: Set it once on the observer and optionally tighten it at invocation time.
 */
export interface ObserverDefaults {
  timeout: Duration;
}

/**
 * Why: Represents an external-state wait whose intermediate state and terminal output both cross schemas.
 * Use: Create it with `defineObserver`, then wait through `ctx.observe`.
 */
export interface ObserverDefinition<
  InputSchema extends AnySchema,
  StateSchema extends AnySchema,
  OutputSchema extends AnySchema,
  Source extends ObserverSource<InferOut<InputSchema>, InferIn<StateSchema>>,
> extends WorkflowNode<"weft.observer"> {
  readonly kind: "weft.observer";
  readonly name: string;
  readonly description?: string;
  readonly input: InputSchema;
  readonly state: StateSchema;
  readonly output: OutputSchema;
  readonly source: Source;
  readonly defaults: Readonly<ObserverDefaults>;
  readonly complete: (
    state: InferOut<StateSchema>,
    input: InferOut<InputSchema>,
  ) => InferIn<OutputSchema> | null;
}

/**
 * Why: Collects schema boundaries and completion policy shared by polling and signal observer configurations.
 * Use: Extend it through the source-specific configuration passed to `defineObserver`.
 */
export interface ObserverConfigBase<
  InputSchema extends AnySchema,
  StateSchema extends AnySchema,
  OutputSchema extends AnySchema,
> {
  name: string;
  description?: string;
  input: InputSchema;
  state: StateSchema;
  output: OutputSchema;
  defaults: ObserverDefaults;
  complete: (state: InferOut<StateSchema>, input: InferOut<InputSchema>) => InferIn<OutputSchema> | null;
}

/**
 * Why: Couples a polling source to the observer schemas it must produce and complete.
 * Use: Pass it to `defineObserver` when the engine should journal repeated external reads.
 */
export interface PollObserverConfig<
  InputSchema extends AnySchema,
  StateSchema extends AnySchema,
  OutputSchema extends AnySchema,
> extends ObserverConfigBase<InputSchema, StateSchema, OutputSchema> {
  source: PollObserverSource<InferOut<InputSchema>, InferIn<StateSchema>>;
}

/**
 * Why: Couples a host signal source to the observer schemas it must validate and complete.
 * Use: Pass it to `defineObserver` when an authenticated connector can resume the wait.
 */
export interface SignalObserverConfig<
  InputSchema extends AnySchema,
  StateSchema extends AnySchema,
  OutputSchema extends AnySchema,
> extends ObserverConfigBase<InputSchema, StateSchema, OutputSchema> {
  source: SignalObserverSource<InferOut<InputSchema>>;
}

/**
 * Why: Declares a reusable durable polling wait without observing external state at definition time.
 * Use: Use the polling overload for APIs that expose current state but cannot push events.
 */
export declare function defineObserver<
  InputSchema extends AnySchema,
  StateSchema extends AnySchema,
  OutputSchema extends AnySchema,
>(
  config: PollObserverConfig<InputSchema, StateSchema, OutputSchema>,
): ObserverDefinition<
  InputSchema,
  StateSchema,
  OutputSchema,
  PollObserverSource<InferOut<InputSchema>, InferIn<StateSchema>>
>;

/**
 * Why: Declares a reusable durable signal wait without subscribing or suspending at definition time.
 * Use: Use the signal overload when a host connector can deliver authenticated state payloads.
 */
export declare function defineObserver<
  InputSchema extends AnySchema,
  StateSchema extends AnySchema,
  OutputSchema extends AnySchema,
>(
  config: SignalObserverConfig<InputSchema, StateSchema, OutputSchema>,
): ObserverDefinition<InputSchema, StateSchema, OutputSchema, SignalObserverSource<InferOut<InputSchema>>>;

/**
 * Why: Recovers the raw lookup input accepted by an observer definition.
 * Use: It supplies the input side of `ctx.observe` and the internal observer invocation.
 */
export type ObserverInputOf<Definition> =
  Definition extends ObserverDefinition<
    infer InputSchema,
    infer _StateSchema,
    infer _OutputSchema,
    infer _Source
  >
    ? InferIn<InputSchema>
    : never;

/**
 * Why: Recovers the validated terminal output produced by an observer definition.
 * Use: It supplies the result side of `ctx.observe` and the internal observer invocation.
 */
export type ObserverOutputOf<Definition> =
  Definition extends ObserverDefinition<
    infer _InputSchema,
    infer _StateSchema,
    infer OutputSchema,
    infer _Source
  >
    ? InferOut<OutputSchema>
    : never;

/**
 * Why: Supplies durable identity and a tighter timeout shared by every observer source mode.
 * Use: Extend it through the poll- or signal-specific invocation options selected from the definition.
 */
export interface ObserverInvocationOptionsBase {
  key: string;
  label?: string;
  timeout?: Duration;
}

/**
 * Why: Allows a polling invocation to tighten the definition's default observation cadence.
 * Use: Pass it to `ctx.observe` only for an observer whose source kind is `poll`.
 */
export interface PollObserverInvocationOptions extends ObserverInvocationOptionsBase {
  every?: Duration;
}

/**
 * Why: Prevents polling cadence from being supplied to a host-signal observer.
 * Use: Pass it to `ctx.observe` for an observer whose source kind is `signal`.
 */
export interface SignalObserverInvocationOptions extends ObserverInvocationOptionsBase {
  every?: never;
}

/**
 * Why: Gives internal erased observer handling one named union for all valid source-specific options.
 * Use: Narrow it alongside the observer source before reading polling-only fields.
 */
export type ObserverInvocationOptions = PollObserverInvocationOptions | SignalObserverInvocationOptions;

/**
 * Why: Selects invocation options from the concrete source carried by an observer definition.
 * Use: It keeps `ctx.observe` from accepting polling-only overrides for signal-backed observers.
 */
export type ObserverInvocationOptionsOf<Definition> =
  Definition extends ObserverDefinition<
    infer _InputSchema,
    infer _StateSchema,
    infer _OutputSchema,
    infer Source
  >
    ? Source extends PollObserverSource<infer _ParsedInput, infer _RawState>
      ? PollObserverInvocationOptions
      : SignalObserverInvocationOptions
    : never;

/**
 * Why: Exposes durable external observation without repeating polling or signal schemas inline.
 * Use: Call `ctx.observe(definition, input, options)` and await its validated terminal output.
 */
export type ObserverFn = <Definition extends WorkflowNode<"weft.observer">>(
  definition: Definition,
  input: ObserverInputOf<Definition>,
  options: ObserverInvocationOptionsOf<Definition>,
) => Promise<ObserverOutputOf<Definition>>;
