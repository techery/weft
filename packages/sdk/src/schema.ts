/**
 * Schema plumbing. Zod is the default; anything implementing Standard Schema V1
 * (Valibot, ArkType, …) is accepted everywhere a schema is required.
 */

/** The Standard Schema V1 interface (https://standardschema.dev). */
export interface StandardSchemaV1<Input = unknown, Output = Input> {
  readonly "~standard": StandardSchemaV1.Props<Input, Output>;
}

export declare namespace StandardSchemaV1 {
  interface Props<Input = unknown, Output = Input> {
    readonly version: 1;
    readonly vendor: string;
    readonly validate: (value: unknown) => Result<Output> | Promise<Result<Output>>;
    readonly types?: Types<Input, Output> | undefined;
  }
  type Result<Output> = SuccessResult<Output> | FailureResult;
  interface SuccessResult<Output> {
    readonly value: Output;
    readonly issues?: undefined;
  }
  interface FailureResult {
    readonly issues: ReadonlyArray<Issue>;
  }
  interface Issue {
    readonly message: string;
    readonly path?: ReadonlyArray<PropertyKey | PathSegment> | undefined;
  }
  interface PathSegment {
    readonly key: PropertyKey;
  }
  interface Types<Input = unknown, Output = Input> {
    readonly input: Input;
    readonly output: Output;
  }
  type InferInput<S extends StandardSchemaV1> = NonNullable<S["~standard"]["types"]>["input"];
  type InferOutput<S extends StandardSchemaV1> = NonNullable<S["~standard"]["types"]>["output"];
}

/** Any schema Weft accepts on a step. */
export type AnySchema = StandardSchemaV1<any, any>;

/** The typed value a schema produces. */
export type InferOut<S extends AnySchema> = StandardSchemaV1.InferOutput<S>;

/** The input side of a schema (what a caller must supply). */
export type InferIn<S extends AnySchema> = StandardSchemaV1.InferInput<S>;

/** A single validation problem, normalized for journaling and repair prompts. */
export interface SchemaIssue {
  message: string;
  path: string;
}

export type ValidationResult<T> = { ok: true; value: T } | { ok: false; issues: SchemaIssue[] };

function normalizePath(path: StandardSchemaV1.Issue["path"]): string {
  if (!path || path.length === 0) return "";
  return path
    .map((seg) => String(typeof seg === "object" && seg !== null && "key" in seg ? seg.key : seg))
    .join(".");
}

/** Validate a value against any Standard Schema, normalizing the outcome. */
export async function validateSchema<S extends AnySchema>(
  schema: S,
  value: unknown,
): Promise<ValidationResult<InferOut<S>>> {
  const result = await schema["~standard"].validate(value);
  if (result.issues) {
    return {
      ok: false,
      issues: result.issues.map((i) => ({ message: i.message, path: normalizePath(i.path) })),
    };
  }
  return { ok: true, value: result.value as InferOut<S> };
}

/** True when the schema is a Zod schema (enables z.toJSONSchema on the engine side). */
export function isZodSchema(schema: AnySchema): boolean {
  return schema["~standard"].vendor === "zod";
}
