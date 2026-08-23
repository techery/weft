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
import { existsSync } from "node:fs";
import { isAbsolute, join, resolve, sep } from "node:path";
import { Engine, ProviderRegistry } from "@weft/core";
import { createWorkflowRegistry, type FileWorkflowRegistry, GateError, loadWorkflow } from "@weft/gate";
import type { RunIndex } from "@weft/index-sqlite";
import { type MockAgentBuilder, mock } from "@weft/provider-mock";
import type { WorkflowDefinition } from "@weft/sdk";
import { createFsStores } from "@weft/store-fs";
import { loadConfig, WEFT_DIR, type WeftConfig } from "./config.ts";

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
  /**
   * The scripted builder behind the `mock` provider. In mock mode it also answers as
   * `claude` and `codex`, so a workflow's normal routing lands on fixtures.
   */
  mockBuilder?: MockAgentBuilder;
  /** Open (once) and rebuild the local run index from the journal store. */
  reindex(): Promise<RunIndex>;
  /** Release the run index if one was opened. Optional: process exit does the same. */
  close(): Promise<void>;
}

export interface CreateWeftOptions {
  cwd: string;
  /** Skips {@link loadConfig} when given — hosts that already parsed flags pass the merge. */
  config?: WeftConfig;
  /** `"real"` (default) wires the Claude and Codex adapters; `"mock"` wires fixtures only. */
  providers?: "real" | "mock";
}

export async function createWeft(opts: CreateWeftOptions): Promise<Weft> {
  const cwd = resolve(opts.cwd);
  const config = opts.config ?? (await loadConfig(cwd));
  const weftDir = join(cwd, WEFT_DIR);
  const stores = createFsStores(weftDir);

  const allowBare = config.workflows?.allowBare;
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
      import("@weft/provider-claude"),
      import("@weft/provider-codex"),
    ]);
    providers.register(claude.createClaudeProvider());
    providers.register(codex.createCodexProvider());
    providers.register(mockBuilder.provider("mock"));
  }

  const engine = new Engine({
    journal: stores.journal,
    blobs: stores.blobs,
    providers,
    config,
    // The registry is what lets resume and ctx.workflow("name", …) find a definition by
    // name, in a process that never saw the file.
    registry,
  });

  let index: Promise<RunIndex> | undefined;
  const openIndex = (): Promise<RunIndex> => {
    index ??= import("@weft/index-sqlite").then(
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
    mockBuilder,
    async reindex(): Promise<RunIndex> {
      const idx = await openIndex();
      await idx.rebuild(stores.journal);
      return idx;
    },
    async close(): Promise<void> {
      const pending = index;
      index = undefined;
      if (pending) (await pending).close();
    },
  };
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
  const allowBare = weft.config.workflows?.allowBare;
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
