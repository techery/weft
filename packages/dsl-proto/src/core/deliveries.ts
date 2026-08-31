/** Declaration-only verified-delivery surface for the Weft DSL prototype. */

import type { ArtifactRefBase } from "./artifacts.ts";
import type { OperationCapability } from "./operations.ts";
import type {
  AnySchema,
  Duration,
  HostBinding,
  InferIn,
  InferOut,
  NominalValue,
  PromotionProof,
  Risk,
  SubjectAttestation,
  WorkflowNode,
  WorkspaceSnapshotRef,
} from "./shared.ts";

// ---------------------------------------------------------------------------
// Generation-bound promotion and delivery
// ---------------------------------------------------------------------------

/**
 * Why: Makes the approval policy for one delivery kind inspectable before a candidate exists.
 * Use: Declare the action and risk on `defineDelivery`; host policy may approve, deny, or ask a person.
 */
export interface DeliveryAuthorizationPolicy {
  readonly action: string;
  readonly risk: Risk;
  readonly timeout?: Duration;
}

/**
 * Why: Centralizes retry, timeout, and mandatory authorization policy for an atomic host delivery.
 * Use: Set it on a delivery definition and tighten execution limits at an individual invocation.
 */
export interface DeliveryDefaults {
  readonly timeout?: Duration;
  readonly attempts?: number;
  readonly authorization: Readonly<DeliveryAuthorizationPolicy>;
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
 * Why: Requires at least one engine-minted proof before a workspace candidate can be prepared.
 * Use: Provide check, goal, or review proofs that all name the same candidate snapshot.
 */
export type PromotionProofs<Snapshot extends WorkspaceSnapshotRef = WorkspaceSnapshotRef> = readonly [
  PromotionProof<"check" | "review" | "goal", Snapshot>,
  ...additional: PromotionProof<"check" | "review" | "goal", Snapshot>[],
];

/**
 * Why: Preserves a migration name while preventing arbitrary attestations from satisfying promotion policy.
 * Use: Prefer `PromotionProofs`; this alias now accepts only positive proof handles.
 */
export type PromotionEvidence<Snapshot extends WorkspaceSnapshotRef = WorkspaceSnapshotRef> =
  PromotionProofs<Snapshot>;

/**
 * Why: Collects the exact snapshot, frozen delivery input, proofs, and immutable supporting artifacts atomically.
 * Use: The host derives it from a `ctx.delivery` request and rejects mixed or stale snapshots.
 */
export interface PromotionCandidateInput<
  Definition extends DeliveryDefinition<any, any>,
  Snapshot extends WorkspaceSnapshotRef = WorkspaceSnapshotRef,
> {
  snapshot: Snapshot;
  input: DeliveryInputOf<Definition>;
  proofs: PromotionProofs<NoInfer<Snapshot>>;
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
  Snapshot extends WorkspaceSnapshotRef = WorkspaceSnapshotRef,
> extends NominalValue<readonly ["promotion-candidate", Definition, Snapshot]> {
  readonly ref: string;
  readonly delivery: Definition["name"];
  readonly snapshot: Snapshot;
  readonly inputDigest: string;
  readonly proofs: PromotionProofs<Snapshot>;
  readonly artifacts: readonly ArtifactRefBase<unknown>[];
  readonly rollback?: ArtifactRefBase<unknown>;
  readonly preparedAt: string;
  readonly [promotionCandidateBrand]: Definition;
}

/**
 * Why: Recovers the delivery definition already carried nominally by an engine-minted promotion candidate.
 * Use: Build internal lifecycle helpers without repeating the delivery definition.
 */
export type PromotionCandidateDefinitionOf<Candidate> =
  Candidate extends PromotionCandidateRef<infer Definition, any> ? Definition : never;

/**
 * Why: Recovers the exact workspace snapshot already frozen into a promotion candidate.
 * Use: Preserve snapshot correlation when later delivery stages infer their definition from the candidate.
 */
export type PromotionCandidateSnapshotOf<Candidate> =
  Candidate extends PromotionCandidateRef<any, infer Snapshot> ? Snapshot : never;

/**
 * Why: Prevents a general gate answer or approval for another candidate from authorizing delivery.
 * Use: The engine mints it during the one-shot `ctx.delivery` lifecycle and consumes it with the same candidate.
 */
declare const deliveryAuthorizationBrand: unique symbol;

/**
 * Why: Carries nominal authority tied to one frozen promotion candidate and delivery definition.
 * Use: Treat it as a single-use capability for the corresponding delivery call, not as reusable evidence.
 */
export interface DeliveryAuthorizationRef<
  Definition extends DeliveryDefinition<any, any>,
  Candidate extends PromotionCandidateRef<Definition, WorkspaceSnapshotRef>,
> extends NominalValue<readonly ["delivery-authorization", Definition, Candidate]> {
  readonly ref: string;
  readonly candidateRef: Candidate["ref"];
  readonly snapshot: Candidate["snapshot"];
  readonly action: string;
  readonly risk: Risk;
  readonly approvedBy: "human" | "policy";
  readonly approvedAt: string;
  readonly [deliveryAuthorizationBrand]: Definition;
}

/**
 * Why: Recovers the delivery definition already bound into candidate-specific delivery authority.
 * Use: Infer receipt output when internal execution starts from the authorization reference.
 */
export type DeliveryAuthorizationDefinitionOf<Authorization> =
  Authorization extends DeliveryAuthorizationRef<infer Definition, any> ? Definition : never;

/**
 * Why: Recovers the exact promotion candidate already bound into delivery authority.
 * Use: Preserve its snapshot and proof relationships in an authorization-only execution result.
 */
export type DeliveryAuthorizationCandidateOf<Authorization> =
  Authorization extends DeliveryAuthorizationRef<any, infer Candidate> ? Candidate : never;

/**
 * Why: Supplies durable identity and labels while the engine validates and freezes a promotion candidate.
 * Use: The engine derives it from the stable key on the public `ctx.delivery` call.
 */
export interface DeliveryPrepareOptions {
  key: string;
  label?: string;
}

/**
 * Why: Adds candidate-specific detail and timeout to the authorization policy declared by a delivery definition.
 * Use: The engine derives it from public authorization presentation; it cannot weaken action or risk.
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
  Candidate extends PromotionCandidateRef<Definition, WorkspaceSnapshotRef>,
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
 * Why: Carries candidate-specific approval presentation inside one author-facing delivery call.
 * Use: Supply optional detail or a tighter approval timeout without changing declared action or risk.
 */
export interface DeliveryRunAuthorizationOptions {
  detail?: string;
  timeout?: Duration;
  readonly action?: never;
  readonly risk?: never;
}

/**
 * Why: Gives ordinary authors one durable delivery key while retaining the exact candidate and its proofs.
 * Use: Pass it to `ctx.delivery`; the host atomically rejects stale candidates or mismatched proofs.
 */
export interface DeliveryOneShotRequest<
  Definition extends DeliveryDefinition<any, any>,
  Snapshot extends WorkspaceSnapshotRef = WorkspaceSnapshotRef,
> {
  key: string;
  label?: string;
  candidate: Snapshot;
  input: DeliveryInputOf<Definition>;
  proofs: PromotionProofs<NoInfer<Snapshot>>;
  artifacts?: readonly ArtifactRefBase<unknown>[];
  rollback?: ArtifactRefBase<unknown>;
  timeout?: Duration;
  attempts?: number;
  authorization: DeliveryRunAuthorizationOptions;
}

/**
 * Why: Returns host-validated output and an attested link to the exact candidate that was delivered.
 * Use: Read `value` for provider data and retain `attestation` for later CI observation or audit.
 */
export interface DeliveryReceipt<
  Definition extends DeliveryDefinition<any, any>,
  Candidate extends PromotionCandidateRef<Definition, WorkspaceSnapshotRef>,
> {
  readonly value: DeliveryOutputOf<Definition>;
  readonly candidate: Candidate;
  readonly snapshot: Candidate["snapshot"];
  readonly binding: Definition["binding"];
  readonly idempotencyKey: string;
  readonly deliveredAt: string;
  readonly attestation: SubjectAttestation<"delivery", DeliveryOutputOf<Definition>, Candidate["snapshot"]>;
}

/** One-shot verified delivery call. */
export type DeliveryApi = <
  Definition extends DeliveryDefinition<any, any>,
  Snapshot extends WorkspaceSnapshotRef,
>(
  definition: Definition,
  request: DeliveryOneShotRequest<Definition, Snapshot>,
) => Promise<DeliveryReceipt<Definition, PromotionCandidateRef<Definition, Snapshot>>>;
