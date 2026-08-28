/** Declaration-only tasks surface for the Weft DSL prototype. */
import type { AnySchema, WorkflowNode } from "./shared.ts";

// ---------------------------------------------------------------------------
// Durable tasks
// ---------------------------------------------------------------------------

/**
 * Why: Gives the tasks DSL an explicit workflow task status contract instead of relying on untyped values.
 * Use: Import it when declaring, configuring, or consuming the corresponding tasks API.
 */
export type WorkflowTaskStatus = "todo" | "in_progress" | "blocked" | "done" | "cancelled";
/**
 * Why: Gives the tasks DSL an explicit workflow task priority contract instead of relying on untyped values.
 * Use: Import it when declaring, configuring, or consuming the corresponding tasks API.
 */
export type WorkflowTaskPriority = "low" | "medium" | "high" | "critical";

/**
 * Why: Gives the tasks DSL an explicit workflow task criterion contract instead of relying on untyped values.
 * Use: Import it when declaring, configuring, or consuming the corresponding tasks API.
 */
export interface WorkflowTaskCriterion {
  id: string;
  text: string;
  met: boolean;
}

/**
 * Why: Gives the tasks DSL an explicit workflow task note contract instead of relying on untyped values.
 * Use: Import it when declaring, configuring, or consuming the corresponding tasks API.
 */
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
  extensionSchemaVersion: number;
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

/**
 * Why: Gives the tasks DSL an explicit workflow task selector contract instead of relying on untyped values.
 * Use: Import it when declaring, configuring, or consuming the corresponding tasks API.
 */
export interface WorkflowTaskSelector {
  ids?: string[];
  dedupeKeys?: string[];
  statuses?: WorkflowTaskStatus[];
  tags?: string[];
  relatedFiles?: string[];
  limit?: number;
}

/**
 * Why: Gives the tasks DSL an explicit agent task access contract instead of relying on untyped values.
 * Use: Import it when declaring, configuring, or consuming the corresponding tasks API.
 */
export interface AgentTaskAccess extends WorkflowTaskSelector {
  mode: "read" | "write";
}

/**
 * Why: Gives the tasks DSL an explicit workflow task snapshot contract instead of relying on untyped values.
 * Use: Import it when declaring, configuring, or consuming the corresponding tasks API.
 */
export interface WorkflowTaskSnapshot<Extensions = unknown> {
  total: number;
  truncated: boolean;
  tasks: WorkflowTaskSummary<Extensions>[];
}

/**
 * Why: Gives the tasks DSL an explicit workflow task create input contract instead of relying on untyped values.
 * Use: Import it when declaring, configuring, or consuming the corresponding tasks API.
 */
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

/**
 * Why: Gives the tasks DSL an explicit workflow task update input contract instead of relying on untyped values.
 * Use: Import it when declaring, configuring, or consuming the corresponding tasks API.
 */
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

/**
 * Why: Gives the tasks DSL an explicit workflow task step options contract instead of relying on untyped values.
 * Use: Import it when declaring, configuring, or consuming the corresponding tasks API.
 */
export interface WorkflowTaskStepOptions {
  key: string;
}

/**
 * Why: Gives the tasks DSL an explicit workflow task mutation options contract instead of relying on untyped values.
 * Use: Import it when declaring, configuring, or consuming the corresponding tasks API.
 */
export interface WorkflowTaskMutationOptions extends WorkflowTaskStepOptions {
  ifRevision?: number;
}

/**
 * Why: Gives the tasks DSL an explicit workflow task upsert input contract instead of relying on untyped values.
 * Use: Import it when declaring, configuring, or consuming the corresponding tasks API.
 */
export interface WorkflowTaskUpsertInput<Extensions = unknown> extends WorkflowTaskStepOptions {
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
  upsert(input: WorkflowTaskUpsertInput<ExtensionInput>): Promise<void>;
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
 * Why: Pins workflow-specific task extensions to a schema and semantic revision.
 * Use: Create one with `defineTaskContract` and attach it to workflow metadata.
 */
export interface TaskContract<S extends AnySchema> extends WorkflowNode<"weft.task-contract"> {
  readonly kind: "weft.task-contract";
  readonly schema: S;
  readonly revision: string;
  readonly version: number;
  readonly agentAccess?: false | "read" | "write";
  readonly migrate?: (extensions: unknown, fromVersion: number) => unknown | Promise<unknown>;
}

/**
 * Why: Declares typed durable task extensions and their evolution policy.
 * Use: Use it at module scope, then pass the returned contract as `defineWorkflow` metadata `tasks`.
 */
export interface TaskContractConfig<S extends AnySchema> {
  schema: S;
  revision: string;
  version?: number;
  agentAccess?: false | "read" | "write";
  migrate?: (extensions: unknown, fromVersion: number) => unknown | Promise<unknown>;
}

/**
 * Why: Declares typed durable task extensions and their evolution policy.
 * Use: Use it at module scope, then pass the returned contract as `defineWorkflow` metadata `tasks`.
 */
export declare function defineTaskContract<S extends AnySchema>(
  config: TaskContractConfig<S>,
): TaskContract<S>;
