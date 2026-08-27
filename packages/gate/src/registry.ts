/**
 * The workflow registry: a directory of `*.ts` files (`.weft/workflows/` in a repo), each
 * callable by name. The name is the basename — `review.ts` is `review` — unless the file
 * declares `meta.name`, which wins so an inline-authored workflow keeps its identity when
 * it lands on disk.
 *
 * Loading is cached by content hash, and the content hash is the *bundle's*: bundling is
 * milliseconds and covers every relative import, so editing `./schemas.ts` invalidates the
 * cached definition of every workflow that pulls it in — which re-parsing only the entry
 * file would miss.
 *
 * The directory is shared with helper modules (`schemas.ts`, `lib/`), so a file that does
 * not export a workflow is simply not a workflow: `list()` skips whatever fails to load
 * rather than making one bad neighbour take down the listing.
 */
import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import type { CompiledUiCatalog, WorkflowDefinition } from "@techery/weft-sdk";
import { bundleWorkflow } from "./bundle.ts";
import { instantiateBundle } from "./load.ts";
import { type GateDiagnostic, GateError } from "./rules.ts";

/** Structurally the `WorkflowRegistry` @techery/weft-core's Engine takes (gate does not import core). */
export interface WorkflowRegistry {
  get(name: string): Promise<WorkflowDefinition | undefined>;
  resolve?(identity: {
    id?: string;
    name: string;
  }): Promise<
    { def: WorkflowDefinition; name: string; hash?: string; uiCatalog?: CompiledUiCatalog } | undefined
  >;
  /** Bundle content hash of what `get(name)` returns; the engine's resume compares it. */
  hashOf?(name: string): Promise<string | undefined>;
}

export interface WorkflowListEntry {
  /** Stable durable-state identity; defaults to `name` for older definitions. */
  id: string;
  name: string;
  /** Absolute path to the workflow file. */
  file: string;
  description: string;
}

export interface WorkflowLoadIssue {
  /** Absolute path to the workflow file that could not be loaded. */
  file: string;
  /** The gate, bundle, or loader error suitable for a human-readable summary. */
  error: string;
  /** Position-aware details when the gate or bundler provided them. */
  diagnostics: GateDiagnostic[];
}

export interface WorkflowInspection {
  entries: WorkflowListEntry[];
  issues: WorkflowLoadIssue[];
}

export interface RegistryLoadResult {
  def: WorkflowDefinition;
  /** Callable registry name after filename/default resolution. */
  name: string;
  /** Content hash of the bundle — the version a run pins. */
  hash: string;
  buildHash: string;
  uiCatalog: CompiledUiCatalog;
  file: string;
}

export interface FileWorkflowRegistry extends WorkflowRegistry {
  /** Every loadable workflow in the directory, sorted by name. Missing directory → `[]`. */
  list(): Promise<WorkflowListEntry[]>;
  /** Every loadable workflow plus files rejected by the gate, sorted by path. */
  listWithIssues(): Promise<WorkflowInspection>;
  load(name: string): Promise<RegistryLoadResult>;
  /** Load by callable name or durable ID, rejecting cross-namespace ambiguity. */
  loadIdentity(identity: string): Promise<RegistryLoadResult>;
  /** Resolve durable run identity; an explicit ID never falls back to a callable name. */
  resolve(identity: {
    id?: string;
    name: string;
  }): Promise<
    { def: WorkflowDefinition; name: string; hash?: string; uiCatalog?: CompiledUiCatalog } | undefined
  >;
  hashOf(name: string): Promise<string | undefined>;
}

export interface RegistryOptions {
  dir: string;
  /** Additional workflow directories, searched alongside `dir` in the given order. */
  extraDirs?: readonly string[];
  allowBare?: string[];
}

interface CacheEntry {
  file: string;
  hash: string;
  buildHash: string;
  uiCatalog: CompiledUiCatalog;
  def: WorkflowDefinition;
  name: string;
  id: string;
  description: string;
}

/** Open a registry over `dir`. Nothing is read until the first call. */
export function createWorkflowRegistry(opts: RegistryOptions): FileWorkflowRegistry {
  const primaryDir = path.resolve(opts.dir);
  const dirs = [...new Set([primaryDir, ...(opts.extraDirs ?? []).map((dir) => path.resolve(dir))])];
  const allowBare = opts.allowBare;
  const cache = new Map<string, CacheEntry>();

  const loadFile = async (file: string): Promise<CacheEntry> => {
    const { code, hash, buildHash, uiCatalog } = await bundleWorkflow({
      entry: file,
      cwd: path.dirname(file),
      ...(allowBare ? { allowBare } : {}),
    });
    const cached = cache.get(file);
    if (cached?.hash === hash && cached.buildHash === buildHash) return cached;

    const def = await instantiateBundle(code, {
      filename: file,
      ...(allowBare ? { allowBare } : {}),
    });
    const entry: CacheEntry = {
      file,
      hash,
      buildHash,
      uiCatalog,
      def,
      name: def.meta.name ?? path.basename(file, path.extname(file)),
      id: def.meta.id ?? def.meta.name ?? path.basename(file, path.extname(file)),
      description: def.meta.description,
    };
    cache.set(file, entry);
    return entry;
  };

  const candidatesIn = async (dir: string): Promise<string[]> => {
    let names: string[];
    try {
      names = await readdir(dir);
    } catch (err) {
      // Only ABSENCE means an empty registry: no .weft/workflows yet (ENOENT),
      // or a path component that is a file (ENOTDIR). Any other failure —
      // EACCES, ELOOP, EIO — is a directory that EXISTS but cannot be read,
      // and reporting it as "no workflows" would silently hide every workflow.
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ENOTDIR") return [];
      throw new GateError(`cannot read workflow directory ${dir}: ${(err as Error).message}`, [], {
        cause: err,
      });
    }
    const candidates = names.filter((n) => n.endsWith(".ts") && !n.endsWith(".d.ts")).sort();
    // An extra directory with `workflow.ts` is a workflow package: sibling TypeScript
    // files are its entry point and helpers, not additional registry definitions. The
    // primary `.weft/workflows` directory keeps the many-files registry convention, and
    // an extra directory without `workflow.ts` does too.
    const selected = dir !== primaryDir && candidates.includes("workflow.ts") ? ["workflow.ts"] : candidates;
    return selected.map((n) => path.join(dir, n));
  };

  const candidates = async (): Promise<string[]> => {
    const files = await Promise.all(dirs.map((dir) => candidatesIn(dir)));
    return files.flat();
  };

  const find = async (name: string): Promise<CacheEntry | undefined> => {
    // Fast path: the file named after the workflow, when it does not rename itself. A
    // broken file here is the one the caller asked for, so its error propagates — but a
    // file that simply is not a workflow (a `schemas.ts` next door) just does not match.
    const entries: CacheEntry[] = [];
    const matches: CacheEntry[] = [];
    const candidateFiles = await candidates();
    const directFiles = candidateFiles.filter((file) => path.basename(file) === `${name}.ts`);
    for (const direct of directFiles) {
      if (await isFile(direct)) {
        const entry = await loadFile(direct).catch((err: unknown) => {
          if (isNotAWorkflow(err)) return undefined;
          throw err;
        });
        if (entry) {
          entries.push(entry);
          if (entry.name === name) matches.push(entry);
        }
      }
    }
    for (const file of candidateFiles) {
      if (directFiles.includes(file)) continue;
      const entry = await tolerantLoad(loadFile, file);
      if (entry) {
        entries.push(entry);
        if (entry.name === name) matches.push(entry);
      }
    }
    assertUnique(matches, "name", name);
    const match = matches[0];
    if (match)
      assertUnique(
        entries.filter((entry) => entry.id === match.id),
        "id",
        match.id,
      );
    return match;
  };

  const findById = async (id: string): Promise<CacheEntry | undefined> => {
    const matches: CacheEntry[] = [];
    for (const file of await candidates()) {
      const entry = await tolerantLoad(loadFile, file);
      if (entry?.id === id) matches.push(entry);
    }
    assertUnique(matches, "id", id);
    return matches[0];
  };

  const resultOf = (entry: CacheEntry): RegistryLoadResult => ({
    def: entry.def,
    name: entry.name,
    hash: entry.hash,
    buildHash: entry.buildHash,
    uiCatalog: entry.uiCatalog,
    file: entry.file,
  });

  return {
    async list(): Promise<WorkflowListEntry[]> {
      const inspection = await this.listWithIssues();
      return inspection.entries;
    },

    async listWithIssues(): Promise<WorkflowInspection> {
      const entries: WorkflowListEntry[] = [];
      const issues: WorkflowLoadIssue[] = [];
      for (const file of await candidates()) {
        try {
          const entry = await loadFile(file);
          entries.push({ id: entry.id, name: entry.name, file: entry.file, description: entry.description });
        } catch (err) {
          if (!isNotAWorkflow(err)) {
            issues.push({
              file,
              error: err instanceof Error ? err.message : String(err),
              diagnostics: err instanceof GateError ? err.diagnostics : [],
            });
          }
        }
      }
      const ids = new Map<string, string>();
      const names = new Map<string, string>();
      for (const entry of entries) {
        const prior = ids.get(entry.id);
        if (prior) {
          throw new GateError(
            `duplicate workflow id ${JSON.stringify(entry.id)} in ${prior} and ${entry.file}`,
          );
        }
        ids.set(entry.id, entry.file);
        const named = names.get(entry.name);
        if (named) {
          throw new GateError(
            `duplicate workflow name ${JSON.stringify(entry.name)} in ${named} and ${entry.file}`,
          );
        }
        names.set(entry.name, entry.file);
      }
      return {
        entries: entries.sort((a, b) => a.name.localeCompare(b.name)),
        issues: issues.sort((a, b) => a.file.localeCompare(b.file)),
      };
    },

    async load(name: string): Promise<RegistryLoadResult> {
      const entry = await find(name);
      if (!entry) throw new GateError(`workflow "${name}" not found in ${dirs.join(", ")}`);
      return resultOf(entry);
    },

    async loadIdentity(identity: string): Promise<RegistryLoadResult> {
      const [named, identified] = await Promise.all([find(identity), findById(identity)]);
      if (named && identified && named.file !== identified.file) {
        throw new GateError(
          `workflow identity ${JSON.stringify(identity)} is ambiguous: it is the name of ${named.file} and the id of ${identified.file}`,
        );
      }
      const entry = named ?? identified;
      if (!entry) throw new GateError(`workflow "${identity}" not found in ${dirs.join(", ")}`);
      return resultOf(entry);
    },

    async get(name: string): Promise<WorkflowDefinition | undefined> {
      const entry = await find(name);
      return entry?.def;
    },

    async resolve(
      identity,
    ): Promise<
      { def: WorkflowDefinition; name: string; hash: string; uiCatalog: CompiledUiCatalog } | undefined
    > {
      const entry = identity.id === undefined ? await find(identity.name) : await findById(identity.id);
      if (!entry) return undefined;
      return { def: entry.def, name: entry.name, hash: entry.hash, uiCatalog: entry.uiCatalog };
    },

    async hashOf(name: string): Promise<string | undefined> {
      // Same cached fold `get` just did, so the pair names one version of one file.
      const entry = await find(name);
      return entry?.hash;
    },
  };
}

function assertUnique(entries: CacheEntry[], field: "name" | "id", value: string): void {
  if (entries.length < 2) return;
  throw new GateError(
    `duplicate workflow ${field} ${JSON.stringify(value)} in ${entries.map((entry) => entry.file).join(" and ")}`,
  );
}

async function isFile(file: string): Promise<boolean> {
  try {
    return (await stat(file)).isFile();
  } catch {
    return false;
  }
}

/** "This file exports no workflow" is a miss, not a breakage: helper modules share the directory. */
function isNotAWorkflow(err: unknown): boolean {
  return (
    err instanceof GateError &&
    err.diagnostics.length > 0 &&
    err.diagnostics.every((d) => d.rule === "no-workflow-export")
  );
}

/** Helper modules living beside the workflows are not failures; they are just not workflows. */
async function tolerantLoad(
  loadFile: (file: string) => Promise<CacheEntry>,
  file: string,
): Promise<CacheEntry | undefined> {
  try {
    return await loadFile(file);
  } catch {
    return undefined;
  }
}
