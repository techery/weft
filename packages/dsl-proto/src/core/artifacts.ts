/** Declaration-only artifact surface for the Weft DSL prototype. */

import type {
  AnySchema,
  DefinitionTypeCarrier,
  EvidenceRef,
  InferIn,
  InferOut,
  NominalValue,
  SubjectAttestation,
  WorkflowNode,
  WorkspaceSnapshotRef,
} from "./shared.ts";

// ---------------------------------------------------------------------------
// Typed immutable artifacts
// ---------------------------------------------------------------------------

/**
 * Why: Names the immutable content contract and optional metadata contract shared by every artifact capture.
 * Use: Create one with `defineArtifact`, then pass it to `ctx.artifact` when preserving evidence or deliverables.
 */
export interface ArtifactDefinition<
  ContentSchema extends AnySchema,
  MetadataSchema extends AnySchema | undefined = undefined,
  Name extends string = string,
> extends WorkflowNode<"weft.artifact"> {
  readonly kind: "weft.artifact";
  readonly name: Name;
  readonly mediaType: string;
  readonly content: ContentSchema;
  readonly metadata?: MetadataSchema;
  readonly extension?: string;
}

/**
 * Why: Collects fields shared by artifacts with and without typed metadata.
 * Use: Extend it through the metadata-specific configuration accepted by `defineArtifact`.
 */
export interface ArtifactConfigBase<ContentSchema extends AnySchema, Name extends string = string> {
  name: Name;
  mediaType: string;
  content: ContentSchema;
  extension?: string;
}

/**
 * Why: Prevents metadata from being supplied when an artifact intentionally has no metadata schema.
 * Use: Pass it to `defineArtifact` for a content-only artifact such as a plain test log.
 */
export interface ContentOnlyArtifactConfig<ContentSchema extends AnySchema, Name extends string = string>
  extends ArtifactConfigBase<ContentSchema, Name> {
  metadata?: undefined;
}

/**
 * Why: Couples artifact metadata to a runtime schema instead of allowing unvalidated descriptive objects.
 * Use: Pass it to `defineArtifact` for plans, reports, or other content needing typed provenance fields.
 */
export interface MetadataArtifactConfig<
  ContentSchema extends AnySchema,
  MetadataSchema extends AnySchema,
  Name extends string = string,
> extends ArtifactConfigBase<ContentSchema, Name> {
  metadata: MetadataSchema;
}

/**
 * Why: Declares a reusable immutable artifact contract without storing any content.
 * Use: Use the content-only overload when callers should capture only schema-validated content.
 */
export declare function defineArtifact<ContentSchema extends AnySchema, const Name extends string = string>(
  config: ContentOnlyArtifactConfig<ContentSchema, Name>,
): ArtifactDefinition<ContentSchema, undefined, Name>;

/**
 * Why: Declares a reusable immutable artifact contract without storing any content.
 * Use: Use the metadata overload when every capture must also cross a typed metadata boundary.
 */
export declare function defineArtifact<
  ContentSchema extends AnySchema,
  MetadataSchema extends AnySchema,
  const Name extends string = string,
>(
  config: MetadataArtifactConfig<ContentSchema, MetadataSchema, Name>,
): ArtifactDefinition<ContentSchema, MetadataSchema, Name>;

/**
 * Why: Recovers the exact definition-time artifact name for heterogeneous registries and diagnostics.
 * Use: Apply it to a concrete `defineArtifact` result; broad legacy definitions continue to produce `string`.
 */
export type ArtifactNameOf<Definition> =
  Definition extends ArtifactDefinition<any, any, infer Name> ? Name : never;

/**
 * Why: Carries content through the artifact schema before immutable storage occurs.
 * Use: It is the shared portion of both metadata-free and metadata-backed capture inputs.
 */
export interface ArtifactContentInput<Content> {
  content: Content;
}

/**
 * Why: Rejects accidental metadata on an artifact whose definition has no metadata schema.
 * Use: `ArtifactCaptureInputOf` selects it for a content-only artifact definition.
 */
export interface ContentOnlyArtifactInput<Content> extends ArtifactContentInput<Content> {
  metadata?: never;
}

/**
 * Why: Requires metadata whenever the artifact definition declares a metadata schema.
 * Use: `ArtifactCaptureInputOf` selects it for a metadata-backed artifact definition.
 */
export interface MetadataArtifactInput<Content, Metadata> extends ArtifactContentInput<Content> {
  metadata: Metadata;
}

/**
 * Why: Derives the exact raw capture input from an artifact's content and optional metadata schemas.
 * Use: Use it when binding `ctx.artifact` or constructing its internal invocation.
 */
export type ArtifactCaptureInputOf<Definition> =
  Definition extends ArtifactDefinition<infer ContentSchema, infer MetadataSchema, any>
    ? MetadataSchema extends AnySchema
      ? MetadataArtifactInput<InferIn<ContentSchema>, InferIn<MetadataSchema>>
      : ContentOnlyArtifactInput<InferIn<ContentSchema>>
    : never;

/**
 * Why: Records immutable storage identity and the validated content type without returning large content inline.
 * Use: Pass the reference to reviews, workflow outputs, reports, or later artifact consumers.
 */
declare const artifactRefBrand: unique symbol;

/**
 * Why: Records immutable storage identity and the validated content type without returning large content inline.
 * Use: Pass the reference to reviews, workflow outputs, reports, or later artifact consumers.
 */
export interface ArtifactRefBase<
  Content,
  Candidate extends WorkspaceSnapshotRef | undefined = WorkspaceSnapshotRef | undefined,
  Name extends string = string,
> extends DefinitionTypeCarrier<{ content: Content }>,
    NominalValue<readonly ["artifact", Name, Content, Candidate]> {
  readonly ref: string;
  readonly name: Name;
  readonly sha256: string;
  readonly size: number;
  readonly mediaType: string;
  readonly candidate: Candidate;
  readonly sources: readonly EvidenceRef[];
  readonly attestation: Candidate extends WorkspaceSnapshotRef
    ? SubjectAttestation<"artifact", Content, Candidate>
    : undefined;
  readonly [artifactRefBrand]: Name;
}

/**
 * Why: Makes the absence of artifact metadata explicit for consumers and conditional helpers.
 * Use: It is returned when the artifact definition has no metadata schema.
 */
export interface ContentOnlyArtifactRef<
  Content,
  Candidate extends WorkspaceSnapshotRef | undefined = WorkspaceSnapshotRef | undefined,
  Name extends string = string,
> extends ArtifactRefBase<Content, Candidate, Name> {
  metadata?: never;
}

/**
 * Why: Preserves validated provenance metadata alongside the immutable artifact reference.
 * Use: It is returned when the artifact definition declares a metadata schema.
 */
export interface MetadataArtifactRef<
  Content,
  Metadata,
  Candidate extends WorkspaceSnapshotRef | undefined = WorkspaceSnapshotRef | undefined,
  Name extends string = string,
> extends ArtifactRefBase<Content, Candidate, Name> {
  metadata: Metadata;
}

/**
 * Why: Derives the exact immutable reference returned for an artifact definition.
 * Use: Apply it to a definition in workflow outputs, review subjects, or engine invocation results.
 */
export type ArtifactRefOf<
  Definition,
  Candidate extends WorkspaceSnapshotRef | undefined = WorkspaceSnapshotRef | undefined,
> =
  Definition extends ArtifactDefinition<infer ContentSchema, infer MetadataSchema, infer Name>
    ? MetadataSchema extends AnySchema
      ? MetadataArtifactRef<InferOut<ContentSchema>, InferOut<MetadataSchema>, Candidate, Name>
      : ContentOnlyArtifactRef<InferOut<ContentSchema>, Candidate, Name>
    : never;

/**
 * Why: Holds capture fields that do not depend on whether the artifact is bound to a workspace candidate.
 * Use: Extend it through the bound or unbound capture-options branch.
 */
export interface ArtifactCaptureOptionsBase {
  key: string;
  label?: string;
  sources?: readonly EvidenceRef[];
}

/**
 * Why: Makes an exact workspace candidate mandatory when capture should mint candidate-bound artifact evidence.
 * Use: Pass the current nominal workspace candidate; the host rejects drift before minting the bound reference.
 */
export interface CandidateArtifactCaptureOptions<Candidate extends WorkspaceSnapshotRef>
  extends ArtifactCaptureOptionsBase {
  candidate: Candidate;
}

/**
 * Why: Makes the absence of workspace authority explicit for artifacts such as global reports or logs.
 * Use: Omit `candidate`; the returned reference has `candidate` and `attestation` fixed to `undefined`.
 */
export interface UnboundArtifactCaptureOptions extends ArtifactCaptureOptionsBase {
  candidate?: undefined;
}

/**
 * Why: Selects the exact capture-options branch from the candidate carried by an internal or generic invocation.
 * Use: Parameterize it with a nominal candidate for bound capture or `undefined` for unbound capture.
 */
export type ArtifactCaptureOptionsFor<Candidate extends WorkspaceSnapshotRef | undefined> =
  Candidate extends WorkspaceSnapshotRef ? CandidateArtifactCaptureOptions<Candidate> : UnboundArtifactCaptureOptions;

/**
 * Why: Exposes typed artifact capture while correlating an exact optional candidate with the returned reference.
 * Use: Supply a candidate for attested workspace evidence, or omit it for an explicitly unbound artifact.
 */
export interface ArtifactFn {
  <Definition extends WorkflowNode<"weft.artifact">, Candidate extends WorkspaceSnapshotRef>(
    definition: Definition,
    input: ArtifactCaptureInputOf<Definition>,
    options: CandidateArtifactCaptureOptions<Candidate>,
  ): Promise<ArtifactRefOf<Definition, Candidate>>;
  <Definition extends WorkflowNode<"weft.artifact">>(
    definition: Definition,
    input: ArtifactCaptureInputOf<Definition>,
    options: UnboundArtifactCaptureOptions,
  ): Promise<ArtifactRefOf<Definition, undefined>>;
}
