/**
 * Global flags and the one way this host builds an engine. Every command opens its own
 * {@link Weft} through `createWeft`, so the CLI stays a shell over `weft.engine` (C10) and
 * a run started by `weft run` is indistinguishable from one the daemon or the MCP server
 * started.
 */
import { join, resolve } from "node:path";
import { createWeft, mergedAllowBare, type Weft } from "@techery/weft-host";
import type { Command } from "commander";

export interface GlobalOptions {
  /** Repo root: what runs execute in, and where `.weft` is read and written. */
  cwd: string;
  /** Additional workflow registries; relative paths resolve against `cwd`. */
  extraWorkflowDirs: string[];
  /**
   * `--mock` wires the fixture provider in place of Claude and Codex. There is no way to
   * script fixtures from a shell, so this is for agent-less workflows: an agent step under
   * `--mock` fails loudly ("no fixture matches step …") rather than inventing an answer.
   */
  mock: boolean;
}

export function globalOptions(cmd: Command): GlobalOptions {
  const opts = cmd.optsWithGlobals() as { cwd?: string; extraWorkflowDir?: string[]; mock?: boolean };
  const cwd = resolve(opts.cwd ?? process.cwd());
  return {
    cwd,
    extraWorkflowDirs: (opts.extraWorkflowDir ?? []).map((dir) => resolve(cwd, dir)),
    mock: opts.mock === true,
  };
}

/** Open the engine for this invocation. */
export async function openWeft(cmd: Command): Promise<Weft> {
  const { cwd, extraWorkflowDirs, mock } = globalOptions(cmd);
  return createWeft({ cwd, extraWorkflowDirs, providers: mock ? "mock" : "real" });
}

/**
 * Where the registry looks. `createWeft` resolves this internally but does not hand it
 * back, and `weft check`/`weft new` need the directory itself — including the files that
 * fail to load, which the registry listing skips by design.
 */
export function workflowsDir(weft: Weft): string {
  return weft.workflowDirs[0] ?? join(weft.weftDir, "workflows");
}

/** Primary configured registry followed by repeatable CLI-provided extras. */
export function workflowDirs(weft: Weft): readonly string[] {
  return weft.workflowDirs;
}

/** The repo's bare-import allowance (defaults + config extras), in the shape the gate takes. */
export function allowBareOf(weft: Weft): { allowBare?: string[] } {
  const allowBare = mergedAllowBare(weft.config);
  return allowBare ? { allowBare } : {};
}

/** `--reuse content|key`, validated here so a typo never silently becomes the default. */
export function parseReuse(value: string | undefined): "content" | "key" | undefined {
  if (value === undefined) return undefined;
  if (value === "content" || value === "key") return value;
  throw new Error(`invalid --reuse ${JSON.stringify(value)} — expected "content" or "key"`);
}
