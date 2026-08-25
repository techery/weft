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
import type { WorkflowDefinition } from "@techery/weft-sdk";
import { bundleWorkflow } from "./bundle.ts";
import { instantiateBundle } from "./load.ts";
import { GateError } from "./rules.ts";

/** Structurally the `WorkflowRegistry` @techery/weft-core's Engine takes (gate does not import core). */
export interface WorkflowRegistry {
  get(name: string): Promise<WorkflowDefinition | undefined>;
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

export interface RegistryLoadResult {
  def: WorkflowDefinition;
  /** Content hash of the bundle — the version a run pins. */
  hash: string;
  file: string;
}

export interface FileWorkflowRegistry extends WorkflowRegistry {
  /** Every loadable workflow in the directory, sorted by name. Missing directory → `[]`. */
  list(): Promise<WorkflowListEntry[]>;
  load(name: string): Promise<RegistryLoadResult>;
  hashOf(name: string): Promise<string | undefined>;
}

export interface RegistryOptions {
  dir: string;
  allowBare?: string[];
}

interface CacheEntry {
  file: string;
  hash: string;
  def: WorkflowDefinition;
  name: string;
  id: string;
  description: string;
}

/** Open a registry over `dir`. Nothing is read until the first call. */
export function createWorkflowRegistry(opts: RegistryOptions): FileWorkflowRegistry {
  const dir = path.resolve(opts.dir);
  const allowBare = opts.allowBare;
  const cache = new Map<string, CacheEntry>();

  const loadFile = async (file: string): Promise<CacheEntry> => {
    const { code, hash } = await bundleWorkflow({
      entry: file,
      cwd: dir,
      ...(allowBare ? { allowBare } : {}),
    });
    const cached = cache.get(file);
    if (cached?.hash === hash) return cached;

    const def = await instantiateBundle(code, {
      filename: file,
      ...(allowBare ? { allowBare } : {}),
    });
    const entry: CacheEntry = {
      file,
      hash,
      def,
      name: def.meta.name ?? path.basename(file, path.extname(file)),
      id: def.meta.id ?? def.meta.name ?? path.basename(file, path.extname(file)),
      description: def.meta.description,
    };
    cache.set(file, entry);
    return entry;
  };

  const candidates = async (): Promise<string[]> => {
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
    return names
      .filter((n) => n.endsWith(".ts") && !n.endsWith(".d.ts"))
      .sort()
      .map((n) => path.join(dir, n));
  };

  const find = async (name: string): Promise<CacheEntry | undefined> => {
    // Fast path: the file named after the workflow, when it does not rename itself. A
    // broken file here is the one the caller asked for, so its error propagates — but a
    // file that simply is not a workflow (a `schemas.ts` next door) just does not match.
    const direct = path.join(dir, `${name}.ts`);
    const matches: CacheEntry[] = [];
    if (await isFile(direct)) {
      const entry = await loadFile(direct).catch((err: unknown) => {
        if (isNotAWorkflow(err)) return undefined;
        throw err;
      });
      if (entry?.name === name) matches.push(entry);
    }
    for (const file of await candidates()) {
      if (file === direct) continue;
      const entry = await tolerantLoad(loadFile, file);
      if (entry?.name === name) matches.push(entry);
    }
    assertUnique(matches, "name", name);
    return matches[0];
  };

  return {
    async list(): Promise<WorkflowListEntry[]> {
      const entries: WorkflowListEntry[] = [];
      for (const file of await candidates()) {
        const entry = await tolerantLoad(loadFile, file);
        if (entry)
          entries.push({ id: entry.id, name: entry.name, file: entry.file, description: entry.description });
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
      return entries.sort((a, b) => a.name.localeCompare(b.name));
    },

    async load(name: string): Promise<RegistryLoadResult> {
      const entry = await find(name);
      if (!entry) throw new GateError(`workflow "${name}" not found in ${dir}`);
      return { def: entry.def, hash: entry.hash, file: entry.file };
    },

    async get(name: string): Promise<WorkflowDefinition | undefined> {
      const entry = await find(name);
      return entry?.def;
    },

    async hashOf(name: string): Promise<string | undefined> {
      // Same cached fold `get` just did, so the pair names one version of one file.
      const entry = await find(name);
      return entry?.hash;
    },
  };
}

function assertUnique(entries: CacheEntry[], field: "name", value: string): void {
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
