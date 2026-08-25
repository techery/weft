import { createHash, randomUUID } from "node:crypto";
import { link, mkdir, open, readdir, readFile, rename, stat, unlink, utimes } from "node:fs/promises";
import { dirname, join } from "node:path";
import { type AgentTaskContext, type AgentTaskOperation, jsonUnsafeAt } from "@techery/weft-core";
import type { AnySchema } from "@techery/weft-sdk";
import { assertWorkflowId, validateSchema } from "@techery/weft-sdk";

export const TASK_SCHEMA_VERSION = 1;
export const TASK_NAMESPACE_SCHEMA_VERSION = 1;

export const TASK_STATUSES = ["todo", "in_progress", "blocked", "done", "cancelled"] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];
export const TASK_PRIORITIES = ["low", "medium", "high", "critical"] as const;
export type TaskPriority = (typeof TASK_PRIORITIES)[number];

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
  id: string;
  workflowId: string;
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
}

export interface CreateTaskInput {
  /** Internal deterministic id used by journal-replayed agent batches. */
  id?: string;
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
  extensions?: unknown;
  actor?: string;
  ifRevision?: number;
  operationKey?: string;
}

/** One JSON file per task keeps unrelated parallel agent updates independent. */
export class TaskStore {
  private readonly runtimeSchemas = new Map<string, AnySchema | undefined>();

  constructor(
    private readonly root: string,
    private readonly schemaFor?: (workflowId: string) => Promise<AnySchema | undefined>,
  ) {}

  async registerWorkflow(
    workflow: { id: string; name: string },
    extensionSchema: AnySchema | undefined,
    extensionJsonSchema: unknown | null,
  ): Promise<void> {
    assertWorkflowId(workflow.id);
    assertWorkflowId(workflow.name);
    this.runtimeSchemas.set(workflow.id, extensionSchema);
    const namespace: TaskWorkflowNamespace = {
      schemaVersion: TASK_NAMESPACE_SCHEMA_VERSION,
      id: workflow.id,
      name: workflow.name,
      extensionSchemaDeclared: extensionSchema !== undefined,
      extensionSchema: extensionJsonSchema,
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
    const id = input.id ?? `task-${randomUUID().slice(0, 8)}`;
    assertId(id);
    const task: WorkflowTask = {
      schemaVersion: TASK_SCHEMA_VERSION,
      id,
      workflowId,
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
      notes: [],
      extensions: await extensionsOf(input.extensions, extensionSchema),
      createdAt: now,
      updatedAt: now,
      createdBy: actor,
      updatedBy: actor,
      revision: 1,
      appliedOperations: input.operationKey ? [input.operationKey] : [],
    };
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
    const actor = cleanRequired(input.actor ?? "cli", "actor");
    const next: WorkflowTask = {
      ...current,
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
            acceptanceCriteria: criteria(input.acceptanceCriteria, current.acceptanceCriteria),
          }
        : {}),
      ...(input.extensions !== undefined
        ? { extensions: await extensionsOf(input.extensions, extensionSchema) }
        : {}),
      updatedAt: Date.now(),
      updatedBy: actor,
      revision: current.revision + 1,
      appliedOperations: input.operationKey
        ? [...current.appliedOperations, input.operationKey]
        : current.appliedOperations,
    };
    await this.assertDependencies(workflowId, next, extensionSchema);
    await this.write(next);
    return next;
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
  async snapshot(workflowId: string, limit = 50): Promise<unknown> {
    const tasks = await this.list(workflowId);
    const active = tasks.filter((task) => task.status !== "done" && task.status !== "cancelled");
    const selected = (active.length > 0 ? active : tasks)
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, limit);
    return {
      total: tasks.length,
      truncated: selected.length < (active.length > 0 ? active.length : tasks.length),
      tasks: selected.map((task) => ({
        id: task.id,
        revision: task.revision,
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
  async applyBatch(
    context: AgentTaskContext,
    batchId: string,
    operations: AgentTaskOperation[],
  ): Promise<void> {
    await this.mutate(context.workflowId, async () => {
      const marker = this.batchFile(context.workflowId, batchId);
      if (await fileExists(marker)) return;
      const extensionSchema = await this.extensionSchema(context.workflowId);
      const actor = `agent:${context.provider}:${context.runId}:${context.step}`;
      for (const [index, operation] of operations.entries()) {
        const operationKey = `${batchId}:${index}`;
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
    await extensionsOf(task.extensions, extensionSchema);
    return task;
  }

  private async write(task: WorkflowTask, createOnly = false): Promise<void> {
    const bad = jsonUnsafeAt(task);
    if (bad !== undefined) throw new Error(`task cannot be stored as JSON at ${bad}`);
    const dir = this.workflowDir(task.workflowId);
    await mkdir(dir, { recursive: true });
    const target = this.taskFile(task.workflowId, task.id);
    const temp = join(dir, `.${task.id}.${randomUUID()}.tmp`);
    const handle = await open(temp, "wx");
    try {
      await handle.writeFile(`${JSON.stringify(task, null, 2)}\n`, "utf8");
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
  private async extensionSchema(workflowId: string, fallback?: AnySchema): Promise<AnySchema | undefined> {
    if (this.runtimeSchemas.has(workflowId)) return this.runtimeSchemas.get(workflowId);
    if (!this.schemaFor) return fallback;
    return this.schemaFor(workflowId);
  }
}

async function extensionsOf(value: unknown, schema?: AnySchema): Promise<unknown> {
  const candidate = value ?? {};
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
  return checked.value;
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
  return [...unique.values()];
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
    "id",
    "workflowId",
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
    id: expectedId,
    workflowId: expectedWorkflowId,
    title: string("title"),
    description: string("description"),
    status,
    priority,
    tags: stringsAt("tags"),
    dependencies,
    relatedFiles: stringsAt("relatedFiles"),
    acceptanceCriteria,
    notes,
    extensions: v.extensions ?? {},
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
  for (const task of tasks) {
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
