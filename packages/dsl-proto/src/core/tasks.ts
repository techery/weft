/** Declaration-only tasks surface for the Weft DSL prototype. */
import type { AnySchema, WorkflowNode } from "./shared.ts";

// ---------------------------------------------------------------------------
// Durable tasks
// ---------------------------------------------------------------------------

/** Workflow task status. */
export type WorkflowTaskStatus = "todo" | "in_progress" | "blocked" | "done" | "cancelled";
/** Workflow task priority. */
export type WorkflowTaskPriority = "low" | "medium" | "high" | "critical";

/** Workflow task criterion. */
export interface WorkflowTaskCriterion {
  id: string;
  text: string;
  met: boolean;
}

/** Workflow task note. */
export interface WorkflowTaskNote {
  text: string;
  at: number;
  actor: string;
}

/**
 * Why: Provides a bounded task projection suitable for durable workflow and agent decisions.
 * Use: Read summaries from `ctx.tasks.observe` rather than reading mutable task storage directly.
 */
export interface WorkflowTaskSummary<Extensions = unknown> {
  id: string;
  revision: number;
  dedupeKey?: string;
  title: string;
  description: string;
  status: WorkflowTaskStatus;
  priority: WorkflowTaskPriority;
  tags: string[];
  dependencies: string[];
  relatedFiles: string[];
  acceptanceCriteria: WorkflowTaskCriterion[];
  latestNote: WorkflowTaskNote | null;
  extensions?: Exclude<Extensions, undefined>;
  updatedAt: number;
}

/** Workflow task selector. */
export interface WorkflowTaskSelector {
  ids?: string[];
  dedupeKeys?: string[];
  statuses?: WorkflowTaskStatus[];
  tags?: string[];
  relatedFiles?: string[];
  limit?: number;
}

/** Agent task access. */
export interface AgentTaskAccess extends WorkflowTaskSelector {
  mode: "read" | "write";
}

/** Workflow task snapshot. */
export interface WorkflowTaskSnapshot<Extensions = unknown> {
  total: number;
  truncated: boolean;
  tasks: WorkflowTaskSummary<Extensions>[];
}

/** Workflow task create input. */
export interface WorkflowTaskCreateInput<Extensions = unknown> {
  title: string;
  description: string;
  status?: WorkflowTaskStatus;
  priority?: WorkflowTaskPriority;
  tags?: string[];
  dependencies?: string[];
  relatedFiles?: string[];
  acceptanceCriteria?: string[];
  extensions?: Extensions;
}

/** Workflow task update input. */
export interface WorkflowTaskUpdateInput<Extensions = unknown> {
  title?: string;
  description?: string;
  status?: WorkflowTaskStatus;
  priority?: WorkflowTaskPriority;
  tags?: string[];
  dependencies?: string[];
  relatedFiles?: string[];
  acceptanceCriteria?: string[];
  resetAcceptance?: boolean;
  extensions?: Extensions;
  ifRevision?: number;
}

/** Workflow task step options. */
export interface WorkflowTaskStepOptions {
  key: string;
}

/** Workflow task mutation options. */
export interface WorkflowTaskMutationOptions extends WorkflowTaskStepOptions {
  ifRevision?: number;
}

/** Workflow task upsert input. */
export interface WorkflowTaskUpsertInput<Extensions = unknown> {
  dedupeKey: string;
  set: WorkflowTaskCreateInput<Extensions>;
  note?: string;
}

/**
 * Why: Defines replay-stable task observation and optimistic task mutation operations.
 * Use: Use it through `ctx.tasks` to converge work across runs without silently overwriting newer revisions.
 */
export interface WorkflowTasksApi<ExtensionInput = unknown, Extensions = ExtensionInput> {
  observe(
    selector: WorkflowTaskSelector,
    opts: WorkflowTaskStepOptions,
  ): Promise<WorkflowTaskSnapshot<Extensions>>;
  upsert(
    input: WorkflowTaskUpsertInput<ExtensionInput>,
    opts: WorkflowTaskStepOptions,
  ): Promise<void>;
  update(
    id: string,
    input: WorkflowTaskUpdateInput<ExtensionInput>,
    opts: WorkflowTaskStepOptions,
  ): Promise<void>;
  note(id: string, text: string, opts: WorkflowTaskMutationOptions): Promise<void>;
  setCriterion(
    id: string,
    criterionId: string,
    met: boolean,
    opts: WorkflowTaskMutationOptions,
  ): Promise<void>;
}

/**
 * Why: Pins short-lived workflow task extensions to one validation schema.
 * Use: Create one with `defineTaskContract` and attach it to workflow metadata.
 */
export interface TaskContract<S extends AnySchema> extends WorkflowNode<"weft.task-contract"> {
  readonly kind: "weft.task-contract";
  readonly schema: S;
  readonly agentAccess?: false | "read" | "write";
}

/**
 * Why: Declares typed extensions and optional agent access for short-lived workflow tasks.
 * Use: Use it at module scope, then pass the returned contract as `defineWorkflow` metadata `tasks`.
 */
export interface TaskContractConfig<S extends AnySchema> {
  schema: S;
  agentAccess?: false | "read" | "write";
}

/**
 * Why: Declares typed extensions and optional agent access for short-lived workflow tasks.
 * Use: Use it at module scope, then pass the returned contract as `defineWorkflow` metadata `tasks`.
 */
export declare function defineTaskContract<S extends AnySchema>(
  config: TaskContractConfig<S>,
): TaskContract<S>;
