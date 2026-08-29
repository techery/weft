/** Declaration-only agent surface for the Weft DSL prototype. */

import type { ContextSnapshot } from "./context-sources.ts";
import type { GoalDefinition, GoalResult } from "./goals.ts";
import type { WriteScope } from "./path-policies.ts";
import type {
  AnySchema,
  Duration,
  InferIn,
  InferOut,
  PromptDefinition,
  PromptPart,
  Provider,
  ProviderRequirements,
  WorkflowNode,
  WorkspaceSnapshotRef,
} from "./shared.ts";
import type { AgentTaskAccess } from "./tasks.ts";
import type { Ctx } from "./workflow.ts";

// ---------------------------------------------------------------------------
// Agents and reusable recipes
// ---------------------------------------------------------------------------

/**
 * Why: Gives the agent DSL an explicit usage contract instead of relying on untyped values.
 * Use: Import it when declaring, configuring, or consuming the corresponding agent API.
 */
export interface Usage {
  input: number;
  output: number;
  cacheRead?: number;
  usd?: number;
  samples?: number;
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
export interface PatchRef {
  readonly ref: string;
  readonly key: string;
  readonly files: string[];
  readonly base: WorkspaceSnapshotRef;
  readonly baseTree: string;
  readonly quarantined?: boolean;
  readonly outOfScope?: string[];
  readonly [patchRefBrand]: true;
}

/**
 * Why: Returns validated model output and operational metadata in one stable envelope.
 * Use: Read `value` for domain data and use files, usage, patch, session, attempts, or goal evidence when needed.
 */
export interface AgentResultBase<T> {
  value: T;
  usage: Usage;
  files: string[];
  patch?: PatchRef;
  attempts: number;
  sessionId?: string;
}

/**
 * Why: Gives the agent DSL an explicit agent result without goal contract instead of relying on untyped values.
 * Use: Import it when declaring, configuring, or consuming the corresponding agent API.
 */
export interface AgentResultWithoutGoal {
  goal?: never;
}

/**
 * Why: Gives the agent DSL an explicit agent result with goal contract instead of relying on untyped values.
 * Use: Import it when declaring, configuring, or consuming the corresponding agent API.
 */
export interface AgentResultWithGoal<Goal> {
  goal: Goal;
}

/**
 * Why: Gives the agent DSL an explicit agent goal field contract instead of relying on untyped values.
 * Use: Import it when declaring, configuring, or consuming the corresponding agent API.
 */
export type AgentGoalField<Goal> = [Goal] extends [undefined]
  ? AgentResultWithoutGoal
  : AgentResultWithGoal<Goal>;

/**
 * Why: Returns validated model output and operational metadata in one stable envelope.
 * Use: Read `value` for domain data and use files, usage, patch, session, attempts, or goal evidence when needed.
 */
export type AgentResult<T, Goal = undefined> = AgentResultBase<T> & AgentGoalField<Goal>;

/**
 * Why: Gives the agent DSL an explicit required patch contract instead of relying on untyped values.
 * Use: Import it when declaring, configuring, or consuming the corresponding agent API.
 */
export interface RequiredPatch {
  patch: PatchRef;
}

/**
 * Why: Gives the agent DSL an explicit integrated workspace patch contract instead of relying on untyped values.
 * Use: Import it when declaring, configuring, or consuming the corresponding agent API.
 */
export interface IntegratedWorkspacePatch {
  patch?: never;
}

/**
 * Why: Gives the agent DSL an explicit patch agent result contract instead of relying on untyped values.
 * Use: Import it when declaring, configuring, or consuming the corresponding agent API.
 */
export type PatchAgentResult<T, Goal = undefined> = Omit<AgentResult<T, Goal>, "patch"> & RequiredPatch;

/**
 * Why: Gives the agent DSL an explicit workspace write agent result contract instead of relying on untyped values.
 * Use: Import it when declaring, configuring, or consuming the corresponding agent API.
 */
export type WorkspaceWriteAgentResult<T, Goal = undefined> = Omit<AgentResult<T, Goal>, "patch"> &
  IntegratedWorkspacePatch;

/**
 * Why: Gives the agent DSL an explicit retry options contract instead of relying on untyped values.
 * Use: Import it when declaring, configuring, or consuming the corresponding agent API.
 */
export interface RetryOptions {
  attempts: number;
  backoff?: Duration;
}

/**
 * Why: Gives the agent DSL an explicit agent goal options contract instead of relying on untyped values.
 * Use: Import it when declaring, configuring, or consuming the corresponding agent API.
 */
export interface AgentGoalOptions {
  definition: GoalDefinition<any, any, any>;
  input?: unknown;
  attempts?: number;
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

/**
 * Why: Gives the agent DSL an explicit agent execution options contract instead of relying on untyped values.
 * Use: Import it when declaring, configuring, or consuming the corresponding agent API.
 */
export interface AgentExecutionOptions {
  key?: string;
  label?: string;
  provider?: Provider;
  providerRequirements?: ProviderRequirements;
  write?: WriteScope;
  goal?: AgentGoalOptions;
  maxTurns?: number;
  timeout?: Duration;
  retry?: RetryOptions;
  repair?: number;
  onMaxTurns?: "finalize" | "fail";
  onError?: "throw" | "null";
  tasks?: false | AgentTaskAccess;
  tools?: readonly AgentTool[];
  context?: readonly ContextSnapshot<unknown>[];
}

/**
 * Why: Gives the agent DSL an explicit agent definition defaults contract instead of relying on untyped values.
 * Use: Import it when declaring, configuring, or consuming the corresponding agent API.
 */
export type AgentDefinitionDefaults = Omit<
  AgentExecutionOptions,
  "key" | "label" | "write" | "goal" | "onError" | "tasks"
>;

/**
 * Why: Names a reusable typed role with one prompt, output schema, and routing defaults.
 * Use: Create it with `defineAgent` and invoke it through `ctx.agent({ agent, input, ... })`.
 */
export interface AgentDefinition<
  Input,
  S extends AnySchema,
  ParsedInput = Input,
  Name extends string = string,
> extends WorkflowNode<"weft.agent"> {
  readonly kind: "weft.agent";
  readonly name: Name;
  readonly description?: string;
  readonly prompt: string | PromptDefinition<Input, ParsedInput>;
  readonly schema: S;
  readonly defaults: Readonly<AgentDefinitionDefaults>;
}

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

/**
 * Why: Gives the agent DSL an explicit prompted agent config contract instead of relying on untyped values.
 * Use: Import it when declaring, configuring, or consuming the corresponding agent API.
 */
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
): AgentDefinition<void, S, void, Name>;

/**
 * Why: Declares a reusable agent role without starting a model session.
 * Use: Use the static-prompt or typed-prompt overload at module scope, then pass the definition to `ctx.agent`.
 */
export declare function defineAgent<
  Input,
  ParsedInput,
  S extends AnySchema,
  const Name extends string = string,
>(config: PromptedAgentConfig<Input, ParsedInput, S, Name>): AgentDefinition<Input, S, ParsedInput, Name>;

/**
 * Why: Gives the agent DSL an explicit goal invocation base contract instead of relying on untyped values.
 * Use: Import it when declaring, configuring, or consuming the corresponding agent API.
 */
export interface GoalInvocationBase<Definition extends GoalDefinition<any, any, any>> {
  definition: Definition;
  attempts?: number;
}

/**
 * Why: Gives the agent DSL an explicit no goal input contract instead of relying on untyped values.
 * Use: Import it when declaring, configuring, or consuming the corresponding agent API.
 */
export interface NoGoalInput {
  input?: never;
}

/**
 * Why: Gives the agent DSL an explicit required goal input contract instead of relying on untyped values.
 * Use: Import it when declaring, configuring, or consuming the corresponding agent API.
 */
export interface RequiredGoalInput<Input> {
  input: Input;
}

/**
 * Why: Gives the agent DSL an explicit goal input argument contract instead of relying on untyped values.
 * Use: Import it when declaring, configuring, or consuming the corresponding agent API.
 */
export type GoalInputArgument<Input> = [undefined] extends [Input] ? NoGoalInput : RequiredGoalInput<Input>;

/**
 * Why: Gives the agent DSL an explicit goal invocation contract instead of relying on untyped values.
 * Use: Import it when declaring, configuring, or consuming the corresponding agent API.
 */
export type GoalInvocation<Definition extends GoalDefinition<any, any, any>> =
  GoalInvocationBase<Definition> &
    (Definition extends GoalDefinition<infer Input, any, any> ? GoalInputArgument<Input> : never);

/**
 * Why: Centralizes the internal agent call base relationship so adjacent public declarations infer consistently.
 * Use: It is used by the surrounding agent types and is not a separate runtime feature.
 */
interface AgentCallBase extends AgentExecutionOptions {
  key: string;
}

/**
 * Why: Gives the agent DSL an explicit inline agent call contract instead of relying on untyped values.
 * Use: Import it when declaring, configuring, or consuming the corresponding agent API.
 */
export interface InlineAgentFields<S extends AnySchema> {
  prompt: PromptPart;
  schema: S;
  agent?: never;
  input?: never;
}

/**
 * Why: Gives the agent DSL an explicit inline agent call contract instead of relying on untyped values.
 * Use: Import it when declaring, configuring, or consuming the corresponding agent API.
 */
export type InlineAgentCall<S extends AnySchema = AnySchema> = AgentCallBase & InlineAgentFields<S>;

/**
 * Why: Gives the agent DSL an explicit defined agent fields contract instead of relying on untyped values.
 * Use: Import it when declaring, configuring, or consuming the corresponding agent API.
 */
export interface DefinedAgentFields<Input, S extends AnySchema, ParsedInput> {
  agent: AgentDefinition<Input, S, ParsedInput>;
  prompt?: never;
  schema?: never;
}

/**
 * Why: Gives the agent DSL an explicit defined agent input contract instead of relying on untyped values.
 * Use: Import it when declaring, configuring, or consuming the corresponding agent API.
 */
export type DefinedAgentInput<Input> = [undefined] extends [Input] ? NoGoalInput : RequiredGoalInput<Input>;

/**
 * Why: Gives the agent DSL an explicit defined agent call contract instead of relying on untyped values.
 * Use: Import it when declaring, configuring, or consuming the corresponding agent API.
 */
export type DefinedAgentCall<
  Input = unknown,
  S extends AnySchema = AnySchema,
  ParsedInput = Input,
> = AgentCallBase & DefinedAgentFields<Input, S, ParsedInput> & DefinedAgentInput<Input>;

/**
 * Why: Centralizes the internal agent definition input relationship so adjacent public declarations infer consistently.
 * Use: It is used by the surrounding agent types and is not a separate runtime feature.
 */
type AgentDefinitionInput<Definition> =
  Definition extends AgentDefinition<infer Input, any, any> ? Input : never;

/**
 * Why: Gives the agent DSL an explicit any agent call contract instead of relying on untyped values.
 * Use: Import it when declaring, configuring, or consuming the corresponding agent API.
 */
export type AnyAgentCall = InlineAgentCall<any> | AnyDefinedAgentCall;

/**
 * Why: Gives the agent DSL an explicit any defined agent call contract instead of relying on untyped values.
 * Use: Import it when declaring, configuring, or consuming the corresponding agent API.
 */
export interface AnyDefinedAgentCall extends AgentCallBase {
  agent: AgentDefinition<any, any, any>;
  input?: unknown;
  prompt?: never;
  schema?: never;
}

/**
 * Why: Centralizes the internal agent definition carrier relationship so adjacent public declarations infer consistently.
 * Use: It is used by the surrounding agent types and is not a separate runtime feature.
 */
interface AgentDefinitionCarrier<S extends AnySchema> {
  agent: AgentDefinition<any, S, any>;
}

/**
 * Why: Centralizes the internal agent value of relationship so adjacent public declarations infer consistently.
 * Use: It is used by the surrounding agent types and is not a separate runtime feature.
 */
type AgentValueOf<Call> =
  Call extends InlineAgentCall<infer S>
    ? InferOut<S>
    : Call extends AgentDefinitionCarrier<infer S>
      ? InferOut<S>
      : never;

/**
 * Why: Centralizes the internal agent goal of relationship so adjacent public declarations infer consistently.
 * Use: It is used by the surrounding agent types and is not a separate runtime feature.
 */
interface GoalDefinitionCarrier<Definition> {
  goal: GoalInvocationBase<Definition & GoalDefinition<any, any, any>>;
}

/**
 * Why: Centralizes the internal agent goal of relationship so adjacent public declarations infer consistently.
 * Use: It is used by the surrounding agent types and is not a separate runtime feature.
 */
type AgentGoalOf<Call> =
  Call extends GoalDefinitionCarrier<infer Definition>
    ? Definition extends GoalDefinition<any, infer Results, any>
      ? GoalResult<Results>
      : undefined
    : undefined;

/**
 * Why: Centralizes the internal write call carrier relationship so adjacent public declarations infer consistently.
 * Use: It is used by the surrounding agent types and is not a separate runtime feature.
 */
interface WriteCallCarrier {
  write: WriteScope;
}

/**
 * Why: Centralizes the internal nullable call carrier relationship so adjacent public declarations infer consistently.
 * Use: It is used by the surrounding agent types and is not a separate runtime feature.
 */
interface NullableCallCarrier {
  onError: "null";
}

/**
 * Why: Centralizes the internal agent envelope relationship so adjacent public declarations infer consistently.
 * Use: It is used by the surrounding agent types and is not a separate runtime feature.
 */
type AgentEnvelope<Call, Workspace extends boolean> = Call extends WriteCallCarrier
  ? Workspace extends true
    ? WorkspaceWriteAgentResult<AgentValueOf<Call>, AgentGoalOf<Call>>
    : PatchAgentResult<AgentValueOf<Call>, AgentGoalOf<Call>>
  : AgentResult<AgentValueOf<Call>, AgentGoalOf<Call>>;

/**
 * Why: Centralizes the internal nullable agent envelope relationship so adjacent public declarations infer consistently.
 * Use: It is used by the surrounding agent types and is not a separate runtime feature.
 */
type NullableAgentEnvelope<Call, Workspace extends boolean> = Call extends NullableCallCarrier
  ? AgentEnvelope<Call, Workspace> | null
  : AgentEnvelope<Call, Workspace>;

/**
 * Why: Models the unified object-shaped agent API and derives patch semantics from its bound context.
 * Use: Call it as `ctx.agent({...})`; plain contexts return isolated patches while workspace contexts write in place.
 */
export interface AgentFn<Workspace extends boolean = false> {
  <const Call extends AnyDefinedAgentCall>(
    call: Call & DefinedAgentInput<AgentDefinitionInput<Call["agent"]>>,
  ): Promise<NullableAgentEnvelope<Call, Workspace>>;
  <Call extends InlineAgentCall<any>>(call: Call): Promise<NullableAgentEnvelope<Call, Workspace>>;
}

/**
 * Why: Gives the agent DSL an explicit recipe config contract instead of relying on untyped values.
 * Use: Import it when declaring, configuring, or consuming the corresponding agent API.
 */
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
    ctx: Ctx<any, any, any>,
    input: InferOut<InputSchema>,
  ) => Promise<InferIn<OutputSchema>> | InferIn<OutputSchema>;
}

/**
 * Why: Provides schema-backed reusable orchestration without creating a separate child run.
 * Use: Create it with `defineRecipe` and invoke it through `ctx.recipe`, sequence, or parallel composition.
 */
export interface RecipeDefinition<
  Input,
  Output,
  ParsedInput = Input,
  RawOutput = Output,
  Name extends string = string,
> extends WorkflowNode<"weft.recipe"> {
  readonly kind: "weft.recipe";
  readonly name: Name;
  readonly description?: string;
  readonly input: AnySchema;
  readonly output: AnySchema;
  readonly run: (ctx: Ctx<any, any, any>, input: ParsedInput) => Promise<RawOutput> | RawOutput;
  readonly __input?: Input;
  readonly __output?: Output;
}

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
  InferIn<InputSchema>,
  InferOut<OutputSchema>,
  InferOut<InputSchema>,
  InferIn<OutputSchema>,
  Name
>;
