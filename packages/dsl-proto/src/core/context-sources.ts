/** Declaration-only host-bound context source surface for the Weft DSL prototype. */

import type {
  AnySchema,
  Duration,
  EvidenceRef,
  HostBinding,
  InferIn,
  InferOut,
  NominalValue,
  WorkflowNode,
} from "./shared.ts";

// ---------------------------------------------------------------------------
// Read-only context sources and provenance-bearing snapshots
// ---------------------------------------------------------------------------

/**
 * Why: Distinguishes merely supplied context from authenticated or system-of-record data without treating either as authorization.
 * Use: Set the minimum acceptable level on a source and inspect the host-attested level on each returned snapshot.
 */
export type ContextTrustLevel = "untrusted" | "authenticated" | "authoritative";

/**
 * Why: Makes the trust floor for a host-bound source explicit and independently enforceable by the host.
 * Use: Require the weakest acceptable source identity; use `authorities` when only named issuers may satisfy it.
 */
export interface ContextTrustPolicy {
  minimum: ContextTrustLevel;
  authorities?: readonly string[];
}

/**
 * Why: Records the trust classification the host actually established instead of copying the declaration's requested policy.
 * Use: Preserve it with the snapshot and branch on `level` before using context for consequential decisions.
 */
export interface ContextTrustMetadata<
  Level extends ContextTrustLevel = ContextTrustLevel,
  Authority extends string = string,
> {
  level: Level;
  authority: Authority;
}

/**
 * Why: Forces every source to state when an observation becomes stale and what invocation should do at that boundary.
 * Use: Choose `reject` for current-state decisions or `allow` when historical context remains useful if clearly marked.
 */
export interface ContextFreshnessPolicy {
  maxAge: Duration;
  stale: "reject" | "allow";
}

/**
 * Why: Keeps current and stale context distinguishable after resolution rather than relying on callers to compare timestamps.
 * Use: Inspect it on snapshots from sources whose policy permits stale observations.
 */
export type ContextFreshnessStatus = "fresh" | "stale";

/**
 * Why: Captures the host's observation window separately from the source's static freshness policy.
 * Use: Retain these timestamps with derived claims so later consumers can detect expired context.
 */
export interface ContextFreshnessMetadata<
  Status extends ContextFreshnessStatus = ContextFreshnessStatus,
> {
  observedAt: string;
  expiresAt: string;
  status: Status;
}

/**
 * Why: Retains the strongest trust level a source policy guarantees after the host rejects weaker observations.
 * Use: Derive snapshot trust metadata from a context source's declared minimum.
 */
export type ContextTrustLevelAtLeast<Level extends ContextTrustLevel> =
  Level extends "authoritative"
    ? "authoritative"
    : Level extends "authenticated"
      ? "authenticated" | "authoritative"
      : ContextTrustLevel;

/**
 * Why: Retains a source's declared authority literals while leaving unrestricted sources open to any host authority.
 * Use: Derive the `trust.authority` field of a context snapshot.
 */
export type ContextTrustAuthorityOf<Policy extends ContextTrustPolicy> =
  Policy extends { readonly authorities: readonly (infer Authority extends string)[] }
    ? Authority
    : string;

/**
 * Why: Makes a reject-stale policy guarantee a fresh returned snapshot while preserving both states for allow-stale sources.
 * Use: Derive the `freshness.status` field after host policy enforcement.
 */
export type ContextFreshnessStatusOf<Policy extends ContextFreshnessPolicy> =
  Policy["stale"] extends "reject" ? "fresh" : ContextFreshnessStatus;

/**
 * Why: Names the exact external subject selected by a source without exposing or replaying its potentially sensitive lookup input.
 * Use: Read it from snapshot evidence when correlating observations of the same host-canonical subject.
 */
export interface ContextSourceSubject<SourceName extends string = string> {
  source: SourceName;
  binding: HostBinding;
  key: string;
}

/**
 * Why: Prevents schema-shaped values from masquerading as context that the engine obtained through an authorized host read.
 * Use: It is carried only by `ContextSnapshot` values minted after binding resolution and output validation.
 */
declare const contextSnapshotBrand: unique symbol;

/**
 * Why: Couples validated context with host-observed freshness, trust, and nominal digest-addressed provenance.
 * Use: Consume `value` for reasoning and preserve `evidence` with any artifact or claim derived from the snapshot.
 */
export interface ContextSnapshot<
  Value,
  SourceName extends string = string,
  Freshness extends ContextFreshnessMetadata = ContextFreshnessMetadata,
  Trust extends ContextTrustMetadata = ContextTrustMetadata,
> extends NominalValue<readonly ["context-snapshot", SourceName, Value, Freshness, Trust]> {
  readonly source: SourceName;
  readonly value: Value;
  readonly freshness: Readonly<Freshness>;
  readonly trust: Readonly<Trust>;
  readonly evidence: EvidenceRef<"context-snapshot", Value, ContextSourceSubject<SourceName>>;
  readonly [contextSnapshotBrand]: true;
}

/**
 * Why: Represents one portable read-only integration whose raw lookup and returned value both cross schemas.
 * Use: Create it with `defineContextSource`, then resolve it only through the workflow's `ContextFn` capability.
 */
export interface ContextSourceDefinition<
  InputSchema extends AnySchema,
  OutputSchema extends AnySchema,
  Name extends string = string,
  Freshness extends ContextFreshnessPolicy = ContextFreshnessPolicy,
  Trust extends ContextTrustPolicy = ContextTrustPolicy,
> extends WorkflowNode<"weft.context-source"> {
  readonly kind: "weft.context-source";
  readonly name: Name;
  readonly description?: string;
  readonly input: InputSchema;
  readonly output: OutputSchema;
  readonly binding: HostBinding;
  readonly access: "read-only";
  readonly freshness: Readonly<Freshness>;
  readonly trust: Readonly<Trust>;
}

/**
 * Why: Collects the complete portable contract for a host-authorized context read without admitting an executable callback or mutation capability.
 * Use: Pass it to `defineContextSource`; the host must resolve `binding`, enforce policy, validate output, and mint provenance.
 */
export interface ContextSourceConfig<
  InputSchema extends AnySchema,
  OutputSchema extends AnySchema,
  Name extends string = string,
  Freshness extends ContextFreshnessPolicy = ContextFreshnessPolicy,
  Trust extends ContextTrustPolicy = ContextTrustPolicy,
> {
  name: Name;
  description?: string;
  input: InputSchema;
  output: OutputSchema;
  binding: HostBinding;
  freshness: Freshness;
  trust: Trust;
}

/**
 * Why: Declares a reusable strictly read-only context boundary without reading, caching, or authenticating anything at definition time.
 * Use: Define it at module scope, then pass the returned definition to `ctx.context` or another `ContextFn` binder.
 */
export declare function defineContextSource<
  InputSchema extends AnySchema,
  OutputSchema extends AnySchema,
  const Name extends string,
  const Freshness extends ContextFreshnessPolicy,
  const Trust extends ContextTrustPolicy,
>(
  config: ContextSourceConfig<InputSchema, OutputSchema, Name, Freshness, Trust>,
): ContextSourceDefinition<InputSchema, OutputSchema, Name, Freshness, Trust>;

/**
 * Why: Recovers the raw lookup value accepted by a context source before schema validation.
 * Use: It supplies the input side of `ContextFn` and internal source invocations.
 */
export type ContextSourceInputOf<Definition> =
  Definition extends ContextSourceDefinition<
    infer InputSchema,
    infer _OutputSchema,
    infer _Name,
    infer _Freshness,
    infer _Trust
  >
    ? InferIn<InputSchema>
    : never;

/**
 * Why: Recovers the validated value produced by a context source without exposing its host adapter.
 * Use: It supplies the `value` type inside a source's nominal `ContextSnapshot`.
 */
export type ContextSourceOutputOf<Definition> =
  Definition extends ContextSourceDefinition<
    infer _InputSchema,
    infer OutputSchema,
    infer _Name,
    infer _Freshness,
    infer _Trust
  >
    ? InferOut<OutputSchema>
    : never;

/**
 * Why: Recovers a context source's literal name so snapshot provenance stays source-specific after invocation.
 * Use: It supplies the `source` and evidence-subject name carried by `ContextSnapshotOf`.
 */
export type ContextSourceNameOf<Definition> =
  Definition extends ContextSourceDefinition<
    infer _InputSchema,
    infer _OutputSchema,
    infer Name,
    infer _Freshness,
    infer _Trust
  >
    ? Name
    : never;

/**
 * Why: Recovers the exact freshness policy retained by one context source definition.
 * Use: Derive snapshot freshness without widening a reject-stale source back to `fresh | stale`.
 */
export type ContextSourceFreshnessOf<Definition> =
  Definition extends ContextSourceDefinition<
    infer _InputSchema,
    infer _OutputSchema,
    infer _Name,
    infer Freshness,
    infer _Trust
  >
    ? Freshness
    : ContextFreshnessPolicy;

/**
 * Why: Recovers the exact trust policy retained by one context source definition.
 * Use: Derive guaranteed trust levels and accepted authority literals on returned snapshots.
 */
export type ContextSourceTrustOf<Definition> =
  Definition extends ContextSourceDefinition<
    infer _InputSchema,
    infer _OutputSchema,
    infer _Name,
    infer _Freshness,
    infer Trust
  >
    ? Trust
    : ContextTrustPolicy;

/**
 * Why: Projects one context source's enforced freshness policy into precise engine-minted metadata.
 * Use: Supply the freshness field of `ContextSnapshotOf`.
 */
export type ContextSourceFreshnessMetadataOf<Definition> = ContextFreshnessMetadata<
  ContextFreshnessStatusOf<ContextSourceFreshnessOf<Definition>>
>;

/**
 * Why: Projects one context source's trust floor and authority allow-list into precise engine-minted metadata.
 * Use: Supply the trust field of `ContextSnapshotOf`.
 */
export type ContextSourceTrustMetadataOf<Definition> = ContextTrustMetadata<
  ContextTrustLevelAtLeast<ContextSourceTrustOf<Definition>["minimum"]>,
  ContextTrustAuthorityOf<ContextSourceTrustOf<Definition>>
>;

/**
 * Why: Derives the exact nominal snapshot returned by one source definition in a reusable named type.
 * Use: Annotate helpers or stored results that must retain both the source's output and provenance identity.
 */
export type ContextSnapshotOf<Definition> = ContextSnapshot<
  ContextSourceOutputOf<Definition>,
  ContextSourceNameOf<Definition>,
  ContextSourceFreshnessMetadataOf<Definition>,
  ContextSourceTrustMetadataOf<Definition>
>;

/**
 * Why: Gives each read a durable identity while permitting a call site to request a stricter age limit than the source default.
 * Use: Pass a stable `key`; set `maxAge` only to tighten the definition's freshness policy for this invocation.
 */
export interface ContextInvocationOptions {
  key: string;
  label?: string;
  maxAge?: Duration;
}

/**
 * Why: Exposes schema-validated context acquisition as a read-only workflow capability that always returns nominal evidence.
 * Use: Bind it as `ctx.context` and resolve a `ContextSourceDefinition` with typed input and durable invocation options.
 */
export type ContextFn = <Definition extends ContextSourceDefinition<AnySchema, AnySchema, string>>(
  definition: Definition,
  input: ContextSourceInputOf<Definition>,
  options: ContextInvocationOptions,
) => Promise<ContextSnapshotOf<Definition>>;
