import type { AnySchema, InferIn, InferOut } from "./schema.ts";
import type { Ctx, Effort, ProviderId } from "./types.ts";

interface WorkflowTaskSchemaEvolution {
  /** Increment when persisted extension values need an explicit migration. Defaults to 1. */
  schemaVersion?: number;
}

export type WorkflowTaskSchemaConfig =
  | (WorkflowTaskSchemaEvolution & {
      extensions?: undefined;
      semanticRevision?: undefined;
      migrate?: undefined;
    })
  | (WorkflowTaskSchemaEvolution & {
      extensions?: undefined;
      semanticRevision: string;
      /** Convert a stored older value when retiring a previously declared extension schema. */
      migrate: (extensions: unknown, fromVersion: number) => unknown | Promise<unknown>;
    })
  | (WorkflowTaskSchemaEvolution & {
      extensions: AnySchema;
      /**
       * Stable executable-contract identity. Keep it across display-name changes; change it
       * whenever validation, defaults, refinements, transforms, or migration behavior changes.
       */
      semanticRevision: string;
      /** Convert a stored older value to the current version before validation. */
      migrate?: (extensions: unknown, fromVersion: number) => unknown | Promise<unknown>;
    });

/**
 * Workflow metadata. `name` derives from the filename in module mode; override with
 * `name:` for inline scripts or explicit registration.
 */
export interface WorkflowMeta<InS extends AnySchema, OutS extends AnySchema> {
  /**
   * Stable identity for durable workflow-owned state. Unlike `name`, this must not
   * change when a workflow file is renamed. It defaults to the resolved registry
   * name for backwards compatibility; workflows using durable tasks should set it.
   */
  id?: string;
  name?: string;
  description: string;
  input: InS;
  output: OutS;
  /** Routing defaults for every step in this workflow (step opts still win). */
  defaults?: { provider?: ProviderId; model?: string; effort?: Effort };
  /**
   * Workflow-specific fields stored under `task.extensions`. The task tracker owns
   * lifecycle fields (status, dependencies, acceptance criteria, timestamps); this
   * schema lets a workflow add typed context without weakening those invariants.
   */
  tasks?: WorkflowTaskSchemaConfig;
}

export interface WorkflowDefinition<In = any, Out = any> {
  readonly kind: "weft.workflow";
  readonly meta: {
    id?: string;
    name?: string;
    description: string;
    input: AnySchema;
    output: AnySchema;
    defaults?: { provider?: ProviderId; model?: string; effort?: Effort };
    tasks?: WorkflowTaskSchemaConfig;
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
  if (meta.id !== undefined) assertWorkflowId(meta.id, "meta.id");
  if (meta.name !== undefined) assertWorkflowId(meta.name, "meta.name");
  if (
    meta.tasks?.schemaVersion !== undefined &&
    (!Number.isInteger(meta.tasks.schemaVersion) || meta.tasks.schemaVersion < 1)
  ) {
    throw new TypeError("defineWorkflow: tasks.schemaVersion must be a positive integer");
  }
  if (meta.tasks?.migrate !== undefined && typeof meta.tasks.migrate !== "function") {
    throw new TypeError("defineWorkflow: tasks.migrate must be a function");
  }
  if (
    (meta.tasks?.extensions !== undefined || meta.tasks?.migrate !== undefined) &&
    (typeof meta.tasks.semanticRevision !== "string" || meta.tasks.semanticRevision.trim() === "")
  ) {
    throw new TypeError("defineWorkflow: tasks.semanticRevision is required for extensions and migrations");
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

/** One canonical grammar shared by the SDK, registry-facing CLI, daemon, and task store. */
export const WORKFLOW_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export function isWorkflowId(value: string): boolean {
  return WORKFLOW_ID_PATTERN.test(value) && value !== "." && value !== ".." && !value.endsWith(".ts");
}

export function assertWorkflowId(value: string, label = "workflow id"): void {
  if (!isWorkflowId(value)) {
    throw new TypeError(
      `${label} must be 1-128 letters, numbers, dots, underscores, or hyphens; ` +
        "it cannot be a path or end in .ts",
    );
  }
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
