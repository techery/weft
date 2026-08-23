/**
 * @weft/git — typed git operations over the git CLI.
 *
 * This package is the low-level layer: it runs git and parses porcelain output into
 * typed values. It does NOT journal, gate, or apply approval policy — the engine
 * (`@weft/core`) wraps these ops as journaled, risk-tiered steps. `@weft/isolation`
 * builds worktrees and patch capture on top of it.
 */
import type {
  GitBlameLine,
  GitCommitInfo,
  GitDiffStats,
  GitFileStatus,
  GitRange,
  GitStatusResult,
  Risk,
} from "@weft/sdk";

export type {
  GitBlameLine,
  GitCommitInfo,
  GitDiffStats,
  GitFileStatus,
  GitRange,
  GitStatusResult,
} from "@weft/sdk";

export interface RawResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export class GitError extends Error {
  readonly args: string[];
  readonly exitCode: number;
  readonly stderr: string;
  constructor(message: string, opts: { args: string[]; exitCode: number; stderr: string }) {
    super(message);
    this.name = "GitError";
    this.args = opts.args;
    this.exitCode = opts.exitCode;
    this.stderr = opts.stderr;
  }
}

/**
 * A git handle bound to one working directory. All ops shell out to the git CLI.
 * Reads parse porcelain formats; writes return just enough to idempotency-check
 * on resume (`revParse`, returned shas).
 */
export interface Git {
  readonly cwd: string;
  /** Run raw git args. Throws GitError on non-zero exit unless allowFailure. */
  raw(
    args: string[],
    opts?: { allowFailure?: boolean; input?: string; env?: Record<string, string> },
  ): Promise<RawResult>;

  // -- reads ---------------------------------------------------------------
  status(): Promise<GitStatusResult>;
  head(): Promise<{ sha: string }>;
  branches(): Promise<{ current: string; all: string[] }>;
  mergeBase(a: string, b: string): Promise<{ sha: string }>;
  /**
   * Files changed relative to merge-base(ref, HEAD), including uncommitted working
   * tree changes and untracked files (reported as "A").
   */
  changedSince(ref: string): Promise<{ files: Array<{ path: string; status: GitFileStatus }> }>;
  /** Unified diff. `to` defaults to the working tree; `from` defaults to HEAD. */
  diff(range?: GitRange): Promise<{ patch: string; stats: GitDiffStats }>;
  log(opts?: GitRange & { max?: number }): Promise<{ commits: GitCommitInfo[] }>;
  show(ref: string): Promise<{ content: string }>;
  blame(path: string, opts?: { lines?: [number, number] }): Promise<{ lines: GitBlameLine[] }>;
  fileAt(ref: string, path: string): Promise<{ content: string }>;
  /**
   * Records the current tracked working-tree state as a commit object without moving
   * HEAD or the index (git stash create); returns HEAD's sha when the tree is clean.
   */
  snapshot(): Promise<{ ref: string }>;
  /** Resolve a ref to a sha, or null when it does not exist. */
  revParse(ref: string): Promise<string | null>;

  // -- writes --------------------------------------------------------------
  add(opts: { paths: string[] }): Promise<void>;
  commit(opts: { message: string; paths?: string[]; allowEmpty?: boolean }): Promise<{ sha: string }>;
  checkout(ref: string, opts?: { discard?: boolean }): Promise<void>;
  fetchRemote(opts?: { remote?: string }): Promise<void>;
  pull(opts?: { rebase?: boolean; remote?: string; branch?: string }): Promise<void>;
  push(opts?: { remote?: string; branch?: string; setUpstream?: boolean; force?: boolean }): Promise<void>;
  reset(opts: { to: string; mode?: "soft" | "mixed" | "hard" }): Promise<void>;
  /** git apply, optionally --3way (leaves conflict markers; throws GitError when unapplicable). */
  applyPatch(opts: { patch: string; threeWay?: boolean; index?: boolean }): Promise<void>;
  tag(name: string, opts?: { ref?: string }): Promise<void>;
  branchCreate(name: string, opts?: { from?: string; checkout?: boolean }): Promise<void>;
  branchDelete(name: string, opts?: { force?: boolean }): Promise<void>;
  stashPush(opts?: { message?: string }): Promise<void>;
  stashPop(): Promise<void>;
  stashDrop(): Promise<void>;
  clean(opts?: { force?: boolean }): Promise<void>;
  /** Paths currently in unmerged (conflict) state. */
  unmergedPaths(): Promise<string[]>;
}

/** Create a Git handle for a repository working directory. */
export function createGit(cwd: string): Git {
  return new GitCli(cwd);
}

/** Names for write ops as used in approval policy and journal events. */
export type GitWriteOp =
  | "add"
  | "commit"
  | "branch.create"
  | "checkout"
  | "fetch"
  | "stash.push"
  | "stash.pop"
  | "tag"
  | "pull"
  | "reset"
  | "apply"
  | "stash.drop"
  | "checkout.discard"
  | "push"
  | "push.force"
  | "reset.hard"
  | "branch.delete"
  | "clean";

/**
 * Fixed risk tier per write op. A workflow may raise a tier, never lower it;
 * the run's approval policy decides what "ask" means.
 */
export const GIT_WRITE_RISK: Record<GitWriteOp, Risk> = {
  add: "low",
  commit: "low",
  "branch.create": "low",
  checkout: "low",
  fetch: "low",
  "stash.push": "low",
  "stash.pop": "low",
  tag: "low",
  pull: "medium",
  reset: "medium",
  apply: "medium",
  "stash.drop": "medium",
  "checkout.discard": "medium",
  push: "high",
  "push.force": "irreversible",
  "reset.hard": "irreversible",
  "branch.delete": "irreversible",
  clean: "irreversible",
};

// Implementation lives in git.ts; the class is re-exported for DI in tests.
import { GitCli } from "./git.ts";

export { GitCli } from "./git.ts";
