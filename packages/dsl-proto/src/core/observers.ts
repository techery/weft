/** Declaration-only durable observer surface for the Weft DSL prototype. */

import type {
  AnySchema,
  Duration,
  EvidenceRef,
  HostBinding,
  InferIn,
  InferOut,
  WorkflowNode,
} from "./shared.ts";

// ---------------------------------------------------------------------------
// Durable external observation
// ---------------------------------------------------------------------------

/**
 * Why: Gives a polling observer cancellation and attempt information for one replayable observation.
 * Use: Read it inside `source.observe` to stop promptly or report attempt-aware diagnostics.
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
 * Why: Restricts observer trust claims to levels that require a host-authenticated source identity.
 * Use: Choose `authoritative` only for a system of record; otherwise prefer `authenticated`.
 */
export type ObserverTrustLevel = "authenticated" | "authoritative";

/**
 * Why: Makes an observer's trust floor and accepted issuers inspectable before any event is consumed.
 * Use: Declare at least one authority on every bound signal endpoint and optionally on bound polling.
 */
export interface ObserverTrustPolicy {
  minimum: ObserverTrustLevel;
  authorities: readonly [string, ...string[]];
}

/**
 * Why: Records which allowed authority and trust level the host actually established for accepted state.
 * Use: Retain it from detailed observation provenance instead of copying the definition's requested policy.
 */
export interface ObserverTrustMetadata {
  level: ObserverTrustLevel;
  authority: string;
}

/**
 * Why: Lets the engine reject correlation mismatches, replayed or conflicting event IDs, and non-monotonic state.
 * Use: Return canonical keys after validation; add `sequence` when the provider exposes strict monotonic ordering.
 */
export interface ObserverIdentityContract<ParsedInput, ParsedState> {
  inputCorrelation: (input: ParsedInput) => string;
  stateCorrelation: (state: ParsedState) => string;
  eventId: (state: ParsedState) => string;
  sequence?: (state: ParsedState) => number;
}

/**
 * Why: Names the host fields required to resume a workflow from authenticated push events.
 * Use: Reuse it in a signal source or the signal endpoint of a signal-first source.
 */
export interface SignalObserverEndpoint<ParsedInput> {
  binding: HostBinding;
  signal: ObserverSignalName<ParsedInput>;
  trust: ObserverTrustPolicy;
}

/**
 * Why: Names one host-resolved pull endpoint with its default cadence and optional trust policy.
 * Use: Reuse it in a bound polling source or as the fallback endpoint of a signal-first source.
 */
export interface PollObserverEndpoint {
  binding: HostBinding;
  every: Duration;
  trust?: ObserverTrustPolicy;
}

/**
 * Why: Describes fields shared by both locally implemented and host-bound polling sources.
 * Use: Extend it through the concrete polling source branch rather than constructing it alone.
 */
export interface PollObserverSourceBase {
  kind: "poll";
  every: Duration;
}

/**
 * Why: Describes a polling adapter implemented beside the observer without permitting a host-authority claim.
 * Use: Supply `observe` for repository-local or test adapters and omit `binding` and `trust`.
 */
export interface ImplementedPollObserverSource<ParsedInput, RawState> extends PollObserverSourceBase {
  binding?: never;
  trust?: never;
  observe: (input: ParsedInput, context: ObserverRunContext) => Promise<RawState> | RawState;
}

/**
 * Why: Describes portable polling whose concrete external read and optional trust policy are resolved by the host.
 * Use: Supply a stable `binding`; add `trust` only when the host can attest an allowed authority.
 */
export interface BoundPollObserverSource extends PollObserverSourceBase {
  binding: HostBinding;
  trust?: ObserverTrustPolicy;
  observe?: never;
}

/**
 * Why: Keeps host-bound and locally implemented polling behind one discriminated source family.
 * Use: Pass either source mode to `defineObserver`; invocation typing remains the same.
 */
export type PollObserverSource<ParsedInput, RawState> =
  | ImplementedPollObserverSource<ParsedInput, RawState>
  | BoundPollObserverSource;

/**
 * Why: Makes every canonical signal source name both its host adapter and accepted trust authorities.
 * Use: Prefer this branch for new signal observers so resumption provenance is inspectable.
 */
export interface BoundSignalObserverSource<ParsedInput> extends SignalObserverEndpoint<ParsedInput> {
  kind: "signal";
}

/**
 * Why: Declares the author-supplied endpoints and grace period for one signal-first observation strategy.
 * Use: Provide host-bound signal and polling endpoints; the engine starts fallback only after `grace`.
 */
export interface SignalFirstObserverSourceConfig<ParsedInput> {
  kind: "signal-first";
  signal: SignalObserverEndpoint<ParsedInput>;
  fallback: PollObserverEndpoint;
  grace: Duration;
}

/**
 * Why: Separates fallback grace, observation timeout, and caller cancellation in one engine-owned state machine.
 * Use: Exactly one valid terminal completion wins; timeout or cancellation aborts both endpoints without fallback.
 */
export interface SignalFirstObserverCoordination {
  readonly fallbackOn: "grace-deadline";
  readonly timeoutOn: "observation-deadline";
  readonly cancelOn: "abort-signal";
  readonly terminalWinner: "first-valid-completion";
  readonly loserCancellation: "engine";
}

/**
 * Why: Makes the single engine-owned signal/fallback state machine explicit on normalized definitions.
 * Use: Inspect `coordination`; workflow authors never race endpoint promises or reinterpret abort as fallback.
 */
export interface SignalFirstObserverSource<ParsedInput> extends SignalFirstObserverSourceConfig<ParsedInput> {
  readonly coordination: SignalFirstObserverCoordination;
}

/**
 * Why: Unifies pull, push, and signal-first observation behind one node while retaining source-specific fields.
 * Use: Narrow it by `kind` inside observer binders and engine handlers.
 */
export type ObserverSource<ParsedInput, RawState> =
  | PollObserverSource<ParsedInput, RawState>
  | BoundSignalObserverSource<ParsedInput>
  | SignalFirstObserverSource<ParsedInput>;

/**
 * Why: Centralizes the maximum durable wait shared by every observer strategy.
 * Use: Set it once on the observer and optionally tighten it at invocation time.
 */
export interface ObserverDefaults {
  timeout: Duration;
}

/**
 * Why: Represents an external-state wait whose intermediate state and terminal output both cross schemas.
 * Use: Create it with `defineObserver`, then wait through `ctx.observe` or `ctx.observe.detailed`.
 */
export interface ObserverDefinition<
  InputSchema extends AnySchema,
  StateSchema extends AnySchema,
  OutputSchema extends AnySchema,
  Source extends ObserverSource<InferOut<InputSchema>, InferIn<StateSchema>>,
  Name extends string = string,
> extends WorkflowNode<"weft.observer"> {
  readonly kind: "weft.observer";
  readonly name: Name;
  readonly description?: string;
  readonly input: InputSchema;
  readonly state: StateSchema;
  readonly output: OutputSchema;
  readonly source: Source;
  readonly identity?: ObserverIdentityContract<InferOut<InputSchema>, InferOut<StateSchema>>;
  readonly defaults: Readonly<ObserverDefaults>;
  readonly complete: (
    state: InferOut<StateSchema>,
    input: InferOut<InputSchema>,
  ) => InferIn<OutputSchema> | null;
}

/**
 * Why: Collects schema, identity, timeout, and completion policy shared by every observer strategy.
 * Use: Extend it through the source-specific configuration passed to `defineObserver`.
 */
export interface ObserverConfigBase<
  InputSchema extends AnySchema,
  StateSchema extends AnySchema,
  OutputSchema extends AnySchema,
  Name extends string = string,
> {
  name: Name;
  description?: string;
  input: InputSchema;
  state: StateSchema;
  output: OutputSchema;
  identity?: ObserverIdentityContract<InferOut<InputSchema>, InferOut<StateSchema>>;
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
  Name extends string = string,
  Source extends PollObserverSource<InferOut<InputSchema>, InferIn<StateSchema>> = PollObserverSource<
    InferOut<InputSchema>,
    InferIn<StateSchema>
  >,
> extends ObserverConfigBase<InputSchema, StateSchema, OutputSchema, Name> {
  source: Source;
}

/**
 * Why: Couples an explicitly host-bound signal source to the observer schemas it must validate and complete.
 * Use: Prefer it for new signal observers whose adapter and accepted authorities must be inspectable.
 */
export interface BoundSignalObserverConfig<
  InputSchema extends AnySchema,
  StateSchema extends AnySchema,
  OutputSchema extends AnySchema,
  Name extends string = string,
> extends ObserverConfigBase<InputSchema, StateSchema, OutputSchema, Name> {
  source: BoundSignalObserverSource<InferOut<InputSchema>>;
}

/**
 * Why: Keeps the established signal-config export while requiring an explicitly trusted host source.
 * Use: Use it when annotating reusable signal observer declarations.
 */
export type SignalObserverConfig<
  InputSchema extends AnySchema,
  StateSchema extends AnySchema,
  OutputSchema extends AnySchema,
  Name extends string = string,
> = BoundSignalObserverConfig<InputSchema, StateSchema, OutputSchema, Name>;

/**
 * Why: Couples a signal-first strategy to one shared state and completion contract.
 * Use: Pass it to `defineObserver`; the returned definition records engine-owned loser cancellation.
 */
export interface SignalFirstObserverConfig<
  InputSchema extends AnySchema,
  StateSchema extends AnySchema,
  OutputSchema extends AnySchema,
  Name extends string = string,
> extends ObserverConfigBase<InputSchema, StateSchema, OutputSchema, Name> {
  source: SignalFirstObserverSourceConfig<InferOut<InputSchema>>;
}

/**
 * Why: Declares a reusable durable polling wait without observing external state at definition time.
 * Use: Use the polling overload for APIs that expose current state but cannot push events.
 */
export declare function defineObserver<
  InputSchema extends AnySchema,
  StateSchema extends AnySchema,
  OutputSchema extends AnySchema,
  Name extends string,
  Source extends PollObserverSource<InferOut<InputSchema>, InferIn<StateSchema>>,
>(
  config: PollObserverConfig<InputSchema, StateSchema, OutputSchema, Name, Source>,
): ObserverDefinition<InputSchema, StateSchema, OutputSchema, Source, Name>;

/**
 * Why: Declares a reusable durable signal wait whose host adapter and trust authorities are explicit.
 * Use: Supply `binding`, `signal`, and `trust`; unbound signal resumption is intentionally rejected.
 */
export declare function defineObserver<
  InputSchema extends AnySchema,
  StateSchema extends AnySchema,
  OutputSchema extends AnySchema,
  Name extends string,
>(
  config: SignalObserverConfig<InputSchema, StateSchema, OutputSchema, Name>,
): ObserverDefinition<
  InputSchema,
  StateSchema,
  OutputSchema,
  BoundSignalObserverSource<InferOut<InputSchema>>,
  Name
>;

/**
 * Why: Declares signal-first observation as one durable engine-owned state machine, not a workflow-authored race.
 * Use: Supply named signal and fallback endpoints plus a grace period; one terminal winner cancels the losing endpoint.
 */
export declare function defineObserver<
  InputSchema extends AnySchema,
  StateSchema extends AnySchema,
  OutputSchema extends AnySchema,
  Name extends string,
>(
  config: SignalFirstObserverConfig<InputSchema, StateSchema, OutputSchema, Name>,
): ObserverDefinition<
  InputSchema,
  StateSchema,
  OutputSchema,
  SignalFirstObserverSource<InferOut<InputSchema>>,
  Name
>;

/**
 * Why: Recovers the raw lookup input accepted by an observer definition.
 * Use: It supplies the input side of `ctx.observe` and internal observer invocations.
 */
export type ObserverInputOf<Definition> =
  Definition extends ObserverDefinition<
    infer InputSchema,
    infer _StateSchema,
    infer _OutputSchema,
    infer _Source,
    infer _Name
  >
    ? InferIn<InputSchema>
    : never;

/**
 * Why: Recovers the validated terminal output produced by an observer definition.
 * Use: It supplies ordinary results and the `output` field of detailed results.
 */
export type ObserverOutputOf<Definition> =
  Definition extends ObserverDefinition<
    infer _InputSchema,
    infer _StateSchema,
    infer OutputSchema,
    infer _Source,
    infer _Name
  >
    ? InferOut<OutputSchema>
    : never;

/**
 * Why: Recovers the exact source strategy carried by an observer definition.
 * Use: Select invocation options or inspect endpoint policy without erasing source-specific fields.
 */
export type ObserverSourceOf<Definition> =
  Definition extends ObserverDefinition<
    infer _InputSchema,
    infer _StateSchema,
    infer _OutputSchema,
    infer Source,
    infer _Name
  >
    ? Source
    : never;

/**
 * Why: Recovers an observer definition's literal name for nominal subjects and provenance.
 * Use: Derive detailed result types without repeating the observer name.
 */
export type ObserverNameOf<Definition> =
  Definition extends ObserverDefinition<
    infer _InputSchema,
    infer _StateSchema,
    infer _OutputSchema,
    infer _Source,
    infer Name
  >
    ? Name
    : never;

/**
 * Why: Supplies durable identity and a tighter timeout shared by every observer strategy.
 * Use: Extend it through the source-specific invocation options selected from the definition.
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
 * Why: Prevents polling cadence from being supplied to a signal-only observer.
 * Use: Pass it to `ctx.observe` for an observer whose source kind is `signal`.
 */
export interface SignalObserverInvocationOptions extends ObserverInvocationOptionsBase {
  every?: never;
  grace?: never;
  fallbackEvery?: never;
}

/**
 * Why: Lets one invocation tighten signal grace and fallback cadence without exposing ambiguous polling options.
 * Use: Pass it only to a `signal-first` observer; the engine still owns endpoint startup and loser cancellation.
 */
export interface SignalFirstObserverInvocationOptions extends ObserverInvocationOptionsBase {
  every?: never;
  grace?: Duration;
  fallbackEvery?: Duration;
}

/**
 * Why: Gives internal erased observer handling one named union for every valid source-specific option set.
 * Use: Narrow it alongside the observer source before reading cadence or grace fields.
 */
export type ObserverInvocationOptions =
  | PollObserverInvocationOptions
  | SignalObserverInvocationOptions
  | SignalFirstObserverInvocationOptions;

/**
 * Why: Selects invocation options from the concrete source carried by an observer definition.
 * Use: Keep signal-only, polling, and signal-first overrides mutually exclusive at call sites.
 */
export type ObserverInvocationOptionsOf<Definition> =
  ObserverSourceOf<Definition> extends SignalFirstObserverSource<infer _ParsedInput>
    ? SignalFirstObserverInvocationOptions
    : ObserverSourceOf<Definition> extends PollObserverSource<infer _ParsedInput, infer _RawState>
      ? PollObserverInvocationOptions
      : SignalObserverInvocationOptions;

// ---------------------------------------------------------------------------
// Detailed observation evidence
// ---------------------------------------------------------------------------

/**
 * Why: Names the static strategy recorded in detailed provenance independently from the endpoint that completed.
 * Use: Read it when auditing whether a result used polling, signaling, or signal-first fallback.
 */
export type ObserverStrategy = "poll" | "signal" | "signal-first";

/**
 * Why: Distinguishes host signal, host polling, and locally implemented polling completion paths.
 * Use: Pair it with `binding` and trust metadata in detailed provenance.
 */
export type ObserverEndpointKind = "signal" | "poll" | "implemented-poll";

/**
 * Why: Captures the identity values the engine accepted after schema validation and replay checks.
 * Use: Retain it with evidence when downstream consumers need the terminal external event identity.
 */
export interface ObserverObservedIdentity {
  correlation: string;
  eventId: string;
  sequence?: number;
}

/**
 * Why: Records when a signal-first observer activated its polling endpoint after the declared grace period.
 * Use: Distinguish a poll fallback from a signal completion without inferring from workflow timing.
 */
export interface ObserverFallbackProvenance {
  grace: Duration;
  activatedAt: string;
}

/**
 * Why: Prevents workflow-authored metadata from masquerading as provenance recorded by the observer engine.
 * Use: It is carried only by `ObserverProvenance` values returned from `ctx.observe.detailed`.
 */
declare const observerProvenanceBrand: unique symbol;

/**
 * Why: Records the one terminal winner, host adapter, established trust, accepted identity, and fallback path.
 * Use: Preserve it beside detailed output and evidence rather than trusting payload-shaped provenance fields.
 */
export interface ObserverProvenance<Name extends string = string> {
  readonly observer: Name;
  readonly strategy: ObserverStrategy;
  readonly endpoint: ObserverEndpointKind;
  readonly binding?: HostBinding;
  readonly trust?: Readonly<ObserverTrustMetadata>;
  readonly identity?: Readonly<ObserverObservedIdentity>;
  readonly fallback?: Readonly<ObserverFallbackProvenance>;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly [observerProvenanceBrand]: Name;
}

/**
 * Why: Prevents copied observer names, inputs, and correlation strings from masquerading as an observed subject.
 * Use: Receive it from `ctx.observe.detailed` and carry it unchanged with derived evidence.
 */
declare const observerSubjectBrand: unique symbol;

/**
 * Why: Identifies one exact observer definition and validated input, plus correlation when identity is configured.
 * Use: Treat it as the subject of the detailed result's nominal evidence reference.
 */
export interface ObserverSubject<Name extends string = string> {
  readonly observer: Name;
  readonly definitionDigest: string;
  readonly inputDigest: string;
  readonly correlation?: string;
  readonly [observerSubjectBrand]: Name;
}

/**
 * Why: Prevents an ordinary output envelope from claiming engine-minted observation evidence and provenance.
 * Use: It is carried only by values returned from `ctx.observe.detailed`.
 */
declare const detailedObserverResultBrand: unique symbol;

/**
 * Why: Returns validated output together with its exact observer subject, provenance, and digest-addressed evidence.
 * Use: Prefer it when observation results support promotion, compliance, or other consequential claims.
 */
export interface DetailedObserverResult<Definition extends WorkflowNode<"weft.observer">> {
  readonly output: ObserverOutputOf<Definition>;
  readonly subject: ObserverSubject<ObserverNameOf<Definition>>;
  readonly provenance: ObserverProvenance<ObserverNameOf<Definition>>;
  readonly evidence: EvidenceRef<
    "observer",
    ObserverOutputOf<Definition>,
    ObserverSubject<ObserverNameOf<Definition>>
  >;
  readonly [detailedObserverResultBrand]: Definition;
}

/**
 * Why: Exposes durable external observation while preserving the established output-only call form.
 * Use: Call it directly for output, or call `.detailed` when nominal evidence and provenance must be retained.
 */
export interface ObserverFn {
  <Definition extends WorkflowNode<"weft.observer">>(
    definition: Definition,
    input: ObserverInputOf<Definition>,
    options: ObserverInvocationOptionsOf<Definition>,
  ): Promise<ObserverOutputOf<Definition>>;
  detailed<Definition extends WorkflowNode<"weft.observer">>(
    definition: Definition,
    input: ObserverInputOf<Definition>,
    options: ObserverInvocationOptionsOf<Definition>,
  ): Promise<DetailedObserverResult<Definition>>;
}
