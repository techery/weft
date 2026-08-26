/**
 * `createWeft()` — the assembly layer. The CLI, the MCP server, and the daemon differ in
 * how they talk to a person, not in how they build an engine, so the stores, the workflow
 * registry, the provider wiring, and the derived run index are assembled once here and
 * every host stays a shell over `weft.engine` (C10).
 *
 * ```ts
 * const weft = await createWeft({ cwd: process.cwd() });
 * const { def, hash } = await resolveWorkflow(weft, "review");
 * const run = await weft.engine.start(def, { input, cwd: weft.cwd, defHash: hash });
 * ```
 */
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve, sep } from "node:path";
import { Engine, ProviderRegistry, type ResumeOptions } from "@techery/weft-core";
import {
  createWorkflowRegistry,
  DEFAULT_ALLOW_BARE,
  type FileWorkflowRegistry,
  GateError,
  instantiateBundle,
  loadWorkflow,
} from "@techery/weft-gate";
import type { RunIndex } from "@techery/weft-index-sqlite";
import { type MockAgentBuilder, mock } from "@techery/weft-provider-mock";
import type { WorkflowDefinition } from "@techery/weft-sdk";
import { createFsStores } from "@techery/weft-store-fs";
import * as z from "zod";
import { loadConfig, WEFT_DIR, type WeftConfig } from "./config.ts";
import { TaskStore } from "./tasks.ts";

/** Derived, rebuildable, and safe to delete — never a source of truth. */
export const INDEX_FILE = "index.sqlite";

/** Provider ids the mock builder answers for in mock mode, so routing defaults still resolve. */
const MOCK_IDS = ["claude", "codex", "mock"] as const;

export interface Weft {
  engine: Engine;
  registry: FileWorkflowRegistry;
  config: WeftConfig;
  /** The repo root: what runs execute in, and what relative config paths resolve against. */
  cwd: string;
  /** `<cwd>/.weft` — stores, workflows, and the derived index live under it. */
  weftDir: string;
  runsDir: string;
  /** Workflow-scoped durable context used by the task CLI and workflow manager. */
  tasks: TaskStore;
  /**
   * The scripted builder behind the `mock` provider. In mock mode it also answers as
   * `claude` and `codex`, so a workflow's normal routing lands on fixtures.
   */
  mockBuilder?: MockAgentBuilder;
  /** Open (once) and rebuild the local run index from the journal store. */
  reindex(): Promise<RunIndex>;
  /**
   * Detach from held runs (releasing their ownership claims so another process can
   * take them immediately) and release the run index. Call before process exit — a
   * claim left behind blocks resumes elsewhere until it expires.
   */
  close(): Promise<void>;
}

export interface CreateWeftOptions {
  cwd: string;
  /** Skips {@link loadConfig} when given — hosts that already parsed flags pass the merge. */
  config?: WeftConfig;
  /** `"real"` (default) wires the Claude and Codex adapters; `"mock"` wires fixtures only. */
  providers?: "real" | "mock";
}

/**
 * Config allowBare entries EXTEND the default bare imports (@techery/weft-sdk, zod) —
 * they never replace them: enabling lodash must not make every Zod-based
 * workflow fail to load. EVERY loader entry point (registry, inline source,
 * path refs — host, CLI, and MCP alike) must resolve the list through here.
 */
export function mergedAllowBare(config: WeftConfig): string[] | undefined {
  const extra = config.workflows?.allowBare;
  if (!extra || extra.length === 0) return undefined;
  return [...new Set([...DEFAULT_ALLOW_BARE, ...extra])];
}

export async function createWeft(opts: CreateWeftOptions): Promise<Weft> {
  const cwd = resolve(opts.cwd);
  const config = opts.config ?? (await loadConfig(cwd));
  const weftDir = join(cwd, WEFT_DIR);
  const stores = createFsStores(weftDir);

  const allowBare = mergedAllowBare(config);
  const registry = createWorkflowRegistry({
    dir: workflowsDir(cwd, weftDir, config),
    ...(allowBare ? { allowBare } : {}),
  });

  const providers = new ProviderRegistry();
  const mockBuilder = mock();
  if (opts.providers === "mock") {
    for (const id of MOCK_IDS) providers.register(mockBuilder.provider(id));
  } else {
    // Imported here, not at module load: a host that only lists runs should not pay for
    // two vendor SDKs. Both constructors are pure — no credential lookup, no process, no
    // socket — so a checkout without credentials still builds a working engine and fails
    // (if at all) at the first agent step, with that step's error.
    const [claude, codex] = await Promise.all([
      import("@techery/weft-provider-claude"),
      import("@techery/weft-provider-codex"),
    ]);
    providers.register(claude.createClaudeProvider());
    providers.register(codex.createCodexProvider());
    providers.register(mockBuilder.provider("mock"));
  }

  const taskDefinition = async (workflowId: string): Promise<WorkflowDefinition | undefined> => {
    // A malformed workflow must not degrade into "no task schema": that would let an
    // extension write bypass the declaration precisely when the declaration fails to load.
    const direct = await registry.get(workflowId);
    if (direct && (direct.meta.id ?? direct.meta.name ?? workflowId) === workflowId) return direct;
    for (const entry of await registry.list()) {
      const candidate = await registry.get(entry.name);
      if (candidate?.meta.id === workflowId) return candidate;
    }
    return undefined;
  };
  const taskRoot = join(weftDir, "tasks");
  const tasks = new TaskStore(taskRoot, async (workflowId) =>
    taskDefinition(workflowId).then((def) => def?.meta.tasks?.extensions),
  );
  const engine = new Engine({
    journal: stores.journal,
    blobs: stores.blobs,
    providers,
    config,
    // The registry is what lets resume and ctx.workflow("name", …) find a definition by
    // name, in a process that never saw the file.
    registry,
    taskTracker: {
      protectedPaths: [taskRoot],
      prepare: async (workflow, extensionSchema, taskOptions) => {
        let jsonSchema: unknown | null = null;
        if (extensionSchema) {
          try {
            jsonSchema = z.toJSONSchema(extensionSchema as z.ZodType, {
              io: "input",
              unrepresentable: "any",
            });
          } catch {
            jsonSchema = null;
          }
        }
        return tasks.registerWorkflow(workflow, extensionSchema, jsonSchema, taskOptions);
      },
      snapshot: (context) => tasks.snapshot(context.workflowId, context.selector, context.schemaBinding),
      // prepare() persisted this representation from the exact definition the
      // engine is executing, including path/stdin workflows the registry cannot find.
      schema: (context) => tasks.schema(context.workflowId, context.schemaBinding),
      validateBatch: (context, operations) => tasks.validateBatch(context, operations),
      applyBatch: (context, batchId, operations) => tasks.applyBatch(context, batchId, operations),
    },
  });

  let index: Promise<RunIndex> | undefined;
  const openIndex = (): Promise<RunIndex> => {
    index ??= import("@techery/weft-index-sqlite").then(
      ({ RunIndex }) => new RunIndex({ dbPath: join(weftDir, INDEX_FILE) }),
    );
    return index;
  };

  return {
    engine,
    registry,
    config,
    cwd,
    weftDir,
    runsDir: stores.runsDir,
    tasks,
    mockBuilder,
    async reindex(): Promise<RunIndex> {
      const idx = await openIndex();
      await idx.rebuild(stores.journal);
      return idx;
    },
    async close(): Promise<void> {
      // Detach from held runs first: the process is going away, and a stale
      // ownership claim would block `weft answer && weft resume` for its TTL.
      await engine.shutdown();
      const pending = index;
      index = undefined;
      if (pending) (await pending).close();
    },
  };
}

/**
 * Reserve a fresh run id by CREATING its run directory exclusively. Provenance
 * (script.ts / workflow.json) is written into that directory BEFORE the engine
 * journals anything — without the exclusive create, a random-id collision with
 * an existing run would overwrite THAT run's persisted definition, and the old
 * run would later resume with the new workflow.
 */
export async function reserveRunId(weft: Weft): Promise<string> {
  await mkdir(weft.runsDir, { recursive: true });
  for (let attempt = 0; attempt < 16; attempt++) {
    const runId = randomUUID().slice(0, 8);
    try {
      await mkdir(join(weft.runsDir, runId));
      return runId;
    } catch (err) {
      // Only a collision retries; a broken filesystem surfaces.
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }
  }
  throw new Error("could not reserve a run id after 16 collisions");
}

/**
 * Persist an inline workflow's bundled script alongside its run. Inline source
 * (stdin, MCP `source`) has no file the registry could find again — without this,
 * a suspended inline run is unresumable from any later process.
 */
export async function persistInlineScript(weft: Weft, runId: string, code: string): Promise<void> {
  const dir = join(weft.runsDir, runId);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "script.ts"), code, "utf8");
}

/** True when a workflow ref is a file path rather than a registry name. */
export function isWorkflowPathRef(ref: string): boolean {
  return looksLikePath(ref);
}

/**
 * Record the path a run's workflow was started from. Registry names need nothing (the
 * journaled name finds them again) and inline source persists its bundled script, but
 * an arbitrary path like `./flows/review.ts` is recoverable only if it rides along —
 * a later resume re-resolves it from disk, so file edits land the way they do for
 * registry workflows.
 */
export async function persistWorkflowRef(weft: Weft, runId: string, ref: string): Promise<void> {
  const dir = join(weft.runsDir, runId);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "workflow.json"), JSON.stringify({ ref }), "utf8");
}

/**
 * The definition persisted with a run, and the bundle hash of the version just loaded:
 * a recorded path ref re-resolved from disk, or an inline run's bundled script.
 * Undefined for registry runs — the engine's registry lookup by the journaled name
 * covers those.
 *
 * The hash is what lets `engine.resume` notice an edit inside a module the workflow body
 * merely delegates to: `def.run.toString()` is identical across such an edit, and step
 * positions would go on being trusted after the call sites underneath them moved.
 */
export async function persistedDefOf(weft: Weft, runId: string): Promise<PersistedDef | undefined> {
  let raw: string;
  try {
    raw = await readFile(join(weft.runsDir, runId, "workflow.json"), "utf8");
  } catch (err) {
    // Only ABSENCE falls through (a registry or inline run). Any other failure
    // must surface: swallowed, resume() would fall back to a registry lookup by
    // the journaled NAME — and a different workflow wearing that name would
    // silently run in this run's place.
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ENOENT" && code !== "ENOTDIR") throw err;
    const def = await inlineDefOf(weft, runId);
    // An inline run's script is journaled with it, so it cannot have changed and there
    // is nothing for a hash to catch.
    return def === undefined ? undefined : { def };
  }
  const parsed = JSON.parse(raw) as { ref?: unknown };
  if (typeof parsed.ref !== "string") {
    throw new Error(`run ${runId}: workflow.json carries no usable ref`);
  }
  // A moved file or a failed gate throws here — the caller must see WHY the
  // recorded definition is unavailable, never a quiet fallback.
  const resolved = await resolveWorkflow(weft, parsed.ref);
  return { def: resolved.def, ...(resolved.hash !== undefined ? { hash: resolved.hash } : {}) };
}

/** A run's recorded definition, with the bundle hash where the ref could produce one. */
export interface PersistedDef {
  def: WorkflowDefinition;
  hash?: string;
}

/**
 * `persistedDefOf`'s answer as `engine.resume` options.
 *
 * The hash travels with the definition or the version check quietly weakens: without it
 * the engine compares only `def.run.toString()`, which is blind to an edit inside a
 * module the body delegates to, and a resume then goes on trusting step positions after
 * the call sites underneath them moved. Every host resumes through here so that pairing
 * is not something three call sites have to remember.
 */
export function resumeOptions(persisted: PersistedDef | undefined): ResumeOptions {
  if (persisted === undefined) return {};
  return {
    def: persisted.def,
    ...(persisted.hash !== undefined ? { defHash: persisted.hash } : {}),
  };
}

/**
 * The definition persisted with an inline run, or undefined when the run came from
 * the registry (resume then falls back to the name the run journaled).
 */
export async function inlineDefOf(weft: Weft, runId: string): Promise<WorkflowDefinition | undefined> {
  const file = join(weft.runsDir, runId, "script.ts");
  let code: string;
  try {
    code = await readFile(file, "utf8");
  } catch (err) {
    // Same contract as workflow.json above: absence means "not an inline run";
    // anything else is a real failure the caller must see.
    const code_ = (err as NodeJS.ErrnoException).code;
    if (code_ !== "ENOENT" && code_ !== "ENOTDIR") throw err;
    return undefined;
  }
  const allowBare = mergedAllowBare(weft.config);
  return instantiateBundle(code, { filename: file, ...(allowBare ? { allowBare } : {}) });
}

/** `.weft/workflows` unless the config points elsewhere; relative paths are repo-relative. */
function workflowsDir(cwd: string, weftDir: string, config: WeftConfig): string {
  const dir = config.workflows?.dir;
  return dir ? resolve(cwd, dir) : join(weftDir, "workflows");
}

// ---------------------------------------------------------------------------
// Refs
// ---------------------------------------------------------------------------

export interface ResolvedWorkflow {
  def: WorkflowDefinition;
  name: string;
  /** Bundle content hash — the version a run pins (`defHash` on `engine.start`). */
  hash?: string;
}

/**
 * Turn what a person typed into a definition: a registry name (`review`) or a path to a
 * `.ts` file (`./flows/review.ts`). Names win, because that is what a run journals and
 * what a resume in another process can find again.
 */
export async function resolveWorkflow(weft: Weft, ref: string): Promise<ResolvedWorkflow> {
  if (ref.trim() === "") {
    throw new Error("workflow ref is empty — pass a registry name or a path to a .ts file");
  }

  if (!looksLikePath(ref)) {
    const hit = await weft.registry.load(ref).catch((err: unknown) => {
      // A file that exists but does not build is the caller's actual problem; only a
      // plain miss falls through to the path branch.
      if (isRegistryMiss(err)) return undefined;
      throw err;
    });
    if (hit) {
      const name = hit.def.meta.name ?? ref;
      return { def: named(hit.def, name), name, hash: hit.hash };
    }
    throw await unknownRef(weft, ref);
  }

  const file = isAbsolute(ref) ? ref : resolve(weft.cwd, ref);
  if (!existsSync(file)) throw await unknownRef(weft, ref, file);
  const allowBare = mergedAllowBare(weft.config);
  const loaded = await loadWorkflow({ entry: file, ...(allowBare ? { allowBare } : {}) });
  return { def: named(loaded.def, loaded.name), name: loaded.name, hash: loaded.hash };
}

/**
 * A run journals `def.meta.name`, and a resume (or `ctx.workflow("name", …)`) looks that
 * name up in the registry. A file that does not name itself is named by the ref that
 * found it — otherwise it journals as the engine's fallback `"workflow"` and no later
 * process can find its definition again.
 */
function named(def: WorkflowDefinition, name: string): WorkflowDefinition {
  if (def.meta.name === name) return def;
  return Object.freeze({
    kind: def.kind,
    meta: Object.freeze({ ...def.meta, name }),
    run: def.run,
  });
}

/** A ref that could only be a file: it has a separator, a `.ts` extension, or both. */
function looksLikePath(ref: string): boolean {
  return ref.includes("/") || ref.includes(sep) || ref.endsWith(".ts");
}

/** The registry reports a plain miss as a GateError carrying no diagnostics. */
function isRegistryMiss(err: unknown): boolean {
  return err instanceof GateError && err.diagnostics.length === 0 && err.message.includes("not found in");
}

async function unknownRef(weft: Weft, ref: string, file?: string): Promise<Error> {
  const names = await weft.registry
    .list()
    .then((entries) => entries.map((e) => e.name))
    .catch(() => []);
  const known = names.length > 0 ? names.join(", ") : "none";
  const where = file ? ` (no file at ${file})` : "";
  return new Error(
    `unknown workflow "${ref}"${where} — pass a registry name (available: ${known}) or a path to a .ts file`,
  );
}
