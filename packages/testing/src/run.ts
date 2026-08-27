/**
 * runWorkflow: start a workflow on a private in-memory engine, serve every side
 * effect from fixtures, answer every human request from `answers`, and hand back
 * the typed output next to the journal it produced.
 */
import { rmSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  Engine,
  type EngineConfigInput,
  type JournalRecord,
  MemoryBlobStore,
  MemoryJournalStore,
  type PendingRequest,
  ProviderRegistry,
  type RunHandle,
  type RunState,
  reduceState,
} from "@techery/weft-core";
import { type CreateTaskInput, TaskStore } from "@techery/weft-host";
import { type MockAgentBuilder, mock } from "@techery/weft-provider-mock";
import { type WorkflowDefinition, type WorkflowTaskSnapshot, z } from "@techery/weft-sdk";
import {
  type BashFixtures,
  buildTestHooks,
  type ExecFixtures,
  type FetchFixtures,
  type GitFixtures,
} from "./fixtures.ts";
import { buildJournalView, type JournalView } from "./journal.ts";

/** Answers looked up by request id (`h1`), then by exact question, then by function. */
export type AnswerFixtures = Record<string, unknown> | ((req: PendingRequest) => unknown | Promise<unknown>);

/** Signal payloads looked up by signal name, or resolved lazily by name. */
export type SignalFixtures = Record<string, unknown> | ((name: string) => unknown | Promise<unknown>);

/** Tasks present before the workflow starts, validated against its declared task contract. */
export type TaskSeed<Extensions = unknown> = Omit<CreateTaskInput, "actor" | "extensions"> & {
  extensions?: Extensions;
};

export interface RunWorkflowOptions<Input = unknown, TaskExtensionInput = unknown> {
  input: Input;
  /** Fallback registered for both provider ids; defaults to an empty, fail-loud mock. */
  provider?: MockAgentBuilder;
  /** Provider-specific fixtures override `provider`, allowing routing assertions. */
  providers?: Record<string, MockAgentBuilder>;
  git?: GitFixtures;
  exec?: ExecFixtures;
  bash?: BashFixtures;
  fetch?: FetchFixtures;
  env?: Record<string, string>;
  /** Defaults to a fresh temp dir per call (not a git repo — git fixtures make that fine). */
  cwd?: string;
  budget?: { tokens?: number; usd?: number };
  config?: EngineConfigInput;
  answers?: AnswerFixtures;
  signals?: SignalFixtures;
  taskSeeds?: TaskSeed<TaskExtensionInput>[];
}

export interface RunWorkflowResult<Out, TaskExtensions = unknown> {
  output: Out;
  journal: JournalView;
  state: RunState;
  runId: string;
  tasks: WorkflowTaskSnapshot<TaskExtensions>;
}

const scratchDirs: string[] = [];
let scratchCleanupArmed = false;

/**
 * A throwaway working directory for one run. It survives the test (so assertions
 * can read whatever a write step produced) and is swept at process exit.
 */
async function scratchCwd(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "weft-testing-"));
  scratchDirs.push(dir);
  if (!scratchCleanupArmed) {
    scratchCleanupArmed = true;
    process.once("exit", () => {
      for (const d of scratchDirs) {
        try {
          rmSync(d, { recursive: true, force: true });
        } catch {
          // best effort — a leaked temp dir must never fail a test run
        }
      }
    });
  }
  return dir;
}

export async function runWorkflow<
  In,
  Out,
  TaskExtensions = unknown,
  RawIn = In,
  TaskExtensionInput = TaskExtensions,
>(
  def: WorkflowDefinition<In, Out, TaskExtensions, RawIn, TaskExtensionInput>,
  opts: RunWorkflowOptions<RawIn, TaskExtensionInput>,
): Promise<RunWorkflowResult<Out, TaskExtensions>> {
  const journalStore = new MemoryJournalStore();
  const blobs = new MemoryBlobStore();
  const builder = opts.provider ?? mock();
  const providers = new ProviderRegistry();
  providers.register((opts.providers?.claude ?? builder).provider("claude"));
  providers.register((opts.providers?.codex ?? builder).provider("codex"));
  for (const [id, providerBuilder] of Object.entries(opts.providers ?? {})) {
    if (id !== "claude" && id !== "codex") providers.register(providerBuilder.provider(id));
  }

  const testHooks = buildTestHooks(opts);
  const cwd = opts.cwd ?? (await scratchCwd());
  const taskStore = new TaskStore(join(cwd, ".weft", "tasks"));
  const workflowId = def.meta.id ?? def.meta.name ?? "workflow";
  const workflowName = def.meta.name ?? def.meta.id ?? "workflow";
  let extensionJsonSchema: unknown | null = null;
  if (def.meta.tasks?.extensions) {
    try {
      extensionJsonSchema = z.toJSONSchema(def.meta.tasks.extensions as z.ZodType, {
        io: "input",
        unrepresentable: "any",
      });
    } catch {
      extensionJsonSchema = null;
    }
  }
  await taskStore.registerWorkflow(
    { id: workflowId, name: workflowName },
    def.meta.tasks?.extensions,
    extensionJsonSchema,
    def.meta.tasks,
  );
  for (const seed of opts.taskSeeds ?? []) {
    await taskStore.create(workflowId, { ...seed, actor: "test" }, def.meta.tasks?.extensions);
  }
  const engine = new Engine({
    journal: journalStore,
    blobs,
    providers,
    config: opts.config ?? {},
    ...(testHooks !== undefined ? { testHooks } : {}),
    taskTracker: {
      prepare: async (workflow, extensionSchema, taskOptions) => {
        let extensionJsonSchema: unknown | null = null;
        if (extensionSchema) {
          try {
            extensionJsonSchema = z.toJSONSchema(extensionSchema as z.ZodType, {
              io: "input",
              unrepresentable: "any",
            });
          } catch {
            extensionJsonSchema = null;
          }
        }
        return taskStore.registerWorkflow(workflow, extensionSchema, extensionJsonSchema, taskOptions);
      },
      snapshot: (context) => taskStore.snapshot(context.workflowId, context.selector, context.schemaBinding),
      schema: (context) => taskStore.schema(context.workflowId, context.schemaBinding),
      validateBatch: (context, operations) => taskStore.validateBatch(context, operations),
      applyBatch: (context, batchId, operations) => taskStore.applyBatch(context, batchId, operations),
    },
  });

  const handle = await engine.start(def, {
    input: opts.input,
    cwd,
    ...(opts.budget !== undefined ? { budget: opts.budget } : {}),
  });

  const output = await settle(engine, handle, opts.answers, opts.signals);

  const records: JournalRecord[] = [];
  for await (const rec of journalStore.read(handle.runId)) records.push(rec);
  return {
    output: output as Out,
    journal: buildJournalView(records),
    state: reduceState(records),
    runId: handle.runId,
    tasks: (await taskStore.snapshot(workflowId)) as WorkflowTaskSnapshot<TaskExtensions>,
  };
}

/**
 * Drive the run to a terminal state. Every suspension is either answered from the
 * fixtures or turned into a message that names what is missing — a test must never
 * hang waiting for a person.
 */
async function settle(
  engine: Engine,
  handle: RunHandle,
  answers: AnswerFixtures | undefined,
  signals: SignalFixtures | undefined,
): Promise<unknown> {
  for (;;) {
    const outcome = await handle.outcome();
    switch (outcome.status) {
      case "complete":
        return outcome.output;
      case "failed":
        throw outcome.error;
      case "cancelled":
        throw new Error(`runWorkflow: run ${handle.runId} was cancelled`);
      case "waiting_for_signal": {
        const state = await engine.state(handle.runId);
        const names = state.steps
          .filter((s) => s.kind === "signal" && s.status === "running")
          .map((s) => (s.label ?? "").replace(/^signal:/, ""))
          .filter((name) => name !== "");
        if (names.length === 0) {
          throw new Error(`runWorkflow: run ${handle.runId} is waiting for an unnamed signal`);
        }
        for (const name of names) {
          const payload = await resolveSignal(name, signals);
          if (!payload.found) {
            throw new Error(
              `runWorkflow: run ${handle.runId} is waiting for signal:${name} - provide it via opts.signals`,
            );
          }
          await engine.signal(handle.runId, name, payload.value);
        }
        break;
      }
      case "waiting_for_human": {
        if (outcome.pending.length === 0) {
          throw new Error(
            `runWorkflow: run ${handle.runId} is waiting for a human but no request is pending`,
          );
        }
        for (const req of outcome.pending) {
          const answer = await resolveAnswer(req, answers);
          if (answer === undefined) {
            throw new Error(
              `runWorkflow: unanswered human request: ${req.question} - provide it via opts.answers`,
            );
          }
          await engine.answer(handle.runId, req.id, answer);
        }
        break;
      }
    }
  }
}

async function resolveSignal(
  name: string,
  signals: SignalFixtures | undefined,
): Promise<{ found: boolean; value?: unknown }> {
  if (signals === undefined) return { found: false };
  if (typeof signals === "function") {
    const value = await signals(name);
    return value === undefined ? { found: false } : { found: true, value };
  }
  return Object.hasOwn(signals, name) ? { found: true, value: signals[name] } : { found: false };
}

async function resolveAnswer(req: PendingRequest, answers: AnswerFixtures | undefined): Promise<unknown> {
  if (answers === undefined) return undefined;
  if (typeof answers === "function") return answers(req);
  const byId = answers[req.id];
  if (byId !== undefined) return byId;
  return answers[req.question];
}
