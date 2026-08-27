/**
 * The workflow registry: a directory of workflow packages (`.weft/workflows/` in a repo).
 * Every package is named for its workflow and contains `main.ts`, `lib/`, `tests/`, and
 * `CHANGELOG.md`. The package directory is the callable name unless `meta.name` repeats it.
 *
 * Loading is cached by content hash, and the content hash is the *bundle's*: bundling is
 * milliseconds and covers every relative import, so editing `./schemas.ts` invalidates the
 * cached definition of every workflow that pulls it in — which re-parsing only the entry
 * file would miss.
 *
 * Helpers live under each package's `lib/` directory and tests under `tests/`, so discovery
 * has one unambiguous entry point and never mistakes supporting TypeScript for a workflow.
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
  /** Absolute path to the workflow package's `main.ts`. */
  file: string;
  description: string;
}

export interface WorkflowLoadIssue {
  /** Absolute path to the workflow package or entry point that could not be loaded. */
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
  /** Callable registry name after package/default resolution. */
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

interface WorkflowPackage {
  /** Directory name and therefore callable workflow name. */
  name: string;
  /** Absolute package directory. */
  dir: string;
  /** Absolute `main.ts` entry point. */
  file: string;
}

const PACKAGE_ENTRY = "main.ts";
const PACKAGE_CHANGELOG = "CHANGELOG.md";
const PACKAGE_DIRECTORIES = ["lib", "tests"] as const;

/** Open a registry over `dir`. Nothing is read until the first call. */
export function createWorkflowRegistry(opts: RegistryOptions): FileWorkflowRegistry {
  const primaryDir = path.resolve(opts.dir);
  const dirs = [...new Set([primaryDir, ...(opts.extraDirs ?? []).map((dir) => path.resolve(dir))])];
  const allowBare = opts.allowBare;
  const cache = new Map<string, CacheEntry>();

  const loadFile = async (workflowPackage: WorkflowPackage): Promise<CacheEntry> => {
    const { file } = workflowPackage;
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
    const name = def.meta.name ?? workflowPackage.name;
    if (name !== workflowPackage.name) {
      throw new GateError(
        `workflow package ${workflowPackage.dir} must be named ${JSON.stringify(name)} to match meta.name`,
      );
    }
    const entry: CacheEntry = {
      file,
      hash,
      buildHash,
      uiCatalog,
      def,
      name,
      id: def.meta.id ?? name,
      description: def.meta.description,
    };
    cache.set(file, entry);
    return entry;
  };

  const readDirectory = async (dir: string) => {
    try {
      return await readdir(dir, { withFileTypes: true });
    } catch (err) {
      // Only ABSENCE means an empty registry: no .weft/workflows yet (ENOENT).
      // ENOTDIR, EACCES, ELOOP, and EIO mean the configured registry cannot be read,
      // and reporting it as "no workflows" would silently hide every workflow.
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return [];
      throw new GateError(`cannot read workflow directory ${dir}: ${(err as Error).message}`, [], {
        cause: err,
      });
    }
  };

  const inspectPackage = async (
    packageDir: string,
  ): Promise<{ workflowPackage?: WorkflowPackage; issue?: WorkflowLoadIssue }> => {
    const name = path.basename(packageDir);
    const missing: string[] = [];
    if (!(await isFile(path.join(packageDir, PACKAGE_ENTRY)))) missing.push(PACKAGE_ENTRY);
    for (const child of PACKAGE_DIRECTORIES) {
      if (!(await isDirectory(path.join(packageDir, child)))) missing.push(`${child}/`);
    }
    if (!(await isFile(path.join(packageDir, PACKAGE_CHANGELOG)))) missing.push(PACKAGE_CHANGELOG);
    if (missing.length > 0) {
      return {
        issue: {
          file: packageDir,
          error: `invalid workflow package ${JSON.stringify(name)}: missing ${missing.join(", ")}`,
          diagnostics: [],
        },
      };
    }
    return {
      workflowPackage: { name, dir: packageDir, file: path.join(packageDir, PACKAGE_ENTRY) },
    };
  };

  const inspectRoot = async (
    dir: string,
  ): Promise<{ packages: WorkflowPackage[]; issues: WorkflowLoadIssue[] }> => {
    const entries = await readDirectory(dir);
    const packages: WorkflowPackage[] = [];
    const issues: WorkflowLoadIssue[] = [];
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name.startsWith(".")) continue;
      const target = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        const inspected = await inspectPackage(target);
        if (inspected.workflowPackage) packages.push(inspected.workflowPackage);
        if (inspected.issue) issues.push(inspected.issue);
      } else if (entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts")) {
        const name = path.basename(entry.name, ".ts");
        issues.push({
          file: target,
          error: `flat workflow files are not supported: move it to ${path.join(dir, name, PACKAGE_ENTRY)} and add lib/, tests/, and CHANGELOG.md`,
          diagnostics: [],
        });
      }
    }
    return { packages, issues };
  };

  const inspectAll = async (): Promise<{
    packages: WorkflowPackage[];
    issues: WorkflowLoadIssue[];
  }> => {
    const inspections = [];
    for (const [index, dir] of dirs.entries()) {
      // The primary path is always a registry root. An extra path may be either a
      // registry root or one complete workflow package, which keeps
      // `--extra-workflow-dir path/to/my-workflow` ergonomic.
      const directPackage = index > 0 && (await isFile(path.join(dir, PACKAGE_ENTRY)));
      if (directPackage) {
        const inspected = await inspectPackage(dir);
        inspections.push({
          packages: inspected.workflowPackage ? [inspected.workflowPackage] : [],
          issues: inspected.issue ? [inspected.issue] : [],
        });
      } else {
        inspections.push(await inspectRoot(dir));
      }
    }
    return {
      packages: inspections.flatMap((inspection) => inspection.packages),
      issues: inspections.flatMap((inspection) => inspection.issues),
    };
  };

  const find = async (name: string): Promise<CacheEntry | undefined> => {
    // Fast path: the package named after the workflow. A broken `main.ts` here is the
    // workflow the caller asked for, so its error propagates.
    const entries: CacheEntry[] = [];
    const matches: CacheEntry[] = [];
    const inspected = await inspectAll();
    const directIssue = inspected.issues.find(
      (issue) =>
        dirs.some((dir) => issue.file === path.join(dir, name)) ||
        dirs.some((dir) => issue.file === path.join(dir, `${name}.ts`)),
    );
    if (directIssue) throw new GateError(directIssue.error, directIssue.diagnostics);
    const candidatePackages = inspected.packages;
    const directPackages = candidatePackages.filter((candidate) => candidate.name === name);
    for (const direct of directPackages) {
      if (await isFile(direct.file)) {
        const entry = await loadFile(direct);
        if (entry) {
          entries.push(entry);
          if (entry.name === name) matches.push(entry);
        }
      }
    }
    for (const candidate of candidatePackages) {
      if (directPackages.includes(candidate)) continue;
      const entry = await tolerantLoad(loadFile, candidate);
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
    for (const workflowPackage of (await inspectAll()).packages) {
      const entry = await tolerantLoad(loadFile, workflowPackage);
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
      const inspected = await inspectAll();
      issues.push(...inspected.issues);
      for (const workflowPackage of inspected.packages) {
        try {
          const entry = await loadFile(workflowPackage);
          entries.push({ id: entry.id, name: entry.name, file: entry.file, description: entry.description });
        } catch (err) {
          issues.push({
            file: workflowPackage.file,
            error: err instanceof Error ? err.message : String(err),
            diagnostics: err instanceof GateError ? err.diagnostics : [],
          });
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

async function isDirectory(dir: string): Promise<boolean> {
  try {
    return (await stat(dir)).isDirectory();
  } catch {
    return false;
  }
}

/** Broken unrelated packages do not prevent resolving another package by name or durable ID. */
async function tolerantLoad(
  loadFile: (workflowPackage: WorkflowPackage) => Promise<CacheEntry>,
  workflowPackage: WorkflowPackage,
): Promise<CacheEntry | undefined> {
  try {
    return await loadFile(workflowPackage);
  } catch {
    return undefined;
  }
}
