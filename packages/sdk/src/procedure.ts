import type { AnySchema, InferIn, InferOut } from "./schema.ts";

/** A named same-run body. The engine re-enters it on resume and replays its individual effects. */
export interface ProcedureDefinition<Input, Output, Requires, ParsedInput = Input, RawOutput = Output> {
  readonly kind: "weft.procedure";
  readonly name: string;
  readonly revision: string;
  readonly description?: string;
  readonly input: AnySchema;
  readonly output: AnySchema;
  /** Optional host-readable capability manifest; it never grants capabilities. */
  readonly requires: readonly (keyof Requires & string)[];
  readonly run: (ctx: Requires, input: ParsedInput) => Promise<RawOutput> | RawOutput;
  readonly __input?: Input;
  readonly __output?: Output;
}

export interface ProcedureOptions {
  /** Stable invocation identity. All nested effect keys are local to this invocation. */
  key: string;
  label?: string;
}

export type ProcedureFn<Self> = <Input, Output, ParsedInput, RawOutput>(
  definition: ProcedureDefinition<Input, Output, Self, ParsedInput, RawOutput>,
  input: Input,
  opts: ProcedureOptions,
) => Promise<Output>;

/** Annotate run's context with the capabilities the body consumes (for example Pick<Ctx, "git" | "exec">). */
export function defineProcedure<
  InputSchema extends AnySchema,
  OutputSchema extends AnySchema,
  Requires,
>(config: {
  name: string;
  revision: string;
  description?: string;
  input: InputSchema;
  output: OutputSchema;
  requires?: readonly (keyof Requires & string)[];
  run: (
    ctx: Requires,
    input: InferOut<InputSchema>,
  ) => Promise<InferIn<OutputSchema>> | InferIn<OutputSchema>;
}): ProcedureDefinition<
  InferIn<InputSchema>,
  InferOut<OutputSchema>,
  Requires,
  InferOut<InputSchema>,
  InferIn<OutputSchema>
> {
  for (const field of ["name", "revision"] as const) {
    if (typeof config[field] !== "string" || config[field].trim() === "") {
      throw new TypeError(`defineProcedure: ${field} must be a non-empty string`);
    }
  }
  for (const field of ["input", "output"] as const) {
    if (typeof config[field]?.["~standard"]?.validate !== "function") {
      throw new TypeError(`defineProcedure: ${field} must be a Standard Schema`);
    }
  }
  if (typeof config.run !== "function") throw new TypeError("defineProcedure: run must be a function");
  if (config.requires?.some((key) => typeof key !== "string" || key.trim() === "")) {
    throw new TypeError("defineProcedure: requires must contain non-empty capability names");
  }
  return Object.freeze({
    ...config,
    kind: "weft.procedure" as const,
    requires: Object.freeze([...(config.requires ?? [])]),
  });
}
