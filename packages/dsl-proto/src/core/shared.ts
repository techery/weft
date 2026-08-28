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
  /**
   * Why: Centralizes the internal props relationship so adjacent public declarations infer consistently.
   * Use: It is used by the surrounding core types and is not a separate runtime feature.
   */
  interface Props<Input = unknown, Output = Input> {
    readonly version: 1;
    readonly vendor: string;
    readonly validate: (value: unknown) => Result<Output> | Promise<Result<Output>>;
    readonly types?: Types<Input, Output> | undefined;
  }
  /**
   * Why: Centralizes the internal result relationship so adjacent public declarations infer consistently.
   * Use: It is used by the surrounding core types and is not a separate runtime feature.
   */
  type Result<Output> = SuccessResult<Output> | FailureResult;
  /**
   * Why: Centralizes the internal success result relationship so adjacent public declarations infer consistently.
   * Use: It is used by the surrounding core types and is not a separate runtime feature.
   */
  interface SuccessResult<Output> {
    readonly value: Output;
    readonly issues?: undefined;
  }
  /**
   * Why: Centralizes the internal failure result relationship so adjacent public declarations infer consistently.
   * Use: It is used by the surrounding core types and is not a separate runtime feature.
   */
  interface FailureResult {
    readonly issues: ReadonlyArray<Issue>;
  }
  /**
   * Why: Centralizes the internal issue relationship so adjacent public declarations infer consistently.
   * Use: It is used by the surrounding core types and is not a separate runtime feature.
   */
  interface Issue {
    readonly message: string;
    readonly path?: ReadonlyArray<PropertyKey | PathSegment> | undefined;
  }
  /**
   * Why: Centralizes the internal path segment relationship so adjacent public declarations infer consistently.
   * Use: It is used by the surrounding core types and is not a separate runtime feature.
   */
  interface PathSegment {
    readonly key: PropertyKey;
  }
  /**
   * Why: Centralizes the internal types relationship so adjacent public declarations infer consistently.
   * Use: It is used by the surrounding core types and is not a separate runtime feature.
   */
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
  | "weft.goal"
  | "weft.observer"
  | "weft.operation"
  | "weft.prompt"
  | "weft.recipe"
  | "weft.task-contract"
  | "weft.ui-view"
  | "weft.workflow";

/**
 * Why: Makes `WorkflowNode` nominal so ordinary objects with a matching `kind` cannot masquerade as definitions.
 * Use: It is carried only by values returned from `define*` functions and is not accessed by workflow authors.
 */
declare const workflowNodeBrand: unique symbol;

/**
 * Why: Gives every value created by a `define*` function one safe global identity without erasing its specific type.
 * Use: Accept `WorkflowNode` in registries, graph tools, inspectors, and utilities that operate on any definition.
 */
export interface WorkflowNode<Kind extends WorkflowNodeKind = WorkflowNodeKind> {
  readonly kind: Kind;
  readonly [workflowNodeBrand]: true;
}

/**
 * Why: Preserves both successful values and lane failures without losing input order during concurrent work.
 * Use: Use it with `ctx.parallel`, `ctx.pipeline`, `ctx.all`, and `ctx.successes`.
 */
export interface SettledSuccess<T> {
  ok: true;
  value: T;
}

/**
 * Why: Gives the core DSL an explicit settled failure contract instead of relying on untyped values.
 * Use: Import it when declaring, configuring, or consuming the corresponding core API.
 */
export interface SettledFailure {
  ok: false;
  error: unknown;
}

/**
 * Why: Preserves both successful values and lane failures without losing input order during concurrent work.
 * Use: Use it with `ctx.parallel`, `ctx.pipeline`, `ctx.all`, and `ctx.successes`.
 */
export type Settled<T> = SettledSuccess<T> | SettledFailure;

// ---------------------------------------------------------------------------
// Provider routing and prompts
// ---------------------------------------------------------------------------

/**
 * Why: Gives the core DSL an explicit claude provider options contract instead of relying on untyped values.
 * Use: Import it when declaring, configuring, or consuming the corresponding core API.
 */
export interface ClaudeProviderOptions {
  permissionMode?: "default" | "dontAsk";
}

/**
 * Why: Gives the core DSL an explicit codex provider options contract instead of relying on untyped values.
 * Use: Import it when declaring, configuring, or consuming the corresponding core API.
 */
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

/**
 * Why: Gives the core DSL an explicit built in provider contract instead of relying on untyped values.
 * Use: Import it when declaring, configuring, or consuming the corresponding core API.
 */
export interface ProviderConfig<Id extends keyof ProviderOptionRegistry> {
  id: Id;
  model?: string;
  effort?: Effort;
  options?: ProviderOptionRegistry[Id];
}

/**
 * Why: Gives the core DSL an explicit built in provider contract instead of relying on untyped values.
 * Use: Import it when declaring, configuring, or consuming the corresponding core API.
 */
export type BuiltInProvider = {
  [Id in keyof ProviderOptionRegistry]: ProviderConfig<Id>;
}[keyof ProviderOptionRegistry];

/**
 * Why: Gives the core DSL an explicit custom provider id contract instead of relying on untyped values.
 * Use: Import it when declaring, configuring, or consuming the corresponding core API.
 */
export type CustomProviderId = string & Record<never, never>;

/**
 * Why: Gives the core DSL an explicit custom provider contract instead of relying on untyped values.
 * Use: Import it when declaring, configuring, or consuming the corresponding core API.
 */
export interface CustomProvider {
  id: CustomProviderId;
  model?: string;
  effort?: Effort;
  options?: Record<string, unknown>;
}

/**
 * Why: Keeps provider identity, model selection, effort, and vendor options together as one routed value.
 * Use: Use it in agent defaults, scoped contexts, or individual agent calls.
 */
export type Provider = BuiltInProvider | CustomProvider;

/**
 * Why: Gives the core DSL an explicit provider requirements contract instead of relying on untyped values.
 * Use: Import it when declaring, configuring, or consuming the corresponding core API.
 */
export interface ProviderRequirements {
  structured?: "native" | "tool";
  permissionHook?: true;
  sessionResume?: true;
}

/**
 * Why: Gives the core DSL an explicit prompt section contract instead of relying on untyped values.
 * Use: Import it when declaring, configuring, or consuming the corresponding core API.
 */
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
export interface PromptDefinition<Input, ParsedInput = Input> extends WorkflowNode<"weft.prompt"> {
  readonly kind: "weft.prompt";
  readonly name: string;
  readonly input?: AnySchema;
  readonly render: (input: ParsedInput) => string;
  readonly __input?: Input;
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
 * Why: Declares a reusable input-to-prompt contract without invoking a provider.
 * Use: Use it at module scope and supply the result to `defineAgent`.
 */
export interface SchemaPromptConfig<S extends AnySchema> {
  name: string;
  input: S;
  render: (input: InferOut<S>) => PromptPart;
}

/**
 * Why: Declares a reusable input-to-prompt contract without invoking a provider.
 * Use: Use it at module scope and supply the result to `defineAgent`.
 */
export declare function definePrompt<S extends AnySchema>(
  config: SchemaPromptConfig<S>,
): PromptDefinition<InferIn<S>, InferOut<S>>;

/**
 * Why: Declares a reusable input-to-prompt contract without invoking a provider.
 * Use: Use it at module scope and supply the result to `defineAgent`.
 */
export interface TypedPromptConfig<Input> {
  name: string;
  render: (input: Input) => PromptPart;
}

/**
 * Why: Declares a reusable input-to-prompt contract without invoking a provider.
 * Use: Use it at module scope and supply the result to `defineAgent`.
 */
export declare function definePrompt<Input>(config: TypedPromptConfig<Input>): PromptDefinition<Input>;
