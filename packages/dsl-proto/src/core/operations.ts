/** Declaration-only atomic operation surface for the Weft DSL prototype. */

import type { AnySchema, Duration, HostBinding, InferIn, InferOut, Risk, WorkflowNode } from "./shared.ts";

// ---------------------------------------------------------------------------
// Typed authorized atomic operations
// ---------------------------------------------------------------------------

/**
 * Why: Restricts operation capability declarations to inspectable host-controlled capability families.
 * Use: Declare what an operation requires; the host still decides whether those capabilities are available.
 */
export type OperationCapability =
  | "filesystem:read"
  | "filesystem:write"
  | "git:read"
  | "git:write"
  | "network"
  | "process"
  | "secrets:read"
  | "workspace:read"
  | "workspace:write"
  | `integration:${string}`;

/**
 * Why: Gives an atomic operation cancellation and attempt information without exposing nested workflow effects.
 * Use: Read it inside an operation handler to stop promptly or report bounded retry attempts.
 */
export interface OperationRunContext {
  signal: AbortSignal;
  attempt: number;
}

/**
 * Why: Centralizes timeout and retry defaults without mixing them with non-weakenable authorization policy.
 * Use: Set it on `defineOperation`; individual executions may tighten these limits.
 */
export interface OperationDefaults {
  timeout?: Duration;
  attempts?: number;
}

/**
 * Why: Marks an operation as safe to invoke without minting a candidate-specific authorization reference.
 * Use: Choose it only when host policy permits direct execution for the declared capabilities.
 */
export interface NoOperationAuthorizationPolicy {
  readonly mode: "none";
}

/**
 * Why: Makes the non-weakenable action, risk, and approval timeout explicit before protected input exists.
 * Use: Choose it for operations that must freeze input and obtain candidate-specific authority before execution.
 */
export interface ProtectedOperationAuthorizationPolicy {
  readonly mode: "required";
  readonly action: string;
  readonly risk: Risk;
  readonly timeout?: Duration;
}

/**
 * Why: Preserves the exact authorization branch on each operation definition for safe call-site narrowing.
 * Use: Supply one branch explicitly on every `defineOperation` call.
 */
export type OperationAuthorizationPolicy =
  | NoOperationAuthorizationPolicy
  | ProtectedOperationAuthorizationPolicy;

/**
 * Why: Names the executable adapter shape separately from an operation's portable schema contract.
 * Use: Supply it only when the operation implementation intentionally lives beside the DSL definition.
 */
export type OperationHandler<InputSchema extends AnySchema, OutputSchema extends AnySchema> = (
  input: InferOut<InputSchema>,
  context: OperationRunContext,
) => Promise<InferIn<OutputSchema>> | InferIn<OutputSchema>;

/**
 * Why: Holds fields shared by host-bound and locally implemented operations without weakening their exclusivity.
 * Use: Extend it through one of the two concrete operation definition forms.
 */
export interface OperationDefinitionBase<
  InputSchema extends AnySchema,
  OutputSchema extends AnySchema,
  Authorization extends OperationAuthorizationPolicy = OperationAuthorizationPolicy,
  Name extends string = string,
> extends WorkflowNode<"weft.operation"> {
  readonly kind: "weft.operation";
  readonly name: Name;
  readonly description?: string;
  readonly input: InputSchema;
  readonly output: OutputSchema;
  readonly capabilities: readonly OperationCapability[];
  readonly defaults: Readonly<OperationDefaults>;
  readonly authorization: Readonly<Authorization>;
}

/**
 * Why: Represents a portable operation contract whose adapter is resolved and authorized by the host.
 * Use: Prefer it in workflow packages by passing `binding` instead of an executable callback.
 */
export interface BoundOperationDefinition<
  InputSchema extends AnySchema,
  OutputSchema extends AnySchema,
  Authorization extends OperationAuthorizationPolicy = OperationAuthorizationPolicy,
  Name extends string = string,
> extends OperationDefinitionBase<InputSchema, OutputSchema, Authorization, Name> {
  readonly binding: HostBinding;
  readonly run?: never;
}

/**
 * Why: Represents an operation whose adapter is deliberately implemented beside its declaration.
 * Use: Use it for repository-local or test adapters that do not require host binding resolution.
 */
export interface ImplementedOperationDefinition<
  InputSchema extends AnySchema,
  OutputSchema extends AnySchema,
  Authorization extends OperationAuthorizationPolicy = OperationAuthorizationPolicy,
  Name extends string = string,
> extends OperationDefinitionBase<InputSchema, OutputSchema, Authorization, Name> {
  readonly binding?: never;
  readonly run: OperationHandler<InputSchema, OutputSchema>;
}

/**
 * Why: Represents one schema-validated atomic integration boundary separately from transparent recipes.
 * Use: Create it with `defineOperation`, then invoke it through the path selected by its authorization mode.
 */
export type OperationDefinition<
  InputSchema extends AnySchema,
  OutputSchema extends AnySchema,
  Authorization extends OperationAuthorizationPolicy = OperationAuthorizationPolicy,
  Name extends string = string,
> =
  | BoundOperationDefinition<InputSchema, OutputSchema, Authorization, Name>
  | ImplementedOperationDefinition<InputSchema, OutputSchema, Authorization, Name>;

/**
 * Why: Names definitions that remain callable without a candidate-specific authorization transition.
 * Use: Accept it only in APIs whose direct execution path is intentionally limited to `mode: "none"`.
 */
export interface DirectOperationDefinition<Name extends string = string>
  extends WorkflowNode<"weft.operation"> {
  readonly name: Name;
  readonly authorization: Readonly<NoOperationAuthorizationPolicy>;
}

/**
 * Why: Names definitions that require the complete prepare, authorize, and execute type-state sequence.
 * Use: Accept it in protected operation APIs so direct invocation is unrepresentable.
 */
export interface ProtectedOperationDefinition<Name extends string = string>
  extends WorkflowNode<"weft.operation"> {
  readonly name: Name;
  readonly authorization: Readonly<ProtectedOperationAuthorizationPolicy>;
}

/**
 * Why: Holds schema, identity, capability, execution, and authorization fields shared by both adapters.
 * Use: Extend it through `BoundOperationConfig` or `ImplementedOperationConfig`, never as a loose mixed object.
 */
export interface OperationConfigBase<
  InputSchema extends AnySchema,
  OutputSchema extends AnySchema,
  Authorization extends OperationAuthorizationPolicy = OperationAuthorizationPolicy,
  Name extends string = string,
> {
  name: Name;
  description?: string;
  input: InputSchema;
  output: OutputSchema;
  capabilities?: readonly OperationCapability[];
  defaults?: OperationDefaults;
  authorization: Authorization;
}

/**
 * Why: Declares an operation whose concrete adapter belongs to the authorized host environment.
 * Use: Provide a stable `binding` and omit `run` in portable workflow packages.
 */
export interface BoundOperationConfig<
  InputSchema extends AnySchema,
  OutputSchema extends AnySchema,
  Authorization extends OperationAuthorizationPolicy = OperationAuthorizationPolicy,
  Name extends string = string,
> extends OperationConfigBase<InputSchema, OutputSchema, Authorization, Name> {
  binding: HostBinding;
  run?: never;
}

/**
 * Why: Declares an operation whose callback is intentionally part of this repository's executable adapter layer.
 * Use: Provide `run` and omit `binding` when local implementation is the desired contract.
 */
export interface ImplementedOperationConfig<
  InputSchema extends AnySchema,
  OutputSchema extends AnySchema,
  Authorization extends OperationAuthorizationPolicy = OperationAuthorizationPolicy,
  Name extends string = string,
> extends OperationConfigBase<InputSchema, OutputSchema, Authorization, Name> {
  binding?: never;
  run: OperationHandler<InputSchema, OutputSchema>;
}

/**
 * Why: Declares every field needed to validate, authorize, execute, and test one atomic operation.
 * Use: Pass it to `defineOperation`; choose a recipe instead when nested effects must remain independently visible.
 */
export type OperationConfig<
  InputSchema extends AnySchema,
  OutputSchema extends AnySchema,
  Authorization extends OperationAuthorizationPolicy = OperationAuthorizationPolicy,
  Name extends string = string,
> =
  | BoundOperationConfig<InputSchema, OutputSchema, Authorization, Name>
  | ImplementedOperationConfig<InputSchema, OutputSchema, Authorization, Name>;

/**
 * Why: Declares a reusable host-bound atomic effect without executing or authorizing it at definition time.
 * Use: Pass a host binding and an explicit authorization policy at module scope.
 */
export declare function defineOperation<
  InputSchema extends AnySchema,
  OutputSchema extends AnySchema,
  Authorization extends OperationAuthorizationPolicy,
  const Name extends string = string,
>(
  config: BoundOperationConfig<InputSchema, OutputSchema, Authorization, Name>,
): BoundOperationDefinition<InputSchema, OutputSchema, Authorization, Name>;

/**
 * Why: Declares a reusable locally implemented atomic effect without executing or authorizing it at definition time.
 * Use: Pass the callback form when implementation locality is intentional; otherwise prefer a host binding.
 */
export declare function defineOperation<
  InputSchema extends AnySchema,
  OutputSchema extends AnySchema,
  Authorization extends OperationAuthorizationPolicy,
  const Name extends string = string,
>(
  config: ImplementedOperationConfig<InputSchema, OutputSchema, Authorization, Name>,
): ImplementedOperationDefinition<InputSchema, OutputSchema, Authorization, Name>;

/**
 * Why: Recovers the raw input accepted by an operation definition before schema validation.
 * Use: It supplies direct invocation and protected candidate preparation inputs.
 */
export type OperationInputOf<Definition> =
  Definition extends OperationDefinition<
    infer InputSchema,
    infer _OutputSchema,
    infer _Authorization,
    infer _Name
  >
    ? InferIn<InputSchema>
    : never;

/**
 * Why: Recovers the validated result produced by an operation definition.
 * Use: It supplies direct and protected execution outputs.
 */
export type OperationOutputOf<Definition> =
  Definition extends OperationDefinition<
    infer _InputSchema,
    infer OutputSchema,
    infer _Authorization,
    infer _Name
  >
    ? InferOut<OutputSchema>
    : never;

/**
 * Why: Recovers an operation definition's exact authorization policy branch.
 * Use: Inspect it in helpers that preserve whether direct or protected execution is permitted.
 */
export type OperationAuthorizationOf<Definition> =
  Definition extends OperationDefinition<
    infer _InputSchema,
    infer _OutputSchema,
    infer Authorization,
    infer _Name
  >
    ? Authorization
    : never;

/**
 * Why: Recovers the exact definition-time operation name for registry keys and nominal effect diagnostics.
 * Use: Apply it to a concrete `defineOperation` result; broad legacy definitions continue to produce `string`.
 */
export type OperationNameOf<Definition> =
  Definition extends OperationDefinition<any, any, any, infer Name> ? Name : never;

/**
 * Why: Prevents ordinary objects from masquerading as engine-frozen operation candidates.
 * Use: It is carried only by references minted through `ctx.operation.prepare`.
 */
declare const operationCandidateBrand: unique symbol;

/**
 * Why: Binds one immutable validated input digest to the exact protected operation definition digest.
 * Use: Authorize it unchanged, then pair it with the resulting authority for execution.
 */
export interface OperationCandidateRef<
  Definition extends ProtectedOperationDefinition,
  Input extends OperationInputOf<Definition> = OperationInputOf<Definition>,
> {
  readonly ref: string;
  readonly operation: Definition["name"];
  readonly definitionDigest: string;
  readonly inputDigest: string;
  readonly preparedAt: string;
  readonly [operationCandidateBrand]: readonly [definition: Definition, input: Input];
}

/**
 * Why: Prevents a general approval or authorization for different bytes from authorizing this operation.
 * Use: It is carried only by references minted through `ctx.operation.authorize`.
 */
declare const operationAuthorizationBrand: unique symbol;

/**
 * Why: Carries nominal authority for one exact operation definition, frozen input digest, and candidate reference.
 * Use: Treat it as a host-consumed capability for the corresponding `ctx.operation.execute` call.
 */
export interface OperationAuthorizationRef<
  Definition extends ProtectedOperationDefinition,
  Candidate extends OperationCandidateRef<Definition>,
> {
  readonly ref: string;
  readonly candidateRef: Candidate["ref"];
  readonly operation: Definition["name"];
  readonly definitionDigest: Candidate["definitionDigest"];
  readonly inputDigest: Candidate["inputDigest"];
  readonly action: Definition["authorization"]["action"];
  readonly risk: Definition["authorization"]["risk"];
  readonly approvedBy: "human" | "policy";
  readonly approvedAt: string;
  readonly expiresAt?: string;
  readonly [operationAuthorizationBrand]: readonly [definition: Definition, candidate: Candidate];
}

/**
 * Why: Supplies durable identity while the engine validates and freezes one protected operation input.
 * Use: Pass it to `ctx.operation.prepare` with a stable key.
 */
export interface OperationPrepareOptions {
  key: string;
  label?: string;
}

/**
 * Why: Adds candidate-specific presentation without allowing a workflow to weaken declared action or risk.
 * Use: Pass it to `ctx.operation.authorize`; only timeout may tighten the definition policy.
 */
export interface OperationAuthorizeOptions {
  key: string;
  label?: string;
  detail?: string;
  timeout?: Duration;
}

/**
 * Why: Pairs exactly one frozen operation candidate with the nominal authority minted for it.
 * Use: Construct it from matching `prepare` and `authorize` results for protected execution.
 */
export interface ProtectedOperationExecution<
  Definition extends ProtectedOperationDefinition,
  Candidate extends OperationCandidateRef<Definition>,
> {
  candidate: Candidate;
  authorization: OperationAuthorizationRef<Definition, Candidate>;
}

/**
 * Why: Supplies durable identity and bounded execution limits without changing authorization policy or frozen input.
 * Use: Pass it to direct invocation or `ctx.operation.execute` with a stable key.
 */
export interface OperationInvocationOptions {
  key: string;
  label?: string;
  timeout?: Duration;
  attempts?: number;
}

// ---------------------------------------------------------------------------
// Recoverable protected operation lifecycle
// ---------------------------------------------------------------------------

/**
 * Why: Recovers the exact input frozen into an engine-minted protected operation candidate.
 * Use: Bind execution receipts to input types without making the validated input bytes mutable or public.
 */
export type OperationCandidateInputOf<Candidate> =
  Candidate extends OperationCandidateRef<infer _Definition, infer Input> ? Input : never;

/**
 * Why: Prevents output-shaped workflow values from masquerading as proof that a protected primary effect ran.
 * Use: It is carried only by execution receipts minted and journaled by the engine.
 */
declare const operationExecutionReceiptBrand: unique symbol;

/**
 * Why: Binds exact definition, frozen input, validated output, and idempotency identity into durable effect evidence.
 * Use: Consume its output or pass the receipt itself into a registered recovery mapper.
 */
export interface OperationExecutionReceipt<
  Definition extends ProtectedOperationDefinition,
  Candidate extends OperationCandidateRef<Definition>,
  IdempotencyKey extends string,
> {
  readonly ref: string;
  readonly operation: Definition["name"];
  readonly definitionDigest: Candidate["definitionDigest"];
  readonly inputDigest: Candidate["inputDigest"];
  readonly outputDigest: string;
  readonly candidateRef: Candidate["ref"];
  readonly authorizationRef: string;
  readonly idempotencyKey: IdempotencyKey;
  readonly output: OperationOutputOf<Definition>;
  readonly completedAt: string;
  readonly [operationExecutionReceiptBrand]: readonly [
    definition: Definition,
    input: OperationCandidateInputOf<Candidate>,
    output: OperationOutputOf<Definition>,
    idempotencyKey: IdempotencyKey,
  ];
}

/**
 * Why: Requires a stable external-effect identity in addition to the workflow step key used for journal replay.
 * Use: Pass it while registering primary execution, automatic cancellation, or explicit compensation.
 */
export interface RecoverableOperationInvocationOptions<IdempotencyKey extends string>
  extends OperationInvocationOptions {
  idempotencyKey: IdempotencyKey;
}

/**
 * Why: Restricts guaranteed cancellation to a host-bound operation that needs no later workflow authorization.
 * Use: Declare an idempotent conditional cleanup binding whose host policy permits execution after abandonment.
 */
export interface ConditionalCleanupOperationDefinition<Name extends string = string>
  extends DirectOperationDefinition<Name> {
  readonly binding: HostBinding;
}

/**
 * Why: Prevents a copied candidate or idempotency key from masquerading as a journaled pre-dispatch intent.
 * Use: It is carried only by attempt intents minted after recovery registration and before adapter dispatch.
 */
declare const operationAttemptIntentBrand: unique symbol;

/**
 * Why: Binds exact primary definition, frozen input, authority, and idempotency before the adapter may run.
 * Use: Map automatic cancellation input from this nominal intent even when no primary response ever arrives.
 */
export interface OperationAttemptIntent<
  Primary extends ProtectedOperationDefinition,
  PrimaryCandidate extends OperationCandidateRef<Primary>,
  PrimaryIdempotencyKey extends string,
> {
  readonly ref: string;
  readonly operation: Primary["name"];
  readonly definitionDigest: PrimaryCandidate["definitionDigest"];
  readonly inputDigest: PrimaryCandidate["inputDigest"];
  readonly candidateRef: PrimaryCandidate["ref"];
  readonly authorizationRef: string;
  readonly idempotencyKey: PrimaryIdempotencyKey;
  readonly createdAt: string;
  readonly [operationAttemptIntentBrand]: readonly [
    primary: Primary,
    input: OperationCandidateInputOf<PrimaryCandidate>,
    idempotencyKey: PrimaryIdempotencyKey,
  ];
}

/**
 * Why: Maps cancellation from pre-dispatch nominal intent rather than a success-only primary output.
 * Use: Derive the complete raw input for an idempotent host cleanup binding.
 */
export type OperationCancellationInputMapper<
  Primary extends ProtectedOperationDefinition,
  PrimaryCandidate extends OperationCandidateRef<Primary>,
  PrimaryIdempotencyKey extends string,
  Cancellation extends ConditionalCleanupOperationDefinition,
  CancellationInput extends OperationInputOf<Cancellation>,
> = (attempt: OperationAttemptIntent<Primary, PrimaryCandidate, PrimaryIdempotencyKey>) => CancellationInput;

/**
 * Why: Gives compensation mapping success-only nominal evidence including the validated primary output.
 * Use: Derive protected compensation input only after `executeRecoverable` returns `succeeded`.
 */
export type OperationCompensationInputMapper<
  Primary extends ProtectedOperationDefinition,
  PrimaryCandidate extends OperationCandidateRef<Primary>,
  PrimaryIdempotencyKey extends string,
  Compensation extends ProtectedOperationDefinition,
  CompensationInput extends OperationInputOf<Compensation>,
> = (
  receipt: OperationExecutionReceipt<Primary, PrimaryCandidate, PrimaryIdempotencyKey>,
) => CompensationInput;

/**
 * Why: Supplies a direct conditional cleanup that is executable even when the workflow callback never resumes.
 * Use: Register it atomically with primary intent; the engine freezes mapped input and all invocation limits first.
 */
export interface OperationCancellationRegistration<
  Primary extends ProtectedOperationDefinition,
  PrimaryCandidate extends OperationCandidateRef<Primary>,
  PrimaryIdempotencyKey extends string,
  Cancellation extends ConditionalCleanupOperationDefinition,
  CancellationInput extends OperationInputOf<Cancellation>,
  CancellationIdempotencyKey extends string,
> {
  readonly operation: Cancellation;
  readonly map: OperationCancellationInputMapper<
    Primary,
    PrimaryCandidate,
    PrimaryIdempotencyKey,
    Cancellation,
    CancellationInput
  >;
  readonly options: RecoverableOperationInvocationOptions<CancellationIdempotencyKey>;
}

/**
 * Why: Registers post-success undo intent without pre-authorizing a high-risk compensation before it is needed.
 * Use: Map from the nominal success receipt, then use explicit prepare, authorize, and recover effects.
 */
export interface OperationCompensationRegistration<
  Primary extends ProtectedOperationDefinition,
  PrimaryCandidate extends OperationCandidateRef<Primary>,
  PrimaryIdempotencyKey extends string,
  Compensation extends ProtectedOperationDefinition,
  CompensationInput extends OperationInputOf<Compensation>,
> {
  readonly operation: Compensation;
  readonly map: OperationCompensationInputMapper<
    Primary,
    PrimaryCandidate,
    PrimaryIdempotencyKey,
    Compensation,
    CompensationInput
  >;
}

/**
 * Why: Declares the minimum recovery plan that makes every ambiguous primary dispatch engine-cleanable.
 * Use: Choose it when a completed primary effect needs no later business compensation.
 */
export interface OperationCancellationRecoveryPlan<
  Primary extends ProtectedOperationDefinition,
  PrimaryCandidate extends OperationCandidateRef<Primary>,
  PrimaryIdempotencyKey extends string,
  Cancellation extends ConditionalCleanupOperationDefinition,
  CancellationInput extends OperationInputOf<Cancellation>,
  CancellationIdempotencyKey extends string,
> {
  readonly cancellation: OperationCancellationRegistration<
    Primary,
    PrimaryCandidate,
    PrimaryIdempotencyKey,
    Cancellation,
    CancellationInput,
    CancellationIdempotencyKey
  >;
  readonly compensation?: never;
}

/**
 * Why: Adds explicit post-success compensation while retaining guaranteed direct cleanup for ambiguous dispatch.
 * Use: Choose it for primary effects that may later need both cancellation and protected business rollback.
 */
export interface OperationCompensatedRecoveryPlan<
  Primary extends ProtectedOperationDefinition,
  PrimaryCandidate extends OperationCandidateRef<Primary>,
  PrimaryIdempotencyKey extends string,
  Cancellation extends ConditionalCleanupOperationDefinition,
  CancellationInput extends OperationInputOf<Cancellation>,
  CancellationIdempotencyKey extends string,
  Compensation extends ProtectedOperationDefinition,
  CompensationInput extends OperationInputOf<Compensation>,
> {
  readonly cancellation: OperationCancellationRegistration<
    Primary,
    PrimaryCandidate,
    PrimaryIdempotencyKey,
    Cancellation,
    CancellationInput,
    CancellationIdempotencyKey
  >;
  readonly compensation: OperationCompensationRegistration<
    Primary,
    PrimaryCandidate,
    PrimaryIdempotencyKey,
    Compensation,
    CompensationInput
  >;
}

/**
 * Why: Stores exact cancellation and optional compensation types behind one compact attempt parameter.
 * Use: Carry it nominally through attempt, receipt, candidate, and recovery result helper types.
 */
export interface OperationRecoveryStateMarker {
  readonly cancellation: ConditionalCleanupOperationDefinition;
  readonly cancellationInput: unknown;
  readonly cancellationIdempotencyKey: string;
  readonly compensation: ProtectedOperationDefinition | null;
  readonly compensationInput: unknown;
}

/**
 * Why: Materializes the exact recovery relationships inferred from a registration plan.
 * Use: Let `recoverable` return it inside the nominal attempt without exposing workflow-mutable state.
 */
export interface OperationRecoveryState<
  Cancellation extends ConditionalCleanupOperationDefinition,
  CancellationInput extends OperationInputOf<Cancellation>,
  CancellationIdempotencyKey extends string,
  Compensation extends ProtectedOperationDefinition | null,
  CompensationInput,
> extends OperationRecoveryStateMarker {
  readonly cancellation: Cancellation;
  readonly cancellationInput: CancellationInput;
  readonly cancellationIdempotencyKey: CancellationIdempotencyKey;
  readonly compensation: Compensation;
  readonly compensationInput: CompensationInput;
}

/**
 * Why: Records one engine-owned registration without exposing its executable mapper as mutable workflow state.
 * Use: Audit definition, mapper, input, and idempotency digests from a journaled attempt.
 */
export interface RegisteredOperationRecovery {
  readonly ref: string;
  readonly operation: string;
  readonly definitionDigest: string;
  readonly mapperDigest: string;
  readonly registeredAt: string;
}

/**
 * Why: Proves cancellation input and idempotency were frozen while primary intent was still pre-dispatch.
 * Use: Audit the exact direct cleanup the engine can invoke without a later workflow authorization callback.
 */
export interface RegisteredOperationCancellation extends RegisteredOperationRecovery {
  readonly inputDigest: string;
  readonly idempotencyKey: string;
}

/**
 * Why: Exposes the always-executable cancellation registration and optional success-only compensation intent.
 * Use: Correlate runtime recovery effects without granting authority through these structural metadata fields.
 */
export interface RegisteredOperationRecoveryPlan {
  readonly cancellation: RegisteredOperationCancellation;
  readonly compensation?: RegisteredOperationRecovery;
}

/**
 * Why: Prevents ordinary intent-shaped values from entering dispatch or automatic-cancellation engine paths.
 * Use: It binds the exact primary and inferred recovery state to a journaled attempt reference.
 */
declare const operationAttemptBrand: unique symbol;

/**
 * Why: Represents recovery registration committed before dispatch, so ambiguity always has a nominal cleanup subject.
 * Use: Pass it to `executeRecoverable`; reuse the same attempt on replay instead of minting another remote intent.
 */
export interface OperationAttemptRef<
  Primary extends ProtectedOperationDefinition,
  PrimaryCandidate extends OperationCandidateRef<Primary>,
  PrimaryIdempotencyKey extends string,
  RecoveryState extends OperationRecoveryStateMarker,
> extends OperationAttemptIntent<Primary, PrimaryCandidate, PrimaryIdempotencyKey> {
  readonly recovery: RegisteredOperationRecoveryPlan;
  readonly [operationAttemptBrand]: readonly [
    primary: Primary,
    primaryCandidate: PrimaryCandidate,
    primaryIdempotencyKey: PrimaryIdempotencyKey,
    recovery: RecoveryState,
  ];
}

/**
 * Why: Gives dispatch and receipt APIs one nominal attempt constraint while preserving exact hidden type state.
 * Use: Accept any engine-minted attempt and recover its exact members through the helper types below.
 */
export interface OperationAttemptRefMarker {
  readonly ref: string;
  readonly recovery: RegisteredOperationRecoveryPlan;
  readonly [operationAttemptBrand]: readonly [
    primary: ProtectedOperationDefinition,
    primaryCandidate: unknown,
    primaryIdempotencyKey: string,
    recovery: OperationRecoveryStateMarker,
  ];
}

/**
 * Why: Recovers an attempt's exact primary definition.
 * Use: Freeze dispatch and receipt inference to that definition.
 */
export type OperationAttemptPrimaryOf<Attempt extends OperationAttemptRefMarker> =
  Attempt[typeof operationAttemptBrand][0];

/**
 * Why: Recovers an attempt's exact frozen primary candidate.
 * Use: Preserve its input and digest identity.
 */
export type OperationAttemptCandidateOf<Attempt extends OperationAttemptRefMarker> =
  Attempt[typeof operationAttemptBrand][1] extends OperationCandidateRef<OperationAttemptPrimaryOf<Attempt>>
    ? Attempt[typeof operationAttemptBrand][1]
    : never;

/**
 * Why: Recovers an attempt's primary idempotency identity.
 * Use: Bind it unchanged into successful receipts.
 */
export type OperationAttemptIdempotencyOf<Attempt extends OperationAttemptRefMarker> =
  Attempt[typeof operationAttemptBrand][2];

/**
 * Why: Recovers an attempt's exact cancellation and compensation types.
 * Use: Drive result and recovery helpers.
 */
export type OperationAttemptRecoveryOf<Attempt extends OperationAttemptRefMarker> =
  Attempt[typeof operationAttemptBrand][3];

/**
 * Why: Recovers the host-bound cancellation definition registered on an attempt.
 * Use: Type automatic cleanup evidence.
 */
export type OperationAttemptCancellationOf<Attempt extends OperationAttemptRefMarker> =
  OperationAttemptRecoveryOf<Attempt>["cancellation"];

/**
 * Why: Recovers validated cancellation input.
 * Use: Bind exact input and output evidence to automatic cleanup.
 */
export type OperationAttemptCancellationInputOf<Attempt extends OperationAttemptRefMarker> =
  OperationAttemptRecoveryOf<Attempt>["cancellationInput"] extends OperationInputOf<
    OperationAttemptCancellationOf<Attempt>
  >
    ? OperationAttemptRecoveryOf<Attempt>["cancellationInput"]
    : never;

/**
 * Why: Recovers cancellation idempotency.
 * Use: Correlate replayed automatic cleanup with one remote intent.
 */
export type OperationAttemptCancellationIdempotencyOf<Attempt extends OperationAttemptRefMarker> =
  OperationAttemptRecoveryOf<Attempt>["cancellationIdempotencyKey"];

/**
 * Why: Recovers an optional protected compensation definition.
 * Use: Make compensation APIs uncallable when absent.
 */
export type OperationAttemptCompensationOf<Attempt extends OperationAttemptRefMarker> =
  OperationAttemptRecoveryOf<Attempt>["compensation"] extends ProtectedOperationDefinition
    ? OperationAttemptRecoveryOf<Attempt>["compensation"]
    : never;

/**
 * Why: Recovers validated compensation input.
 * Use: Type the receipt-bound candidate prepared after success.
 */
export type OperationAttemptCompensationInputOf<Attempt extends OperationAttemptRefMarker> =
  OperationAttemptRecoveryOf<Attempt>["compensationInput"] extends OperationInputOf<
    OperationAttemptCompensationOf<Attempt>
  >
    ? OperationAttemptRecoveryOf<Attempt>["compensationInput"]
    : never;

/**
 * Why: Binds a schema-validated successful primary response back to the exact pre-dispatch attempt.
 * Use: Consume its output and use it as the only nominal source for protected compensation input.
 */
declare const recoverableOperationReceiptBrand: unique symbol;

/**
 * Why: Carries the attempt relationship layered onto exact primary execution evidence.
 * Use: Form nominal receipts.
 */
export interface RecoverableOperationReceiptIdentity<Attempt extends OperationAttemptRefMarker> {
  readonly attemptRef: Attempt["ref"];
  readonly [recoverableOperationReceiptBrand]: Attempt;
}

/**
 * Why: Proves successful schema-validated execution of the exact journaled attempt and idempotency identity.
 * Use: Read it only from the `succeeded` attempt outcome or pass it into compensation preparation.
 */
export type RecoverableOperationReceipt<Attempt extends OperationAttemptRefMarker> =
  OperationExecutionReceipt<
    OperationAttemptPrimaryOf<Attempt>,
    OperationAttemptCandidateOf<Attempt>,
    OperationAttemptIdempotencyOf<Attempt>
  > &
    RecoverableOperationReceiptIdentity<Attempt>;

/**
 * Why: Gives compensation methods one nominal receipt constraint.
 * Use: Recover its exact attempt with the helper.
 */
export interface RecoverableOperationReceiptMarker {
  readonly ref: string;
  readonly attemptRef: string;
  readonly [recoverableOperationReceiptBrand]: OperationAttemptRefMarker;
}

/**
 * Why: Recovers the exact attempt referenced by a success receipt.
 * Use: Select its registered compensation types.
 */
export type OperationReceiptAttemptOf<Receipt extends RecoverableOperationReceiptMarker> =
  Receipt[typeof recoverableOperationReceiptBrand];

/**
 * Why: Recovers the protected compensation definition registered on the receipt's exact primary attempt.
 * Use: Require that definition explicitly at compensation preparation and execution sites.
 */
export type OperationReceiptCompensationOf<Receipt extends RecoverableOperationReceiptMarker> =
  OperationAttemptCompensationOf<OperationReceiptAttemptOf<Receipt>>;

/**
 * Why: Recovers the validated input produced by the registered success-receipt mapper.
 * Use: Freeze it into a nominal protected candidate before requesting compensation authority.
 */
export type OperationReceiptCompensationInputOf<Receipt extends RecoverableOperationReceiptMarker> =
  OperationAttemptCompensationInputOf<OperationReceiptAttemptOf<Receipt>>;

/**
 * Why: Classifies only host-observed unsuccessful effects, including uncertainty after transport or process loss.
 * Use: Never derive it by catching arbitrary workflow exceptions; unknown post-dispatch state is `ambiguous`.
 */
export type OperationUnsuccessfulDisposition = "retryable" | "terminal" | "ambiguous";

/**
 * Why: Preserves bounded host evidence behind every retryable, terminal, or ambiguous classification.
 * Use: Report adapter code, reason, attempt count, and observation time without fabricating an operation output.
 */
export interface OperationFailureDetail {
  readonly code: string;
  readonly reason: string;
  readonly attempts: number;
  readonly observedAt: string;
}

/**
 * Why: Prevents workflow-created objects from posing as host-classified primary attempt outcomes.
 * Use: It is carried by every non-success attempt result minted by the engine.
 */
declare const operationAttemptOutcomeBrand: unique symbol;

/**
 * Why: Proves the provider did not commit a retryable or terminal primary attempt.
 * Use: Retry the same journaled attempt only for `retryable`; stop forward progress for `terminal`.
 */
export interface OperationAttemptNotCommitted<
  Attempt extends OperationAttemptRefMarker,
  Status extends "retryable" | "terminal",
> {
  readonly status: Status;
  readonly commit: "not-committed";
  readonly attemptRef: Attempt["ref"];
  readonly failure: OperationFailureDetail;
  readonly [operationAttemptOutcomeBrand]: Attempt;
}

/**
 * Why: Prevents workflow-created objects from posing as engine evidence for automatic conditional cancellation.
 * Use: It binds cleanup output or failure classification to the exact ambiguous primary attempt.
 */
declare const operationCancellationEvidenceBrand: unique symbol;

/**
 * Why: Carries exact provenance shared by all automatic cancellation outcomes.
 * Use: Correlate host cleanup with the registered definition, frozen mapped input, and idempotency identity.
 */
export interface OperationCancellationEvidenceBase<Attempt extends OperationAttemptRefMarker> {
  readonly attemptRef: Attempt["ref"];
  readonly operation: OperationAttemptCancellationOf<Attempt>["name"];
  readonly definitionDigest: string;
  readonly inputDigest: string;
  readonly idempotencyKey: OperationAttemptCancellationIdempotencyOf<Attempt>;
  readonly [operationCancellationEvidenceBrand]: Attempt;
}

/**
 * Why: Proves the engine's pre-authorized direct cleanup produced schema-validated cancellation output.
 * Use: Record it as exact cancellation evidence for an ambiguous primary dispatch.
 */
export interface OperationCancellationSucceeded<Attempt extends OperationAttemptRefMarker>
  extends OperationCancellationEvidenceBase<Attempt> {
  readonly status: "succeeded";
  readonly output: OperationOutputOf<OperationAttemptCancellationOf<Attempt>>;
  readonly outputDigest: string;
  readonly completedAt: string;
}

/**
 * Why: Makes an unresolved automatic cancellation host-classified and nominal instead of boolean retry advice.
 * Use: Narrow the explicit disposition and preserve failure evidence for replay or manual reconciliation.
 */
export interface OperationCancellationUnsuccessful<
  Attempt extends OperationAttemptRefMarker,
  Status extends OperationUnsuccessfulDisposition,
> extends OperationCancellationEvidenceBase<Attempt> {
  readonly status: Status;
  readonly failure: OperationFailureDetail;
}

/**
 * Why: Exhaustively reports the direct cleanup the engine performs after an ambiguous primary dispatch.
 * Use: Treat only `succeeded` as confirmed cleanup; an ambiguous cancellation may itself have committed.
 */
export type OperationCancellationResult<Attempt extends OperationAttemptRefMarker> =
  | OperationCancellationSucceeded<Attempt>
  | OperationCancellationUnsuccessful<Attempt, "retryable">
  | OperationCancellationUnsuccessful<Attempt, "terminal">
  | OperationCancellationUnsuccessful<Attempt, "ambiguous">;

/**
 * Why: Represents a dispatch whose commit state the host cannot prove after all bounded attempts.
 * Use: Inspect mandatory automatic cancellation evidence before deciding whether external reconciliation remains.
 */
export interface OperationAttemptAmbiguous<Attempt extends OperationAttemptRefMarker> {
  readonly status: "ambiguous";
  readonly commit: "may-have-committed";
  readonly attemptRef: Attempt["ref"];
  readonly failure: OperationFailureDetail;
  readonly cancellation: OperationCancellationResult<Attempt>;
  readonly [operationAttemptOutcomeBrand]: Attempt;
}

/**
 * Why: Keeps the successful receipt in the same exhaustive host-minted result as non-commit and ambiguity evidence.
 * Use: Narrow on `status`; compensation is available only through the receipt in this branch.
 */
export interface OperationAttemptSucceeded<Attempt extends OperationAttemptRefMarker> {
  readonly status: "succeeded";
  readonly receipt: RecoverableOperationReceipt<Attempt>;
  readonly [operationAttemptOutcomeBrand]: Attempt;
}

/**
 * Why: Makes primary dispatch outcome complete without letting arbitrary caught errors claim provider state.
 * Use: Branch on succeeded, retryable non-commit, terminal non-commit, or ambiguous may-have-committed.
 */
export type OperationAttemptResult<Attempt extends OperationAttemptRefMarker> =
  | OperationAttemptSucceeded<Attempt>
  | OperationAttemptNotCommitted<Attempt, "retryable">
  | OperationAttemptNotCommitted<Attempt, "terminal">
  | OperationAttemptAmbiguous<Attempt>;

/**
 * Why: Prevents a compensation candidate prepared from one success receipt from being paired with another receipt.
 * Use: Authorize it through the ordinary protected path, then pass it to explicit `recover`.
 */
declare const operationRecoveryCandidateBrand: unique symbol;

/**
 * Why: Carries the success-receipt relationship layered onto an ordinary protected compensation candidate.
 * Use: Intersect it through `OperationRecoveryCandidateRef`, then authorize that candidate normally.
 */
export interface OperationRecoveryCandidateIdentity<Receipt extends RecoverableOperationReceiptMarker> {
  readonly primaryReceiptRef: Receipt["ref"];
  readonly recoveryRegistrationRef: string;
  readonly recoveryKind: "compensation";
  readonly [operationRecoveryCandidateBrand]: Receipt;
}

/**
 * Why: Binds schema-validated compensation input to exact success evidence and its pre-dispatch registration.
 * Use: Obtain it only from `ctx.operation.prepareRecovery`; ordinary output-shaped handles cannot substitute.
 */
export type OperationRecoveryCandidateRef<Receipt extends RecoverableOperationReceiptMarker> =
  OperationCandidateRef<
    OperationReceiptCompensationOf<Receipt>,
    OperationReceiptCompensationInputOf<Receipt>
  > &
    OperationRecoveryCandidateIdentity<Receipt>;

/**
 * Why: Prevents workflow-created objects from posing as engine evidence for a recovery attempt.
 * Use: It binds success and every host-classified failure to the same receipt, candidate, and idempotency identity.
 */
declare const operationRecoveryEvidenceBrand: unique symbol;

/**
 * Why: Carries exact provenance shared by successful and failed cancellation or compensation attempts.
 * Use: Correlate a recovery result with its primary receipt, registered relation, frozen input, and authority.
 */
export interface OperationRecoveryEvidenceBase<
  Receipt extends RecoverableOperationReceiptMarker,
  RecoveryCandidate extends OperationRecoveryCandidateRef<Receipt>,
  RecoveryIdempotencyKey extends string,
> {
  readonly kind: "compensation";
  readonly primaryReceiptRef: Receipt["ref"];
  readonly recoveryRegistrationRef: string;
  readonly operation: OperationReceiptCompensationOf<Receipt>["name"];
  readonly definitionDigest: RecoveryCandidate["definitionDigest"];
  readonly inputDigest: RecoveryCandidate["inputDigest"];
  readonly candidateRef: RecoveryCandidate["ref"];
  readonly authorizationRef: string;
  readonly idempotencyKey: RecoveryIdempotencyKey;
  readonly [operationRecoveryEvidenceBrand]: readonly [
    receipt: Receipt,
    recovery: OperationReceiptCompensationOf<Receipt>,
    candidate: RecoveryCandidate,
    idempotencyKey: RecoveryIdempotencyKey,
  ];
}

/**
 * Why: Proves that an explicitly invoked recovery produced a schema-validated output for its exact frozen input.
 * Use: Record `receipt` as terminal cancellation or compensation evidence.
 */
export interface OperationRecoverySucceeded<
  Receipt extends RecoverableOperationReceiptMarker,
  RecoveryCandidate extends OperationRecoveryCandidateRef<Receipt>,
  RecoveryIdempotencyKey extends string,
> extends OperationRecoveryEvidenceBase<Receipt, RecoveryCandidate, RecoveryIdempotencyKey> {
  readonly status: "succeeded";
  readonly receipt: OperationExecutionReceipt<
    OperationReceiptCompensationOf<Receipt>,
    RecoveryCandidate,
    RecoveryIdempotencyKey
  >;
}

/**
 * Why: Proves the engine attempted exact compensation but classified it without schema-validated success.
 * Use: Preserve explicit retryable, terminal, or ambiguous evidence; unknown post-dispatch state is ambiguous.
 */
export interface OperationRecoveryUnsuccessful<
  Receipt extends RecoverableOperationReceiptMarker,
  RecoveryCandidate extends OperationRecoveryCandidateRef<Receipt>,
  RecoveryIdempotencyKey extends string,
  Status extends OperationUnsuccessfulDisposition,
> extends OperationRecoveryEvidenceBase<Receipt, RecoveryCandidate, RecoveryIdempotencyKey> {
  readonly status: Status;
  readonly commit: Status extends "ambiguous" ? "may-have-committed" : "not-committed";
  readonly failure: OperationFailureDetail;
}

/**
 * Why: Makes successful and unresolved recovery outcomes exhaustively branchable at the workflow boundary.
 * Use: Narrow on `status`; neither branch hides the explicit `prepareRecovery`, `authorize`, or `recover` effects.
 */
export type OperationRecoveryResult<
  Receipt extends RecoverableOperationReceiptMarker,
  RecoveryCandidate extends OperationRecoveryCandidateRef<Receipt>,
  RecoveryIdempotencyKey extends string,
> =
  | OperationRecoverySucceeded<Receipt, RecoveryCandidate, RecoveryIdempotencyKey>
  | OperationRecoveryUnsuccessful<Receipt, RecoveryCandidate, RecoveryIdempotencyKey, "retryable">
  | OperationRecoveryUnsuccessful<Receipt, RecoveryCandidate, RecoveryIdempotencyKey, "terminal">
  | OperationRecoveryUnsuccessful<Receipt, RecoveryCandidate, RecoveryIdempotencyKey, "ambiguous">;

/**
 * Why: Makes protected operation execution a three-step type-state while keeping explicit no-authorization calls terse.
 * Use: Call definitions with `mode: "none"` directly; otherwise prepare, authorize, and execute in order.
 */
export interface OperationFn {
  <Definition extends DirectOperationDefinition>(
    definition: Definition,
    input: OperationInputOf<Definition>,
    options: OperationInvocationOptions,
  ): Promise<OperationOutputOf<Definition>>;
  prepare<Definition extends ProtectedOperationDefinition, Input extends OperationInputOf<Definition>>(
    definition: Definition,
    input: Input,
    options: OperationPrepareOptions,
  ): Promise<OperationCandidateRef<Definition, Input>>;
  authorize<
    Definition extends ProtectedOperationDefinition,
    Candidate extends OperationCandidateRef<Definition>,
  >(
    definition: Definition,
    candidate: Candidate,
    options: OperationAuthorizeOptions,
  ): Promise<OperationAuthorizationRef<Definition, Candidate>>;
  execute<
    Definition extends ProtectedOperationDefinition,
    Candidate extends OperationCandidateRef<Definition>,
  >(
    definition: Definition,
    execution: ProtectedOperationExecution<Definition, Candidate>,
    options: OperationInvocationOptions,
  ): Promise<OperationOutputOf<Definition>>;
  /**
   * Atomically journals primary intent and direct conditional cancellation before the adapter may be dispatched.
   * The returned attempt is pre-dispatch evidence, not proof that the primary operation ran or succeeded.
   */
  recoverable<
    Primary extends ProtectedOperationDefinition,
    PrimaryCandidate extends OperationCandidateRef<Primary>,
    PrimaryIdempotencyKey extends string,
    Cancellation extends ConditionalCleanupOperationDefinition,
    CancellationInput extends OperationInputOf<Cancellation>,
    CancellationIdempotencyKey extends string,
  >(
    definition: Primary,
    execution: ProtectedOperationExecution<Primary, PrimaryCandidate>,
    recovery: OperationCancellationRecoveryPlan<
      Primary,
      PrimaryCandidate,
      PrimaryIdempotencyKey,
      Cancellation,
      CancellationInput,
      CancellationIdempotencyKey
    >,
    options: RecoverableOperationInvocationOptions<PrimaryIdempotencyKey>,
  ): Promise<
    OperationAttemptRef<
      Primary,
      PrimaryCandidate,
      PrimaryIdempotencyKey,
      OperationRecoveryState<Cancellation, CancellationInput, CancellationIdempotencyKey, null, never>
    >
  >;
  /**
   * Atomically adds protected post-success compensation to mandatory direct conditional cancellation.
   * Compensation remains inert until a success receipt is explicitly prepared, authorized, and recovered.
   */
  recoverable<
    Primary extends ProtectedOperationDefinition,
    PrimaryCandidate extends OperationCandidateRef<Primary>,
    PrimaryIdempotencyKey extends string,
    Cancellation extends ConditionalCleanupOperationDefinition,
    CancellationInput extends OperationInputOf<Cancellation>,
    CancellationIdempotencyKey extends string,
    Compensation extends ProtectedOperationDefinition,
    CompensationInput extends OperationInputOf<Compensation>,
  >(
    definition: Primary,
    execution: ProtectedOperationExecution<Primary, PrimaryCandidate>,
    recovery: OperationCompensatedRecoveryPlan<
      Primary,
      PrimaryCandidate,
      PrimaryIdempotencyKey,
      Cancellation,
      CancellationInput,
      CancellationIdempotencyKey,
      Compensation,
      CompensationInput
    >,
    options: RecoverableOperationInvocationOptions<PrimaryIdempotencyKey>,
  ): Promise<
    OperationAttemptRef<
      Primary,
      PrimaryCandidate,
      PrimaryIdempotencyKey,
      OperationRecoveryState<
        Cancellation,
        CancellationInput,
        CancellationIdempotencyKey,
        Compensation,
        CompensationInput
      >
    >
  >;
  /**
   * Dispatches one journaled attempt and returns only an engine-minted commit classification.
   * Ambiguity triggers the attempt's pre-authorized direct cancellation before this lifecycle settles.
   */
  executeRecoverable<Attempt extends OperationAttemptRefMarker>(
    definition: NoInfer<OperationAttemptPrimaryOf<Attempt>>,
    attempt: Attempt,
  ): Promise<OperationAttemptResult<Attempt>>;
  /**
   * Runs the registered success-receipt mapper and schema-validates protected compensation input.
   * No pre-dispatch attempt or ordinary output-shaped value can enter this compensation path.
   */
  prepareRecovery<Receipt extends RecoverableOperationReceiptMarker>(
    receipt: Receipt,
    definition: NoInfer<OperationReceiptCompensationOf<Receipt>>,
    options: OperationPrepareOptions,
  ): Promise<OperationRecoveryCandidateRef<Receipt>>;
  /**
   * Explicitly invokes protected compensation and returns host-minted success or commit classification evidence.
   * The definition argument keeps the effect visible; unknown post-dispatch errors become `ambiguous`.
   */
  recover<
    Receipt extends RecoverableOperationReceiptMarker,
    RecoveryCandidate extends OperationRecoveryCandidateRef<Receipt>,
    RecoveryIdempotencyKey extends string,
  >(
    receipt: Receipt,
    definition: NoInfer<OperationReceiptCompensationOf<Receipt>>,
    execution: ProtectedOperationExecution<OperationReceiptCompensationOf<Receipt>, RecoveryCandidate>,
    options: RecoverableOperationInvocationOptions<RecoveryIdempotencyKey>,
  ): Promise<OperationRecoveryResult<Receipt, RecoveryCandidate, RecoveryIdempotencyKey>>;
}
