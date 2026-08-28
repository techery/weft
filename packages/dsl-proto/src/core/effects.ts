/** Declaration-only effects surface for the Weft DSL prototype. */
import type { AgentDefinition } from "./agent.ts";
import type { CommandResult } from "./checks.ts";
import type { AnySchema, Duration, InferIn, InferOut, Risk } from "./shared.ts";

// ---------------------------------------------------------------------------
// Repository, process, network, wait, and Git effects
// ---------------------------------------------------------------------------

/**
 * Why: Prevents secret values from becoming ordinary strings that could leak into journals or outputs.
 * Use: Obtain one with `ctx.secret` and pass it only to supported headers or process environments.
 */
export interface SecretHandle {
  readonly __weftSecret: string;
}

/**
 * Why: Gives the effects DSL an explicit fs read result contract instead of relying on untyped values.
 * Use: Import it when declaring, configuring, or consuming the corresponding effects API.
 */
export interface FsReadResult {
  content: string;
  sha256: string;
  size: number;
}

/**
 * Why: Gives the effects DSL an explicit fs stat result contract instead of relying on untyped values.
 * Use: Import it when declaring, configuring, or consuming the corresponding effects API.
 */
export interface FsStatResult {
  exists: boolean;
  size?: number;
  mtimeMs?: number;
  isFile?: boolean;
  isDirectory?: boolean;
}

/**
 * Why: Gives the effects DSL an explicit fs glob options contract instead of relying on untyped values.
 * Use: Import it when declaring, configuring, or consuming the corresponding effects API.
 */
export interface FsGlobOptions {
  cwd?: string;
}

/**
 * Why: Gives the effects DSL an explicit fs glob result contract instead of relying on untyped values.
 * Use: Import it when declaring, configuring, or consuming the corresponding effects API.
 */
export interface FsGlobResult {
  paths: string[];
}

/**
 * Why: Makes repository observations replayable and hash-aware instead of relying on ambient filesystem reads.
 * Use: Use `ctx.fs.read`, `glob`, and `stat` for workflow decisions.
 */
export interface FsApi {
  read(path: string): Promise<FsReadResult>;
  glob(patterns: string | string[], opts?: FsGlobOptions): Promise<FsGlobResult>;
  stat(path: string): Promise<FsStatResult>;
}

/**
 * Why: Gives the effects DSL an explicit exec options contract instead of relying on untyped values.
 * Use: Import it when declaring, configuring, or consuming the corresponding effects API.
 */
export interface ExecOptions {
  key?: string;
  cwd?: string;
  timeout?: Duration;
  env?: Record<string, string | SecretHandle>;
  risk?: Risk;
}

/**
 * Why: Gives the effects DSL an explicit unparsed exec options contract instead of relying on untyped values.
 * Use: Import it when declaring, configuring, or consuming the corresponding effects API.
 */
export interface UnparsedExecOptions extends ExecOptions {
  schema?: undefined;
}

/**
 * Why: Gives the effects DSL an explicit parsed exec options contract instead of relying on untyped values.
 * Use: Import it when declaring, configuring, or consuming the corresponding effects API.
 */
export interface ParsedExecOptions<S extends AnySchema> extends ExecOptions {
  schema: S;
}

/**
 * Why: Gives the effects DSL an explicit exec result contract instead of relying on untyped values.
 * Use: Import it when declaring, configuring, or consuming the corresponding effects API.
 */
export interface ExecResult extends CommandResult {}

/**
 * Why: Defines journaled argument-array process execution with optional schema-validated JSON output.
 * Use: Use `ctx.exec(program, args, options)` when shell grammar is unnecessary.
 */
export interface ExecFn {
  (file: string, args?: string[], opts?: UnparsedExecOptions): Promise<ExecResult>;
  <S extends AnySchema>(file: string, args: string[], opts: ParsedExecOptions<S>): Promise<InferOut<S>>;
}

/**
 * Why: Provides an explicit journaled boundary for commands that intentionally need shell grammar.
 * Use: Use `ctx.bash(command, options)` instead of ambient process execution.
 */
export interface BashFn {
  (command: string, opts?: UnparsedExecOptions): Promise<ExecResult>;
  <S extends AnySchema>(command: string, opts: ParsedExecOptions<S>): Promise<InferOut<S>>;
}

/**
 * Why: Gives the effects DSL an explicit fetch options contract instead of relying on untyped values.
 * Use: Import it when declaring, configuring, or consuming the corresponding effects API.
 */
export interface FetchOptions {
  key?: string;
  method?: string;
  headers?: Record<string, string | SecretHandle>;
  body?: string;
  timeout?: Duration;
}

/**
 * Why: Gives the effects DSL an explicit unparsed fetch options contract instead of relying on untyped values.
 * Use: Import it when declaring, configuring, or consuming the corresponding effects API.
 */
export interface UnparsedFetchOptions extends FetchOptions {
  schema?: undefined;
}

/**
 * Why: Gives the effects DSL an explicit parsed fetch options contract instead of relying on untyped values.
 * Use: Import it when declaring, configuring, or consuming the corresponding effects API.
 */
export interface ParsedFetchOptions<S extends AnySchema> extends FetchOptions {
  schema: S;
}

/**
 * Why: Gives the effects DSL an explicit fetch result contract instead of relying on untyped values.
 * Use: Import it when declaring, configuring, or consuming the corresponding effects API.
 */
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
  (url: string, init?: UnparsedFetchOptions): Promise<FetchResult>;
  <S extends AnySchema>(url: string, init: ParsedFetchOptions<S>): Promise<InferOut<S>>;
}

/**
 * Why: Gives the effects DSL an explicit env api contract instead of relying on untyped values.
 * Use: Import it when declaring, configuring, or consuming the corresponding effects API.
 */
export interface EnvApi {
  get(name: string): Promise<string | undefined>;
}

/**
 * Why: Gives the effects DSL an explicit git file status contract instead of relying on untyped values.
 * Use: Import it when declaring, configuring, or consuming the corresponding effects API.
 */
export type GitFileStatus = "A" | "M" | "D" | "R";

/**
 * Why: Gives the effects DSL an explicit git conflict resolver contract instead of relying on untyped values.
 * Use: Import it when declaring, configuring, or consuming the corresponding effects API.
 */
export interface GitConflictResolver<Context = unknown> {
  resolver: AgentDefinition<any, AnySchema, any>;
  context: Context;
  attempts: number;
  fallback: "ask" | "fail";
}

/**
 * Why: Gives the effects DSL an explicit git status result contract instead of relying on untyped values.
 * Use: Import it when declaring, configuring, or consuming the corresponding effects API.
 */
export interface GitStatusResult {
  branch: string;
  clean: boolean;
  staged: string[];
  unstaged: string[];
  untracked: string[];
}

/**
 * Why: Gives the effects DSL an explicit git sha result contract instead of relying on untyped values.
 * Use: Import it when declaring, configuring, or consuming the corresponding effects API.
 */
export interface GitShaResult {
  sha: string;
}

/**
 * Why: Gives the effects DSL an explicit git branches result contract instead of relying on untyped values.
 * Use: Import it when declaring, configuring, or consuming the corresponding effects API.
 */
export interface GitBranchesResult {
  current: string;
  all: string[];
}

/**
 * Why: Gives the effects DSL an explicit git changed file contract instead of relying on untyped values.
 * Use: Import it when declaring, configuring, or consuming the corresponding effects API.
 */
export interface GitChangedFile {
  path: string;
  status: GitFileStatus;
}

/**
 * Why: Gives the effects DSL an explicit git changed files result contract instead of relying on untyped values.
 * Use: Import it when declaring, configuring, or consuming the corresponding effects API.
 */
export interface GitChangedFilesResult {
  files: GitChangedFile[];
}

/**
 * Why: Gives the effects DSL an explicit git range contract instead of relying on untyped values.
 * Use: Import it when declaring, configuring, or consuming the corresponding effects API.
 */
export interface GitRange {
  from?: string;
  to?: string;
  paths?: string[];
}

/**
 * Why: Gives the effects DSL an explicit git diff stats contract instead of relying on untyped values.
 * Use: Import it when declaring, configuring, or consuming the corresponding effects API.
 */
export interface GitDiffStats {
  files: number;
  insertions: number;
  deletions: number;
}

/**
 * Why: Gives the effects DSL an explicit git diff result contract instead of relying on untyped values.
 * Use: Import it when declaring, configuring, or consuming the corresponding effects API.
 */
export interface GitDiffResult {
  patch: string;
  stats: GitDiffStats;
  ref?: string;
}

/**
 * Why: Gives the effects DSL an explicit git log options contract instead of relying on untyped values.
 * Use: Import it when declaring, configuring, or consuming the corresponding effects API.
 */
export interface GitLogOptions extends GitRange {
  max?: number;
}

/**
 * Why: Gives the effects DSL an explicit git commit info contract instead of relying on untyped values.
 * Use: Import it when declaring, configuring, or consuming the corresponding effects API.
 */
export interface GitCommitInfo {
  sha: string;
  author: string;
  date: string;
  subject: string;
  body: string;
}

/**
 * Why: Gives the effects DSL an explicit git log result contract instead of relying on untyped values.
 * Use: Import it when declaring, configuring, or consuming the corresponding effects API.
 */
export interface GitLogResult {
  commits: GitCommitInfo[];
}

/**
 * Why: Gives the effects DSL an explicit git content result contract instead of relying on untyped values.
 * Use: Import it when declaring, configuring, or consuming the corresponding effects API.
 */
export interface GitContentResult {
  content: string;
}

/**
 * Why: Gives the effects DSL an explicit git blame options contract instead of relying on untyped values.
 * Use: Import it when declaring, configuring, or consuming the corresponding effects API.
 */
export interface GitBlameOptions {
  lines?: [number, number];
}

/**
 * Why: Gives the effects DSL an explicit git blame line contract instead of relying on untyped values.
 * Use: Import it when declaring, configuring, or consuming the corresponding effects API.
 */
export interface GitBlameLine {
  line: number;
  sha: string;
  author: string;
  content: string;
}

/**
 * Why: Gives the effects DSL an explicit git blame result contract instead of relying on untyped values.
 * Use: Import it when declaring, configuring, or consuming the corresponding effects API.
 */
export interface GitBlameResult {
  lines: GitBlameLine[];
}

/**
 * Why: Gives the effects DSL an explicit git ref result contract instead of relying on untyped values.
 * Use: Import it when declaring, configuring, or consuming the corresponding effects API.
 */
export interface GitRefResult {
  ref: string;
}

/**
 * Why: Gives the effects DSL an explicit git compare options contract instead of relying on untyped values.
 * Use: Import it when declaring, configuring, or consuming the corresponding effects API.
 */
export interface GitCompareOptions {
  branch: string;
  upstream: string;
}

/**
 * Why: Gives the effects DSL an explicit git compare result contract instead of relying on untyped values.
 * Use: Import it when declaring, configuring, or consuming the corresponding effects API.
 */
export interface GitCompareResult {
  branch: string;
  head: string;
  upstream: string;
  upstreamHead: string;
  upstreamMoved: boolean;
  ahead: number;
  behind: number;
}

/**
 * Why: Gives the effects DSL an explicit git risk options contract instead of relying on untyped values.
 * Use: Import it when declaring, configuring, or consuming the corresponding effects API.
 */
export interface GitRiskOptions {
  risk?: Risk;
}

/**
 * Why: Gives the effects DSL an explicit git add options contract instead of relying on untyped values.
 * Use: Import it when declaring, configuring, or consuming the corresponding effects API.
 */
export interface GitAddOptions extends GitRiskOptions {
  paths: string[];
}

/**
 * Why: Gives the effects DSL an explicit git commit options contract instead of relying on untyped values.
 * Use: Import it when declaring, configuring, or consuming the corresponding effects API.
 */
export interface GitCommitOptions extends GitRiskOptions {
  message: string;
  paths?: string[];
}

/**
 * Why: Gives the effects DSL an explicit git checkout options contract instead of relying on untyped values.
 * Use: Import it when declaring, configuring, or consuming the corresponding effects API.
 */
export interface GitCheckoutOptions extends GitRiskOptions {
  discard?: boolean;
}

/**
 * Why: Gives the effects DSL an explicit git fetch options contract instead of relying on untyped values.
 * Use: Import it when declaring, configuring, or consuming the corresponding effects API.
 */
export interface GitFetchOptions extends GitRiskOptions {
  remote?: string;
}

/**
 * Why: Gives the effects DSL an explicit git pull options contract instead of relying on untyped values.
 * Use: Import it when declaring, configuring, or consuming the corresponding effects API.
 */
export interface GitPullOptions extends GitFetchOptions {
  rebase?: boolean;
  branch?: string;
}

/**
 * Why: Gives the effects DSL an explicit git push options contract instead of relying on untyped values.
 * Use: Import it when declaring, configuring, or consuming the corresponding effects API.
 */
export interface GitPushOptions extends GitFetchOptions {
  branch?: string;
  setUpstream?: boolean;
  forceWithLease?: boolean;
}

/**
 * Why: Gives the effects DSL an explicit git rebase options contract instead of relying on untyped values.
 * Use: Import it when declaring, configuring, or consuming the corresponding effects API.
 */
export interface GitRebaseOptions<Context> extends GitRiskOptions {
  onto: string;
  onConflict: GitConflictResolver<Context>;
}

/**
 * Why: Gives the effects DSL an explicit git head result contract instead of relying on untyped values.
 * Use: Import it when declaring, configuring, or consuming the corresponding effects API.
 */
export interface GitHeadResult {
  head: string;
}

/**
 * Why: Gives the effects DSL an explicit git reset options contract instead of relying on untyped values.
 * Use: Import it when declaring, configuring, or consuming the corresponding effects API.
 */
export interface GitResetOptions extends GitRiskOptions {
  to: string;
  mode?: "soft" | "mixed" | "hard";
}

/**
 * Why: Gives the effects DSL an explicit git apply options contract instead of relying on untyped values.
 * Use: Import it when declaring, configuring, or consuming the corresponding effects API.
 */
export interface GitApplyOptions extends GitRiskOptions {
  patch: string;
  threeWay?: boolean;
}

/**
 * Why: Gives the effects DSL an explicit git tag options contract instead of relying on untyped values.
 * Use: Import it when declaring, configuring, or consuming the corresponding effects API.
 */
export interface GitTagOptions extends GitRiskOptions {
  ref?: string;
}

/**
 * Why: Gives the effects DSL an explicit git branch create options contract instead of relying on untyped values.
 * Use: Import it when declaring, configuring, or consuming the corresponding effects API.
 */
export interface GitBranchCreateOptions extends GitRiskOptions {
  from?: string;
  checkout?: boolean;
}

/**
 * Why: Gives the effects DSL an explicit git branch delete options contract instead of relying on untyped values.
 * Use: Import it when declaring, configuring, or consuming the corresponding effects API.
 */
export interface GitBranchDeleteOptions extends GitRiskOptions {
  force?: boolean;
}

/**
 * Why: Gives the effects DSL an explicit git stash push options contract instead of relying on untyped values.
 * Use: Import it when declaring, configuring, or consuming the corresponding effects API.
 */
export interface GitStashPushOptions extends GitRiskOptions {
  message?: string;
}

/**
 * Why: Gives the effects DSL an explicit git branch api contract instead of relying on untyped values.
 * Use: Import it when declaring, configuring, or consuming the corresponding effects API.
 */
export interface GitBranchApi {
  create(name: string, opts?: GitBranchCreateOptions): Promise<void>;
  delete(name: string, opts?: GitBranchDeleteOptions): Promise<void>;
}

/**
 * Why: Gives the effects DSL an explicit git stash api contract instead of relying on untyped values.
 * Use: Import it when declaring, configuring, or consuming the corresponding effects API.
 */
export interface GitStashApi {
  push(opts?: GitStashPushOptions): Promise<void>;
  pop(opts?: GitRiskOptions): Promise<void>;
  drop(opts?: GitRiskOptions): Promise<void>;
}

/**
 * Why: Collects typed journaled Git reads and risk-aware writes behind the workflow context.
 * Use: Use `ctx.git` or a workspace-bound `git` API instead of spawning Git directly.
 */
export interface GitApi {
  status(): Promise<GitStatusResult>;
  head(): Promise<GitShaResult>;
  branches(): Promise<GitBranchesResult>;
  mergeBase(a: string, b: string): Promise<GitShaResult>;
  changedSince(ref: string): Promise<GitChangedFilesResult>;
  diff(range?: GitRange): Promise<GitDiffResult>;
  log(opts?: GitLogOptions): Promise<GitLogResult>;
  show(ref: string): Promise<GitContentResult>;
  blame(path: string, opts?: GitBlameOptions): Promise<GitBlameResult>;
  fileAt(ref: string, path: string): Promise<GitContentResult>;
  snapshot(): Promise<GitRefResult>;
  compare(opts: GitCompareOptions): Promise<GitCompareResult>;
  add(opts: GitAddOptions): Promise<void>;
  commit(opts: GitCommitOptions): Promise<GitShaResult>;
  checkout(ref: string, opts?: GitCheckoutOptions): Promise<void>;
  fetch(opts?: GitFetchOptions): Promise<void>;
  pull(opts?: GitPullOptions): Promise<void>;
  push(opts?: GitPushOptions): Promise<void>;
  rebase<Context = unknown>(opts: GitRebaseOptions<Context>): Promise<GitHeadResult>;
  reset(opts: GitResetOptions): Promise<void>;
  apply(opts: GitApplyOptions): Promise<void>;
  tag(name: string, opts?: GitTagOptions): Promise<GitShaResult>;
  branch: GitBranchApi;
  stash: GitStashApi;
  clean(opts?: GitBranchDeleteOptions): Promise<void>;
}

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
