import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";
import {
  link,
  mkdir,
  mkdtemp,
  open,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  unlink,
  utimes,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { type AgentTaskContext, type AgentTaskOperation, jsonUnsafeAt } from "@techery/weft-core";
import type { AnySchema, WorkflowTaskSelector } from "@techery/weft-sdk";
import { assertWorkflowId, validateSchema } from "@techery/weft-sdk";

export const TASK_SCHEMA_VERSION = 1;
export const TASK_NAMESPACE_SCHEMA_VERSION = 1;

export const TASK_STATUSES = ["todo", "in_progress", "blocked", "done", "cancelled"] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];
export const TASK_PRIORITIES = ["low", "medium", "high", "critical"] as const;
export type TaskPriority = (typeof TASK_PRIORITIES)[number];

/** Raw schema input retained across hydrated task mutations; JSON ignores symbols. */
const STORED_EXTENSIONS = Symbol("weft.task.storedExtensions");
type HydratedWorkflowTask = WorkflowTask & { [STORED_EXTENSIONS]?: unknown };

export interface TaskCriterion {
  id: string;
  text: string;
  met: boolean;
}

export interface TaskNote {
  text: string;
  at: number;
  actor: string;
}

/** Durable, workflow-scoped context shared by every step and run of that workflow. */
export interface WorkflowTask {
  schemaVersion: typeof TASK_SCHEMA_VERSION;
  extensionSchemaVersion: number;
  id: string;
  workflowId: string;
  /** Workflow-scoped idempotent identity for recurring logical work. */
  dedupeKey?: string;
  title: string;
  description: string;
  status: TaskStatus;
  priority: TaskPriority;
  tags: string[];
  dependencies: string[];
  relatedFiles: string[];
  acceptanceCriteria: TaskCriterion[];
  notes: TaskNote[];
  extensions: unknown;
  createdAt: number;
  updatedAt: number;
  createdBy: string;
  updatedBy: string;
  revision: number;
  /** Idempotency keys already incorporated into this task. */
  appliedOperations: string[];
}

/** Durable binding used by the CLI when a path/stdin workflow is not in the registry. */
export interface TaskWorkflowNamespace {
  schemaVersion: typeof TASK_NAMESPACE_SCHEMA_VERSION;
  id: string;
  name: string;
  extensionSchemaDeclared: boolean;
  extensionSchema: unknown | null;
  extensionSchemaVersion: number;
}

export interface CreateTaskInput {
  /** Internal deterministic id used by journal-replayed agent batches. */
  id?: string;
  dedupeKey?: string;
  title: string;
  description: string;
  status?: TaskStatus;
  priority?: TaskPriority;
  tags?: string[];
  dependencies?: string[];
  relatedFiles?: string[];
  acceptanceCriteria?: string[];
  extensions?: unknown;
  actor?: string;
  operationKey?: string;
  initialNote?: string;
}

export interface UpdateTaskInput {
  title?: string;
  description?: string;
  status?: TaskStatus;
  priority?: TaskPriority;
  tags?: string[];
  dependencies?: string[];
  relatedFiles?: string[];
  acceptanceCriteria?: Array<{ id?: string; text: string; met?: boolean }>;
  resetAcceptance?: boolean;
  extensions?: unknown;
  actor?: string;
  ifRevision?: number;
  operationKey?: string;
}

export interface UpsertTaskInput {
  create: Omit<CreateTaskInput, "dedupeKey" | "actor" | "operationKey" | "initialNote">;
  update?: UpdateTaskInput;
  note?: string;
  actor?: string;
}

/** One JSON file per task keeps unrelated parallel agent updates independent. */
export class TaskStore {
  private readonly runtimeSchemas = new Map<string, AnySchema | undefined>();
  private readonly runtimeJsonSchemas = new Map<string, unknown | null>();
  private readonly runtimeMigrations = new Map<
    string,
    {
      version: number;
      migrate?: (extensions: unknown, fromVersion: number) => unknown | Promise<unknown>;
    }
  >();
  private readonly latestBindings = new Map<string, string>();
  private readonly schemaScope = new AsyncLocalStorage<{
    workflowId: string;
    binding: string;
    schema: AnySchema | undefined;
    version: number;
    migrate?: (extensions: unknown, fromVersion: number) => unknown | Promise<unknown>;
  }>();

  constructor(
    private readonly root: string,
    private readonly schemaFor?: (workflowId: string) => Promise<AnySchema | undefined>,
  ) {}

  async registerWorkflow(
    workflow: { id: string; name: string },
    extensionSchema: AnySchema | undefined,
    extensionJsonSchema: unknown | null,
    options: {
      schemaVersion?: number;
      migrate?: (extensions: unknown, fromVersion: number) => unknown | Promise<unknown>;
      identity?: string;
      persist?: boolean;
    } = {},
  ): Promise<string> {
    assertWorkflowId(workflow.id);
    assertWorkflowId(workflow.name);
    const version = options.schemaVersion ?? 1;
    if (!Number.isInteger(version) || version < 1) {
      throw new Error("task extension schema version must be a positive integer");
    }
    const schemaBinding = digest(
      JSON.stringify({
        declared: extensionSchema !== undefined,
        schema: extensionJsonSchema,
        version,
        migrate: options.migrate ? String(options.migrate) : null,
        identity: options.identity ?? null,
      }),
    );
    const bindingKey = `${workflow.id}:${schemaBinding}`;
    this.runtimeSchemas.set(bindingKey, extensionSchema);
    this.runtimeJsonSchemas.set(bindingKey, extensionJsonSchema);
    this.runtimeMigrations.set(bindingKey, {
      version,
      ...(options.migrate ? { migrate: options.migrate } : {}),
    });
    if (options.persist === false) return schemaBinding;
    this.latestBindings.set(workflow.id, schemaBinding);
    const namespace: TaskWorkflowNamespace = {
      schemaVersion: TASK_NAMESPACE_SCHEMA_VERSION,
      id: workflow.id,
      name: workflow.name,
      extensionSchemaDeclared: extensionSchema !== undefined,
      extensionSchema: extensionJsonSchema,
      extensionSchemaVersion: version,
    };
    await this.mutate(workflow.id, async () => {
      const file = this.namespaceFile(workflow.id);
      const current = await readFile(file, "utf8").catch((err: unknown) => {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
        throw err;
      });
      const encoded = `${JSON.stringify(namespace)}\n`;
      if (current !== encoded) await this.writeAux(file, namespace);
    });
    return schemaBinding;
  }

  async schema(workflowId: string, schemaBinding?: string): Promise<unknown | null> {
    if (schemaBinding !== undefined) {
      const key = `${workflowId}:${schemaBinding}`;
      if (!this.runtimeJsonSchemas.has(key)) {
        throw new Error(`task extension schema binding ${schemaBinding} is not registered for ${workflowId}`);
      }
      return this.runtimeJsonSchemas.get(key) ?? null;
    }
    return (await this.namespace(workflowId))?.extensionSchema ?? null;
  }

  async namespace(workflowId: string): Promise<TaskWorkflowNamespace | undefined> {
    const file = this.namespaceFile(workflowId);
    let value: unknown;
    try {
      value = JSON.parse(await readFile(file, "utf8")) as unknown;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw new Error(`invalid task namespace ${file}: ${(err as Error).message}`, { cause: err });
    }
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new Error(`invalid task namespace ${file}: expected object`);
    }
    const namespace = value as Record<string, unknown>;
    if (
      namespace.schemaVersion !== TASK_NAMESPACE_SCHEMA_VERSION ||
      namespace.id !== workflowId ||
      typeof namespace.name !== "string" ||
      typeof namespace.extensionSchemaDeclared !== "boolean" ||
      !("extensionSchema" in namespace)
    ) {
      throw new Error(`invalid task namespace ${file}: identity or schema version mismatch`);
    }
    assertWorkflowId(namespace.name);
    if (namespace.extensionSchemaVersion === undefined) namespace.extensionSchemaVersion = 1;
    if (!Number.isInteger(namespace.extensionSchemaVersion) || Number(namespace.extensionSchemaVersion) < 1) {
      throw new Error(`invalid task namespace ${file}: extension schema version must be positive`);
    }
    return namespace as unknown as TaskWorkflowNamespace;
  }

  async list(workflowId: string, extensionSchema?: AnySchema): Promise<WorkflowTask[]> {
    const dir = this.workflowDir(workflowId);
    const schema = await this.extensionSchema(workflowId, extensionSchema);
    let files: string[];
    try {
      files = await readdir(dir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }
    const tasks = await Promise.all(
      files
        .filter((file) => /^task-[a-f0-9]{8}\.json$/.test(file))
        .map((file) => {
          const id = file.slice(0, -5);
          return this.readTask(join(dir, file), workflowId, id, schema);
        }),
    );
    validateTopology(tasks, workflowId);
    return tasks.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
  }

  async get(workflowId: string, id: string, extensionSchema?: AnySchema): Promise<WorkflowTask> {
    assertId(id);
    const schema = await this.extensionSchema(workflowId, extensionSchema);
    try {
      return await this.readTask(this.taskFile(workflowId, id), workflowId, id, schema);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        throw new Error(`task ${id} not found in workflow ${workflowId}`);
      }
      throw err;
    }
  }

  async create(
    workflowId: string,
    input: CreateTaskInput,
    extensionSchema?: AnySchema,
  ): Promise<WorkflowTask> {
    const schema = await this.extensionSchema(workflowId, extensionSchema);
    return this.mutate(workflowId, () => this.createUnlocked(workflowId, input, schema));
  }

  private async createUnlocked(
    workflowId: string,
    input: CreateTaskInput,
    extensionSchema?: AnySchema,
  ): Promise<WorkflowTask> {
    assertWorkflowId(workflowId);
    const actor = cleanRequired(input.actor ?? "cli", "actor");
    const now = Date.now();
    const dedupeKey = input.dedupeKey !== undefined ? cleanDedupeKey(input.dedupeKey) : undefined;
    const id =
      input.id ??
      (dedupeKey
        ? `task-${digest(`dedupe:${workflowId}:${dedupeKey}`).slice(0, 8)}`
        : `task-${randomUUID().slice(0, 8)}`);
    assertId(id);
    const currentTasks = await this.list(workflowId, extensionSchema);
    const duplicate = dedupeKey
      ? currentTasks.find((candidate) => candidate.dedupeKey === dedupeKey)
      : undefined;
    if (duplicate) {
      throw new Error(`dedupe key ${JSON.stringify(dedupeKey)} is already used by ${duplicate.id}`);
    }
    if (currentTasks.some((candidate) => candidate.id === id)) {
      throw new Error(`task id ${id} already exists in workflow ${workflowId}`);
    }
    const extensionInput = input.extensions === undefined ? {} : input.extensions;
    const task = withStoredExtensions<WorkflowTask>(
      {
        schemaVersion: TASK_SCHEMA_VERSION,
        extensionSchemaVersion: this.extensionConfig(workflowId).version,
        id,
        workflowId,
        ...(dedupeKey ? { dedupeKey } : {}),
        title: cleanRequired(input.title, "title"),
        description: cleanRequired(input.description, "description"),
        status: statusOf(input.status ?? "todo"),
        priority: priorityOf(input.priority ?? "medium"),
        tags: strings(input.tags),
        dependencies: strings(input.dependencies),
        relatedFiles: strings(input.relatedFiles),
        acceptanceCriteria: strings(input.acceptanceCriteria).map((text) => ({
          id: criterionId(text),
          text,
          met: false,
        })),
        notes: input.initialNote ? [{ text: cleanRequired(input.initialNote, "note"), at: now, actor }] : [],
        extensions: await extensionsOf(extensionInput, extensionSchema),
        createdAt: now,
        updatedAt: now,
        createdBy: actor,
        updatedBy: actor,
        revision: 1,
        appliedOperations: input.operationKey ? [input.operationKey] : [],
      },
      extensionInput,
    );
    await this.assertDependencies(workflowId, task, extensionSchema);
    await this.write(task, true);
    return task;
  }

  async update(
    workflowId: string,
    id: string,
    input: UpdateTaskInput,
    extensionSchema?: AnySchema,
  ): Promise<WorkflowTask> {
    const schema = await this.extensionSchema(workflowId, extensionSchema);
    return this.mutate(workflowId, () => this.updateUnlocked(workflowId, id, input, schema));
  }

  private async updateUnlocked(
    workflowId: string,
    id: string,
    input: UpdateTaskInput,
    extensionSchema?: AnySchema,
  ): Promise<WorkflowTask> {
    const current = await this.get(workflowId, id, extensionSchema);
    if (input.operationKey && current.appliedOperations.includes(input.operationKey)) return current;
    if (input.ifRevision !== undefined && input.ifRevision !== current.revision) {
      throw new Error(
        `task ${id} changed (expected revision ${input.ifRevision}, found ${current.revision}) — read it again`,
      );
    }
    const next = await this.updatedTask(current, input, extensionSchema);
    await this.assertDependencies(workflowId, next, extensionSchema);
    await this.write(next);
    return next;
  }

  private async updatedTask(
    current: WorkflowTask,
    input: UpdateTaskInput,
    extensionSchema?: AnySchema,
    note?: string,
  ): Promise<WorkflowTask> {
    const actor = cleanRequired(input.actor ?? "cli", "actor");
    const now = Date.now();
    const extensionInput = input.extensions !== undefined ? input.extensions : storedExtensionsOf(current);
    return withStoredExtensions(
      {
        ...current,
        extensionSchemaVersion: this.extensionConfig(current.workflowId).version,
        ...(input.title !== undefined ? { title: cleanRequired(input.title, "title") } : {}),
        ...(input.description !== undefined
          ? { description: cleanRequired(input.description, "description") }
          : {}),
        ...(input.status !== undefined ? { status: statusOf(input.status) } : {}),
        ...(input.priority !== undefined ? { priority: priorityOf(input.priority) } : {}),
        ...(input.tags !== undefined ? { tags: strings(input.tags) } : {}),
        ...(input.dependencies !== undefined ? { dependencies: strings(input.dependencies) } : {}),
        ...(input.relatedFiles !== undefined ? { relatedFiles: strings(input.relatedFiles) } : {}),
        ...(input.acceptanceCriteria !== undefined
          ? {
              acceptanceCriteria: criteria(
                input.acceptanceCriteria,
                input.resetAcceptance ? [] : current.acceptanceCriteria,
              ),
            }
          : {}),
        ...(input.extensions !== undefined
          ? { extensions: await extensionsOf(extensionInput, extensionSchema) }
          : {}),
        ...(note !== undefined
          ? { notes: [...current.notes, { text: cleanRequired(note, "note"), at: now, actor }] }
          : {}),
        updatedAt: now,
        updatedBy: actor,
        revision: current.revision + 1,
        appliedOperations: input.operationKey
          ? [...current.appliedOperations, input.operationKey]
          : current.appliedOperations,
      },
      extensionInput,
    );
  }

  private async upsertUnlocked(
    workflowId: string,
    dedupeKey: string,
    input: {
      create: Omit<CreateTaskInput, "dedupeKey" | "actor" | "operationKey" | "initialNote">;
      update?: UpdateTaskInput;
      note?: string;
      actor: string;
      operationKey: string;
    },
    extensionSchema?: AnySchema,
  ): Promise<WorkflowTask> {
    const cleanKey = cleanDedupeKey(dedupeKey);
    const existing = (await this.list(workflowId, extensionSchema)).find(
      (task) => task.dedupeKey === cleanKey,
    );
    if (!existing) {
      return this.createUnlocked(
        workflowId,
        {
          ...input.create,
          dedupeKey: cleanKey,
          actor: input.actor,
          operationKey: input.operationKey,
          ...(input.note !== undefined ? { initialNote: input.note } : {}),
        },
        extensionSchema,
      );
    }
    if (existing.appliedOperations.includes(input.operationKey)) return existing;
    if (input.update?.ifRevision !== undefined && input.update.ifRevision !== existing.revision) {
      throw new Error(
        `task ${existing.id} changed (expected revision ${input.update.ifRevision}, found ${existing.revision}) — read it again`,
      );
    }
    const next = await this.updatedTask(
      existing,
      { ...(input.update ?? {}), actor: input.actor, operationKey: input.operationKey },
      extensionSchema,
      input.note,
    );
    await this.assertDependencies(workflowId, next, extensionSchema);
    await this.write(next);
    return next;
  }

  /** Create or update one recurring logical task using its workflow-scoped identity. */
  async upsert(
    workflowId: string,
    dedupeKey: string,
    input: UpsertTaskInput,
    extensionSchema?: AnySchema,
  ): Promise<WorkflowTask> {
    const schema = await this.extensionSchema(workflowId, extensionSchema);
    return this.mutate(workflowId, async () => {
      const operationKey = `direct:${randomUUID()}`;
      const task = await this.upsertUnlocked(
        workflowId,
        dedupeKey,
        {
          create: input.create,
          ...(input.update ? { update: input.update } : {}),
          ...(input.note !== undefined ? { note: input.note } : {}),
          actor: input.actor ?? "cli",
          operationKey,
        },
        schema,
      );
      const cleaned = {
        ...task,
        appliedOperations: task.appliedOperations.filter((key) => key !== operationKey),
      };
      if (cleaned.appliedOperations.length !== task.appliedOperations.length) await this.write(cleaned);
      return cleaned;
    });
  }

  async addNote(
    workflowId: string,
    id: string,
    text: string,
    actor = "cli",
    opts: { ifRevision?: number; operationKey?: string } = {},
  ): Promise<WorkflowTask> {
    const extensionSchema = await this.extensionSchema(workflowId);
    return this.mutate(workflowId, async () => {
      const current = await this.get(workflowId, id, extensionSchema);
      if (opts.operationKey && current.appliedOperations.includes(opts.operationKey)) return current;
      if (opts.ifRevision !== undefined && current.revision !== opts.ifRevision) {
        throw new Error(
          `task ${id} changed (expected revision ${opts.ifRevision}, found ${current.revision}) — read it again`,
        );
      }
      const at = Date.now();
      const cleanActor = cleanRequired(actor, "actor");
      const next: WorkflowTask = {
        ...current,
        notes: [...current.notes, { text: cleanRequired(text, "note"), at, actor: cleanActor }],
        updatedAt: at,
        updatedBy: cleanActor,
        revision: current.revision + 1,
        appliedOperations: opts.operationKey
          ? [...current.appliedOperations, opts.operationKey]
          : current.appliedOperations,
      };
      await this.write(next);
      return next;
    });
  }

  async setCriterion(
    workflowId: string,
    id: string,
    criterionRef: string | number,
    met: boolean,
    actor = "cli",
    ifRevision?: number,
  ): Promise<WorkflowTask> {
    const extensionSchema = await this.extensionSchema(workflowId);
    return this.mutate(workflowId, async () => {
      const current = await this.get(workflowId, id, extensionSchema);
      if (ifRevision !== undefined && current.revision !== ifRevision) {
        throw new Error(
          `task ${id} changed (expected revision ${ifRevision}, found ${current.revision}) — read it again`,
        );
      }
      const criterionId =
        typeof criterionRef === "number" ? current.acceptanceCriteria[criterionRef - 1]?.id : criterionRef;
      if (!criterionId || !current.acceptanceCriteria.some((criterion) => criterion.id === criterionId)) {
        throw new Error(`criterion ${String(criterionRef)} not found on task ${id}`);
      }
      const acceptanceCriteria = current.acceptanceCriteria.map((criterion) =>
        criterion.id === criterionId ? { ...criterion, met } : criterion,
      );
      return this.updateUnlocked(workflowId, id, { acceptanceCriteria, actor }, extensionSchema);
    });
  }

  /** Bounded context injected into an agent prompt; full history remains available through the CLI/UI. */
  async snapshot(
    workflowId: string,
    selector: WorkflowTaskSelector = {},
    schemaBinding?: string,
  ): Promise<unknown> {
    const scoped = this.schemaScope.getStore();
    if (
      schemaBinding !== undefined &&
      (scoped?.binding !== schemaBinding || scoped.workflowId !== workflowId)
    ) {
      return this.withSchemaBinding(workflowId, schemaBinding, () =>
        this.snapshot(workflowId, selector, schemaBinding),
      );
    }
    const tasks = await this.list(workflowId);
    const filtered = tasks.filter((task) => {
      if (selector.ids && !selector.ids.includes(task.id)) return false;
      if (selector.dedupeKeys && (!task.dedupeKey || !selector.dedupeKeys.includes(task.dedupeKey))) {
        return false;
      }
      if (selector.statuses && !selector.statuses.includes(task.status)) return false;
      if (selector.tags && !selector.tags.some((tag) => task.tags.includes(tag))) return false;
      if (selector.relatedFiles && !selector.relatedFiles.some((file) => task.relatedFiles.includes(file))) {
        return false;
      }
      return true;
    });
    const candidates = filtered;
    const limit = Math.min(100, Math.max(1, selector.limit ?? 50));
    const selected = candidates.sort((a, b) => b.updatedAt - a.updatedAt).slice(0, limit);
    return {
      total: tasks.length,
      truncated: selected.length < candidates.length,
      tasks: selected.map((task) => ({
        id: task.id,
        revision: task.revision,
        extensionSchemaVersion: task.extensionSchemaVersion,
        ...(task.dedupeKey ? { dedupeKey: task.dedupeKey } : {}),
        title: task.title,
        description: task.description,
        status: task.status,
        priority: task.priority,
        tags: task.tags,
        dependencies: task.dependencies,
        relatedFiles: task.relatedFiles,
        acceptanceCriteria: task.acceptanceCriteria,
        latestNote: task.notes.at(-1) ?? null,
        extensions: task.extensions,
        updatedAt: task.updatedAt,
      })),
    };
  }

  /** Apply one journaled agent batch. Replays are harmless, including after a partial crash. */
  async validateBatch(context: AgentTaskContext, operations: AgentTaskOperation[]): Promise<void> {
    if (
      context.schemaBinding !== undefined &&
      (this.schemaScope.getStore()?.binding !== context.schemaBinding ||
        this.schemaScope.getStore()?.workflowId !== context.workflowId)
    ) {
      return this.withSchemaBinding(context.workflowId, context.schemaBinding, () =>
        this.validateBatch(context, operations),
      );
    }
    await this.mutate(context.workflowId, async () => {
      const extensionSchema = await this.extensionSchema(
        context.workflowId,
        undefined,
        context.schemaBinding,
      );
      await this.validateBatchUnlocked(context, operations, extensionSchema);
    });
  }

  async applyBatch(
    context: AgentTaskContext,
    batchId: string,
    operations: AgentTaskOperation[],
  ): Promise<void> {
    // A completed batch is a no-op even if its old runtime validator is no longer
    // registered after a process restart and workflow edit.
    if (await fileExists(this.batchFile(context.workflowId, batchId))) return;
    if (
      context.schemaBinding !== undefined &&
      !this.runtimeSchemas.has(`${context.workflowId}:${context.schemaBinding}`)
    ) {
      const recovered = await this.recoverOperations(context, operations);
      return this.applyBatch(recovered.context, batchId, recovered.operations);
    }
    if (
      context.schemaBinding !== undefined &&
      (this.schemaScope.getStore()?.binding !== context.schemaBinding ||
        this.schemaScope.getStore()?.workflowId !== context.workflowId)
    ) {
      return this.withSchemaBinding(context.workflowId, context.schemaBinding, () =>
        this.applyBatch(context, batchId, operations),
      );
    }
    await this.mutate(context.workflowId, async () => {
      const extensionSchema = await this.extensionSchema(
        context.workflowId,
        undefined,
        context.schemaBinding,
      );
      const marker = this.batchFile(context.workflowId, batchId);
      if (await fileExists(marker)) return;
      const pendingOperations = await this.unappliedOperations(
        context.workflowId,
        batchId,
        operations,
        extensionSchema,
      );
      await this.validateBatchUnlocked(context, pendingOperations, extensionSchema);
      const actor =
        context.source === "workflow"
          ? `workflow:${context.runId}:${context.step}`
          : `agent:${context.provider}:${context.runId}:${context.step}`;
      for (const [index, operation] of operations.entries()) {
        const operationKey = `${batchId}:${index}`;
        if (operation.op === "upsert") {
          const update = operation.update ? agentUpdateInput(operation.update) : undefined;
          await this.upsertUnlocked(
            context.workflowId,
            operation.dedupeKey,
            {
              create: operation.create,
              ...(update ? { update } : {}),
              ...(operation.note !== undefined ? { note: operation.note } : {}),
              actor,
              operationKey,
            },
            extensionSchema,
          );
          continue;
        }
        if (operation.op === "create") {
          const id = `task-${digest(operationKey).slice(0, 8)}`;
          const existing = await this.get(context.workflowId, id, extensionSchema).catch((err: unknown) => {
            if (isMissingTask(err, context.workflowId, id)) return undefined;
            throw err;
          });
          if (existing) {
            if (!existing.appliedOperations.includes(operationKey)) {
              throw new Error(`deterministic task id collision for ${id}`);
            }
            continue;
          }
          await this.createUnlocked(
            context.workflowId,
            { ...operation, id, actor, operationKey },
            extensionSchema,
          );
          continue;
        }
        if (operation.op === "update") {
          const { acceptanceCriteria, op: _op, ...fields } = operation;
          await this.updateUnlocked(
            context.workflowId,
            operation.id,
            {
              ...fields,
              ...(acceptanceCriteria
                ? {
                    acceptanceCriteria: acceptanceCriteria.map((text) => ({ text })),
                  }
                : {}),
              actor,
              operationKey,
            },
            extensionSchema,
          );
          continue;
        }
        if (operation.op === "note") {
          const current = await this.get(context.workflowId, operation.id, extensionSchema);
          if (current.appliedOperations.includes(operationKey)) continue;
          if (operation.ifRevision !== undefined && current.revision !== operation.ifRevision) {
            throw new Error(
              `task ${operation.id} changed (expected revision ${operation.ifRevision}, found ${current.revision}) — read it again`,
            );
          }
          const at = Date.now();
          await this.write({
            ...current,
            notes: [...current.notes, { text: cleanRequired(operation.text, "note"), at, actor }],
            updatedAt: at,
            updatedBy: actor,
            revision: current.revision + 1,
            appliedOperations: [...current.appliedOperations, operationKey],
          });
          continue;
        }
        const current = await this.get(context.workflowId, operation.id, extensionSchema);
        if (current.appliedOperations.includes(operationKey)) continue;
        if (operation.ifRevision !== undefined && current.revision !== operation.ifRevision) {
          throw new Error(
            `task ${operation.id} changed (expected revision ${operation.ifRevision}, found ${current.revision}) — read it again`,
          );
        }
        if (!current.acceptanceCriteria.some((criterion) => criterion.id === operation.criterionId)) {
          throw new Error(`criterion ${operation.criterionId} not found on task ${operation.id}`);
        }
        await this.updateUnlocked(context.workflowId, operation.id, {
          acceptanceCriteria: current.acceptanceCriteria.map((criterion) =>
            criterion.id === operation.criterionId ? { ...criterion, met: operation.met } : criterion,
          ),
          actor,
          operationKey,
        });
      }
      await this.writeAux(marker, { batchId, workflowId: context.workflowId, appliedAt: Date.now() });
    });
  }

  private async unappliedOperations(
    workflowId: string,
    batchId: string,
    operations: AgentTaskOperation[],
    extensionSchema?: AnySchema,
  ): Promise<AgentTaskOperation[]> {
    const tasks = await this.list(workflowId, extensionSchema);
    const byId = new Map(tasks.map((task) => [task.id, task]));
    const byDedupeKey = new Map(
      tasks.flatMap((task) => (task.dedupeKey ? [[task.dedupeKey, task] as const] : [])),
    );
    return operations.filter((operation, index) => {
      const operationKey = `${batchId}:${index}`;
      if (operation.op === "create") {
        const id = `task-${digest(operationKey).slice(0, 8)}`;
        return !byId.get(id)?.appliedOperations.includes(operationKey);
      }
      if (operation.op === "upsert") {
        return !byDedupeKey.get(operation.dedupeKey)?.appliedOperations.includes(operationKey);
      }
      return !byId.get(operation.id)?.appliedOperations.includes(operationKey);
    });
  }

  private async recoverOperations(
    context: AgentTaskContext,
    operations: AgentTaskOperation[],
  ): Promise<{ context: AgentTaskContext; operations: AgentTaskOperation[] }> {
    const binding = this.latestBindings.get(context.workflowId);
    if (!binding) {
      throw new Error(
        `cannot recover task batch: no current extension schema is registered for ${context.workflowId}`,
      );
    }
    const config = this.runtimeMigrations.get(`${context.workflowId}:${binding}`) ?? { version: 1 };
    const fromVersion = context.schemaVersion ?? 1;
    if (fromVersion === config.version) {
      throw new Error(
        `cannot recover task batch created with unavailable schema binding ${context.schemaBinding}; ` +
          "the batch marker was lost and no version migration can prove equivalence",
      );
    }
    if (fromVersion > config.version || !config.migrate) {
      throw new Error(
        `cannot recover task batch from extension schema version ${fromVersion} to ${config.version}: ` +
          "the current workflow must declare a forward migration",
      );
    }
    const migrate = config.migrate;
    const migrateCreate = async <T extends { extensions?: unknown }>(input: T): Promise<T> => ({
      ...input,
      extensions: await migrate(input.extensions === undefined ? {} : input.extensions, fromVersion),
    });
    const migrated: AgentTaskOperation[] = [];
    for (const operation of operations) {
      if (operation.op === "create") {
        migrated.push(await migrateCreate(operation));
      } else if (operation.op === "update") {
        migrated.push(
          "extensions" in operation
            ? { ...operation, extensions: await migrate(operation.extensions, fromVersion) }
            : operation,
        );
      } else if (operation.op === "upsert") {
        migrated.push({
          ...operation,
          create: await migrateCreate(operation.create),
          ...(operation.update && "extensions" in operation.update
            ? {
                update: {
                  ...operation.update,
                  extensions: await migrate(operation.update.extensions, fromVersion),
                },
              }
            : {}),
        });
      } else {
        migrated.push(operation);
      }
    }
    return {
      context: { ...context, schemaBinding: binding, schemaVersion: config.version },
      operations: migrated,
    };
  }

  private async validateBatchUnlocked(
    context: AgentTaskContext,
    operations: AgentTaskOperation[],
    extensionSchema?: AnySchema,
  ): Promise<void> {
    const current = await this.list(context.workflowId, extensionSchema);
    if (context.source === "agent") {
      if (context.mode === "read" && operations.length > 0) {
        throw new Error("read-only task authority requires an empty batch");
      }
      const visibleIds = new Set(context.visibleTaskIds ?? []);
      const visibleDedupeKeys = new Set(context.visibleDedupeKeys ?? []);
      for (const operation of operations) {
        if (
          (operation.op === "update" || operation.op === "note" || operation.op === "criterion") &&
          !visibleIds.has(operation.id)
        ) {
          throw new Error(`task ${operation.id} was not present in this step's observed task context`);
        }
        if (operation.op === "upsert") {
          const existing = current.find((task) => task.dedupeKey === operation.dedupeKey);
          if (existing && !visibleIds.has(existing.id) && !visibleDedupeKeys.has(operation.dedupeKey)) {
            throw new Error(
              `task ${existing.id} for dedupe key ${JSON.stringify(operation.dedupeKey)} was not present in this step's observed task context`,
            );
          }
        }
      }
    }

    const shadowRoot = await mkdtemp(join(tmpdir(), "weft-task-preflight-"));
    try {
      const shadow = new TaskStore(shadowRoot, async () => extensionSchema);
      const config = this.extensionConfig(context.workflowId);
      await shadow.registerWorkflow(
        { id: context.workflowId, name: context.workflowName },
        extensionSchema,
        null,
        {
          schemaVersion: config.version,
          ...(config.migrate ? { migrate: config.migrate } : {}),
        },
      );
      for (const task of current) await shadow.write(task, true);
      const actor = "preflight";
      for (const [index, operation] of operations.entries()) {
        const operationKey = `preflight:${index}`;
        if (operation.op === "create") {
          await shadow.create(context.workflowId, { ...operation, actor, operationKey }, extensionSchema);
          continue;
        }
        if (operation.op === "update") {
          const { acceptanceCriteria, op: _op, ...fields } = operation;
          await shadow.update(
            context.workflowId,
            operation.id,
            {
              ...fields,
              ...(acceptanceCriteria
                ? { acceptanceCriteria: acceptanceCriteria.map((text) => ({ text })) }
                : {}),
              actor,
              operationKey,
            },
            extensionSchema,
          );
          continue;
        }
        if (operation.op === "note") {
          await shadow.addNote(context.workflowId, operation.id, operation.text, actor, {
            ...(operation.ifRevision !== undefined ? { ifRevision: operation.ifRevision } : {}),
            operationKey,
          });
          continue;
        }
        if (operation.op === "criterion") {
          await shadow.setCriterion(
            context.workflowId,
            operation.id,
            operation.criterionId,
            operation.met,
            actor,
            operation.ifRevision,
          );
          continue;
        }
        const update = operation.update ? agentUpdateInput(operation.update) : undefined;
        await shadow.mutate(context.workflowId, () =>
          shadow.upsertUnlocked(
            context.workflowId,
            operation.dedupeKey,
            {
              create: operation.create,
              ...(update ? { update } : {}),
              ...(operation.note !== undefined ? { note: operation.note } : {}),
              actor,
              operationKey,
            },
            extensionSchema,
          ),
        );
      }
    } finally {
      await rm(shadowRoot, { recursive: true, force: true });
    }
  }

  async remove(workflowId: string, id: string): Promise<void> {
    const extensionSchema = await this.extensionSchema(workflowId);
    await this.mutate(workflowId, async () => {
      const task = await this.get(workflowId, id, extensionSchema);
      const dependents = (await this.list(workflowId, extensionSchema)).filter((candidate) =>
        candidate.dependencies.includes(task.id),
      );
      if (dependents.length > 0) {
        throw new Error(`task ${id} is required by ${dependents.map((task) => task.id).join(", ")}`);
      }
      await unlink(this.taskFile(workflowId, id));
    });
  }

  private async assertDependencies(
    workflowId: string,
    task: WorkflowTask,
    extensionSchema?: AnySchema,
  ): Promise<void> {
    if (task.dependencies.includes(task.id)) throw new Error(`task ${task.id} cannot depend on itself`);
    const tasks = await this.list(workflowId, extensionSchema);
    const all = new Map(tasks.map((candidate) => [candidate.id, candidate]));
    all.set(task.id, task);
    validateTopology([...all.values()], workflowId);
  }

  private async readTask(
    file: string,
    expectedWorkflowId: string,
    expectedId: string,
    extensionSchema?: AnySchema,
  ): Promise<WorkflowTask> {
    let value: unknown;
    try {
      value = JSON.parse(await readFile(file, "utf8")) as unknown;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") throw err;
      throw new Error(`invalid task file ${file}: ${(err as Error).message}`, { cause: err });
    }
    const task = decodeTask(value, file, expectedWorkflowId, expectedId);
    const config = this.extensionConfig(expectedWorkflowId);
    if (task.extensionSchemaVersion > config.version) {
      throw new Error(
        `task ${task.id} uses extension schema version ${task.extensionSchemaVersion}, newer than workflow version ${config.version}`,
      );
    }
    let candidate = task.extensions;
    if (task.extensionSchemaVersion < config.version) {
      if (!config.migrate) {
        throw new Error(
          `task ${task.id} needs extension migration from version ${task.extensionSchemaVersion} to ${config.version}`,
        );
      }
      candidate = await config.migrate(candidate, task.extensionSchemaVersion);
    }
    const extensions = await extensionsOf(candidate, extensionSchema);
    return withStoredExtensions(
      { ...task, extensionSchemaVersion: config.version, extensions },
      candidate === undefined ? {} : candidate,
    );
  }

  private async write(task: WorkflowTask, createOnly = false): Promise<void> {
    const persisted = { ...task, extensions: storedExtensionsOf(task) };
    const bad = jsonUnsafeAt(persisted);
    if (bad !== undefined) throw new Error(`task cannot be stored as JSON at ${bad}`);
    const dir = this.workflowDir(task.workflowId);
    await mkdir(dir, { recursive: true });
    const target = this.taskFile(task.workflowId, task.id);
    const temp = join(dir, `.${task.id}.${randomUUID()}.tmp`);
    const handle = await open(temp, "wx");
    try {
      await handle.writeFile(`${JSON.stringify(persisted, null, 2)}\n`, "utf8");
      await handle.sync();
      await handle.close();
      if (createOnly) {
        // Atomic no-clobber publication: even a mocked UUID collision cannot
        // replace an existing task with a new one.
        await link(temp, target);
      } else {
        await rename(temp, target);
      }
      await syncDir(dir);
    } finally {
      await handle.close().catch(() => undefined);
      await unlink(temp).catch(() => undefined);
    }
  }

  private async writeAux(file: string, value: unknown): Promise<void> {
    const dir = dirname(file);
    const temp = `${file}.${randomUUID()}.tmp`;
    const handle = await open(temp, "wx");
    try {
      await handle.writeFile(`${JSON.stringify(value)}\n`, "utf8");
      await handle.sync();
      await handle.close();
      await rename(temp, file);
      await syncDir(dir);
    } finally {
      await handle.close().catch(() => undefined);
      await unlink(temp).catch(() => undefined);
    }
  }

  /** Serialize topology and note updates across CLI processes; stale crash locks self-heal. */
  private async mutate<T>(workflowId: string, fn: () => Promise<T>): Promise<T> {
    const dir = this.workflowDir(workflowId);
    await mkdir(dir, { recursive: true });
    const lock = join(dir, ".lock");
    const token = randomUUID();
    const owner = JSON.stringify({ token, pid: process.pid, createdAt: Date.now() });
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    for (let attempt = 0; attempt < 200; attempt++) {
      try {
        handle = await open(lock, "wx");
        await handle.writeFile(`${owner}\n`, "utf8");
        await handle.sync();
        break;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
        const age = await stat(lock)
          .then((info) => Date.now() - info.mtimeMs)
          .catch(() => 0);
        if (age > 30_000) {
          const observed = await readFile(lock, "utf8").catch(() => "");
          const pid = lockPid(observed);
          if (pid === undefined || !processAlive(pid)) {
            const unchanged = await readFile(lock, "utf8").catch(() => "");
            if (unchanged === observed) await unlink(lock).catch(() => undefined);
          }
        }
        await new Promise((resolve) => setTimeout(resolve, 10 + Math.min(attempt, 40)));
      }
    }
    if (handle === undefined) throw new Error(`workflow ${workflowId} task store is busy`);
    const heartbeat = setInterval(() => {
      const now = new Date();
      void utimes(lock, now, now).catch(() => undefined);
    }, 5_000);
    heartbeat.unref();
    try {
      await cleanupOrphanTemps(dir);
      return await fn();
    } finally {
      clearInterval(heartbeat);
      await handle.close().catch(() => undefined);
      const current = await readFile(lock, "utf8").catch(() => "");
      if (current.trim() === owner) await unlink(lock).catch(() => undefined);
    }
  }

  private workflowDir(workflowId: string): string {
    assertWorkflowId(workflowId);
    return join(this.root, encodeURIComponent(workflowId));
  }

  private taskFile(workflowId: string, id: string): string {
    assertId(id);
    return join(this.workflowDir(workflowId), `${id}.json`);
  }

  private batchFile(workflowId: string, batchId: string): string {
    return join(this.workflowDir(workflowId), `.batch-${digest(batchId)}.json`);
  }

  private namespaceFile(workflowId: string): string {
    return join(this.workflowDir(workflowId), ".workflow.json");
  }

  /** A configured workflow resolver is authoritative; explicit schemas are a standalone-store fallback. */
  private async extensionSchema(
    workflowId: string,
    fallback?: AnySchema,
    schemaBinding?: string,
  ): Promise<AnySchema | undefined> {
    const scoped = this.schemaScope.getStore();
    if (scoped?.workflowId === workflowId) return scoped.schema;
    if (schemaBinding !== undefined) {
      const key = `${workflowId}:${schemaBinding}`;
      if (!this.runtimeSchemas.has(key)) {
        throw new Error(`task extension schema binding ${schemaBinding} is not registered for ${workflowId}`);
      }
      return this.runtimeSchemas.get(key);
    }
    if (!this.schemaFor) return fallback;
    return this.schemaFor(workflowId);
  }

  private async withSchemaBinding<T>(
    workflowId: string,
    schemaBinding: string,
    fn: () => Promise<T>,
  ): Promise<T> {
    const key = `${workflowId}:${schemaBinding}`;
    if (!this.runtimeSchemas.has(key)) {
      throw new Error(`task extension schema binding ${schemaBinding} is not registered for ${workflowId}`);
    }
    const migration = this.runtimeMigrations.get(key) ?? { version: 1 };
    return this.schemaScope.run(
      {
        workflowId,
        binding: schemaBinding,
        schema: this.runtimeSchemas.get(key),
        version: migration.version,
        ...(migration.migrate ? { migrate: migration.migrate } : {}),
      },
      fn,
    );
  }

  private extensionConfig(workflowId: string): {
    version: number;
    migrate?: (extensions: unknown, fromVersion: number) => unknown | Promise<unknown>;
  } {
    const scoped = this.schemaScope.getStore();
    if (scoped?.workflowId === workflowId) {
      return { version: scoped.version, ...(scoped.migrate ? { migrate: scoped.migrate } : {}) };
    }
    const binding = this.latestBindings.get(workflowId);
    if (!binding) return { version: 1 };
    return this.runtimeMigrations.get(`${workflowId}:${binding}`) ?? { version: 1 };
  }
}

async function extensionsOf(value: unknown, schema?: AnySchema): Promise<unknown> {
  const candidate = value === undefined ? {} : value;
  if (schema === undefined) {
    if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) {
      throw new Error("task extensions must be a JSON object when the workflow declares no extension schema");
    }
    return candidate;
  }
  const checked = await validateSchema(schema, candidate);
  if (!checked.ok) {
    throw new Error(
      `task extensions failed the workflow schema: ${checked.issues.map((issue) => `${issue.path}: ${issue.message}`).join("; ")}`,
    );
  }
  const unsafe = jsonUnsafeAt(checked.value);
  if (unsafe !== undefined) {
    throw new Error(`task extension schema output must be JSON-safe at ${unsafe}`);
  }
  return checked.value;
}

function withStoredExtensions<T extends WorkflowTask>(task: T, stored: unknown): T {
  Object.defineProperty(task, STORED_EXTENSIONS, {
    value: stored,
    writable: true,
    configurable: true,
    // Object spread must carry the raw input through note/status/criterion
    // mutations; JSON.stringify still ignores symbol properties.
    enumerable: true,
  });
  return task;
}

function storedExtensionsOf(task: WorkflowTask): unknown {
  const hydrated = task as HydratedWorkflowTask;
  return STORED_EXTENSIONS in hydrated ? hydrated[STORED_EXTENSIONS] : task.extensions;
}

function strings(values: string[] | undefined): string[] {
  return [...new Set((values ?? []).map((value) => cleanRequired(value, "list value")))];
}

function criteria(
  values: Array<{ id?: string; text: string; met?: boolean }>,
  previous: TaskCriterion[] = [],
): TaskCriterion[] {
  const unique = new Map<string, TaskCriterion>();
  for (const criterion of values) {
    const text = cleanRequired(criterion.text, "acceptance criterion");
    const prior = previous.find((candidate) =>
      criterion.id ? candidate.id === criterion.id : candidate.text === text,
    );
    const id = criterion.id ?? prior?.id ?? criterionId(text);
    assertCriterionId(id);
    unique.set(text, { id, text, met: criterion.met ?? prior?.met ?? false });
  }
  const result = [...unique.values()];
  if (new Set(result.map((criterion) => criterion.id)).size !== result.length) {
    throw new Error("acceptance criterion ids must be unique");
  }
  return result;
}

function criterionId(text: string): string {
  return `criterion-${digest(text).slice(0, 12)}`;
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function cleanRequired(value: string, label: string): string {
  const clean = value.trim();
  if (clean === "") throw new Error(`${label} cannot be empty`);
  return clean;
}

function statusOf(value: string): TaskStatus {
  if ((TASK_STATUSES as readonly string[]).includes(value)) return value as TaskStatus;
  throw new Error(`invalid task status ${JSON.stringify(value)} — expected ${TASK_STATUSES.join(", ")}`);
}

function priorityOf(value: string): TaskPriority {
  if ((TASK_PRIORITIES as readonly string[]).includes(value)) return value as TaskPriority;
  throw new Error(`invalid task priority ${JSON.stringify(value)} — expected ${TASK_PRIORITIES.join(", ")}`);
}

function assertId(value: string): void {
  if (!/^task-[a-f0-9]{8}$/.test(value)) throw new Error(`invalid task id ${JSON.stringify(value)}`);
}

function assertCriterionId(value: string): void {
  if (!/^criterion-[a-f0-9]{12}$/.test(value)) {
    throw new Error(`invalid acceptance criterion id ${JSON.stringify(value)}`);
  }
}

function decodeTask(
  value: unknown,
  file: string,
  expectedWorkflowId: string,
  expectedId: string,
): WorkflowTask {
  const fail = (detail: string): never => {
    throw new Error(`invalid task file ${file}: ${detail}`);
  };
  if (typeof value !== "object" || value === null || Array.isArray(value)) fail("expected object");
  const v = value as Record<string, unknown>;
  const allowed = new Set([
    "schemaVersion",
    "extensionSchemaVersion",
    "id",
    "workflowId",
    "dedupeKey",
    "title",
    "description",
    "status",
    "priority",
    "tags",
    "dependencies",
    "relatedFiles",
    "acceptanceCriteria",
    "notes",
    "extensions",
    "createdAt",
    "updatedAt",
    "createdBy",
    "updatedBy",
    "revision",
    "appliedOperations",
  ]);
  const unknown = Object.keys(v).filter((key) => !allowed.has(key));
  if (unknown.length > 0) fail(`unknown fields: ${unknown.join(", ")}; use extensions for workflow data`);
  if (v.id !== expectedId) fail(`id does not match filename ${expectedId}`);
  if (v.workflowId !== expectedWorkflowId) fail(`workflowId does not match directory ${expectedWorkflowId}`);
  if (v.schemaVersion !== undefined && v.schemaVersion !== TASK_SCHEMA_VERSION) {
    fail(`unsupported schemaVersion ${String(v.schemaVersion)}`);
  }
  assertId(expectedId);
  assertWorkflowId(expectedWorkflowId);
  const string = (key: string): string => {
    if (typeof v[key] !== "string" || (v[key] as string).trim() === "") fail(`${key} must be a string`);
    return v[key] as string;
  };
  const number = (key: string): number => {
    if (typeof v[key] !== "number" || !Number.isFinite(v[key])) fail(`${key} must be a finite number`);
    return v[key] as number;
  };
  const stringsAt = (key: string): string[] => {
    if (
      !Array.isArray(v[key]) ||
      !(v[key] as unknown[]).every((item) => typeof item === "string" && item.trim() !== "")
    ) {
      fail(`${key} must be a string array`);
    }
    const result = v[key] as string[];
    if (new Set(result).size !== result.length) fail(`${key} must not contain duplicates`);
    return result;
  };
  const rawCriteria = v.acceptanceCriteria;
  if (!Array.isArray(rawCriteria)) fail("acceptanceCriteria must be an array");
  const acceptanceCriteria = (rawCriteria as unknown[]).map((item, index) => {
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      return fail(`acceptanceCriteria.${index} must be an object`);
    }
    const criterion = item as Record<string, unknown>;
    if (typeof criterion.text !== "string" || typeof criterion.met !== "boolean") {
      return fail(`acceptanceCriteria.${index} is malformed`);
    }
    const text = cleanRequired(criterion.text, "acceptance criterion");
    const id = typeof criterion.id === "string" ? criterion.id : criterionId(text);
    try {
      assertCriterionId(id);
    } catch (err) {
      return fail(`acceptanceCriteria.${index}: ${(err as Error).message}`);
    }
    return {
      id,
      text,
      met: criterion.met,
    };
  });
  if (new Set(acceptanceCriteria.map((criterion) => criterion.id)).size !== acceptanceCriteria.length) {
    fail("acceptanceCriteria ids must be unique");
  }
  if (!Array.isArray(v.notes)) fail("notes must be an array");
  const notes = (v.notes as unknown[]).map((item, index) => {
    if (typeof item !== "object" || item === null || Array.isArray(item))
      return fail(`notes.${index} malformed`);
    const note = item as Record<string, unknown>;
    if (
      typeof note.text !== "string" ||
      note.text.trim() === "" ||
      typeof note.at !== "number" ||
      !Number.isFinite(note.at) ||
      note.at < 0 ||
      typeof note.actor !== "string" ||
      note.actor.trim() === ""
    ) {
      return fail(`notes.${index} malformed`);
    }
    return { text: note.text, at: note.at, actor: note.actor };
  });
  const status = statusOf(string("status"));
  const priority = priorityOf(string("priority"));
  const revision = number("revision");
  if (!Number.isInteger(revision) || revision < 1) fail("revision must be a positive integer");
  const extensionSchemaVersion =
    v.extensionSchemaVersion === undefined ? 1 : number("extensionSchemaVersion");
  if (!Number.isInteger(extensionSchemaVersion) || extensionSchemaVersion < 1) {
    fail("extensionSchemaVersion must be a positive integer");
  }
  const createdAt = number("createdAt");
  const updatedAt = number("updatedAt");
  if (!Number.isInteger(createdAt) || createdAt < 0) fail("createdAt must be a non-negative integer");
  if (!Number.isInteger(updatedAt) || updatedAt < createdAt) {
    fail("updatedAt must be an integer at or after createdAt");
  }
  const dependencies = stringsAt("dependencies");
  for (const dependency of dependencies) {
    try {
      assertId(dependency);
    } catch (err) {
      fail(`dependencies: ${(err as Error).message}`);
    }
  }
  return {
    schemaVersion: TASK_SCHEMA_VERSION,
    extensionSchemaVersion,
    id: expectedId,
    workflowId: expectedWorkflowId,
    ...(v.dedupeKey !== undefined
      ? {
          dedupeKey: cleanDedupeKey(
            typeof v.dedupeKey === "string" ? v.dedupeKey : fail("dedupeKey must be a string"),
          ),
        }
      : {}),
    title: string("title"),
    description: string("description"),
    status,
    priority,
    tags: stringsAt("tags"),
    dependencies,
    relatedFiles: stringsAt("relatedFiles"),
    acceptanceCriteria,
    notes,
    extensions: v.extensions === undefined ? {} : v.extensions,
    createdAt,
    updatedAt,
    createdBy: string("createdBy"),
    updatedBy: string("updatedBy"),
    revision,
    appliedOperations: Array.isArray(v.appliedOperations) ? stringsAt("appliedOperations") : [],
  };
}

function validateTopology(tasks: WorkflowTask[], workflowId: string): void {
  const all = new Map(tasks.map((task) => [task.id, task]));
  const dedupe = new Map<string, string>();
  for (const task of tasks) {
    if (task.dedupeKey) {
      const prior = dedupe.get(task.dedupeKey);
      if (prior && prior !== task.id) {
        throw new Error(`dedupe key ${JSON.stringify(task.dedupeKey)} is already used by ${prior}`);
      }
      dedupe.set(task.dedupeKey, task.id);
    }
    if (task.dependencies.includes(task.id)) throw new Error(`task ${task.id} cannot depend on itself`);
    for (const dependency of task.dependencies) {
      if (!all.has(dependency)) {
        throw new Error(`dependency ${dependency} does not exist in workflow ${workflowId}`);
      }
    }
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string): void => {
    if (visiting.has(id)) throw new Error(`task dependency cycle includes ${id}`);
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dependency of all.get(id)?.dependencies ?? []) visit(dependency);
    visiting.delete(id);
    visited.add(id);
  };
  for (const id of all.keys()) visit(id);
}

function agentUpdateInput(
  input: NonNullable<Extract<AgentTaskOperation, { op: "upsert" }>["update"]>,
): UpdateTaskInput {
  const { acceptanceCriteria, ...fields } = input;
  return {
    ...fields,
    ...(acceptanceCriteria !== undefined
      ? {
          acceptanceCriteria: acceptanceCriteria.map((text) => ({
            text,
            ...(input.resetAcceptance ? { met: false } : {}),
          })),
        }
      : {}),
  };
}

function cleanDedupeKey(value: string): string {
  const clean = cleanRequired(value, "dedupe key");
  if (clean.length > 512) throw new Error("dedupe key must be at most 512 characters");
  return clean;
}

async function fileExists(file: string): Promise<boolean> {
  try {
    await stat(file);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw err;
  }
}

function isMissingTask(err: unknown, workflowId: string, id: string): boolean {
  return err instanceof Error && err.message === `task ${id} not found in workflow ${workflowId}`;
}

async function cleanupOrphanTemps(dir: string): Promise<void> {
  const files = await readdir(dir);
  await Promise.all(
    files
      .filter((file) => file.endsWith(".tmp"))
      .map((file) =>
        unlink(join(dir, file)).catch((err: unknown) => {
          if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
        }),
      ),
  );
}

function lockPid(value: string): number | undefined {
  try {
    const parsed = JSON.parse(value) as { pid?: unknown };
    return typeof parsed.pid === "number" && Number.isInteger(parsed.pid) ? parsed.pid : undefined;
  } catch {
    return undefined;
  }
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function syncDir(dir: string): Promise<void> {
  const handle = await open(dir, "r").catch(() => undefined);
  if (!handle) return;
  try {
    await handle.sync().catch(() => undefined);
  } finally {
    await handle.close().catch(() => undefined);
  }
}
