/**
 * The full authoring surface: everything a workflow touches comes through `ctx`.
 * These types are the contract between workflow code and the Weft engine.
 */
import type { Duration } from "./duration.ts";
import type { StepError } from "./errors.ts";
import type { AnySchema, InferOut } from "./schema.ts";
import type { Settled } from "./settled.ts";

// ---------------------------------------------------------------------------
// Routing & effort
// ---------------------------------------------------------------------------

export type ProviderId = "claude" | "codex" | (string & {});
export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

/** Risk tiers drive the approval policy: low auto-approves (recorded), higher tiers ask. */
export type Risk = "low" | "medium" | "high" | "irreversible";

// ---------------------------------------------------------------------------
// Agent steps
// ---------------------------------------------------------------------------

/**
 * Declared write scope for a write step. Paths are glob patterns relative to the
 * integration tree. `also` extends the scope for incidental files (lockfiles…).
 * `warn` (default) flags out-of-scope edits in the report but lands the patch;
 * `strict` quarantines the patch instead.
 */
export interface WriteScope {
  paths: string[];
  also?: string[];
  mode?: "warn" | "strict";
}

export interface RetryOptions {
  attempts: number;
  /** Delay before each retry; scales linearly with the attempt number. */
  backoff?: Duration;
}

export interface AgentOptions<S extends AnySchema> {
  /** Required on every step: the only way out is a value this schema validates. */
  schema: S;
  /** Stable identity for replay, tests, and the tree. Auto `Phase/agent#N` if omitted. */
  key?: string;
  /** Cosmetic label for the tree; defaults to the key. */
  label?: string;
  provider?: ProviderId;
  model?: string;
  effort?: Effort;
  /** `"worktree"` gives the agent its own git worktree at the integration tree. */
  isolation?: "worktree" | "none";
  /** Declaring a write scope makes this a write step; its result carries a patch. */
  write?: WriteScope;
  maxTurns?: number;
  timeout?: Duration;
  retry?: RetryOptions;
  /** Schema-repair attempts in the same session (default 2). */
  repair?: number;
  /** At maxTurns: force one "finalize now" turn (default) or fail immediately. */
  onMaxTurns?: "finalize" | "fail";
  /** `"throw"` (default) throws StepError; `"null"` resolves to `T | null`. */
  onError?: "throw" | "null";
}

export interface Usage {
  /** Input tokens (prompt + cache reads are broken out separately). */
  input: number;
  output: number;
  cacheRead?: number;
  usd?: number;
}

/** A captured patch from a write step, referenced by blob hash. */
export interface PatchRef {
  ref: string;
  key: string;
  files: string[];
  quarantined?: boolean;
  outOfScope?: string[];
}

export interface DetailedAgentResult<T> {
  value: T;
  usage: Usage;
  /** Files the agent touched (write steps). */
  files: string[];
  patch?: PatchRef;
  attempts: number;
  sessionId?: string;
}

export interface AgentFn {
  <S extends AnySchema>(
    prompt: string,
    opts: AgentOptions<S> & { onError: "null" },
  ): Promise<InferOut<S> | null>;
  <S extends AnySchema>(prompt: string, opts: AgentOptions<S>): Promise<InferOut<S>>;
  /** Same options; returns the value plus usage, files, patch, attempts, sessionId. */
  detailed<S extends AnySchema>(
    prompt: string,
    opts: AgentOptions<S> & { onError: "null" },
  ): Promise<DetailedAgentResult<InferOut<S>> | null>;
  detailed<S extends AnySchema>(
    prompt: string,
    opts: AgentOptions<S>,
  ): Promise<DetailedAgentResult<InferOut<S>>>;
}

// ---------------------------------------------------------------------------
// Fan-out
// ---------------------------------------------------------------------------

export type ParallelTask<T> = Promise<T> | (() => Promise<T> | T);

export interface ParallelOptions {
  /** Caps lanes for thunk tasks; the global limiter inside every step applies regardless. */
  concurrency?: number;
}

export interface Pipeline<Item, Prev> {
  step<Next>(fn: (prev: Prev, item: Item, index: number) => Promise<Next> | Next): Pipeline<Item, Next>;
  /** A falsy verdict drops the lane (dropped lanes do not appear in run()'s result). */
  filter(fn: (prev: Prev, item: Item, index: number) => boolean | Promise<boolean>): Pipeline<Item, Prev>;
  map<Next>(fn: (prev: Prev, item: Item, index: number) => Next | Promise<Next>): Pipeline<Item, Next>;
  run(opts?: { concurrency?: number }): Promise<Settled<Prev>[]>;
}

// ---------------------------------------------------------------------------
// Humans & gates
// ---------------------------------------------------------------------------

export interface GateRequest {
  action: string;
  risk: Risk;
  detail?: string;
}

export interface GateResult {
  approved: boolean;
  note?: string;
  answeredBy: "human" | "policy" | "timeout";
}

export type HumanTimeoutPolicy<T> = "deny" | "escalate" | { default: T };

export interface HumanAskOptions<S extends AnySchema> {
  question: string;
  schema: S;
  detail?: string;
  timeout?: Duration;
  onTimeout?: HumanTimeoutPolicy<InferOut<S>>;
}

export interface HumanApproveOptions {
  action: string;
  detail?: string;
  timeout?: Duration;
  onTimeout?: HumanTimeoutPolicy<{ approved: boolean; note?: string }>;
}

export interface HumanReviewOptions<S extends AnySchema> {
  /** The artifact under review (markdown, a diff, a report…). Stored as a blob. */
  artifact: string;
  question?: string;
  schema: S;
  timeout?: Duration;
  onTimeout?: HumanTimeoutPolicy<InferOut<S>>;
}

export interface HumanApi {
  /** Always asks a person; the answer is validated against the schema like any output. */
  ask<S extends AnySchema>(opts: HumanAskOptions<S>): Promise<InferOut<S>>;
  approve(opts: HumanApproveOptions): Promise<{ approved: boolean; note?: string }>;
  review<S extends AnySchema>(opts: HumanReviewOptions<S>): Promise<InferOut<S>>;
}

// ---------------------------------------------------------------------------
// Side effects: fs, exec, bash, fetch, env
// ---------------------------------------------------------------------------

export interface FsReadResult {
  content: string;
  sha256: string;
  size: number;
}

export interface FsStatResult {
  exists: boolean;
  size?: number;
  mtimeMs?: number;
  isFile?: boolean;
  isDirectory?: boolean;
}

export interface FsApi {
  read(path: string): Promise<FsReadResult>;
  glob(patterns: string | string[], opts?: { cwd?: string }): Promise<{ paths: string[] }>;
  stat(path: string): Promise<FsStatResult>;
}

export interface ExecOptions {
  cwd?: string;
  timeout?: Duration;
  env?: Record<string, string | SecretHandle>;
  /** Routes through the gate before executing. */
  risk?: Risk;
  key?: string;
}

export interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface ExecFn {
  (file: string, args?: string[], opts?: ExecOptions & { schema?: undefined }): Promise<ExecResult>;
  /** With a schema, JSON stdout is parsed and validated into the typed value. */
  <S extends AnySchema>(
    file: string,
    args: string[],
    opts: ExecOptions & { schema: S },
  ): Promise<InferOut<S>>;
}

export interface BashFn {
  (command: string, opts?: ExecOptions & { schema?: undefined }): Promise<ExecResult>;
  <S extends AnySchema>(command: string, opts: ExecOptions & { schema: S }): Promise<InferOut<S>>;
}

export interface FetchOptions {
  method?: string;
  headers?: Record<string, string | SecretHandle>;
  body?: string;
  timeout?: Duration;
  key?: string;
}

export interface FetchResult {
  status: number;
  headers: Record<string, string>;
  body: string;
}

export interface FetchFn {
  (url: string, init?: FetchOptions & { schema?: undefined }): Promise<FetchResult>;
  /** With a schema, a 2xx JSON body is parsed and validated into the typed value. */
  <S extends AnySchema>(url: string, init: FetchOptions & { schema: S }): Promise<InferOut<S>>;
}

/** Opaque handle to a secret; resolved engine-side at call time, journaled as `<redacted>`. */
export interface SecretHandle {
  readonly __weftSecret: string;
}

export interface EnvApi {
  /** Journaled environment read; use ctx.secret for anything sensitive. */
  get(name: string): Promise<string | undefined>;
}

// ---------------------------------------------------------------------------
// Git
// ---------------------------------------------------------------------------

export type GitFileStatus = "A" | "M" | "D" | "R";

export interface GitStatusResult {
  branch: string;
  clean: boolean;
  staged: string[];
  unstaged: string[];
  untracked: string[];
}

export interface GitDiffStats {
  files: number;
  insertions: number;
  deletions: number;
}

export interface GitCommitInfo {
  sha: string;
  author: string;
  date: string;
  subject: string;
  body: string;
}

export interface GitBlameLine {
  line: number;
  sha: string;
  author: string;
  content: string;
}

export interface GitRange {
  from?: string;
  to?: string;
  paths?: string[];
}

export interface GitWriteOpts {
  /** Raise (never lower) the fixed risk tier of this op. */
  risk?: Risk;
}

export interface GitApi {
  // reads — journaled, no approval
  status(): Promise<GitStatusResult>;
  head(): Promise<{ sha: string }>;
  branches(): Promise<{ current: string; all: string[] }>;
  mergeBase(a: string, b: string): Promise<{ sha: string }>;
  changedSince(ref: string): Promise<{ files: Array<{ path: string; status: GitFileStatus }> }>;
  diff(range?: GitRange): Promise<{ patch: string; stats: GitDiffStats; ref?: string }>;
  log(opts?: GitRange & { max?: number }): Promise<{ commits: GitCommitInfo[] }>;
  show(ref: string): Promise<{ content: string }>;
  blame(path: string, opts?: { lines?: [number, number] }): Promise<{ lines: GitBlameLine[] }>;
  fileAt(ref: string, path: string): Promise<{ content: string }>;
  /** Records the current tree state as a reusable ref (stash-like snapshot commit). */
  snapshot(): Promise<{ ref: string }>;

  // writes — journaled, fixed risk tiers (see docs); idempotency-checked on resume
  add(opts: { paths: string[] } & GitWriteOpts): Promise<void>;
  commit(opts: { message: string; paths?: string[] } & GitWriteOpts): Promise<{ sha: string }>;
  checkout(ref: string, opts?: { discard?: boolean } & GitWriteOpts): Promise<void>;
  fetch(opts?: { remote?: string } & GitWriteOpts): Promise<void>;
  pull(opts?: { rebase?: boolean; remote?: string; branch?: string } & GitWriteOpts): Promise<void>;
  push(
    opts?: {
      remote?: string;
      branch?: string;
      setUpstream?: boolean;
      force?: boolean;
    } & GitWriteOpts,
  ): Promise<void>;
  reset(opts: { to: string; mode?: "soft" | "mixed" | "hard" } & GitWriteOpts): Promise<void>;
  apply(opts: { patch: string; threeWay?: boolean } & GitWriteOpts): Promise<void>;
  tag(name: string, opts?: { ref?: string } & GitWriteOpts): Promise<void>;
  branch: {
    create(name: string, opts?: { from?: string; checkout?: boolean } & GitWriteOpts): Promise<void>;
    delete(name: string, opts?: { force?: boolean } & GitWriteOpts): Promise<void>;
  };
  stash: {
    push(opts?: { message?: string } & GitWriteOpts): Promise<void>;
    pop(opts?: GitWriteOpts): Promise<void>;
    drop(opts?: GitWriteOpts): Promise<void>;
  };
  clean(opts?: { force?: boolean } & GitWriteOpts): Promise<void>;
}

// ---------------------------------------------------------------------------
// Checks, integration, ledger
// ---------------------------------------------------------------------------

export type CheckStatus = "pass" | "fail" | "trust-prior" | "skipped";

export interface CheckResult {
  status: CheckStatus;
  evidence?: string;
}

export interface CheckOptions {
  exec?: [string, ...string[]];
  fn?: () => Promise<boolean | CheckResult> | boolean | CheckResult;
  /** Record a deliberately skipped re-run, trusting a prior run's result. */
  trustPrior?: { run: string; reason: string };
  /** A failing required check gates run completion. */
  required?: boolean;
  timeout?: Duration;
}

export interface IntegrateOptions {
  order?: "sequential";
  onConflict?: "ask" | "fail" | "agent";
}

export interface IntegrationLedger {
  merged: string[];
  conflicts: string[];
  quarantined: string[];
  skipped: string[];
}

export interface NoteInput {
  kind: "decision" | "claim" | "risk";
  text: string;
  evidence?: string;
}

// ---------------------------------------------------------------------------
// Budget & run info
// ---------------------------------------------------------------------------

export interface BudgetView {
  spent: { tokens: number; usd: number };
  /** null = unlimited on that axis. */
  remaining: { tokens: number | null; usd: number | null };
}

export interface RunInfo {
  id: string;
  cwd: string;
  baseRef?: string;
  depth: number;
}

export interface SubWorkflowOptions {
  budget?: { fraction?: number; tokens?: number; usd?: number };
  key?: string;
  label?: string;
}

// ---------------------------------------------------------------------------
// Ctx
// ---------------------------------------------------------------------------

export interface Ctx {
  // steps
  agent: AgentFn;
  parallel<T>(tasks: ReadonlyArray<ParallelTask<T>>, opts?: ParallelOptions): Promise<Settled<T>[]>;
  pipeline<I>(items: ReadonlyArray<I>): Pipeline<I, I>;
  /** Narrow Settled[] to values; drops are recorded and listed in the report. */
  ok<T>(settled: ReadonlyArray<Settled<T>>): T[];
  workflow<In, Out>(def: WorkflowDefinitionLike<In, Out>, input: In, opts?: SubWorkflowOptions): Promise<Out>;
  workflow(name: string, input: unknown, opts?: SubWorkflowOptions): Promise<unknown>;

  // humans
  gate(req: GateRequest): Promise<GateResult>;
  human: HumanApi;

  // side effects
  fs: FsApi;
  exec: ExecFn;
  bash: BashFn;
  fetch: FetchFn;
  env: EnvApi;
  secret(name: string): SecretHandle;
  git: GitApi;

  // checks & ledger
  check(name: string, opts: CheckOptions): Promise<CheckResult>;
  integrate(
    results: ReadonlyArray<DetailedAgentResult<unknown> | PatchRef>,
    opts?: IntegrateOptions,
  ): Promise<IntegrationLedger>;
  discard(results: ReadonlyArray<DetailedAgentResult<unknown> | PatchRef>): Promise<void>;
  note(note: NoteInput): Promise<void>;

  // durable waits
  signal<S extends AnySchema>(name: string, schema: S, opts?: { timeout?: Duration }): Promise<InferOut<S>>;
  sleep(duration: Duration): Promise<void>;

  // journaled replacements for banned globals
  now(): Promise<number>;
  random(): Promise<number>;
  uuid(): Promise<string>;

  // structure & observability
  phase(name: string): void;
  log(message: string): void;
  budget: BudgetView;
  run: RunInfo;
}

/**
 * Structural stand-in for WorkflowDefinition (defined in define.ts) so Ctx does not
 * create a type cycle. Any defineWorkflow() result satisfies it.
 */
export interface WorkflowDefinitionLike<In, Out> {
  readonly kind: "weft.workflow";
  readonly run: (ctx: Ctx, input: In) => Promise<Out>;
  readonly meta: { name?: string; description: string };
}

/** Re-exported here so a StepError's type is reachable from types-only imports. */
export type { StepError };
