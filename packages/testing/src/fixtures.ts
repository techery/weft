/**
 * Fixture tables → engine test hooks. Whatever a hook returns is journaled and
 * served exactly as if the real side effect had run, so a fixtured run replays
 * like a real one. Every table takes either a function or a record whose keys are
 * matched exactly first and then as globs (picomatch: `*` stops at `/`, `**`
 * crosses it). Strict mode rejects unmatched effects before dispatch; integration
 * mode explicitly allows unmatched effects to reach the real host.
 */
import type { TestHooks } from "@techery/weft-core";
import type { ExecResult, FetchResult } from "@techery/weft-sdk";
import picomatch from "picomatch";

/** A canned git result, or a function of the op's journaled args. */
export type GitFixture =
  | Record<string, unknown>
  | readonly unknown[]
  | string
  | number
  | boolean
  | null
  | ((args: unknown) => unknown | Promise<unknown>);

/** Keyed by the op name — the part after `git.`, e.g. `changedSince`, `commit`, `push`. */
export type GitFixtures = Record<string, GitFixture>;

/** Record keys are `file` followed by the args, space-joined: `"node --version"`. */
export type ExecFixtures =
  | Record<string, ExecResult>
  | ((file: string, args: string[]) => ExecResult | undefined | Promise<ExecResult | undefined>);

/** Record keys are the command line verbatim. */
export type BashFixtures =
  | Record<string, ExecResult>
  | ((command: string) => ExecResult | undefined | Promise<ExecResult | undefined>);

/** Record keys are the URL, or `"METHOD url"` when one fixture per method is wanted. */
export type FetchFixtures =
  | Record<string, FetchResult>
  | ((url: string, method: string) => FetchResult | undefined | Promise<FetchResult | undefined>);

export interface FixtureOptions {
  /** Strict by default. Integration permits real subprocess, network, and Git effects. */
  fixtureMode?: "strict" | "integration";
  git?: GitFixtures;
  exec?: ExecFixtures;
  bash?: BashFixtures;
  fetch?: FetchFixtures;
  env?: Record<string, string>;
}

function globMatch(value: string, pattern: string): boolean {
  if (!pattern.includes("*")) return false;
  try {
    return picomatch.isMatch(value, pattern, { dot: true });
  } catch {
    return false;
  }
}

/** Exact keys win over globs, and earlier candidates win over later ones. */
function lookup<T>(table: Record<string, T>, candidates: string[]): T | undefined {
  for (const candidate of candidates) {
    const exact = Object.hasOwn(table, candidate) ? table[candidate] : undefined;
    if (exact !== undefined) return exact;
  }
  for (const [pattern, value] of Object.entries(table)) {
    for (const candidate of candidates) {
      if (globMatch(candidate, pattern)) return value;
    }
  }
  return undefined;
}

/** Build fail-closed engine hooks unless real effects were explicitly enabled. */
export function buildTestHooks(opts: FixtureOptions): TestHooks | undefined {
  const mode = opts.fixtureMode ?? "strict";
  if (mode !== "strict" && mode !== "integration") {
    throw new Error(`runWorkflow: invalid fixtureMode ${JSON.stringify(mode)}`);
  }
  const strict = mode === "strict";
  const hooks: TestHooks = { allowWorkspace: !strict };
  const missing = (effect: string): never => {
    throw new Error(
      `runWorkflow: missing ${effect} fixture (strict mode); provide a fixture or explicitly set fixtureMode: "integration" to allow real effects`,
    );
  };

  if (opts.git || strict) {
    const table = opts.git ?? {};
    hooks.git = async (op, args) => {
      const fixture = lookup(table, [op, `git.${op}`]);
      const value = typeof fixture === "function" ? await fixture(args) : fixture;
      return value === undefined && strict ? missing(`git.${op}`) : value;
    };
  }

  if (opts.exec || strict) {
    const table = opts.exec ?? {};
    hooks.exec = async (file, args) => {
      const command = [file, ...args].join(" ");
      const value = typeof table === "function" ? await table(file, args) : lookup(table, [command, file]);
      return value === undefined && strict ? missing(`exec ${command}`) : value;
    };
  }

  if (opts.bash || strict) {
    const table = opts.bash ?? {};
    hooks.bash = async (command) => {
      const value = typeof table === "function" ? await table(command) : lookup(table, [command]);
      return value === undefined && strict ? missing(`bash ${command}`) : value;
    };
  }

  if (opts.fetch || strict) {
    const table = opts.fetch ?? {};
    hooks.fetch = async (url, method) => {
      const value =
        typeof table === "function" ? await table(url, method) : lookup(table, [`${method} ${url}`, url]);
      return value === undefined && strict ? missing(`fetch ${method} ${url}`) : value;
    };
  }

  if (opts.env || strict) {
    // An absent value is a valid fixture for an unset variable; never read host secrets.
    const table = opts.env ?? {};
    hooks.env = (name) => (Object.hasOwn(table, name) ? table[name] : undefined);
  }

  return Object.keys(hooks).length > 0 ? hooks : undefined;
}
