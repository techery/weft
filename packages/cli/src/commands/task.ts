/** `weft task` — workflow-bound durable context for agents and people. */
import type {
  TaskPriority,
  TaskStatus,
  TaskWorkflowNamespace,
  UpdateTaskInput,
  Weft,
  WorkflowDefinition,
  WorkflowTask,
} from "@techery/weft-host";
import { GateError, TASK_PRIORITIES, TASK_STATUSES } from "@techery/weft-host";
import { Command, Option } from "commander";
import pc from "picocolors";
import { openWeft } from "../context.ts";
import type { CliIo } from "../io.ts";

interface ScopeOptions {
  workflow: string;
  actor?: string;
  json?: boolean;
}

interface CreateOptions {
  title: string;
  description: string;
  dedupeKey?: string;
  status?: TaskStatus;
  priority?: TaskPriority;
  tag: string[];
  dependsOn: string[];
  file: string[];
  acceptance: string[];
  extensions?: string;
}

interface UpdateOptions {
  title?: string;
  description?: string;
  status?: TaskStatus;
  priority?: TaskPriority;
  tag?: string[];
  dependsOn?: string[];
  file?: string[];
  acceptance?: string[];
  extensions?: string;
  ifRevision?: string;
  clearTags?: boolean;
  clearDependencies?: boolean;
  clearFiles?: boolean;
  clearAcceptance?: boolean;
}

interface UpsertOptions {
  dedupeKey: string;
  title: string;
  description: string;
  status?: TaskStatus;
  priority?: TaskPriority;
  tag?: string[];
  dependsOn?: string[];
  file?: string[];
  acceptance?: string[];
  extensions?: string;
  note?: string;
  clearTags?: boolean;
  clearDependencies?: boolean;
  clearFiles?: boolean;
  clearAcceptance?: boolean;
}

export function taskCommand(io: CliIo): Command {
  const task = new Command("task")
    .description("manage durable tasks bound to one workflow")
    .requiredOption("--workflow <id>", "stable workflow id")
    .option("--actor <name>", "identity recorded on mutations", process.env.WEFT_TASK_ACTOR ?? "cli")
    .option("--json", "emit machine-readable JSON");

  task.addCommand(
    new Command("list")
      .description("list every task in the workflow")
      .addOption(new Option("--status <status>", "filter by status").choices([...TASK_STATUSES]))
      .option("--tag <tag>", "filter by tag")
      .option("--dedupe-key <key>", "filter by recurring-work identity")
      .option("--file <path>", "filter by related file")
      .action(async (opts: { status?: string; tag?: string; dedupeKey?: string; file?: string }, cmd) => {
        await withTasks(cmd, async (weft, workflowId) => {
          let tasks = await weft.tasks.list(workflowId);
          if (opts.status !== undefined) tasks = tasks.filter((task) => task.status === opts.status);
          if (opts.tag !== undefined) tasks = tasks.filter((task) => task.tags.includes(opts.tag as string));
          if (opts.dedupeKey !== undefined) {
            tasks = tasks.filter((task) => task.dedupeKey === opts.dedupeKey);
          }
          if (opts.file !== undefined) {
            tasks = tasks.filter((task) => task.relatedFiles.includes(opts.file as string));
          }
          printTasks(io, tasks, scopeOf(cmd).json === true);
        });
      }),
  );

  task.addCommand(
    new Command("schema")
      .description("show the workflow task-extension JSON Schema")
      .action(async (_opts, cmd) => {
        await withTasks(cmd, async (_weft, _workflowId, def, namespace) => {
          const schema = def?.meta.tasks?.extensions;
          if (!schema) {
            io.out(JSON.stringify(namespace.extensionSchema, null, 2));
            return;
          }
          const { z } = await import("@techery/weft-sdk");
          try {
            io.out(JSON.stringify(z.toJSONSchema(schema as never, { io: "input" }), null, 2));
          } catch {
            io.out(JSON.stringify(null));
          }
        });
      }),
  );

  task.addCommand(
    new Command("show")
      .description("show one task")
      .argument("<id>")
      .action(async (id: string, _opts, cmd) => {
        await withTasks(cmd, async (weft, workflowId) => {
          printOne(io, await weft.tasks.get(workflowId, id), scopeOf(cmd).json === true);
        });
      }),
  );

  const create = new Command("create")
    .description("create a task")
    .requiredOption("--title <title>")
    .requiredOption("--description <text>")
    .option("--dedupe-key <key>", "workflow-scoped identity for idempotent recurring work")
    .addOption(new Option("--status <status>").choices([...TASK_STATUSES]))
    .addOption(new Option("--priority <priority>").choices([...TASK_PRIORITIES]))
    .option("--tag <tag>", "tag; repeat for more than one", collect, [])
    .option("--depends-on <id>", "dependency task id; repeatable", collect, [])
    .option("--file <path>", "related repo file; repeatable", collect, [])
    .option("--acceptance <text>", "acceptance criterion; repeatable", collect, [])
    .option("--extensions <json>", "workflow-specific extension value as JSON")
    .action(async (opts: CreateOptions, cmd) => {
      await withTasks(cmd, async (weft, workflowId, def, namespace) => {
        requireDefinitionForDeclaredExtensions(def, namespace, "create a task");
        const task = await weft.tasks.create(
          workflowId,
          {
            title: opts.title,
            description: opts.description,
            ...(opts.dedupeKey !== undefined ? { dedupeKey: opts.dedupeKey } : {}),
            ...(opts.status !== undefined ? { status: opts.status } : {}),
            ...(opts.priority !== undefined ? { priority: opts.priority } : {}),
            tags: opts.tag,
            dependencies: opts.dependsOn,
            relatedFiles: opts.file,
            acceptanceCriteria: opts.acceptance,
            ...(opts.extensions !== undefined ? { extensions: json(opts.extensions, "--extensions") } : {}),
            actor: scopeOf(cmd).actor,
          },
          def?.meta.tasks?.extensions,
        );
        printOne(io, task, scopeOf(cmd).json === true);
      });
    });
  task.addCommand(create);

  const upsert = new Command("upsert")
    .description("create or update a recurring task by workflow-scoped dedupe key")
    .requiredOption("--dedupe-key <key>")
    .requiredOption("--title <title>")
    .requiredOption("--description <text>")
    .addOption(new Option("--status <status>").choices([...TASK_STATUSES]))
    .addOption(new Option("--priority <priority>").choices([...TASK_PRIORITIES]))
    .option("--tag <tag>", "replacement tags; repeatable", collect)
    .option("--depends-on <id>", "replacement dependencies; repeatable", collect)
    .option("--file <path>", "replacement related files; repeatable", collect)
    .option("--acceptance <text>", "replacement acceptance criteria; repeatable", collect)
    .option("--extensions <json>", "replacement workflow-specific extension value")
    .option("--note <text>", "append occurrence context atomically")
    .option("--clear-tags", "replace tags with an empty list")
    .option("--clear-dependencies", "replace dependencies with an empty list")
    .option("--clear-files", "replace related files with an empty list")
    .option("--clear-acceptance", "replace acceptance criteria with an empty list")
    .action(async (opts: UpsertOptions, cmd) => {
      await withTasks(cmd, async (weft, workflowId, def, namespace) => {
        requireDefinitionForDeclaredExtensions(def, namespace, "upsert a task");
        const create = {
          title: opts.title,
          description: opts.description,
          ...(opts.status !== undefined ? { status: opts.status } : {}),
          ...(opts.priority !== undefined ? { priority: opts.priority } : {}),
          tags: opts.tag ?? [],
          dependencies: opts.dependsOn ?? [],
          relatedFiles: opts.file ?? [],
          acceptanceCriteria: opts.acceptance ?? [],
          ...(opts.extensions !== undefined ? { extensions: json(opts.extensions, "--extensions") } : {}),
        };
        const task = await weft.tasks.upsert(
          workflowId,
          opts.dedupeKey,
          {
            create,
            update: {
              title: opts.title,
              description: opts.description,
              ...(opts.status !== undefined ? { status: opts.status } : {}),
              ...(opts.priority !== undefined ? { priority: opts.priority } : {}),
              ...(opts.clearTags ? { tags: [] } : opts.tag !== undefined ? { tags: opts.tag } : {}),
              ...(opts.clearDependencies
                ? { dependencies: [] }
                : opts.dependsOn !== undefined
                  ? { dependencies: opts.dependsOn }
                  : {}),
              ...(opts.clearFiles
                ? { relatedFiles: [] }
                : opts.file !== undefined
                  ? { relatedFiles: opts.file }
                  : {}),
              ...(opts.clearAcceptance
                ? { acceptanceCriteria: [] }
                : opts.acceptance !== undefined
                  ? { acceptanceCriteria: opts.acceptance.map((text) => ({ text })) }
                  : {}),
              ...(opts.extensions !== undefined ? { extensions: json(opts.extensions, "--extensions") } : {}),
            },
            ...(opts.note !== undefined ? { note: opts.note } : {}),
            actor: scopeOf(cmd).actor,
          },
          def?.meta.tasks?.extensions,
        );
        printOne(io, task, scopeOf(cmd).json === true);
      });
    });
  task.addCommand(upsert);

  const update = new Command("update")
    .description("update task fields; repeatable lists replace their current value")
    .argument("<id>")
    .option("--title <title>")
    .option("--description <text>")
    .addOption(new Option("--status <status>").choices([...TASK_STATUSES]))
    .addOption(new Option("--priority <priority>").choices([...TASK_PRIORITIES]))
    .option("--tag <tag>", "replacement tags; repeatable", collect)
    .option("--depends-on <id>", "replacement dependencies; repeatable", collect)
    .option("--file <path>", "replacement related files; repeatable", collect)
    .option("--acceptance <text>", "replacement criteria (all initially unmet); repeatable", collect)
    .option("--extensions <json>", "replacement workflow-specific extension value")
    .option("--if-revision <number>", "fail instead of overwriting a newer revision")
    .option("--clear-tags", "replace tags with an empty list")
    .option("--clear-dependencies", "replace dependencies with an empty list")
    .option("--clear-files", "replace related files with an empty list")
    .option("--clear-acceptance", "replace acceptance criteria with an empty list")
    .action(async (id: string, opts: UpdateOptions, cmd) => {
      await withTasks(cmd, async (weft, workflowId, def, namespace) => {
        if (opts.extensions !== undefined) {
          requireDefinitionForDeclaredExtensions(def, namespace, "replace task extensions");
        }
        const patch: UpdateTaskInput = {
          ...(opts.title !== undefined ? { title: opts.title } : {}),
          ...(opts.description !== undefined ? { description: opts.description } : {}),
          ...(opts.status !== undefined ? { status: opts.status } : {}),
          ...(opts.priority !== undefined ? { priority: opts.priority } : {}),
          ...(opts.clearTags ? { tags: [] } : opts.tag !== undefined ? { tags: opts.tag } : {}),
          ...(opts.clearDependencies
            ? { dependencies: [] }
            : opts.dependsOn !== undefined
              ? { dependencies: opts.dependsOn }
              : {}),
          ...(opts.clearFiles
            ? { relatedFiles: [] }
            : opts.file !== undefined
              ? { relatedFiles: opts.file }
              : {}),
          ...(opts.clearAcceptance
            ? { acceptanceCriteria: [] }
            : opts.acceptance !== undefined
              ? { acceptanceCriteria: opts.acceptance.map((text) => ({ text, met: false })) }
              : {}),
          ...(opts.extensions !== undefined ? { extensions: json(opts.extensions, "--extensions") } : {}),
          ...(opts.ifRevision !== undefined
            ? { ifRevision: positiveInt(opts.ifRevision, "--if-revision") }
            : {}),
          actor: scopeOf(cmd).actor,
        };
        printOne(
          io,
          await weft.tasks.update(workflowId, id, patch, def?.meta.tasks?.extensions),
          scopeOf(cmd).json === true,
        );
      });
    });
  task.addCommand(update);

  task.addCommand(
    new Command("note")
      .description("append context without replacing prior notes")
      .argument("<id>")
      .argument("<text>")
      .action(async (id: string, text: string, _opts, cmd) => {
        await withTasks(cmd, async (weft, workflowId) => {
          printOne(
            io,
            await weft.tasks.addNote(workflowId, id, text, scopeOf(cmd).actor),
            scopeOf(cmd).json === true,
          );
        });
      }),
  );

  for (const [name, met] of [
    ["accept", true],
    ["unaccept", false],
  ] as const) {
    task.addCommand(
      new Command(name)
        .description(`${met ? "mark" : "reopen"} one acceptance criterion by stable id (index also accepted)`)
        .argument("<id>")
        .argument("<criterion>")
        .option("--if-revision <number>", "fail if the task changed after it was read")
        .action(async (id: string, criterion: string, opts: { ifRevision?: string }, cmd) => {
          await withTasks(cmd, async (weft, workflowId) => {
            printOne(
              io,
              await weft.tasks.setCriterion(
                workflowId,
                id,
                /^\d+$/.test(criterion) ? positiveInt(criterion, "criterion") : criterion,
                met,
                scopeOf(cmd).actor,
                opts.ifRevision ? positiveInt(opts.ifRevision, "--if-revision") : undefined,
              ),
              scopeOf(cmd).json === true,
            );
          });
        }),
    );
  }

  task.addCommand(
    new Command("remove")
      .description("permanently remove a task with no dependents")
      .argument("<id>")
      .requiredOption("--yes", "confirm permanent removal")
      .action(async (id: string, _opts, cmd) => {
        await withTasks(cmd, async (weft, workflowId) => {
          await weft.tasks.remove(workflowId, id);
          if (scopeOf(cmd).json === true) io.out(JSON.stringify({ ok: true, removed: id }));
          else io.out(`${pc.green("removed")} ${id}`);
        });
      }),
  );

  return task;
}

async function withTasks(
  cmd: Command,
  fn: (
    weft: Weft,
    workflowId: string,
    def: WorkflowDefinition | undefined,
    namespace: TaskWorkflowNamespace,
  ) => Promise<void>,
): Promise<void> {
  const scope = scopeOf(cmd);
  const weft = await openWeft(cmd);
  try {
    const loaded = await loadBoundWorkflow(weft, scope.workflow);
    await fn(weft, loaded.workflowId, loaded.def, loaded.namespace);
  } finally {
    await weft.close();
  }
}

/** Resolve the stable task namespace before considering a callable workflow name. */
async function loadBoundWorkflow(
  weft: Weft,
  workflowId: string,
): Promise<{
  workflowId: string;
  def: WorkflowDefinition | undefined;
  namespace: TaskWorkflowNamespace;
}> {
  // Agent instructions always emit the durable workflow id. A different workflow
  // may legally use that string as its callable name, so name-first lookup can
  // silently mutate the wrong namespace. Registry ids are authoritative here.
  const entries = await weft.registry.list();
  const idEntry = entries.find((entry) => entry.id === workflowId);
  if (idEntry) {
    const loaded = await weft.registry.load(idEntry.name);
    const namespace = await namespaceForDefinition(
      weft,
      workflowId,
      loaded.def.meta.name ?? idEntry.name,
      loaded.def,
    );
    return { workflowId, def: loaded.def, namespace };
  }

  // Path/stdin workflows can leave a durable namespace without a registry
  // definition. Its exact id still outranks an unrelated callable name.
  const namespace = await weft.tasks.namespace(workflowId);
  if (namespace) return { workflowId, def: undefined, namespace };

  let directError: unknown;
  try {
    const loaded = await weft.registry.load(workflowId);
    const id = loaded.def.meta.id ?? loaded.def.meta.name ?? workflowId;
    const namespace = await namespaceForDefinition(weft, id, loaded.def.meta.name ?? workflowId, loaded.def);
    return { workflowId: id, def: loaded.def, namespace };
  } catch (err) {
    directError = err;
    if (!isRegistryMiss(err)) throw err;
  }
  throw directError;
}

async function namespaceForDefinition(
  weft: Weft,
  id: string,
  name: string,
  def: WorkflowDefinition,
): Promise<TaskWorkflowNamespace> {
  const extensionSchema = def.meta.tasks?.extensions;
  let extensionJsonSchema: unknown | null = null;
  if (extensionSchema) {
    const { z } = await import("@techery/weft-sdk");
    try {
      extensionJsonSchema = z.toJSONSchema(extensionSchema as never, {
        io: "input",
        unrepresentable: "any",
      });
    } catch {
      extensionJsonSchema = null;
    }
  }
  await weft.tasks.registerWorkflow({ id, name }, extensionSchema, extensionJsonSchema, def.meta.tasks);
  const namespace = await weft.tasks.namespace(id);
  if (!namespace) throw new Error(`failed to register task namespace for workflow ${id}`);
  return namespace;
}

function isRegistryMiss(err: unknown): boolean {
  return err instanceof GateError && err.diagnostics.length === 0 && err.message.includes("not found in");
}

function requireDefinitionForDeclaredExtensions(
  def: WorkflowDefinition | undefined,
  namespace: TaskWorkflowNamespace,
  action: string,
): void {
  if (!def && namespace.extensionSchemaDeclared) {
    throw new Error(
      `cannot ${action} for workflow ${namespace.id}: its extension schema is recorded, but the ` +
        "workflow definition is not available to validate the write",
    );
  }
}

function scopeOf(cmd: Command): ScopeOptions {
  const opts = cmd.optsWithGlobals() as ScopeOptions;
  if (typeof opts.workflow !== "string" || opts.workflow.trim() === "") {
    throw new Error("--workflow is required");
  }
  return opts;
}

function collect(value: string, previous: string[] = []): string[] {
  return [...previous, value];
}

function json(value: string, label: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw new Error(`${label} must be valid JSON`);
  }
}

function positiveInt(value: string, label: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`${label} must be a positive integer`);
  return parsed;
}

function printTasks(io: CliIo, tasks: WorkflowTask[], asJson: boolean): void {
  if (asJson) {
    io.out(JSON.stringify(tasks.map(publicTask), null, 2));
    return;
  }
  if (tasks.length === 0) {
    io.out(pc.dim("no tasks"));
    return;
  }
  for (const task of tasks) {
    const deps = task.dependencies.length > 0 ? ` deps:${task.dependencies.join(",")}` : "";
    const tags = task.tags.length > 0 ? ` #${task.tags.join(" #")}` : "";
    io.out(`${task.id}  ${task.status.padEnd(11)} ${task.priority.padEnd(8)} ${task.title}${tags}${deps}`);
  }
}

function printOne(io: CliIo, task: WorkflowTask, asJson: boolean): void {
  if (asJson) {
    io.out(JSON.stringify(publicTask(task), null, 2));
    return;
  }
  io.out(`${pc.bold(task.id)}  ${task.status}  ${task.priority}  r${task.revision}`);
  io.out(task.title);
  io.out(task.description);
  if (task.dedupeKey) io.out(`dedupe key: ${task.dedupeKey}`);
  if (task.tags.length > 0) io.out(`tags: ${task.tags.join(", ")}`);
  if (task.dependencies.length > 0) io.out(`depends on: ${task.dependencies.join(", ")}`);
  if (task.relatedFiles.length > 0) io.out(`files: ${task.relatedFiles.join(", ")}`);
  task.acceptanceCriteria.forEach((criterion, index) => {
    io.out(`${criterion.met ? "[x]" : "[ ]"} ${index + 1}. ${criterion.text} (${criterion.id})`);
  });
  for (const note of task.notes) io.out(`note (${note.actor}): ${note.text}`);
  if (hasExtensionValue(task.extensions)) {
    io.out(`extensions: ${JSON.stringify(task.extensions)}`);
  }
}

function publicTask(task: WorkflowTask): Omit<WorkflowTask, "appliedOperations"> {
  const { appliedOperations: _internal, ...record } = task;
  return record;
}

function hasExtensionValue(value: unknown): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return value !== undefined;
  return Object.keys(value).length > 0;
}
