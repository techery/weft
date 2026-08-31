/** Declaration-only core surface for the Weft DSL prototype. */

// ---------------------------------------------------------------------------
// Schemas and shared primitives
// ---------------------------------------------------------------------------

/**
 * Why: Keeps every data boundary compatible with Zod and other Standard Schema implementations.
 * Use: Use it as the common constraint for workflow, agent, check, human, task, and UI schemas.
 */
export interface StandardSchemaV1<Input = unknown, Output = Input> {
  readonly "~standard": StandardSchemaV1.Props<Input, Output>;
}

/**
 * Why: Keeps every data boundary compatible with Zod and other Standard Schema implementations.
 * Use: Use it as the common constraint for workflow, agent, check, human, task, and UI schemas.
 */
export declare namespace StandardSchemaV1 {
  /** Standard Schema metadata. */
  interface Props<Input = unknown, Output = Input> {
    readonly version: 1;
    readonly vendor: string;
    readonly validate: (value: unknown) => Result<Output> | Promise<Result<Output>>;
    readonly types?: Types<Input, Output> | undefined;
  }
  /** Standard Schema validation result. */
  type Result<Output> = SuccessResult<Output> | FailureResult;
  /** Successful Standard Schema validation. */
  interface SuccessResult<Output> {
    readonly value: Output;
    readonly issues?: undefined;
  }
  /** Failed Standard Schema validation. */
  interface FailureResult {
    readonly issues: ReadonlyArray<Issue>;
  }
  /** Standard Schema validation issue. */
  interface Issue {
    readonly message: string;
    readonly path?: ReadonlyArray<PropertyKey | PathSegment> | undefined;
  }
  /** Structured segment in an issue path. */
  interface PathSegment {
    readonly key: PropertyKey;
  }
  /** Optional Standard Schema input/output metadata. */
  interface Types<Input = unknown, Output = Input> {
    readonly input: Input;
    readonly output: Output;
  }
}

/**
 * Why: Provides one reusable constraint for any supported runtime schema without erasing its inferred input and output.
 * Use: Use it in generic DSL definitions that accept an arbitrary Standard Schema.
 */
export type AnySchema = StandardSchemaV1<any, any>;
/**
 * Why: Extracts the raw value a schema accepts, which may differ from its parsed output after transforms.
 * Use: Use it for call-site inputs and values that will cross a validation boundary.
 */
export type InferIn<S extends AnySchema> = NonNullable<S["~standard"]["types"]>["input"];
/**
 * Why: Extracts the validated value produced by a schema so downstream workflow code stays precise.
 * Use: Use it for parsed callback arguments and schema-backed results.
 */
export type InferOut<S extends AnySchema> = NonNullable<S["~standard"]["types"]>["output"];
/**
 * Why: Prevents timeout and wait options from accepting ambiguous free-form strings.
 * Use: Use a millisecond number or a compact value such as `"30s"`, `"5m"`, or `"2h"`.
 */
export type Duration = number | `${number}${"ms" | "s" | "m" | "h" | "d"}`;

/**
 * Why: Records whether a definition form accepts no input or requires an explicit input property independently of its value type.
 * Use: Definition builders mint this mode; invocation helpers must not infer presence from `undefined`, `unknown`, or `any`.
 */
export type InputMode = "none" | "required";

/**
 * Why: Hides definition-time type state behind one nominal carrier instead of public phantom fields and positional generic lists.
 * Use: DSL definitions extend it and public `InputOf`, `OutputOf`, and `ResultOf` helpers recover the carried types.
 */
declare const definitionTypes: unique symbol;

/**
 * Why: Gives each definition family one extensible hidden bag for the type relationships relevant to that domain.
 * Use: Supply a small object type from a definition declaration; workflow authors consume it only through extractors.
 */
export interface DefinitionTypeCarrier<Types> {
  readonly [definitionTypes]: Types;
}

/**
 * Why: Recovers the complete hidden type bag of a DSL definition without depending on generic parameter order.
 * Use: Prefer the narrower field extractors unless generic tooling genuinely needs the whole definition relationship.
 */
export type TypesOf<Definition> = Definition extends DefinitionTypeCarrier<infer Types> ? Types : never;

/**
 * Why: Recovers the author-supplied input type from any definition that carries one in its hidden type bag.
 * Use: Apply it to `typeof definition` when naming public call-site input types.
 */
export type InputOf<Definition> = TypesOf<Definition> extends { input: infer Input } ? Input : never;

/**
 * Why: Recovers the schema-validated input type without exposing a definition's hidden implementation callback.
 * Use: Apply it in engine and testing adapters that invoke definition implementations after validation.
 */
export type ParsedInputOf<Definition> =
  TypesOf<Definition> extends { parsedInput: infer Input } ? Input : InputOf<Definition>;

/**
 * Why: Recovers the validated domain output from any definition that carries one in its hidden type bag.
 * Use: Apply it to `typeof definition` when naming public result-value types.
 */
export type OutputOf<Definition> = TypesOf<Definition> extends { output: infer Output } ? Output : never;

/**
 * Why: Recovers the pre-validation implementation output while keeping callbacks off public definition objects.
 * Use: Apply it only in engine and testing adapters that validate a definition implementation's returned value.
 */
export type RawOutputOf<Definition> =
  TypesOf<Definition> extends { rawOutput: infer Output } ? Output : OutputOf<Definition>;

/**
 * Why: Recovers a definition-specific result envelope without requiring authors to restate its internal generic state.
 * Use: Apply it to checks, goals, reviews, or other definitions whose hidden bag declares a `result` field.
 */
export type ResultOf<Definition> = TypesOf<Definition> extends { result: infer Result } ? Result : never;

/**
 * Why: Gives declaration-only nodes an auditable name for a host-registered adapter without embedding its implementation.
 * Use: Reference a stable integration binding such as `github.pull-request.create`; the host resolves and authorizes it.
 */
export type HostBinding = `${string}.${string}`;
/**
 * Why: Makes authorization policy explicit for operations whose effects have different consequences.
 * Use: Use it on gates, commands, and Git writes so the host can apply the correct approval policy.
 */
export type Risk = "low" | "medium" | "high" | "irreversible";
/**
 * Why: Normalizes model reasoning effort across provider adapters.
 * Use: Use it inside a provider object when a role or invocation needs a deliberate reasoning level.
 */
export type Effort = "low" | "medium" | "high" | "xhigh" | "max" | "ultra";

/**
 * Why: Enumerates every declarative node category created by the public `define*` functions.
 * Use: Narrow a `WorkflowNode` by its `kind` when building registries, inspectors, or tooling over mixed definitions.
 */
export type WorkflowNodeKind =
  | "weft.agent"
  | "weft.artifact"
  | "weft.check"
  | "weft.check-suite"
  | "weft.context-source"
  | "weft.delivery"
  | "weft.goal"
  | "weft.observer"
  | "weft.operation"
  | "weft.path-policy"
  | "weft.prompt"
  | "weft.review"
  | "weft.task-contract"
  | "weft.trigger"
  | "weft.ui-view"
  | "weft.workflow";

/**
 * Why: Uses a private class member so object spread cannot preserve nominal engine or definition identity.
 * Use: Internal declaration modules extend it in addition to their relationship-specific hidden brands.
 */
export declare abstract class NominalValue<Identity = unknown> {
  private readonly __weftNominalIdentity: Identity;
}

/**
 * Why: Makes `WorkflowNode` nominal so ordinary objects with a matching `kind` cannot masquerade as definitions.
 * Use: It is carried only by values returned from `define*` functions and is not accessed by workflow authors.
 */
declare const workflowNodeBrand: unique symbol;

/**
 * Why: Gives every value created by a `define*` function one safe global identity without erasing its specific type.
 * Use: Accept `WorkflowNode` in registries, graph tools, inspectors, and utilities that operate on any definition.
 */
export interface WorkflowNode<Kind extends WorkflowNodeKind = WorkflowNodeKind>
  extends NominalValue<readonly ["workflow-node", Kind]> {
  readonly kind: Kind;
  readonly [workflowNodeBrand]: true;
}

/**
 * Why: Prevents ordinary strings and counters from masquerading as an engine-observed workspace generation.
 * Use: Receive it from workspace, check, goal, patch, review, and promotion results when exact-generation proof matters.
 */
declare const workspaceSnapshotBrand: unique symbol;

/**
 * Why: Identifies one immutable workspace tree generation with engine-minted nominal provenance.
 * Use: Compare or carry it as a unit instead of reconstructing identity from unrelated string and number fields.
 */
export interface WorkspaceSnapshotRef extends NominalValue<"workspace-snapshot"> {
  readonly workspaceId: string;
  readonly generation: number;
  readonly treeHash: string;
  readonly [workspaceSnapshotBrand]: true;
}

/**
 * Why: Prevents ordinary payloads from claiming that the engine observed and attested evidence for an external subject.
 * Use: It is carried only by `EvidenceRef` values minted at engine-controlled evidence boundaries.
 */
declare const evidenceRefBrand: unique symbol;

/**
 * Why: Gives independently produced evidence one nominal, digest-addressed link to the exact subject it observed.
 * Use: Carry context, artifact, or workspace evidence without reducing provenance to a structurally forgeable payload.
 */
export interface EvidenceRef<Kind extends string = string, Payload = unknown, Subject = unknown>
  extends NominalValue<readonly ["evidence", Kind, Payload, Subject]> {
  readonly kind: Kind;
  readonly ref: string;
  readonly sha256: string;
  readonly subject: Subject;
  readonly createdAt: string;
  readonly [evidenceRefBrand]: Payload;
}

/**
 * Why: Specializes general evidence to an engine-minted workspace generation for freshness-sensitive promotion.
 * Use: Pass check, goal, review, or delivery attestations where every proof must name one exact candidate snapshot.
 */
export type SubjectAttestation<
  Kind extends string = string,
  Payload = unknown,
  Subject extends WorkspaceSnapshotRef = WorkspaceSnapshotRef,
> = EvidenceRef<Kind, Payload, Subject>;

/**
 * Why: Prevents an observation, failed verdict, or rework finding from masquerading as satisfied promotion policy.
 * Use: Receive it only on successful check, review, or goal result branches and pass it to delivery `proofs`.
 */
declare const promotionProofBrand: unique symbol;

/**
 * Why: Represents an engine-minted positive policy transition tied to one exact workspace generation.
 * Use: Collect these handles for verified delivery; supporting evidence and artifacts remain separate context.
 */
export interface PromotionProof<
  Kind extends "check" | "review" | "goal" = "check" | "review" | "goal",
  Candidate extends WorkspaceSnapshotRef = WorkspaceSnapshotRef,
> extends NominalValue<readonly ["promotion-proof", Kind, Candidate]> {
  readonly kind: Kind;
  readonly candidate: Candidate;
  readonly evidenceRef: string;
  readonly [promotionProofBrand]: readonly [kind: Kind, candidate: Candidate];
}

/**
 * Why: Preserves both successful values and lane failures without losing input order during concurrent work.
 * Use: Receive it from settled parallel or pipeline execution and narrow on `ok`.
 */
export interface SettledSuccess<T> {
  readonly ok: true;
  readonly value: T;
}

/** Settled failure. */
export interface SettledFailure {
  readonly ok: false;
  readonly error: unknown;
}

/**
 * Why: Preserves both successful values and lane failures without losing input order during concurrent work.
 * Use: Receive it from `parallel.settled` or `pipeline.settled`, then narrow on `ok`.
 */
export type Settled<T> = SettledSuccess<T> | SettledFailure;

// ---------------------------------------------------------------------------
// Provider routing and prompts
// ---------------------------------------------------------------------------

/** Claude provider options. */
export interface ClaudeProviderOptions {
  permissionMode?: "default" | "dontAsk";
}

/** Codex provider options. */
export interface CodexProviderOptions {
  sandboxMode?: "read-only" | "workspace-write";
  networkAccess?: boolean;
  webSearch?: "disabled" | "cached" | "live";
}

/**
 * Why: Provides an augmentation point that keeps vendor-specific options typed without putting them in the engine contract.
 * Use: Provider packages extend it by provider ID; `Provider` derives its discriminated union from the registry.
 */
export interface ProviderOptionRegistry {
  claude: ClaudeProviderOptions;
  codex: CodexProviderOptions;
}

/** Built in provider. */
export interface ProviderConfig<Id extends keyof ProviderOptionRegistry> {
  id: Id;
  model?: string;
  effort?: Effort;
  options?: ProviderOptionRegistry[Id];
}

/** Built in provider. */
export type BuiltInProvider = {
  [Id in keyof ProviderOptionRegistry]: ProviderConfig<Id>;
}[keyof ProviderOptionRegistry];

/**
 * Why: Keeps runtime-selected providers explicit and non-overlapping with registry-typed provider IDs.
 * Use: Choose this branch only when the provider ID is genuinely dynamic; augment `ProviderOptionRegistry` for known IDs.
 */
export interface DynamicProvider {
  kind: "dynamic";
  id: string;
  model?: string;
  effort?: Effort;
  options?: Record<string, unknown>;
}

/**
 * Why: Keeps provider identity, model selection, effort, and vendor options together as one routed value.
 * Use: Use it in agent defaults, scoped contexts, or individual agent calls.
 */
export type Provider = BuiltInProvider | DynamicProvider;

/** Provider requirements. */
export interface ProviderRequirements {
  structured?: "native" | "tool";
  permissionHook?: true;
  sessionResume?: true;
}

/** Prompt section. */
export interface PromptSection {
  readonly kind: "section";
  readonly title: string;
  readonly body: string;
}

/**
 * Why: Lets prompt builders compose text, titled sections, conditional fragments, and nested lists without manual spacing.
 * Use: Return it from `definePrompt` render callbacks or pass it as an inline agent prompt.
 */
export type PromptPart = string | PromptSection | false | null | undefined | readonly PromptPart[];

/**
 * Why: Separates reusable typed prompt rendering from the agent role that executes it.
 * Use: Create one with `definePrompt`, then pass it to `defineAgent`.
 */
export interface PromptDefinition<Input, ParsedInput = Input, Name extends string = string>
  extends WorkflowNode<"weft.prompt">,
    DefinitionTypeCarrier<{
      input: Input;
      parsedInput: ParsedInput;
      output: string;
      rawOutput: PromptPart;
    }> {
  readonly kind: "weft.prompt";
  readonly name: Name;
  readonly input?: AnySchema;
}

/**
 * Why: Provides small typed helpers for building readable prompt sections and JSON evidence.
 * Use: Use `prompt.section` or `prompt.json` inside a prompt renderer.
 */
export interface PromptHelpers {
  section(title: string, body: string): PromptSection;
  json(title: string, value: unknown): PromptSection;
}

/**
 * Why: Provides small typed helpers for building readable prompt sections and JSON evidence.
 * Use: Use `prompt.section` or `prompt.json` inside a prompt renderer.
 */
export declare const prompt: PromptHelpers;

/**
 * Why: Produces stable prompt text from composable prompt fragments for previews and tests.
 * Use: Pass a `PromptPart`; empty fragments are omitted and sections are separated consistently.
 */
export declare function renderPrompt(parts: PromptPart): string;

/**
 * Why: Provides an explicit preview and test path without exposing a prompt definition's implementation callback.
 * Use: Pass a prompt definition and its raw input; execution still validates schema-backed inputs before rendering.
 */
export declare function renderPromptDefinition<Definition extends PromptDefinition<any, any>>(
  definition: Definition,
  input: InputOf<Definition>,
): string;

/**
 * Why: Declares a reusable input-to-prompt contract without invoking a provider.
 * Use: Use it at module scope and supply the result to `defineAgent`.
 */
export interface SchemaPromptConfig<S extends AnySchema, Name extends string = string> {
  name: Name;
  input: S;
  render: (input: InferOut<S>) => PromptPart;
}

/**
 * Why: Declares a reusable input-to-prompt contract without invoking a provider.
 * Use: Use it at module scope and supply the result to `defineAgent`.
 */
export declare function definePrompt<S extends AnySchema, const Name extends string = string>(
  config: SchemaPromptConfig<S, Name>,
): PromptDefinition<InferIn<S>, InferOut<S>, Name>;

/**
 * Why: Declares a reusable input-to-prompt contract without invoking a provider.
 * Use: Use it at module scope and supply the result to `defineAgent`.
 */
export interface TypedPromptConfig<Input, Name extends string = string> {
  name: Name;
  render: (input: Input) => PromptPart;
}

/**
 * Why: Declares a reusable input-to-prompt contract without invoking a provider.
 * Use: Use it at module scope and supply the result to `defineAgent`.
 */
export declare function definePrompt<Input, const Name extends string = string>(
  config: TypedPromptConfig<Input, Name>,
): PromptDefinition<Input, Input, Name>;
