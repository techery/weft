/**
 * The daemon's wire shapes, as `@techery/weft-daemon` serves them.
 *
 * Written out here rather than imported from the package: this app is served BY the
 * daemon but is not built with it, and a UI that compiles against the engine's internal
 * types would drag the whole workspace into a browser bundle. These are the fields the
 * screens actually read — a narrower contract than the engine's, on purpose, so a change
 * to something the UI never renders cannot break its build.
 */

export type RunStatus =
  | "planning"
  | "executing"
  | "waiting_for_human"
  | "waiting_for_signal"
  | "integrating"
  | "verifying"
  | "complete"
  | "failed"
  | "cancelled";

export type StepKind =
  | "agent"
  | "human"
  | "workflow"
  | "git"
  | "exec"
  | "bash"
  | "fetch"
  | "fs"
  | "env"
  | "check"
  | "sleep";

export type Risk = "low" | "medium" | "high" | "irreversible";
export type ApprovalMode = "auto" | "ask";

/** `GET /api/meta` */
export interface Meta {
  version: string;
  repo: { name: string; cwd: string; weftDir: string; runsDir: string };
  defaults: { provider: string; model?: string; effort?: string };
  limits: { concurrency: number; maxTurns: number; maxDepth: number; stepTimeoutMs: number };
  approvalPolicy: { tiers?: Partial<Record<Risk, ApprovalMode>>; actions?: Record<string, ApprovalMode> };
  fetchAllow: string[] | null;
  providers: Array<{ id: string; registered: boolean; concurrency?: number }>;
}

/** A row of `GET /api/runs`; `spend`, `steps` and `running` need `?spend=1`. */
export interface RunRow {
  runId: string;
  workflow: string;
  status: RunStatus;
  createdAt: number;
  updatedAt: number;
  parentRunId?: string;
  spend?: { tokens: number; usd: number };
  steps?: number;
  running?: number;
}

export interface StepState {
  seq: number;
  kind: StepKind;
  key?: string;
  label?: string;
  phase?: string;
  parentSeq?: number;
  route?: { provider: string; model?: string; effort?: string };
  status: "running" | "ok" | "failed";
  startedAt: number;
  endedAt?: number;
  usage?: { input?: number; output?: number; usd?: number };
  attempts?: number;
  error?: { code?: string; message?: string };
  output?: unknown;
  /** Output schema recorded when the step was scheduled; absent on older runs. */
  schema?: JsonSchema;
  sessionId?: string;
  transcriptRef?: { $blob: string; size: number; preview?: string };
  patchRef?: string;
  childRunId?: string;
}

export interface HumanState {
  id: string;
  seq: number;
  kind: string;
  question: string;
  detail?: string;
  risk?: Risk;
  schema: unknown;
  status: "pending" | "answered";
  answer?: unknown;
  answeredBy?: string;
  requestedAt: number;
  artifactRef?: { $blob: string; size: number; preview?: string };
}

/** `GET /api/runs/:id`, with `?detail=1` adding `limits` and `inputs`. */
export interface RunDetail {
  runId: string;
  workflow: string;
  status: RunStatus;
  input: unknown;
  output?: unknown;
  error?: { code?: string; message?: string };
  createdAt: number;
  updatedAt: number;
  parentRunId?: string;
  depth: number;
  cwd: string;
  phases: Array<{ name: string; steps: number[] }>;
  steps: StepState[];
  humans: HumanState[];
  notes: Array<{ kind: string; text: string; evidence?: string }>;
  checks: Array<{ name: string; status: string; evidence?: string; required: boolean }>;
  patches: {
    captured: Array<{ key: string; ref: string; files: string[]; outOfScope?: string[] }>;
    merged: Array<{ key: string; ref: string; conflicted?: boolean }>;
    discarded: Array<{ key: string; ref: string }>;
  };
  budget: { tokens: number; usd: number };
  /** The ceiling the run was started with. `?detail=1` only; null when it had none. */
  limits?: { tokens?: number; usd?: number } | null;
  /** What each step was scheduled with, by seq. `?detail=1` only. */
  inputs?: Record<string, unknown>;
  records: number;
}

/** One entry of `GET /api/pending`. */
export interface PendingRequest {
  runId: string;
  id: string;
  kind: string;
  question: string;
  detail?: string;
  schema: unknown;
  risk?: Risk;
  createdAt: number;
  workflow: string;
  rootRunId: string;
  rootWorkflow: string;
}

export interface PendingResponse {
  pending: PendingRequest[];
  unreadable: Array<{ runId: string; error: string }>;
}

/** `GET /api/workflows` */
export interface WorkflowRow {
  /** Stable identity for durable workflow-owned state. */
  id: string;
  name: string;
  file: string;
  description: string;
}

/** `GET /api/workflows/:name` */
export interface WorkflowDetail extends WorkflowRow {
  hash: string;
  /** JSON Schema, or null when the declaration is not convertible. */
  input: JsonSchema | null;
  output: JsonSchema | null;
  /** JSON Schema for workflow-owned `task.extensions`, if declared. */
  taskExtensions: JsonSchema | null;
  defaults: { provider?: string; model?: string; effort?: string } | null;
}

export type TaskStatus = "todo" | "in_progress" | "blocked" | "done" | "cancelled";
export type TaskPriority = "low" | "medium" | "high" | "critical";

/** One entry of `GET /api/workflows/:name/tasks`. */
export interface WorkflowTask {
  schemaVersion: number;
  id: string;
  workflowId: string;
  title: string;
  description: string;
  status: TaskStatus;
  priority: TaskPriority;
  tags: string[];
  dependencies: string[];
  relatedFiles: string[];
  acceptanceCriteria: Array<{ id: string; text: string; met: boolean }>;
  notes: Array<{ text: string; at: number; actor: string }>;
  extensions: unknown;
  createdAt: number;
  updatedAt: number;
  createdBy: string;
  updatedBy: string;
  revision: number;
  appliedOperations: string[];
}

/** `GET /api/workflows/:name/stats` */
export interface WorkflowStats {
  name: string;
  windowDays: number;
  runs: number;
  truncated: boolean;
  settled: number;
  ok: number;
  failed: number;
  cancelled: number;
  successRate: number | null;
  p50Ms: number | null;
  p95Ms: number | null;
  usd: number;
  tokens: number;
  p50Usd: number | null;
  lastRunAt: number | null;
  recent: Array<{
    runId: string;
    status: RunStatus;
    createdAt: number;
    updatedAt: number;
    usd: number;
    tokens: number;
    agentSteps: number;
  }>;
}

/** `GET /api/runs/:id/artifacts` */
export interface ArtifactEntry {
  ref: string;
  id: string;
  kind: "patch" | "artifact";
  size: number | null;
  producedBy: { seq: number; kind: string; label: string } | null;
  at: number | null;
  key?: string;
  files?: string[];
  preview?: string;
  gate?: { id: string; kind: string; question: string };
  available: boolean;
}

export interface FileStat {
  path: string;
  adds: number;
  dels: number;
  status: "added" | "deleted" | "modified" | "binary";
}

/** `GET /api/runs/:id/patch` */
export interface PatchResponse {
  runId: string;
  patches: Array<{
    key: string;
    ref: string;
    files: string[];
    outOfScope: string[];
    merged: boolean;
    discarded: boolean;
    available: boolean;
    stats: FileStat[];
    diff?: string;
  }>;
}

/** `GET /api/config` */
export interface ConfigResponse {
  file: string;
  path: string;
  exists: boolean;
  config: WeftConfigFile;
  effective: {
    defaults: { provider: string; model?: string; effort?: string };
    limits: Meta["limits"];
    approvalPolicy: Meta["approvalPolicy"];
    fetchAllow: string[] | null;
    providers: Record<string, { concurrency?: number }>;
  };
}

/** The parts of `.weft/config.json` the settings screen edits. Unknown keys are preserved. */
export interface WeftConfigFile {
  defaults?: { provider?: string; model?: string; effort?: string };
  approvalPolicy?: { tiers?: Partial<Record<Risk, ApprovalMode>>; actions?: Record<string, ApprovalMode> };
  limits?: Record<string, number>;
  fetchAllow?: string[];
  providers?: Record<string, { concurrency?: number }>;
  [key: string]: unknown;
}

/** One journal record, as the SSE stream sends it. */
export interface JournalRecord {
  i: number;
  at: number;
  ev: JournalEvent;
}

export type JournalEvent = { type: string } & Record<string, unknown>;

/** A JSON Schema subset — enough to render a form from a workflow's declared input. */
export interface JsonSchema {
  type?: string | string[];
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  enum?: unknown[];
  const?: unknown;
  default?: unknown;
  description?: string;
  title?: string;
  anyOf?: JsonSchema[];
  oneOf?: JsonSchema[];
  allOf?: JsonSchema[];
  minimum?: number;
  maximum?: number;
  additionalProperties?: boolean | JsonSchema;
}
