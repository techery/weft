/** Declaration-only verified-delivery surface for the Weft DSL prototype. */

import type { ArtifactRefBase } from "./artifacts.ts";
import type { OperationCapability } from "./operations.ts";
import type {
  AnySchema,
  Duration,
  HostBinding,
  InferIn,
  InferOut,
  Risk,
  SubjectAttestation,
  WorkflowNode,
  WorkspaceSubject,
} from "./shared.ts";

// ---------------------------------------------------------------------------
// Generation-bound promotion and delivery
// ---------------------------------------------------------------------------

/**
 * Why: Makes the approval policy for one delivery kind inspectable before a candidate exists.
 * Use: Declare the action and risk on `defineDelivery`; host policy may approve, deny, or ask a person.
 */
export interface DeliveryAuthorizationPolicy {
  action: string;
  risk: Risk;
  timeout?: Duration;
}

/**
 * Why: Centralizes retry, timeout, and mandatory authorization policy for an atomic host delivery.
 * Use: Set it on a delivery definition and tighten execution limits at an individual invocation.
 */
export interface DeliveryDefaults {
  timeout?: Duration;
  attempts?: number;
  authorization: DeliveryAuthorizationPolicy;
}

/**
 * Why: Represents one host-bound promotion contract whose input is frozen before authorization.
 * Use: Create it with `defineDelivery`, prepare a verified candidate, authorize it, then execute it through `ctx.delivery`.
 */
export interface DeliveryDefinition<
  InputSchema extends AnySchema,
  OutputSchema extends AnySchema,
  Name extends string = string,
> extends WorkflowNode<"weft.delivery"> {
  readonly kind: "weft.delivery";
  readonly name: Name;
  readonly description?: string;
  readonly binding: HostBinding;
  readonly input: InputSchema;
  readonly output: OutputSchema;
  readonly capabilities: readonly OperationCapability[];
  readonly defaults: Readonly<DeliveryDefaults>;
}

/**
 * Why: Declares all portable fields needed for an atomic, authorized host delivery without embedding adapter code.
 * Use: Pass it to `defineDelivery`; use `defineOperation` for effects that do not require verified promotion state.
 */
export interface DeliveryConfig<
  InputSchema extends AnySchema,
  OutputSchema extends AnySchema,
  Name extends string = string,
> {
  name: Name;
  description?: string;
  binding: HostBinding;
  input: InputSchema;
  output: OutputSchema;
  capabilities: readonly OperationCapability[];
  defaults: DeliveryDefaults;
}

/**
 * Why: Declares one verified promotion boundary while keeping its implementation and authority in the host.
 * Use: Define Git publication, pull-request, release, or deployment delivery contracts at module scope.
 */
export declare function defineDelivery<
  InputSchema extends AnySchema,
  OutputSchema extends AnySchema,
  const Name extends string,
>(
  config: DeliveryConfig<InputSchema, OutputSchema, Name>,
): DeliveryDefinition<InputSchema, OutputSchema, Name>;

/**
 * Why: Recovers the raw input frozen into a promotion candidate for one delivery definition.
 * Use: It supplies `PromotionCandidateInput.input` and prevents swapping delivery parameters after approval.
 */
export type DeliveryInputOf<Definition> =
  Definition extends DeliveryDefinition<infer InputSchema, infer _OutputSchema>
    ? InferIn<InputSchema>
    : never;

/**
 * Why: Recovers the validated host receipt payload returned by one delivery definition.
 * Use: It supplies `DeliveryReceipt.value` after atomic delivery execution.
 */
export type DeliveryOutputOf<Definition> =
  Definition extends DeliveryDefinition<infer _InputSchema, infer OutputSchema>
    ? InferOut<OutputSchema>
    : never;

/**
 * Why: Requires at least one engine-minted, subject-bound proof before a promotion candidate can be prepared.
 * Use: Provide check, goal, or review attestations that all name the same candidate subject.
 */
export type PromotionEvidence<Subject extends WorkspaceSubject = WorkspaceSubject> = readonly [
  SubjectAttestation<string, unknown, Subject>,
  ...additional: SubjectAttestation<string, unknown, Subject>[],
];

/**
 * Why: Collects the exact generation, frozen delivery input, proof, and immutable supporting artifacts atomically.
 * Use: Pass it to `ctx.delivery.prepare`; the engine rejects mixed or stale subjects before minting a candidate.
 */
export interface PromotionCandidateInput<
  Definition extends DeliveryDefinition<any, any>,
  Subject extends WorkspaceSubject = WorkspaceSubject,
> {
  subject: Subject;
  input: DeliveryInputOf<Definition>;
  evidence: PromotionEvidence<NoInfer<Subject>>;
  artifacts?: readonly ArtifactRefBase<unknown>[];
  rollback?: ArtifactRefBase<unknown>;
}

/**
 * Why: Prevents workflows from constructing a promotion candidate by copying verified-looking strings and hashes.
 * Use: It is minted only after the engine validates every proof and freezes the delivery input.
 */
declare const promotionCandidateBrand: unique symbol;

/**
 * Why: Represents a verified, immutable delivery input bound to one exact workspace generation.
 * Use: Request authorization for it and pass the same reference to delivery execution.
 */
export interface PromotionCandidateRef<
  Definition extends DeliveryDefinition<any, any>,
  Subject extends WorkspaceSubject = WorkspaceSubject,
> {
  readonly ref: string;
  readonly delivery: Definition["name"];
  readonly subject: Subject;
  readonly inputDigest: string;
  readonly evidence: PromotionEvidence<Subject>;
  readonly artifacts: readonly ArtifactRefBase<unknown>[];
  readonly rollback?: ArtifactRefBase<unknown>;
  readonly preparedAt: string;
  readonly [promotionCandidateBrand]: Definition;
}

/**
 * Why: Prevents a general gate answer or approval for another candidate from authorizing delivery.
 * Use: Receive it from `ctx.delivery.authorize` and pass it unchanged with its candidate to `ctx.delivery`.
 */
declare const deliveryAuthorizationBrand: unique symbol;

/**
 * Why: Carries nominal authority tied to one frozen promotion candidate and delivery definition.
 * Use: Treat it as a single-use capability for the corresponding delivery call, not as reusable evidence.
 */
export interface DeliveryAuthorizationRef<
  Definition extends DeliveryDefinition<any, any>,
  Candidate extends PromotionCandidateRef<Definition, WorkspaceSubject>,
> {
  readonly ref: string;
  readonly candidateRef: Candidate["ref"];
  readonly subject: Candidate["subject"];
  readonly action: string;
  readonly risk: Risk;
  readonly approvedBy: "human" | "policy";
  readonly approvedAt: string;
  readonly [deliveryAuthorizationBrand]: Definition;
}

/**
 * Why: Supplies durable identity and labels while the engine validates and freezes a promotion candidate.
 * Use: Pass it to `ctx.delivery.prepare` with a stable key.
 */
export interface DeliveryPrepareOptions {
  key: string;
  label?: string;
}

/**
 * Why: Adds candidate-specific detail and timeout to the authorization policy declared by a delivery definition.
 * Use: Pass it to `ctx.delivery.authorize`; it cannot weaken the definition's action or risk.
 */
export interface DeliveryAuthorizeOptions {
  key: string;
  label?: string;
  detail?: string;
  timeout?: Duration;
}

/**
 * Why: Pairs exactly one promotion candidate with the authorization minted for that candidate.
 * Use: Construct it only from the two results returned by `prepare` and `authorize` for the same definition.
 */
export interface DeliveryRunRequest<
  Definition extends DeliveryDefinition<any, any>,
  Candidate extends PromotionCandidateRef<Definition, WorkspaceSubject>,
> {
  candidate: Candidate;
  authorization: DeliveryAuthorizationRef<Definition, Candidate>;
}

/**
 * Why: Supplies durable identity and bounded retry limits for atomic delivery execution.
 * Use: Pass it to the callable `ctx.delivery` after candidate preparation and authorization.
 */
export interface DeliveryInvocationOptions {
  key: string;
  label?: string;
  timeout?: Duration;
  attempts?: number;
}

/**
 * Why: Returns host-validated output and an attested link to the exact candidate that was delivered.
 * Use: Read `value` for provider data and retain `attestation` for later CI observation or audit.
 */
export interface DeliveryReceipt<
  Definition extends DeliveryDefinition<any, any>,
  Candidate extends PromotionCandidateRef<Definition, WorkspaceSubject>,
> {
  readonly value: DeliveryOutputOf<Definition>;
  readonly candidate: Candidate;
  readonly subject: Candidate["subject"];
  readonly binding: Definition["binding"];
  readonly idempotencyKey: string;
  readonly deliveredAt: string;
  readonly attestation: SubjectAttestation<"delivery", DeliveryOutputOf<Definition>, Candidate["subject"]>;
}

/**
 * Why: Models verified promotion as three explicit type-state transitions rather than a stringly operation call.
 * Use: Prepare proof, authorize the frozen candidate, then call the function to execute the atomic host delivery.
 */
export interface DeliveryFn {
  prepare<Definition extends DeliveryDefinition<any, any>, Subject extends WorkspaceSubject>(
    definition: Definition,
    input: PromotionCandidateInput<Definition, Subject>,
    options: DeliveryPrepareOptions,
  ): Promise<PromotionCandidateRef<Definition, Subject>>;
  authorize<
    Definition extends DeliveryDefinition<any, any>,
    Candidate extends PromotionCandidateRef<Definition, WorkspaceSubject>,
  >(
    definition: Definition,
    candidate: Candidate,
    options: DeliveryAuthorizeOptions,
  ): Promise<DeliveryAuthorizationRef<Definition, Candidate>>;
  <
    Definition extends DeliveryDefinition<any, any>,
    Candidate extends PromotionCandidateRef<Definition, WorkspaceSubject>,
  >(
    definition: Definition,
    request: DeliveryRunRequest<Definition, Candidate>,
    options: DeliveryInvocationOptions,
  ): Promise<DeliveryReceipt<Definition, Candidate>>;
}
