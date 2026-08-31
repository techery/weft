/** Declaration-only effects surface for the Weft DSL prototype. */
import type { AnyAgentDefinition } from "./agent.ts";
import type { CommandResult } from "./checks.ts";
import type { AnySchema, Duration, InferIn, InferOut, NominalValue } from "./shared.ts";

// ---------------------------------------------------------------------------
// Repository, process, network, wait, and Git effects
// ---------------------------------------------------------------------------

/**
 * Why: Prevents secret values from becoming ordinary strings that could leak into journals or outputs.
 * Use: Obtain one with `ctx.secret` and pass it only to supported headers or process environments.
 */
declare const secretHandleBrand: unique symbol;

/**
 * Why: Prevents workflow-authored objects from masquerading as opaque secret capabilities minted by the host.
 * Use: Obtain one with `ctx.secret`; its value is never structurally constructible or readable by workflow code.
 */
export interface SecretHandle extends NominalValue<"secret-handle"> {
  readonly [secretHandleBrand]: true;
}

/** Fs read result. */
export interface FsReadResult {
  content: string;
  sha256: string;
  size: number;
}

/** Fs stat result. */
export interface FsStatResult {
  exists: boolean;
  size?: number;
  mtimeMs?: number;
  isFile?: boolean;
  isDirectory?: boolean;
}

/** Stable author key shared by primitive journaled effects. */
export interface DurableEffectOptions {
  key: string;
}

/** Fs glob options. */
export interface FsGlobOptions extends DurableEffectOptions {
  cwd?: string;
}

/** Fs glob result. */
export interface FsGlobResult {
  readonly paths: readonly string[];
}

/**
 * Why: Makes repository observations replayable and hash-aware instead of relying on ambient filesystem reads.
 * Use: Use `ctx.fs.read`, `glob`, and `stat` for workflow decisions.
 */
export interface FsApi {
  read(path: string, opts: DurableEffectOptions): Promise<FsReadResult>;
  glob(patterns: string | string[], opts: FsGlobOptions): Promise<FsGlobResult>;
  stat(path: string, opts: DurableEffectOptions): Promise<FsStatResult>;
}

/** Exec options. */
export interface ExecOptions {
  key: string;
  cwd?: string;
  timeout?: Duration;
  env?: Record<string, string | SecretHandle>;
}

/** Unparsed exec options. */
export interface UnparsedExecOptions extends ExecOptions {
  schema?: undefined;
}

/** Parsed exec options. */
export interface ParsedExecOptions<S extends AnySchema> extends ExecOptions {
  schema: S;
}

/** Exec result. */
export interface ExecResult extends CommandResult {}

/**
 * Why: Defines journaled argument-array process execution with optional schema-validated JSON output.
 * Use: Use `ctx.exec(program, args, options)` when shell grammar is unnecessary.
 */
export interface ExecFn {
  (file: string, args: string[], opts: UnparsedExecOptions): Promise<ExecResult>;
  <S extends AnySchema>(file: string, args: string[], opts: ParsedExecOptions<S>): Promise<InferOut<S>>;
}

/**
 * Why: Provides an explicit journaled boundary for commands that intentionally need shell grammar.
 * Use: Use `ctx.bash(command, options)` instead of ambient process execution.
 */
export interface BashFn {
  (command: string, opts: UnparsedExecOptions): Promise<ExecResult>;
  <S extends AnySchema>(command: string, opts: ParsedExecOptions<S>): Promise<InferOut<S>>;
}

/** Fetch options. */
export interface FetchOptions {
  key: string;
  method?: "GET" | "HEAD";
  headers?: Record<string, string | SecretHandle>;
  timeout?: Duration;
}

/** Unparsed fetch options. */
export interface UnparsedFetchOptions extends FetchOptions {
  schema?: undefined;
}

/** Parsed fetch options. */
export interface ParsedFetchOptions<S extends AnySchema> extends FetchOptions {
  schema: S;
}

/** Fetch result. */
export interface FetchResult {
  status: number;
  headers: Record<string, string>;
  body: string;
}

/**
 * Why: Makes HTTP observations replayable and optionally schema validated.
 * Use: Use `ctx.fetch(url, options)` for network data that influences workflow decisions.
 */
export interface FetchFn {
  (url: string, init: UnparsedFetchOptions): Promise<FetchResult>;
  <S extends AnySchema>(url: string, init: ParsedFetchOptions<S>): Promise<InferOut<S>>;
}

/** Env api. */
export interface EnvApi {
  get(name: string, opts: DurableEffectOptions): Promise<string | undefined>;
}

/** Git file status. */
export type GitFileStatus = "A" | "M" | "D" | "R";

/** Git conflict resolver. */
export interface GitConflictResolver<Context = unknown> {
  resolver: AnyAgentDefinition;
  context: Context;
  attempts: number;
  fallback: "ask" | "fail";
}

/** Git status result. */
export interface GitStatusResult {
  branch: string;
  clean: boolean;
  staged: string[];
  unstaged: string[];
  untracked: string[];
}

/** Git sha result. */
export interface GitShaResult {
  sha: string;
}

/** Git branches result. */
export interface GitBranchesResult {
  current: string;
  all: string[];
}

/** Git changed file. */
export interface GitChangedFile {
  path: string;
  status: GitFileStatus;
}

/** Git changed files result. */
export interface GitChangedFilesResult {
  files: GitChangedFile[];
}

/** Git range. */
export interface GitRange {
  from?: string;
  to?: string;
  paths?: string[];
}

/** Git diff stats. */
export interface GitDiffStats {
  files: number;
  insertions: number;
  deletions: number;
}

/** Git diff result. */
export interface GitDiffResult {
  patch: string;
  stats: GitDiffStats;
  ref?: string;
}

/** Git log options. */
export interface GitLogOptions extends GitRange, DurableEffectOptions {
  max?: number;
}

/** Git diff options. */
export interface GitDiffOptions extends GitRange, DurableEffectOptions {}

/** Git commit info. */
export interface GitCommitInfo {
  sha: string;
  author: string;
  date: string;
  subject: string;
  body: string;
}

/** Git log result. */
export interface GitLogResult {
  commits: GitCommitInfo[];
}

/** Git content result. */
export interface GitContentResult {
  content: string;
}

/** Git blame options. */
export interface GitBlameOptions {
  key: string;
  lines?: [number, number];
}

/** Git blame line. */
export interface GitBlameLine {
  line: number;
  sha: string;
  author: string;
  content: string;
}

/** Git blame result. */
export interface GitBlameResult {
  lines: GitBlameLine[];
}

/** Git ref result. */
export interface GitRefResult {
  ref: string;
}

/** Git compare options. */
export interface GitCompareOptions {
  key: string;
  branch: string;
  upstream: string;
}

/** Git compare result. */
export interface GitCompareResult {
  branch: string;
  head: string;
  upstream: string;
  upstreamHead: string;
  upstreamMoved: boolean;
  ahead: number;
  behind: number;
}

/** Git add options. */
export interface GitAddOptions {
  key: string;
  paths: readonly string[];
}

/** Git commit options. */
export interface GitCommitOptions {
  key: string;
  message: string;
  paths?: readonly string[];
}

/** Git checkout options. */
export interface GitCheckoutOptions {
  key: string;
  discard?: boolean;
}

/** Git fetch options. */
export interface GitFetchOptions {
  key: string;
  remote?: string;
}

/** Git rebase options. */
export interface GitRebaseOptions<Context> {
  key: string;
  onto: string;
  onConflict: GitConflictResolver<Context>;
}

/** Git head result. */
export interface GitHeadResult {
  head: string;
}

/** Git reset options. */
export interface GitResetOptions {
  key: string;
  to: string;
  mode?: "soft" | "mixed" | "hard";
}

/** Git apply options. */
export interface GitApplyOptions {
  key: string;
  patch: string;
  threeWay?: boolean;
}

/** Git branch create options. */
export interface GitBranchCreateOptions {
  key: string;
  from?: string;
  checkout?: boolean;
}

/** Git branch delete options. */
export interface GitBranchDeleteOptions {
  key: string;
  force?: boolean;
}

/** Git stash push options. */
export interface GitStashPushOptions {
  key: string;
  message?: string;
}

/**
 * Why: Keeps destructive cleanup options local to a workflow-owned workspace instead of reusing remote-risk vocabulary.
 * Use: Pass it only through the workspace-capable Git API when untracked files may be removed.
 */
export interface GitCleanOptions {
  key: string;
  force?: boolean;
}

/** Git branch api. */
export interface GitBranchApi {
  create(name: string, opts: GitBranchCreateOptions): Promise<void>;
  delete(name: string, opts: GitBranchDeleteOptions): Promise<void>;
}

/** Git stash api. */
export interface GitStashApi {
  push(opts: GitStashPushOptions): Promise<void>;
  pop(opts: DurableEffectOptions): Promise<void>;
  drop(opts: DurableEffectOptions): Promise<void>;
}

/**
 * Why: Keeps repository observations and host-controlled remote fetch available without granting local mutation authority.
 * Use: Plain workflows receive this surface; fetched refs remain a read-only remote interaction governed by the host.
 */
export interface GitReadApi {
  status(opts: DurableEffectOptions): Promise<GitStatusResult>;
  head(opts: DurableEffectOptions): Promise<GitShaResult>;
  branches(opts: DurableEffectOptions): Promise<GitBranchesResult>;
  mergeBase(a: string, b: string, opts: DurableEffectOptions): Promise<GitShaResult>;
  changedSince(ref: string, opts: DurableEffectOptions): Promise<GitChangedFilesResult>;
  diff(opts: GitDiffOptions): Promise<GitDiffResult>;
  log(opts: GitLogOptions): Promise<GitLogResult>;
  show(ref: string, opts: DurableEffectOptions): Promise<GitContentResult>;
  blame(path: string, opts: GitBlameOptions): Promise<GitBlameResult>;
  fileAt(ref: string, path: string, opts: DurableEffectOptions): Promise<GitContentResult>;
  snapshot(opts: DurableEffectOptions): Promise<GitRefResult>;
  compare(opts: GitCompareOptions): Promise<GitCompareResult>;
  fetch(opts: GitFetchOptions): Promise<void>;
}

/**
 * Why: Groups mutations that are safe only inside an engine-owned isolated workspace.
 * Use: The workflow context exposes it only when its workspace type parameter is exactly `true`.
 */
export interface WorkspaceGitMutationApi {
  add(opts: GitAddOptions): Promise<void>;
  commit(opts: GitCommitOptions): Promise<GitShaResult>;
  checkout(ref: string, opts: GitCheckoutOptions): Promise<void>;
  rebase<Context = unknown>(opts: GitRebaseOptions<Context>): Promise<GitHeadResult>;
  reset(opts: GitResetOptions): Promise<void>;
  apply(opts: GitApplyOptions): Promise<void>;
  branch: GitBranchApi;
  stash: GitStashApi;
  clean(opts: GitCleanOptions): Promise<void>;
}

/**
 * Why: Provides one useful full Git capability for workflow-owned workspaces without reintroducing remote publication.
 * Use: Receive it only from `Ctx<..., true>`; plain workflows are limited to `GitReadApi`.
 */
export interface GitApi extends GitReadApi, WorkspaceGitMutationApi {}

/**
 * Why: Defines a bounded durable local polling loop that can suspend between attempts.
 * Use: Pass it to `ctx.poll`; return a schema input to finish or `null` to wait again.
 */
export interface PollOptions<S extends AnySchema> {
  key: string;
  every: Duration;
  timeout: Duration;
  schema: S;
  check: () => Promise<InferIn<S> | null> | InferIn<S> | null;
}
