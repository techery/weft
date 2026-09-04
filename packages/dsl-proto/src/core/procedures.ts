/** Declaration-only procedures surface for the Weft DSL prototype. */

import type { AnySchema, DefinitionTypeCarrier, InferIn, InferOut, WorkflowNode } from "./shared.ts";

// ---------------------------------------------------------------------------
// Named reusable procedures
// ---------------------------------------------------------------------------

/**
 * Why: Makes the context a procedure body consumes contravariant, so a definition cannot be invoked from a context that supplies less.
 * Use: It is carried only by values returned from `defineProcedure` and is never read by workflow authors.
 */
declare const procedureRequires: unique symbol;

/** Exact hidden type relationships carried by one reusable procedure definition. */
export interface ProcedureTypes {
  input: unknown;
  parsedInput: unknown;
  output: unknown;
  rawOutput: unknown;
}

/**
 * Why: Represents one named body that runs inside the calling run while owning a durable key namespace, a revision, and validated schemas.
 * Use: Create it with `defineProcedure`, then invoke it through `ctx.procedure(definition, input, { key })`.
 */
export interface ProcedureDefinition<
  Types extends ProcedureTypes = ProcedureTypes,
  Name extends string = string,
  Requires = never,
> extends WorkflowNode<"weft.procedure">,
    DefinitionTypeCarrier<Types> {
  readonly kind: "weft.procedure";
  readonly name: Name;
  readonly description?: string;
  /** Invalidates recorded results whose body no longer means what the recorded run meant. */
  readonly revision: string;
  readonly input: AnySchema;
  readonly output: AnySchema;
  readonly [procedureRequires]: (ctx: Requires) => void;
}

/** Any procedure definition, whatever its schemas, name, or required context. */
export type AnyProcedureDefinition = ProcedureDefinition<any, any, any>;

/** Exact hidden type relationships carried by one reusable procedure definition. */
export type ProcedureTypesOf<Definition> =
  Definition extends ProcedureDefinition<infer Types, any, any> ? Types : never;

/**
 * Why: Recovers the raw schema input accepted by a procedure definition.
 * Use: It supplies the input side of `ctx.procedure` and its internal invocation.
 */
export type ProcedureInputOf<Definition> =
  ProcedureTypesOf<Definition> extends {
    input: infer Input;
  }
    ? Input
    : never;

/**
 * Why: Recovers the parsed output a procedure definition returns to its caller.
 * Use: Apply it to `typeof definition` when naming public call-site result types.
 */
export type ProcedureOutputOf<Definition> =
  ProcedureTypesOf<Definition> extends {
    output: infer Output;
  }
    ? Output
    : never;

/**
 * Why: Declares the identity, schemas, revision, and body of a reusable procedure without executing it.
 * Use: Annotate the `run` context parameter with exactly the capabilities the body needs, so the requirement stays a whitelist.
 */
export interface ProcedureConfig<
  InputSchema extends AnySchema,
  OutputSchema extends AnySchema,
  Requires,
  Name extends string = string,
> {
  name: Name;
  description?: string;
  revision: string;
  input: InputSchema;
  output: OutputSchema;
  run: (
    ctx: Requires,
    input: InferOut<InputSchema>,
  ) => Promise<InferIn<OutputSchema>> | InferIn<OutputSchema>;
}

/**
 * Why: Gives one procedure invocation a durable key and an optional presentation label without granting the body new authority.
 * Use: Pass it as the third argument to `ctx.procedure`; keys written inside the body stay local to this invocation.
 */
export interface ProcedureOptions {
  key: string;
  label?: string;
}

/**
 * Why: Exposes the boundary facts an audit and a workflow view need, including whether replay reused a recorded result.
 * Use: Call `ctx.procedure.detailed` when the caller must distinguish a replayed body from a freshly executed one.
 */
export interface ProcedureReceipt<Types extends ProcedureTypes = ProcedureTypes> {
  readonly value: Types["output"];
  readonly definitionDigest: string;
  readonly inputDigest: string;
  readonly outputDigest: string;
  readonly replayed: boolean;
}

/**
 * Why: Runs a named procedure inside the calling run so its name, schemas, status, and timing become host-observable without a child run.
 * Use: Call `ctx.procedure(definition, input, { key })`; the calling context must already supply every capability the body declares.
 */
export interface ProcedureFn<Self> {
  <Definition extends ProcedureDefinition<any, any, Self>>(
    definition: Definition,
    input: ProcedureInputOf<Definition>,
    opts: ProcedureOptions,
  ): Promise<ProcedureOutputOf<Definition>>;
  detailed<Definition extends ProcedureDefinition<any, any, Self>>(
    definition: Definition,
    input: ProcedureInputOf<Definition>,
    opts: ProcedureOptions,
  ): Promise<ProcedureReceipt<ProcedureTypesOf<Definition>>>;
}

/**
 * Why: Declares one named reusable body whose durable identity, schemas, and revision are visible to the engine and its views.
 * Use: Define it at module scope and invoke it through `ctx.procedure`; annotate `run`'s context with the capabilities it needs.
 */
export declare function defineProcedure<
  InputSchema extends AnySchema,
  OutputSchema extends AnySchema,
  Requires,
  const Name extends string = string,
>(
  config: ProcedureConfig<InputSchema, OutputSchema, Requires, Name>,
): ProcedureDefinition<
  {
    input: InferIn<InputSchema>;
    parsedInput: InferOut<InputSchema>;
    output: InferOut<OutputSchema>;
    rawOutput: InferIn<OutputSchema>;
  },
  Name,
  Requires
>;
