/** Declaration-only atomic operation surface for the Weft DSL prototype. */

import type { AnySchema, Duration, InferIn, InferOut, Risk, WorkflowNode } from "./shared.ts";

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
 * Why: Centralizes timeout, retry, and authorization defaults for every invocation of one operation.
 * Use: Set it on `defineOperation`; individual invocations may tighten these limits.
 */
export interface OperationDefaults {
  timeout?: Duration;
  attempts?: number;
  risk?: Risk;
}

/**
 * Why: Represents one schema-validated atomic integration boundary separately from transparent recipes.
 * Use: Create it with `defineOperation`, then invoke it through `ctx.operation`.
 */
export interface OperationDefinition<InputSchema extends AnySchema, OutputSchema extends AnySchema>
  extends WorkflowNode<"weft.operation"> {
  readonly kind: "weft.operation";
  readonly name: string;
  readonly description?: string;
  readonly input: InputSchema;
  readonly output: OutputSchema;
  readonly capabilities: readonly OperationCapability[];
  readonly defaults: Readonly<OperationDefaults>;
  readonly run: (
    input: InferOut<InputSchema>,
    context: OperationRunContext,
  ) => Promise<InferIn<OutputSchema>> | InferIn<OutputSchema>;
}

/**
 * Why: Declares every field needed to validate, authorize, execute, and test one atomic operation.
 * Use: Pass it to `defineOperation`; choose a recipe instead when nested effects must remain independently visible.
 */
export interface OperationConfig<InputSchema extends AnySchema, OutputSchema extends AnySchema> {
  name: string;
  description?: string;
  input: InputSchema;
  output: OutputSchema;
  capabilities?: readonly OperationCapability[];
  defaults?: OperationDefaults;
  run: (
    input: InferOut<InputSchema>,
    context: OperationRunContext,
  ) => Promise<InferIn<OutputSchema>> | InferIn<OutputSchema>;
}

/**
 * Why: Declares a reusable atomic effect without executing or authorizing it at definition time.
 * Use: Define host or repository integration operations at module scope and call them through `ctx.operation`.
 */
export declare function defineOperation<InputSchema extends AnySchema, OutputSchema extends AnySchema>(
  config: OperationConfig<InputSchema, OutputSchema>,
): OperationDefinition<InputSchema, OutputSchema>;

/**
 * Why: Recovers the raw input accepted by an operation definition before schema validation.
 * Use: It supplies `ctx.operation` and the internal operation invocation input.
 */
export type OperationInputOf<Definition> =
  Definition extends OperationDefinition<infer InputSchema, infer _OutputSchema>
    ? InferIn<InputSchema>
    : never;

/**
 * Why: Recovers the validated result produced by an operation definition.
 * Use: It supplies `ctx.operation` and the internal operation invocation output.
 */
export type OperationOutputOf<Definition> =
  Definition extends OperationDefinition<infer _InputSchema, infer OutputSchema>
    ? InferOut<OutputSchema>
    : never;

/**
 * Why: Supplies durable identity and per-call limits for an atomic operation invocation.
 * Use: Pass it to `ctx.operation`; risk may be strengthened but never used to bypass host policy.
 */
export interface OperationInvocationOptions {
  key: string;
  label?: string;
  timeout?: Duration;
  attempts?: number;
  risk?: Risk;
}

/**
 * Why: Exposes reusable typed atomic integrations without collapsing them into recipes or raw commands.
 * Use: Call `ctx.operation(definition, input, options)` and consume its schema-validated output.
 */
export type OperationFn = <Definition extends WorkflowNode<"weft.operation">>(
  definition: Definition,
  input: OperationInputOf<Definition>,
  options: OperationInvocationOptions,
) => Promise<OperationOutputOf<Definition>>;
