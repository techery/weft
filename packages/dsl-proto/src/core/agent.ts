/** Declaration-only agent surface for the Weft DSL prototype. */

import type { ContextSnapshot } from "./context-sources.ts";
import type { GoalDefinition, GoalTypes } from "./goals.ts";
import type { WriteScope } from "./path-policies.ts";
import type {
  AnySchema,
  DefinitionTypeCarrier,
  Duration,
  InferIn,
  InferOut,
  InputMode,
  NominalValue,
  PromptDefinition,
  PromptPart,
  Provider,
  ProviderRequirements,
  WorkflowNode,
  WorkspaceSnapshotRef,
} from "./shared.ts";
import type { AgentTaskAccess } from "./tasks.ts";
import type { WorkflowCtx } from "./workflow.ts";

// ---------------------------------------------------------------------------
// Agents and reusable recipes
// ---------------------------------------------------------------------------

/** Usage. */
export interface Usage {
  readonly input: number;
  readonly output: number;
  readonly cacheRead?: number;
  readonly usd?: number;
  readonly samples?: number;
}

/**
 * Why: Prevents structurally similar user data from masquerading as an engine-captured patch handle.
 * Use: It is minted only by the internal engine and carried opaquely by `PatchRef`.
 */
declare const patchRefBrand: unique symbol;

/**
 * Why: Represents an isolated writer's captured change without embedding patch bytes in ordinary workflow values.
 * Use: Pass it to integration, composition, discard, or reporting operations.
 */
export interface PatchRef extends NominalValue<"weft.patch-ref"> {
  readonly ref: string;
  readonly key: string;
  readonly files: readonly string[];
  readonly base: WorkspaceSnapshotRef;
  readonly baseTree: string;
  readonly quarantined?: boolean;
  readonly outOfScope?: readonly string[];
  readonly [patchRefBrand]: true;
}

/**
 * Why: Returns validated model output and operational metadata in one stable envelope.
 * Use: Read `value` for domain data and use files, usage, patch, session, attempts, or goal evidence when needed.
 */
export interface AgentResultBase<T> {
  readonly value: T;
  readonly usage: Readonly<Usage>;
  readonly files: readonly string[];
  readonly patch?: PatchRef;
  readonly attempts: number;
  readonly sessionId?: string;
}

/** Agent result without goal. */
export interface AgentResultWithoutGoal {
  readonly goal?: never;
}

/** Agent result with goal. */
export interface AgentResultWithGoal<Goal> {
  readonly goal: Goal;
}

/** Agent goal field. */
export type AgentGoalField<Goal> = [Goal] extends [undefined]
  ? AgentResultWithoutGoal
  : AgentResultWithGoal<Goal>;

/**
 * Why: Returns validated model output and operational metadata in one stable envelope.
 * Use: Read `value` for domain data and use files, usage, patch, session, attempts, or goal evidence when needed.
 */
export type AgentResult<T, Goal = undefined> = AgentResultBase<T> & AgentGoalField<Goal>;

/** Required patch. */
export interface RequiredPatch {
  readonly patch: PatchRef;
}

/** Integrated workspace patch. */
export interface IntegratedWorkspacePatch {
  readonly patch?: never;
}

/** Patch agent result. */
export type PatchAgentResult<T, Goal = undefined> = Omit<AgentResult<T, Goal>, "patch"> & RequiredPatch;

/** Workspace write agent result. */
export type WorkspaceWriteAgentResult<T, Goal = undefined> = Omit<AgentResult<T, Goal>, "patch"> &
  IntegratedWorkspacePatch;

/** Retry options. */
export interface RetryOptions {
  attempts: number;
  backoff?: Duration;
}

/**
 * Why: Adds a per-session call budget to one explicitly allowed operation without granting its host capabilities.
 * Use: Put it in `AgentExecutionOptions.tools`; the host still resolves bindings and enforces operation authorization.
 */
export interface AgentToolGrant<
  Definition extends WorkflowNode<"weft.operation"> = WorkflowNode<"weft.operation">,
> {
  operation: Definition;
  maxCalls?: number;
}

/**
 * Why: Restricts agent tool use to nominal operation definitions instead of prompt-described or provider-global tools.
 * Use: List a definition directly for default limits or use `AgentToolGrant` for an explicit call budget.
 */
export type AgentTool = WorkflowNode<"weft.operation"> | AgentToolGrant;

/** Agent execution options. */
export interface AgentExecutionOptions {
  key?: string;
  label?: string;
  provider?: Provider;
  providerRequirements?: ProviderRequirements;
  write?: WriteScope;
  maxTurns?: number;
  timeout?: Duration;
  retry?: RetryOptions;
  repair?: number;
  onMaxTurns?: "finalize" | "fail";
  tasks?: false | AgentTaskAccess;
  tools?: readonly AgentTool[];
  context?: readonly ContextSnapshot<unknown>[];
}

/** Agent definition defaults. */
export type AgentDefinitionDefaults = Omit<
  AgentExecutionOptions,
  "key" | "label" | "write" | "tasks" | "context"
>;

/**
 * Why: Names the hidden schema and value relationships carried by one reusable agent definition.
 * Use: Agent builders construct it; authors normally consume its fields through definition extractors.
 */
export interface AgentTypes {
  readonly input: unknown;
  readonly parsedInput: unknown;
  readonly output: unknown;
  readonly rawOutput: unknown;
  readonly inputMode: InputMode;
  readonly outputSchema: AnySchema;
}

/**
 * Why: Names a reusable typed role with one prompt, output schema, and routing defaults.
 * Use: Create it with `defineAgent`, then pass the definition as the first argument to `ctx.agent`.
 */
export interface AgentDefinition<
  Types extends AgentTypes = AgentTypes,
  Name extends string = string,
> extends WorkflowNode<"weft.agent">,
    DefinitionTypeCarrier<Types> {
  readonly kind: "weft.agent";
  readonly name: Name;
  readonly description?: string;
  readonly prompt: string | PromptDefinition<Types["input"], Types["parsedInput"]>;
  readonly schema: Types["outputSchema"];
  readonly defaults: Readonly<AgentDefinitionDefaults>;
}

/** Exact hidden type relationships carried by one reusable agent definition. */
export type AgentTypesOf<Definition> =
  Definition extends AgentDefinition<infer Types, any> ? Types : never;

/**
 * Why: Recovers the exact definition-time name retained by one reusable agent role.
 * Use: Apply it to `typeof agent` when building typed registries or provenance views.
 */
export type AgentNameOf<Definition> =
  Definition extends AgentDefinition<any, infer Name> ? Name : never;

/**
 * Why: Declares a reusable agent role without starting a model session.
 * Use: Use the static-prompt or typed-prompt overload at module scope, then pass the definition to `ctx.agent`.
 */
export interface StaticAgentConfig<S extends AnySchema, Name extends string = string> {
  name: Name;
  description?: string;
  prompt: string;
  schema: S;
  defaults?: AgentDefinitionDefaults;
}

/** Prompted agent config. */
export interface PromptedAgentConfig<Input, ParsedInput, S extends AnySchema, Name extends string = string> {
  name: Name;
  description?: string;
  prompt: PromptDefinition<Input, ParsedInput>;
  schema: S;
  defaults?: AgentDefinitionDefaults;
}

/**
 * Why: Declares a reusable agent role without starting a model session.
 * Use: Use the static-prompt or typed-prompt overload at module scope, then pass the definition to `ctx.agent`.
 */
export declare function defineAgent<S extends AnySchema, const Name extends string = string>(
  config: StaticAgentConfig<S, Name>,
): AgentDefinition<
  {
    input: void;
    parsedInput: void;
    output: InferOut<S>;
    rawOutput: InferIn<S>;
    inputMode: "none";
    outputSchema: S;
  },
  Name
>;

/**
 * Why: Declares a reusable agent role without starting a model session.
 * Use: Use the static-prompt or typed-prompt overload at module scope, then pass the definition to `ctx.agent`.
 */
export declare function defineAgent<
  Input,
  ParsedInput,
  S extends AnySchema,
  const Name extends string = string,
>(config: PromptedAgentConfig<Input, ParsedInput, S, Name>): AgentDefinition<
  {
    input: Input;
    parsedInput: ParsedInput;
    output: InferOut<S>;
    rawOutput: InferIn<S>;
    inputMode: "required";
    outputSchema: S;
  },
  Name
>;

/** Goal invocation base. */
export type AnyGoalDefinition = GoalDefinition<any, string>;

/** Goal-definition family constrained to one builder-selected input mode. */
type GoalDefinitionWithInputMode<Mode extends InputMode> = GoalDefinition<
  Omit<GoalTypes, "inputMode"> & { readonly inputMode: Mode },
  string
>;

/**
 * Why: Holds fields shared by every correlated goal binding before its definition-specific input mode is applied.
 * Use: Prefer `GoalInvocation` or `bindGoal`; this base is useful only for erased engine dispatch.
 */
export interface GoalInvocationBase<Definition extends AnyGoalDefinition> {
  readonly definition: Definition;
  readonly attempts?: number;
}

/** No goal input. */
export interface NoGoalInput {
  readonly input?: never;
}

/** Required goal input. */
export interface RequiredGoalInput<Input> {
  readonly input: Input;
}

/**
 * Why: Recovers the raw input type bound to one goal definition independently of whether that type includes `undefined`.
 * Use: Prefer `GoalInvocation`; use this extractor when building goal-aware helpers.
 */
export type GoalInputOf<Definition> =
  Definition extends GoalDefinition<infer Types, any> ? Types["input"] : never;

/**
 * Why: Recovers the definition-form input mode that the goal builder minted.
 * Use: Use it to require an explicit input property for schema and typed goals even when their value type includes `undefined`.
 */
export type GoalInputModeOf<Definition> =
  Definition extends GoalDefinition<infer Types, any> ? Types["inputMode"] : InputMode;

/**
 * Why: Selects goal invocation input presence from the definition form rather than assignability of `undefined`.
 * Use: It is applied by `GoalInvocation`, `bindGoal`, and agent call types.
 */
export type GoalInputArgument<Definition extends AnyGoalDefinition> =
  GoalInputModeOf<Definition> extends "none"
    ? NoGoalInput
    : RequiredGoalInput<GoalInputOf<Definition>>;

/** Goal invocation. */
export type GoalInvocation<Definition extends AnyGoalDefinition> =
  Definition extends AnyGoalDefinition
    ? GoalInvocationBase<Definition> & GoalInputArgument<Definition>
    : never;

/**
 * Why: Gives the author-facing name to a definition-correlated goal invocation passed into an agent call.
 * Use: Create it inline or with `bindGoal`; a mismatched input cannot be detached from its definition.
 */
export type GoalBinding<Definition extends AnyGoalDefinition> = GoalInvocation<Definition>;

/**
 * Why: Constructs a correlated no-input goal binding without creating another workflow node or effect.
 * Use: Call it for a goal built from the static definition form and optionally set an attempt limit.
 */
export declare function bindGoal<Definition extends GoalDefinitionWithInputMode<"none">>(
  definition: Definition,
  options?: { readonly attempts?: number },
): GoalBinding<Definition>;

/**
 * Why: Constructs a correlated required-input goal binding with concise inference and targeted diagnostics.
 * Use: Pass the definition and its exact raw input, even when that input value is explicitly `undefined`.
 */
export declare function bindGoal<Definition extends GoalDefinitionWithInputMode<"required">>(
  definition: Definition,
  input: GoalInputOf<Definition>,
  options?: { readonly attempts?: number },
): GoalBinding<Definition>;

/**
 * Why: Names the two explicit failure policies supported by the unified agent call.
 * Use: Omit it or use `"throw"` for required completion; use `"return"` for an exhaustive `AgentOutcome`.
 */
export type AgentFailureMode = "throw" | "return";

/** Fields shared by every agent call. */
interface AgentCallBase extends AgentExecutionOptions {
  key: string;
  failure?: AgentFailureMode;
}

/**
 * Why: Names the erased union accepted by internal agent dispatch without weakening public definition-input correlation.
 * Use: Internal engine types may carry it after a public call has already been checked.
 */
export type AnyAgentDefinition = AgentDefinition<any, string>;

/**
 * Why: Makes absence of an agent completion goal explicit in generic call construction.
 * Use: It is selected automatically when the call's goal type is `undefined`.
 */
export interface AgentCallWithoutGoal {
  readonly goal?: never;
}

/**
 * Why: Couples one agent call to the exact definition and input of its completion goal.
 * Use: It is selected automatically when a concrete goal definition is inferred from `goal.definition`.
 */
export interface AgentCallWithGoal<Definition extends AnyGoalDefinition> {
  readonly goal: GoalBinding<Definition>;
}

/**
 * Why: Selects the correlated goal field for both inline and reusable agent calls.
 * Use: Supply a concrete goal definition type or leave the goal generic as `undefined`.
 */
export type AgentGoalArgument<Goal extends AnyGoalDefinition | undefined> =
  [Goal] extends [undefined]
    ? AgentCallWithoutGoal
    : Goal extends AnyGoalDefinition
      ? AgentCallWithGoal<Goal>
      : never;

/** Inline agent call. */
export interface InlineAgentFields<S extends AnySchema> {
  prompt: PromptPart;
  schema: S;
  agent?: never;
  input?: never;
}

/** Inline agent call. */
export type InlineAgentCall<
  S extends AnySchema = AnySchema,
  Goal extends AnyGoalDefinition | undefined = undefined,
> = AgentCallBase & InlineAgentFields<S> & AgentGoalArgument<Goal>;

/** Defined agent fields. */
export interface DefinedAgentFields<Definition extends AnyAgentDefinition> {
  agent: Definition;
  prompt?: never;
  schema?: never;
}

/**
 * Why: Recovers the raw input type retained by one reusable agent definition.
 * Use: It supplies the required `input` property of a defined agent call.
 */
export type AgentDefinitionInput<Definition> =
  Definition extends AgentDefinition<infer Types, any> ? Types["input"] : never;

/**
 * Why: Recovers the input-presence mode minted by the static or typed agent definition overload.
 * Use: It keeps `unknown`, `any`, and unions containing `undefined` in the explicit-input branch.
 */
export type AgentInputModeOf<Definition> =
  Definition extends AgentDefinition<infer Types, any> ? Types["inputMode"] : InputMode;

/**
 * Why: Selects reusable-agent input presence from its definition form instead of its value type.
 * Use: It is applied to every public defined-agent call.
 */
export type DefinedAgentInput<Definition extends AnyAgentDefinition> =
  AgentInputModeOf<Definition> extends "none"
    ? NoGoalInput
    : RequiredGoalInput<AgentDefinitionInput<Definition>>;

/** Defined agent call. */
export type DefinedAgentCall<
  Definition extends AnyAgentDefinition = AnyAgentDefinition,
  Goal extends AnyGoalDefinition | undefined = undefined,
> = Definition extends AnyAgentDefinition
  ? AgentCallBase &
    DefinedAgentFields<Definition> &
    DefinedAgentInput<Definition> &
    AgentGoalArgument<Goal>
  : never;

/** Any agent call. */
export type AnyAgentCall = InlineAgentCall<any, any> | AnyDefinedAgentCall;

/** Any defined agent call. */
export interface AnyDefinedAgentCall extends AgentCallBase {
  agent: AnyAgentDefinition;
  input?: unknown;
  goal?: GoalInvocationBase<AnyGoalDefinition> & { readonly input?: unknown };
  prompt?: never;
  schema?: never;
}

/**
 * Why: Describes one terminal agent failure without collapsing provider, validation, budget, timeout, or goal exhaustion into `null`.
 * Use: Narrow it from a call made with `failure: "return"` and retain its diagnostic fields.
 */
export interface AgentFailure {
  readonly kind: "provider" | "validation" | "budget" | "timeout" | "goal-exhausted" | "cancelled";
  readonly message: string;
  readonly retryable: boolean;
}

/**
 * Why: Makes optional agent failure explicit and exhaustively branchable while preserving successful result metadata.
 * Use: Request it with `failure: "return"`; branch on `ok` instead of catching or testing a nullable result.
 */
export type AgentOutcome<
  Value,
  Goal = undefined,
  Success = AgentResult<Value, Goal>,
> =
  | { readonly ok: true; readonly result: Success }
  | {
      readonly ok: false;
      readonly error: AgentFailure;
      readonly attempts: number;
      readonly sessionId?: string;
    };

/**
 * Why: Carries invocation-only policy independently from an agent definition and its input.
 * Use: Pass it as the final argument to `ctx.agent`; `write` grants mutation and `failure` selects throw versus return.
 */
export interface AgentCallOptionsBase extends Omit<AgentExecutionOptions, "key"> {
  readonly key: string;
  readonly failure?: AgentFailureMode;
}

/**
 * Why: Correlates an invocation's optional completion goal with the exact goal input accepted by its definition.
 * Use: Name a reusable options object with the concrete goal type when needed; inline objects infer it automatically.
 */
export type AgentCallOptions<
  Goal extends AnyGoalDefinition | undefined = undefined,
> = AgentCallOptionsBase & AgentGoalArgument<Goal>;

/**
 * Why: Gives one-off prompt/schema calls the same first-argument position as reusable agent definitions.
 * Use: Pass it to `ctx.agent` with an options object when defining a reusable role would add no clarity.
 */
export interface InlineAgentDefinition<S extends AnySchema = AnySchema> {
  readonly prompt: PromptPart;
  readonly schema: S;
}

/**
 * Why: Derives the successful goal envelope from one exact goal definition.
 * Use: It is used by the unified agent-call return types.
 */
export type AgentGoalResultOf<Goal extends AnyGoalDefinition | undefined> =
  Goal extends GoalDefinition<infer Types, any> ? Types["result"] : undefined;

/**
 * Why: Derives the validated output of one exact reusable agent definition.
 * Use: It is used by the unified agent-call return types.
 */
export type AgentOutputOf<Definition extends AnyAgentDefinition> =
  AgentTypesOf<Definition>["output"];

/** Exact completion-goal definition inferred from one invocation options object. */
type AgentGoalDefinitionOfOptions<Options> =
  Options extends { readonly goal: GoalInvocationBase<infer Definition> }
    ? Definition
    : undefined;

/** Revalidates an inferred goal binding against the exact definition carried by that same options object. */
type CorrelatedAgentOptions<Options> = Options extends {
  readonly goal: GoalInvocationBase<infer Definition>;
}
  ? AgentCallWithGoal<Definition>
  : AgentCallWithoutGoal;

/**
 * Why: Selects patch semantics from the exact write option while remaining safe for widened option objects.
 * Use: Concrete `write` returns a write result; optional or union-typed `write` returns every possible success envelope.
 */
export type AgentSuccessResult<
  Value,
  Goal,
  Options,
  Workspace extends boolean,
> = Options extends { readonly write: WriteScope }
  ? Workspace extends true
    ? WorkspaceWriteAgentResult<Value, Goal>
    : PatchAgentResult<Value, Goal>
  : "write" extends keyof Options
    ? | AgentResult<Value, Goal>
      | (Workspace extends true
          ? WorkspaceWriteAgentResult<Value, Goal>
          : PatchAgentResult<Value, Goal>)
    : AgentResult<Value, Goal>;

/**
 * Why: Selects throwing versus returned failure without narrowing widened option objects unsafely.
 * Use: It is the exact promise value produced by the unified `ctx.agent` overloads.
 */
export type AgentCallResult<
  Value,
  Goal,
  Options,
  Workspace extends boolean,
  Success = AgentSuccessResult<Value, Goal, Options, Workspace>,
> = Options extends { readonly failure: "return" }
  ? AgentOutcome<Value, Goal, Success>
  : Options extends { readonly failure: "throw" }
    ? Success
    : "failure" extends keyof Options
      ? Success | AgentOutcome<Value, Goal, Success>
      : Success;

/** Reusable agent family built from the static, inputless definition form. */
type InputlessAgentDefinition = AgentDefinition<
  Omit<AgentTypes, "inputMode"> & { readonly inputMode: "none" },
  string
>;

/** Reusable agent family built from a typed, required-input definition form. */
type RequiredInputAgentDefinition = AgentDefinition<
  Omit<AgentTypes, "inputMode"> & { readonly inputMode: "required" },
  string
>;

/** Keeps a widened reusable definition paired with the input accepted by that same union branch. */
type RequiredAgentArguments<
  Definition extends RequiredInputAgentDefinition,
  Options extends AgentCallOptionsBase,
> = Definition extends RequiredInputAgentDefinition
  ? readonly [
      definition: Definition,
      input: AgentDefinitionInput<Definition>,
      options: Options & CorrelatedAgentOptions<Options>,
    ]
  : never;

/**
 * Why: Presents one orthogonal agent operation instead of separate read, write, and failure methods.
 * Use: Call `ctx.agent(definition, input, options)`; omit input for a static definition or use an inline prompt/schema object.
 */
export interface AgentFn<Workspace extends boolean = false> {
  <
    Definition extends RequiredInputAgentDefinition,
    const Options extends AgentCallOptionsBase,
  >(
    ...args: RequiredAgentArguments<Definition, Options>
  ): Promise<
    AgentCallResult<
      AgentOutputOf<Definition>,
      AgentGoalResultOf<AgentGoalDefinitionOfOptions<Options>>,
      Options,
      Workspace
    >
  >;
  <
    Definition extends InputlessAgentDefinition,
    const Options extends AgentCallOptionsBase,
  >(
    definition: Definition,
    options: Options & CorrelatedAgentOptions<Options>,
  ): Promise<
    AgentCallResult<
      AgentOutputOf<Definition>,
      AgentGoalResultOf<AgentGoalDefinitionOfOptions<Options>>,
      Options,
      Workspace
    >
  >;
  <S extends AnySchema, const Options extends AgentCallOptionsBase>(
    inline: InlineAgentDefinition<S>,
    options: Options & CorrelatedAgentOptions<Options>,
  ): Promise<
    AgentCallResult<
      InferOut<S>,
      AgentGoalResultOf<AgentGoalDefinitionOfOptions<Options>>,
      Options,
      Workspace
    >
  >;
}

/** Task context a review agent may observe without mutating durable task state. */
type ReviewAgentTaskAccess = Omit<AgentTaskAccess, "mode"> & { readonly mode: "read" };

/** Removes writes, delegated operations, and write-capable task access from review invocation policy. */
export type ReviewAgentCallOptionsBase =
  Omit<AgentCallOptionsBase, "write" | "tasks" | "tools"> & {
    readonly write?: never;
    readonly tasks?: false | ReviewAgentTaskAccess;
    readonly tools?: never;
  };

/** Correlated options accepted by the read-only agent surface exposed during a review. */
export type ReviewAgentCallOptions<Goal extends AnyGoalDefinition | undefined = undefined> =
  ReviewAgentCallOptionsBase & AgentGoalArgument<Goal>;

/**
 * Why: Gives reviews agent reasoning without patch writes, task mutation, or delegated operation capabilities.
 * Use: Expose it through `ReviewCtx`; full workflow contexts continue to receive `AgentFn`.
 */
export interface ReadOnlyAgentApi {
  <
    Definition extends RequiredInputAgentDefinition,
    const Options extends ReviewAgentCallOptionsBase,
  >(
    ...args: RequiredAgentArguments<Definition, Options>
  ): Promise<
    AgentCallResult<
      AgentOutputOf<Definition>,
      AgentGoalResultOf<AgentGoalDefinitionOfOptions<Options>>,
      Options,
      false
    >
  >;
  <
    Definition extends InputlessAgentDefinition,
    const Options extends ReviewAgentCallOptionsBase,
  >(
    definition: Definition,
    options: Options & CorrelatedAgentOptions<Options>,
  ): Promise<
    AgentCallResult<
      AgentOutputOf<Definition>,
      AgentGoalResultOf<AgentGoalDefinitionOfOptions<Options>>,
      Options,
      false
    >
  >;
  <S extends AnySchema, const Options extends ReviewAgentCallOptionsBase>(
    inline: InlineAgentDefinition<S>,
    options: Options & CorrelatedAgentOptions<Options>,
  ): Promise<
    AgentCallResult<
      InferOut<S>,
      AgentGoalResultOf<AgentGoalDefinitionOfOptions<Options>>,
      Options,
      false
    >
  >;
}

/** Recipe config. */
export interface RecipeConfig<
  InputSchema extends AnySchema,
  OutputSchema extends AnySchema,
  Name extends string = string,
> {
  name: Name;
  description?: string;
  input: InputSchema;
  output: OutputSchema;
  run: (
    ctx: WorkflowCtx<any, any>,
    input: InferOut<InputSchema>,
  ) => Promise<InferIn<OutputSchema>> | InferIn<OutputSchema>;
}

/**
 * Why: Names the hidden schema and value relationships carried by one reusable recipe definition.
 * Use: Recipe builders construct it; authors normally consume its fields through definition extractors.
 */
export interface RecipeTypes {
  readonly input: unknown;
  readonly parsedInput: unknown;
  readonly output: unknown;
  readonly rawOutput: unknown;
  readonly inputSchema: AnySchema;
  readonly outputSchema: AnySchema;
}

/**
 * Why: Provides schema-backed reusable orchestration without creating a separate child run.
 * Use: Create it with `defineRecipe` and invoke it through `ctx.recipe`, sequence, or parallel composition.
 */
export interface RecipeDefinition<
  Types extends RecipeTypes = RecipeTypes,
  Name extends string = string,
> extends WorkflowNode<"weft.recipe">,
    DefinitionTypeCarrier<Types> {
  readonly kind: "weft.recipe";
  readonly name: Name;
  readonly description?: string;
  readonly input: Types["inputSchema"];
  readonly output: Types["outputSchema"];
}

/** Erased reusable recipe family used by composition and engine dispatch. */
export type AnyRecipeDefinition = RecipeDefinition<any, string>;

/** Exact hidden type relationships carried by one reusable recipe definition. */
export type RecipeTypesOf<Definition> =
  Definition extends RecipeDefinition<infer Types, any> ? Types : never;

/**
 * Why: Recovers the exact definition-time name retained by one reusable recipe.
 * Use: Apply it to `typeof recipe` when building typed registries or provenance views.
 */
export type RecipeNameOf<Definition> =
  Definition extends RecipeDefinition<any, infer Name> ? Name : never;

/** Raw schema-bound input retained by one reusable recipe definition. */
export type RecipeInputOf<Definition extends AnyRecipeDefinition> = RecipeTypesOf<Definition>["input"];

/** Validated output retained by one reusable recipe definition. */
export type RecipeOutputOf<Definition extends AnyRecipeDefinition> = RecipeTypesOf<Definition>["output"];

/**
 * Why: Declares transparent reusable orchestration with validated input and output.
 * Use: Use it when nested effects should remain in the current run and journal.
 */
export declare function defineRecipe<
  InputSchema extends AnySchema,
  OutputSchema extends AnySchema,
  const Name extends string = string,
>(
  config: RecipeConfig<InputSchema, OutputSchema, Name>,
): RecipeDefinition<
  {
    input: InferIn<InputSchema>;
    parsedInput: InferOut<InputSchema>;
    output: InferOut<OutputSchema>;
    rawOutput: InferIn<OutputSchema>;
    inputSchema: InputSchema;
    outputSchema: OutputSchema;
  },
  Name
>;
