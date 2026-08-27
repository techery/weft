/**
 * The full authoring surface: everything a workflow touches comes through `ctx`.
 * These types are the contract between workflow code and the Weft engine.
 */
import type { Duration } from "./duration.ts";
import type { StepError } from "./errors.ts";
import type { AnySchema, InferIn, InferOut } from "./schema.ts";
import type { Settled } from "./settled.ts";
import type { InputUiView, UiApi } from "./ui.ts";

// ---------------------------------------------------------------------------
// Routing & effort
// ---------------------------------------------------------------------------

export type ProviderId = "claude" | "codex" | (string & {});
export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

/** Claude Agent SDK mechanics that do not alter Weft's engine-owned safety boundary. */
export interface ClaudeAgentProviderOptions {
  /** `default` can ask through Weft's permission hook; `dontAsk` denies tools that need an ask. */
  permissionMode?: "default" | "dontAsk";
}

/** Codex SDK mechanics. Engine-owned read/write scope always wins over these settings. */
export interface CodexAgentProviderOptions {
  /** May narrow a write step to read-only; cannot make a read-only Weft step writable. */
  sandboxMode?: "read-only" | "workspace-write";
  networkAccess?: boolean;
  webSearch?: "disabled" | "cached" | "live";
}

/**
 * Provider option registry. Provider packages may augment this interface for their id;
 * Weft ships the built-in Claude and Codex entries so ordinary workflows stay typed.
 */
export interface AgentProviderOptions {
  claude?: ClaudeAgentProviderOptions;
  codex?: CodexAgentProviderOptions;
}

/** Capabilities a workflow requires before Weft spends a provider turn. */
export interface ProviderRequirements {
  structured?: "native" | "tool";
  permissionHook?: true;
  sessionResume?: true;
}

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

// ---------------------------------------------------------------------------
// Workflow task context
// ---------------------------------------------------------------------------

export type WorkflowTaskStatus = "todo" | "in_progress" | "blocked" | "done" | "cancelled";
export type WorkflowTaskPriority = "low" | "medium" | "high" | "critical";

export interface WorkflowTaskCriterion {
  id: string;
  text: string;
  met: boolean;
}

export interface WorkflowTaskNote {
  text: string;
  at: number;
  actor: string;
}

/** The stable task record exposed to workflow code. */
export interface WorkflowTaskRecord<Extensions = unknown> {
  id: string;
  workflowId: string;
  extensionSchemaVersion: number;
  dedupeKey?: string;
  title: string;
  description: string;
  status: WorkflowTaskStatus;
  priority: WorkflowTaskPriority;
  tags: string[];
  dependencies: string[];
  relatedFiles: string[];
  acceptanceCriteria: WorkflowTaskCriterion[];
  notes: WorkflowTaskNote[];
  extensions: Extensions;
  createdAt: number;
  updatedAt: number;
  createdBy: string;
  updatedBy: string;
  revision: number;
}

/** Bounded task projection supplied to workflow and agent context. Full note history stays in CLI/UI. */
export interface WorkflowTaskSummary<Extensions = unknown> {
  id: string;
  revision: number;
  extensionSchemaVersion: number;
  dedupeKey?: string;
  title: string;
  description: string;
  status: WorkflowTaskStatus;
  priority: WorkflowTaskPriority;
  tags: string[];
  dependencies: string[];
  relatedFiles: string[];
  acceptanceCriteria: WorkflowTaskCriterion[];
  latestNote: WorkflowTaskNote | null;
  /** Undefined schema output is represented by key absence on the journal wire. */
  extensions?: Exclude<Extensions, undefined>;
  updatedAt: number;
}

/** Filters are conjunctive; repeated values within one field are alternatives. */
export interface WorkflowTaskSelector {
  ids?: string[];
  dedupeKeys?: string[];
  statuses?: WorkflowTaskStatus[];
  tags?: string[];
  relatedFiles?: string[];
  /** Defaults to 50 and is capped by the host. */
  limit?: number;
}

export interface WorkflowTaskSnapshot<Extensions = unknown> {
  total: number;
  truncated: boolean;
  tasks: WorkflowTaskSummary<Extensions>[];
}

/** Per-agent authority over the automatically injected task observation. */
export type AgentTaskAccess = WorkflowTaskSelector & { mode?: "read" | "write" };

export interface WorkflowTaskCreateInput<Extensions = unknown> {
  title: string;
  description: string;
  status?: WorkflowTaskStatus;
  priority?: WorkflowTaskPriority;
  tags?: string[];
  dependencies?: string[];
  relatedFiles?: string[];
  acceptanceCriteria?: string[];
  extensions?: Extensions;
}

export interface WorkflowTaskUpdateInput<Extensions = unknown> {
  title?: string;
  description?: string;
  status?: WorkflowTaskStatus;
  priority?: WorkflowTaskPriority;
  tags?: string[];
  dependencies?: string[];
  relatedFiles?: string[];
  /** Replaces the criteria; `resetAcceptance` controls whether matching criteria keep their state. */
  acceptanceCriteria?: string[];
  resetAcceptance?: boolean;
  extensions?: Extensions;
  ifRevision?: number;
}

export interface WorkflowTaskUpsertInput<Extensions = unknown> {
  create: WorkflowTaskCreateInput<Extensions>;
  update?: WorkflowTaskUpdateInput<Extensions>;
  /** Appended atomically with the create/update, so replay cannot lose the occurrence evidence. */
  note?: string;
}

/**
 * Preferred recurring-task form. `set` is shared between the create input and
 * the later update patch. Optional fields omitted from it take create defaults
 * initially and remain unchanged on update. `dedupeKey` identifies the logical
 * task; `key` identifies this journaled workflow step.
 */
export interface WorkflowTaskUpsertSpec<Extensions = unknown> extends WorkflowTaskStepOptions {
  dedupeKey: string;
  set: WorkflowTaskCreateInput<Extensions>;
  /** Appended atomically with the create/update. */
  note?: string;
}

export interface WorkflowTaskStepOptions {
  /** Stable step identity used by replay. */
  key: string;
}

export interface WorkflowTasksApi<ExtensionInput = unknown, Extensions = ExtensionInput> {
  /** A journaled, replay-stable observation. New runs read fresh task state; resumes reuse what they saw. */
  observe(
    selector: WorkflowTaskSelector,
    opts: WorkflowTaskStepOptions,
  ): Promise<WorkflowTaskSnapshot<Extensions>>;
  /** Atomically converge one workflow-scoped task on `set` and append optional occurrence evidence. */
  upsert(input: WorkflowTaskUpsertSpec<ExtensionInput>): Promise<void>;
  /** @deprecated Prefer `upsert({ dedupeKey, key, set, note })`; keep this for divergent create/update policy. */
  upsert(
    dedupeKey: string,
    input: WorkflowTaskUpsertInput<ExtensionInput>,
    opts: WorkflowTaskStepOptions,
  ): Promise<void>;
  update(
    id: string,
    input: WorkflowTaskUpdateInput<ExtensionInput>,
    opts: WorkflowTaskStepOptions,
  ): Promise<void>;
  note(id: string, text: string, opts: WorkflowTaskStepOptions & { ifRevision?: number }): Promise<void>;
  setCriterion(
    id: string,
    criterionId: string,
    met: boolean,
    opts: WorkflowTaskStepOptions & { ifRevision?: number },
  ): Promise<void>;
}

export interface RetryOptions {
  attempts: number;
  /** Delay before each retry; scales linearly with the attempt number. */
  backoff?: Duration;
}

export interface AgentOptions<S extends AnySchema> {
  /** Required on every step: the only way out is a value this schema validates. */
  schema: S;
  /**
   * Stable identity for replay, tests, and the tree.
   *
   * Omitted, a step is identified by its CONTENT alone (prompt, schema, routing), and the
   * auto `Phase/agent#N` is a display label that identity ignores. That is fine until two
   * call sites can produce the same content: replay then cannot tell them apart, and
   * rather than hand one the other's journaled answer it re-runs them. Give each call a
   * distinct key whenever that is possible — it is what makes their results reusable.
   */
  key?: string;
  /** Cosmetic label for the tree; defaults to the key. */
  label?: string;
  provider?: ProviderId;
  /** Options for concrete provider adapters. Only the selected provider's entry is dispatched. */
  providerOptions?: AgentProviderOptions;
  /** Fail before a paid turn when the selected provider cannot meet these requirements. */
  providerRequirements?: ProviderRequirements;
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
  /** Override workflow task access for this step. Without `meta.tasks`, the default is no context. */
  tasks?: false | AgentTaskAccess;
}

/** Per-invocation overrides for a reusable agent; its output schema is fixed by the definition. */
export type AgentRunOptions<S extends AnySchema> = Omit<AgentOptions<S>, "schema">;

/** Reusable role defaults cannot own a call-site key or silently make its result nullable. */
export type AgentDefinitionDefaults<S extends AnySchema> = Omit<AgentRunOptions<S>, "key" | "onError">;

/** A stateless, reusable agent role: prompt, output contract, and routing defaults. */
export interface AgentDefinition<Input, S extends AnySchema, ParsedInput = Input> {
  readonly kind: "weft.agent";
  readonly name: string;
  readonly description?: string;
  readonly prompt: PromptTemplate<Input, ParsedInput>;
  readonly schema: S;
  readonly defaults: Readonly<AgentDefinitionDefaults<S>>;
}

export interface Usage {
  /** Input tokens (prompt + cache reads are broken out separately). */
  input: number;
  output: number;
  cacheRead?: number;
  usd?: number;
  /** Provider calls this record aggregates. Absent means 1; a child-workflow
   * roll-up carries the child's real call count so a resumed budget's
   * per-call average stays honest. */
  samples?: number;
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
  <Input, S extends AnySchema, ParsedInput>(
    definition: AgentDefinition<Input, S, ParsedInput>,
    input: Input,
    opts: AgentRunOptions<S> & { onError: "null" },
  ): Promise<InferOut<S> | null>;
  <Input, S extends AnySchema, ParsedInput>(
    definition: AgentDefinition<Input, S, ParsedInput>,
    input: Input,
    opts?: AgentRunOptions<S>,
  ): Promise<InferOut<S>>;
  <S extends AnySchema>(
    prompt: string,
    opts: AgentOptions<S> & { onError: "null" },
  ): Promise<InferOut<S> | null>;
  <S extends AnySchema>(prompt: string, opts: AgentOptions<S>): Promise<InferOut<S>>;
  /** Same options; returns the value plus usage, files, patch, attempts, sessionId. */
  detailed<Input, S extends AnySchema, ParsedInput>(
    definition: AgentDefinition<Input, S, ParsedInput>,
    input: Input,
    opts: AgentRunOptions<S> & { onError: "null" },
  ): Promise<DetailedAgentResult<InferOut<S>> | null>;
  detailed<Input, S extends AnySchema, ParsedInput>(
    definition: AgentDefinition<Input, S, ParsedInput>,
    input: Input,
    opts?: AgentRunOptions<S>,
  ): Promise<DetailedAgentResult<InferOut<S>>>;
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

/** Prefer thunks or the item/mapper overload; promises start before concurrency can be applied. */
export type ParallelTask<T> = Promise<T> | (() => Promise<T> | T);

export interface ParallelOptions {
  /** Caps lanes. Already-started promise arrays cannot be capped. */
  concurrency?: number;
  /** `settle` preserves per-lane failures; `throw` fails after all lanes settle. */
  errors?: "settle" | "throw";
}

// ---------------------------------------------------------------------------
// Reusable authoring definitions and execution scopes
// ---------------------------------------------------------------------------

export interface PromptSection {
  readonly kind: "section";
  readonly title: string;
  readonly body: string;
}

export type PromptPart = string | PromptSection | false | null | undefined | readonly PromptPart[];

/** A named, testable prompt renderer. It contains no runtime state or side effects. */
export interface PromptTemplate<Input, ParsedInput = Input> {
  readonly kind: "weft.prompt";
  readonly name: string;
  readonly input?: AnySchema;
  readonly render: (input: ParsedInput) => string;
}

/** A reusable orchestration recipe. Its effects remain visible as ordinary ctx calls. */
export interface StepDefinition<Input, Output> {
  readonly kind: "weft.step";
  readonly name: string;
  readonly description?: string;
  readonly run: (ctx: Ctx<any, any>, input: Input) => Promise<Output>;
}

/** A schema-backed transparent recipe. Nested effects remain ordinary journal entries. */
export interface RecipeDefinition<Input, Output, ParsedInput = Input, RawOutput = Output> {
  readonly kind: "weft.recipe";
  readonly name: string;
  readonly description?: string;
  readonly input: AnySchema;
  readonly output: AnySchema;
  readonly run: (ctx: Ctx<any, any>, input: ParsedInput) => Promise<RawOutput> | RawOutput;
}

/** Defaults inherited by calls made through a scoped context. Explicit call options win. */
export interface CtxScopeOptions {
  /** Routing/execution policy only; null fallback and task authority stay explicit elsewhere. */
  agent?: Omit<AgentOptions<AnySchema>, "schema" | "key" | "label" | "onError" | "tasks">;
  tasks?: false | AgentTaskAccess;
  parallel?: ParallelOptions;
}

export interface Pipeline<Item, Prev> {
  step<Next>(fn: (prev: Prev, item: Item, index: number) => Promise<Next> | Next): Pipeline<Item, Next>;
  /** A falsy verdict drops the lane (dropped lanes do not appear in run()'s result). */
  filter(fn: (prev: Prev, item: Item, index: number) => boolean | Promise<boolean>): Pipeline<Item, Prev>;
  map<Next>(fn: (prev: Prev, item: Item, index: number) => Next | Promise<Next>): Pipeline<Item, Next>;
  run(opts?: ParallelOptions): Promise<Settled<Prev>[]>;
}

export interface ParallelFn {
  <T>(tasks: ReadonlyArray<ParallelTask<T>>, opts?: ParallelOptions): Promise<Settled<T>[]>;
  <Item, Result>(
    items: ReadonlyArray<Item>,
    run: (item: Item, index: number) => Promise<Result> | Result,
    opts?: ParallelOptions,
  ): Promise<Settled<Result>[]>;
}

export interface SequenceItemContext<TaskExtensionInput = unknown, TaskExtensions = TaskExtensionInput> {
  /** Phase-scoped context for this item. */
  ctx: Ctx<TaskExtensionInput, TaskExtensions>;
  /** Stable item key selected by `keyOf`. */
  itemKey: string;
  /** Compose a globally unique step key beneath this sequence item. */
  key(local: string): string;
}

export interface SequenceOptions<Item> {
  /** Stable identity for the item; duplicate identities fail before any item runs. */
  keyOf(item: Item, index: number): string;
  /** Cosmetic phase label. Defaults to the stable item key. */
  phase?(item: Item, index: number): string;
  /** Prefix for generated step keys; defaults to `item`. */
  keyPrefix?: string;
}

export type SequenceFn<TaskExtensionInput = unknown, TaskExtensions = TaskExtensionInput> = <Item, Result>(
  items: ReadonlyArray<Item>,
  opts: SequenceOptions<Item>,
  run: (
    item: Item,
    scope: SequenceItemContext<TaskExtensionInput, TaskExtensions>,
    index: number,
  ) => Promise<Result> | Result,
) => Promise<Result[]>;

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

/**
 * What a passed deadline does. `default` carries the schema's INPUT (raw JSON)
 * value: it is journaled with the request and applied through the schema like a
 * human answer, so a transform's output (a Date, a class) is produced from it —
 * never stored in it.
 */
export type HumanTimeoutPolicy<T> = "deny" | "escalate" | { default: T };

export interface HumanAskOptions<S extends AnySchema, Props = never> {
  /**
   * Stable identity for replay, exactly as on {@link AgentOptions.key}. A human step is
   * otherwise identified by its CONTENT alone — question, detail, schema, risk, timeouts —
   * so two gates that ask the same thing in different contexts ("Approve?" for staging and
   * for prod, or one per item in a loop) are indistinguishable, and an edit that moves them
   * makes replay re-open both rather than guess. Give each a distinct `key` and they stay
   * reusable across the edit.
   */
  key?: string;
  question: string;
  schema: S;
  detail?: string;
  timeout?: Duration;
  onTimeout?: HumanTimeoutPolicy<InferIn<S>>;
  /** Optional workflow-provided presentation; the host remains the submission authority. */
  ui?: { view: InputUiView<Props, InferIn<S>>; props: Props };
}

export interface HumanApproveOptions {
  /**
   * Stable identity for replay, exactly as on {@link AgentOptions.key}. A human step is
   * otherwise identified by its CONTENT alone — question, detail, schema, risk, timeouts —
   * so two gates that ask the same thing in different contexts ("Approve?" for staging and
   * for prod, or one per item in a loop) are indistinguishable, and an edit that moves them
   * makes replay re-open both rather than guess. Give each a distinct `key` and they stay
   * reusable across the edit.
   */
  key?: string;
  action: string;
  detail?: string;
  timeout?: Duration;
  onTimeout?: HumanTimeoutPolicy<{ approved: boolean; note?: string }>;
}

export interface HumanReviewArtifactSubject {
  kind: "artifact";
  content: string;
  mediaType?: string;
  label?: string;
}

export interface HumanReviewFileSubject {
  kind: "file";
  /** Repository-relative path. */
  path: string;
  /** `edit` presents an editor and applies the submitted draft with a content-hash guard. */
  mode?: "view" | "edit";
}

export type HumanReviewSubject = HumanReviewArtifactSubject | HumanReviewFileSubject;

export type HumanReviewAttachment = HumanReviewArtifactSubject;

interface HumanReviewCommonOptions<S extends AnySchema, Props> {
  /**
   * Stable identity for replay, exactly as on {@link AgentOptions.key}. A human step is
   * otherwise identified by its CONTENT alone — question, detail, schema, risk, timeouts —
   * so two gates that ask the same thing in different contexts ("Approve?" for staging and
   * for prod, or one per item in a loop) are indistinguishable, and an edit that moves them
   * makes replay re-open both rather than guess. Give each a distinct `key` and they stay
   * reusable across the edit.
   */
  key?: string;
  question?: string;
  schema: S;
  /** Supplemental immutable artifacts shown beside the primary subject. */
  attachments?: HumanReviewAttachment[];
  timeout?: Duration;
  onTimeout?: HumanTimeoutPolicy<InferIn<S>>;
  /** Optional workflow-provided presentation; the host remains the submission authority. */
  ui?: { view: InputUiView<Props, InferIn<S>>; props: Props };
}

/** Existing artifact shorthand remains source-compatible. */
export type HumanReviewOptions<S extends AnySchema, Props = never> = HumanReviewCommonOptions<S, Props> &
  ({ artifact: string; subject?: never } | { subject: HumanReviewSubject; artifact?: never });

export interface HumanReviewDetailedResult<T> {
  answer: T;
  subject:
    | { kind: "artifact"; ref: string; sha256: string; size: number; mediaType?: string; label?: string }
    | {
        kind: "file";
        path: string;
        mode: "view" | "edit";
        beforeSha256: string;
        afterSha256: string;
        ref: string;
        size: number;
        applied: boolean;
      };
}

export interface HumanApi {
  /** Always asks a person; the answer is validated against the schema like any output. */
  ask<S extends AnySchema, Props = never>(opts: HumanAskOptions<S, Props>): Promise<InferOut<S>>;
  approve(opts: HumanApproveOptions): Promise<{ approved: boolean; note?: string }>;
  review: {
    <S extends AnySchema, Props = never>(opts: HumanReviewOptions<S, Props>): Promise<InferOut<S>>;
    detailed<S extends AnySchema, Props = never>(
      opts: HumanReviewOptions<S, Props>,
    ): Promise<HumanReviewDetailedResult<InferOut<S>>>;
  };
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
  /** Returns the COMMIT the tag points at — journaled so resume can verify the
   * tag was not re-pointed (git tag -f) while the run was suspended. */
  tag(name: string, opts?: { ref?: string } & GitWriteOpts): Promise<{ sha: string }>;
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

export type CheckStatus = "pass" | "fail";
export type CheckDisposition = "executed" | "trusted" | "waived";
export type CheckPolicy = "required" | "advisory";

export type CheckEvidence =
  | { kind: "text"; text: string }
  | { kind: "file"; path: string; line?: number; message?: string }
  | { kind: "metric"; name: string; actual: number; expected?: number; unit?: string }
  | { kind: "command"; exitCode: number; output?: string }
  | { kind: "artifact"; ref: string; label?: string };

/** Outcome produced by an executed check. Trust and waiver disposition belong to invocation policy. */
export interface CheckExecutionResult {
  status: CheckStatus;
  summary?: string;
  evidence?: string;
  details?: readonly CheckEvidence[];
}

export interface CheckResult extends CheckExecutionResult {
  disposition?: CheckDisposition;
}

export interface CheckRunContext {
  signal: AbortSignal;
}

interface CheckCommonOptions {
  /** Stable replay identity for this invocation. */
  key?: string;
  /** A failing required check gates run completion. */
  required?: boolean;
  policy?: CheckPolicy;
  timeout?: Duration;
}

export type CheckOptions = CheckCommonOptions &
  (
    | { exec: [string, ...string[]]; fn?: never; trustPrior?: never; skip?: never }
    | {
        exec?: never;
        fn: (signal: AbortSignal) => Promise<boolean | CheckResult> | boolean | CheckResult;
        trustPrior?: never;
        skip?: never;
      }
    | { exec?: never; fn?: never; trustPrior: { run: string; reason: string }; skip?: never }
    | { exec?: never; fn?: never; trustPrior?: never; skip: { reason: string } }
  );

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** Source and policy stored by a reusable check; invocation identity remains at the call site. */
export type CheckDefinitionOptions = DistributiveOmit<CheckOptions, "key">;

export interface CheckInvocationOptions {
  key?: string;
  /** Invocation policy may strengthen an advisory definition, never weaken a required one. */
  policy?: "required";
  timeout?: Duration;
  trust?: { run: string; reason: string };
  waive?: { reason: string; issue?: string; expiresAt?: string };
}

interface CheckDefinitionBase<Input, Name extends string, ParsedInput> {
  readonly kind: "weft.check";
  readonly name: Name;
  readonly description?: string;
  readonly policy: CheckPolicy;
  readonly revision?: string;
  readonly input?: AnySchema;
  readonly __input?: Input;
  readonly __parsedInput?: ParsedInput;
}

/** A reusable check whose validated input is passed directly to one command or callback. */
export type CheckDefinition<Input = void, Name extends string = string, ParsedInput = Input> =
  | (CheckDefinitionBase<Input, Name, ParsedInput> & {
      readonly mode: "run";
      readonly run: (
        input: ParsedInput,
        context: CheckRunContext,
      ) => Promise<boolean | CheckExecutionResult> | boolean | CheckExecutionResult;
    })
  | (CheckDefinitionBase<Input, Name, ParsedInput> & {
      readonly mode: "command";
      readonly command: (input: ParsedInput) => [string, ...string[]];
    });

/** A reusable group of static checks. Each check remains a separate journal entry. */
export interface CheckSuiteDefinition<
  Checks extends readonly CheckDefinition<void>[] = readonly CheckDefinition<void>[],
> {
  readonly kind: "weft.check-suite";
  readonly name: string;
  readonly description?: string;
  readonly checks: Checks;
  readonly concurrency?: number;
}

export interface CheckSuiteMember<
  Definition extends CheckDefinition<any, any, any> = CheckDefinition<any, any, any>,
> {
  readonly definition: Definition;
  readonly input: Definition extends CheckDefinition<infer Input, any, any> ? Input : never;
}

export interface CheckSuiteUse {
  <Name extends string>(
    definition: CheckDefinition<void, Name>,
  ): CheckSuiteMember<CheckDefinition<void, Name>>;
  <Input, Name extends string, ParsedInput>(
    definition: CheckDefinition<Input, Name, ParsedInput>,
    input: Input,
  ): CheckSuiteMember<CheckDefinition<Input, Name, ParsedInput>>;
}

export type CheckSuiteMembers = Record<string, CheckSuiteMember>;

/** A reusable contextual suite whose named members are resolved from one validated input. */
export interface ParameterizedCheckSuiteDefinition<
  Input,
  Members extends CheckSuiteMembers,
  ParsedInput = Input,
> {
  readonly kind: "weft.check-suite";
  readonly name: string;
  readonly description?: string;
  readonly input: AnySchema;
  readonly resolve: (input: ParsedInput) => Members;
  readonly concurrency?: number;
  readonly __input?: Input;
}

export interface CheckSuiteResult<
  Checks extends readonly CheckDefinition<void>[] = readonly CheckDefinition<void>[],
> {
  passed: boolean;
  results: { [Definition in Checks[number] as Definition["name"]]: CheckResult };
}

export interface ParameterizedCheckSuiteResult<Members extends CheckSuiteMembers> {
  passed: boolean;
  results: { [Name in keyof Members]: CheckResult };
}

export interface CheckSuiteInvocationOptions {
  /** Prefixes each member's replay key as `<keyPrefix>:<check name>`. */
  keyPrefix?: string;
  /** Strengthens every advisory member to required. */
  policy?: "required";
  /** Overrides timeout for every member. */
  timeout?: Duration;
  /** Overrides the suite's concurrency. */
  concurrency?: number;
}

export interface CheckFn {
  (definition: CheckDefinition<void>, opts?: CheckInvocationOptions): Promise<CheckResult>;
  <Input, ParsedInput>(
    definition: CheckDefinition<Input, string, ParsedInput>,
    input: Input,
    opts?: CheckInvocationOptions,
  ): Promise<CheckResult>;
  <const Checks extends readonly CheckDefinition<void>[]>(
    suite: CheckSuiteDefinition<Checks>,
    opts?: CheckSuiteInvocationOptions,
  ): Promise<CheckSuiteResult<Checks>>;
  <Input, ParsedInput, Members extends CheckSuiteMembers>(
    suite: ParameterizedCheckSuiteDefinition<Input, Members, ParsedInput>,
    input: Input,
    opts?: CheckSuiteInvocationOptions,
  ): Promise<ParameterizedCheckSuiteResult<Members>>;
  /** @deprecated Use `defineCheck()` and invoke its definition. */
  (name: string, opts: CheckOptions): Promise<CheckResult>;
  /** @deprecated Use `defineCheck({ command })`. */
  exec(name: string, command: [string, ...string[]], opts?: CheckCommonOptions): Promise<CheckResult>;
  /**
   * @deprecated Use `defineCheck({ run })`.
   * The signal fires if the check times out — wire it into what the fn awaits, or
   * work past the timeout keeps running in the background (JS cannot force-kill it).
   */
  fn(
    name: string,
    run: (signal: AbortSignal) => Promise<boolean | CheckResult> | boolean | CheckResult,
    opts?: CheckCommonOptions,
  ): Promise<CheckResult>;
  /** @deprecated Use invocation `{ trust }` on a revisioned reusable check. */
  trust(
    name: string,
    prior: { run: string; reason: string },
    opts?: Omit<CheckCommonOptions, "timeout">,
  ): Promise<CheckResult>;
  /** @deprecated Use invocation `{ waive }` on a reusable check. */
  skip(name: string, reason: string, opts?: Omit<CheckCommonOptions, "timeout">): Promise<CheckResult>;
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

export interface Ctx<TaskExtensionInput = unknown, TaskExtensions = TaskExtensionInput> {
  // steps
  agent: AgentFn;
  parallel: ParallelFn;
  /** Sequential item traversal with stable item keys and nested phase contexts. */
  sequence: SequenceFn<TaskExtensionInput, TaskExtensions>;
  pipeline<I>(items: ReadonlyArray<I>): Pipeline<I, I>;
  /** Tolerantly collect values; drops are recorded and listed in the report. */
  successes<T>(settled: ReadonlyArray<Settled<T>>): T[];
  /** Return all values or throw the first lane failure after every lane has settled. */
  all<T>(settled: ReadonlyArray<Settled<T>>): T[];
  workflow<In, Out>(def: WorkflowDefinitionLike<In, Out>, input: In, opts?: SubWorkflowOptions): Promise<Out>;
  workflow(name: string, input: unknown, opts?: SubWorkflowOptions): Promise<unknown>;

  // humans
  gate(req: GateRequest): Promise<GateResult>;
  human: HumanApi;
  /** Durable custom presentations. Rendering is browser-only and never mutates workflow values. */
  ui: UiApi;

  // side effects
  fs: FsApi;
  exec: ExecFn;
  bash: BashFn;
  fetch: FetchFn;
  env: EnvApi;
  secret(name: string): SecretHandle;
  git: GitApi;

  // checks & ledger
  check: CheckFn;
  integrate(
    results: ReadonlyArray<DetailedAgentResult<unknown> | PatchRef>,
    opts?: IntegrateOptions,
  ): Promise<IntegrationLedger>;
  discard(results: ReadonlyArray<DetailedAgentResult<unknown> | PatchRef>): Promise<void>;
  note(note: NoteInput): Promise<void>;
  tasks: WorkflowTasksApi<TaskExtensionInput, TaskExtensions>;

  // reusable composition
  /** Derive an immutable context whose defaults are inherited by all nested calls. */
  scope(opts: CtxScopeOptions): Ctx<TaskExtensionInput, TaskExtensions>;
  /** Run a schema-backed transparent recipe. */
  recipe<Input, Output, ParsedInput, RawOutput>(
    definition: RecipeDefinition<Input, Output, ParsedInput, RawOutput>,
    input: Input,
  ): Promise<Output>;
  /** @deprecated Use a schema-backed `defineRecipe()` with `ctx.recipe()`. */
  step<Input, Output>(definition: StepDefinition<Input, Output>, input: Input): Promise<Output>;

  // durable waits
  signal<S extends AnySchema>(name: string, schema: S, opts?: { timeout?: Duration }): Promise<InferOut<S>>;
  sleep(duration: Duration): Promise<void>;

  // journaled replacements for banned globals
  now(): Promise<number>;
  random(): Promise<number>;
  uuid(): Promise<string>;

  // structure & observability
  /**
   * Announce a phase and return an immutable context bound to it. Ignoring the
   * return value preserves the legacy statement-style API.
   */
  phase(name: string): Ctx<TaskExtensionInput, TaskExtensions>;
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
  /** Raw value accepted by the workflow input schema. */
  readonly __input?: In;
  readonly run: (ctx: Ctx<any, any>, input: any) => Promise<Out>;
  readonly meta: { id?: string; name?: string; description: string };
}

/** Re-exported here so a StepError's type is reachable from types-only imports. */
export type { StepError };
