/**
 * Fixture tables → engine test hooks. Whatever a hook returns is journaled and
 * served exactly as if the real side effect had run, so a fixtured run replays
 * like a real one. Every table takes either a function or a record whose keys are
 * matched exactly first and then as globs (picomatch: `*` stops at `/`, `**`
 * crosses it). Anything a table does not answer falls through to the real thing.
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
    const exact = table[candidate];
    if (exact !== undefined) return exact;
  }
  for (const [pattern, value] of Object.entries(table)) {
    for (const candidate of candidates) {
      if (globMatch(candidate, pattern)) return value;
    }
  }
  return undefined;
}

/** Build the engine's TestHooks, or undefined when no fixture table was given. */
export function buildTestHooks(opts: FixtureOptions): TestHooks | undefined {
  const hooks: TestHooks = {};

  if (opts.git) {
    const table = opts.git;
    hooks.git = async (op, args) => {
      const fixture = lookup(table, [op, `git.${op}`]);
      if (fixture === undefined) return undefined;
      return typeof fixture === "function" ? await fixture(args) : fixture;
    };
  }

  if (opts.exec) {
    const table = opts.exec;
    hooks.exec =
      typeof table === "function" ? table : (file, args) => lookup(table, [[file, ...args].join(" "), file]);
  }

  if (opts.bash) {
    const table = opts.bash;
    hooks.bash = typeof table === "function" ? table : (command) => lookup(table, [command]);
  }

  if (opts.fetch) {
    const table = opts.fetch;
    hooks.fetch =
      typeof table === "function" ? table : (url, method) => lookup(table, [url, `${method} ${url}`]);
  }

  if (opts.env) {
    const table = opts.env;
    hooks.env = (name) => table[name];
  }

  return Object.keys(hooks).length > 0 ? hooks : undefined;
}
