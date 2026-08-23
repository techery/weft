import type { AnySchema, InferIn, InferOut } from "./schema.ts";
import type { Ctx, Effort, ProviderId } from "./types.ts";

/**
 * Workflow metadata. `name` derives from the filename in module mode; override with
 * `name:` for inline scripts or explicit registration.
 */
export interface WorkflowMeta<InS extends AnySchema, OutS extends AnySchema> {
  name?: string;
  description: string;
  input: InS;
  output: OutS;
  /** Routing defaults for every step in this workflow (step opts still win). */
  defaults?: { provider?: ProviderId; model?: string; effort?: Effort };
}

export interface WorkflowDefinition<In = any, Out = any> {
  readonly kind: "weft.workflow";
  readonly meta: {
    name?: string;
    description: string;
    input: AnySchema;
    output: AnySchema;
    defaults?: { provider?: ProviderId; model?: string; effort?: Effort };
  };
  readonly run: (ctx: Ctx, input: In) => Promise<Out>;
}

export type InferWorkflowInput<D> = D extends WorkflowDefinition<infer In, unknown> ? In : never;
export type InferWorkflowOutput<D> = D extends WorkflowDefinition<unknown, infer Out> ? Out : never;

/**
 * Define a workflow: Zod (or any Standard Schema) input/output, and a plain async
 * run function. The engine validates input before the run and output after it.
 */
export function defineWorkflow<InS extends AnySchema, OutS extends AnySchema>(
  meta: WorkflowMeta<InS, OutS>,
  run: (ctx: Ctx, input: InferOut<InS>) => Promise<InferIn<OutS>>,
): WorkflowDefinition<InferOut<InS>, InferOut<OutS>> {
  if (!meta || typeof meta.description !== "string") {
    throw new TypeError("defineWorkflow: meta.description is required");
  }
  if (!meta.input || !meta.output) {
    throw new TypeError("defineWorkflow: meta.input and meta.output schemas are required");
  }
  if (typeof run !== "function") {
    throw new TypeError("defineWorkflow: run must be an async function (ctx, input) => output");
  }
  return Object.freeze({
    kind: "weft.workflow" as const,
    meta: Object.freeze({ ...meta }),
    run: run as (ctx: Ctx, input: InferOut<InS>) => Promise<InferOut<OutS>>,
  });
}

export function isWorkflowDefinition(value: unknown): value is WorkflowDefinition {
  if (typeof value !== "object" || value === null) return false;
  const v = value as { kind?: unknown; run?: unknown; meta?: unknown };
  if (v.kind !== "weft.workflow" || typeof v.run !== "function") return false;
  const meta = v.meta as { description?: unknown; input?: unknown; output?: unknown } | undefined;
  return (
    typeof meta === "object" &&
    meta !== null &&
    typeof meta.description === "string" &&
    meta.input !== undefined &&
    meta.output !== undefined
  );
}
