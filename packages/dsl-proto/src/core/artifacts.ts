/** Declaration-only artifact surface for the Weft DSL prototype. */

import type { AnySchema, InferIn, InferOut, WorkflowNode } from "./shared.ts";

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
> extends WorkflowNode<"weft.artifact"> {
  readonly kind: "weft.artifact";
  readonly name: string;
  readonly mediaType: string;
  readonly content: ContentSchema;
  readonly metadata?: MetadataSchema;
  readonly extension?: string;
}

/**
 * Why: Collects fields shared by artifacts with and without typed metadata.
 * Use: Extend it through the metadata-specific configuration accepted by `defineArtifact`.
 */
export interface ArtifactConfigBase<ContentSchema extends AnySchema> {
  name: string;
  mediaType: string;
  content: ContentSchema;
  extension?: string;
}

/**
 * Why: Prevents metadata from being supplied when an artifact intentionally has no metadata schema.
 * Use: Pass it to `defineArtifact` for a content-only artifact such as a plain test log.
 */
export interface ContentOnlyArtifactConfig<ContentSchema extends AnySchema>
  extends ArtifactConfigBase<ContentSchema> {
  metadata?: undefined;
}

/**
 * Why: Couples artifact metadata to a runtime schema instead of allowing unvalidated descriptive objects.
 * Use: Pass it to `defineArtifact` for plans, reports, or other content needing typed provenance fields.
 */
export interface MetadataArtifactConfig<ContentSchema extends AnySchema, MetadataSchema extends AnySchema>
  extends ArtifactConfigBase<ContentSchema> {
  metadata: MetadataSchema;
}

/**
 * Why: Declares a reusable immutable artifact contract without storing any content.
 * Use: Use the content-only overload when callers should capture only schema-validated content.
 */
export declare function defineArtifact<ContentSchema extends AnySchema>(
  config: ContentOnlyArtifactConfig<ContentSchema>,
): ArtifactDefinition<ContentSchema>;

/**
 * Why: Declares a reusable immutable artifact contract without storing any content.
 * Use: Use the metadata overload when every capture must also cross a typed metadata boundary.
 */
export declare function defineArtifact<ContentSchema extends AnySchema, MetadataSchema extends AnySchema>(
  config: MetadataArtifactConfig<ContentSchema, MetadataSchema>,
): ArtifactDefinition<ContentSchema, MetadataSchema>;

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
  Definition extends ArtifactDefinition<infer ContentSchema, infer MetadataSchema>
    ? MetadataSchema extends AnySchema
      ? MetadataArtifactInput<InferIn<ContentSchema>, InferIn<MetadataSchema>>
      : ContentOnlyArtifactInput<InferIn<ContentSchema>>
    : never;

/**
 * Why: Records immutable storage identity and the validated content type without returning large content inline.
 * Use: Pass the reference to reviews, workflow outputs, reports, or later artifact consumers.
 */
export interface ArtifactRefBase<Content> {
  ref: string;
  name: string;
  sha256: string;
  size: number;
  mediaType: string;
  readonly __content?: Content;
}

/**
 * Why: Makes the absence of artifact metadata explicit for consumers and conditional helpers.
 * Use: It is returned when the artifact definition has no metadata schema.
 */
export interface ContentOnlyArtifactRef<Content> extends ArtifactRefBase<Content> {
  metadata?: never;
}

/**
 * Why: Preserves validated provenance metadata alongside the immutable artifact reference.
 * Use: It is returned when the artifact definition declares a metadata schema.
 */
export interface MetadataArtifactRef<Content, Metadata> extends ArtifactRefBase<Content> {
  metadata: Metadata;
}

/**
 * Why: Derives the exact immutable reference returned for an artifact definition.
 * Use: Apply it to a definition in workflow outputs, review subjects, or engine invocation results.
 */
export type ArtifactRefOf<Definition> =
  Definition extends ArtifactDefinition<infer ContentSchema, infer MetadataSchema>
    ? MetadataSchema extends AnySchema
      ? MetadataArtifactRef<InferOut<ContentSchema>, InferOut<MetadataSchema>>
      : ContentOnlyArtifactRef<InferOut<ContentSchema>>
    : never;

/**
 * Why: Supplies stable replay identity and an optional human label for one artifact capture.
 * Use: Pass it as the final argument to `ctx.artifact`.
 */
export interface ArtifactCaptureOptions {
  key: string;
  label?: string;
}

/**
 * Why: Exposes typed artifact capture without making storage mechanics part of workflow code.
 * Use: Call `ctx.artifact(definition, input, options)` and retain the returned immutable reference.
 */
export type ArtifactFn = <Definition extends WorkflowNode<"weft.artifact">>(
  definition: Definition,
  input: ArtifactCaptureInputOf<Definition>,
  options: ArtifactCaptureOptions,
) => Promise<ArtifactRefOf<Definition>>;
