/** Declaration-only workspace surface for the Weft DSL prototype. */
import type { PatchRef } from "./agent.ts";
import type { GitConflictResolver } from "./effects.ts";
import type { Risk } from "./shared.ts";
import type { Ctx } from "./workflow.ts";

// ---------------------------------------------------------------------------
// Workspaces, patches, integration, gates, and notes
// ---------------------------------------------------------------------------

/**
 * Why: Gives the workspace DSL an explicit apply patches options contract instead of relying on untyped values.
 * Use: Import it when declaring, configuring, or consuming the corresponding workspace API.
 */
export interface ApplyPatchesOptions<Context = unknown> {
  order?: "sequential";
  onConflict?: "ask" | "fail" | GitConflictResolver<Context>;
}

/**
 * Why: Gives the workspace DSL an explicit integrate options contract instead of relying on untyped values.
 * Use: Import it when declaring, configuring, or consuming the corresponding workspace API.
 */
export interface IntegrateOptions<Context = unknown> extends ApplyPatchesOptions<Context> {}

/**
 * Why: Gives the workspace DSL an explicit integration ledger contract instead of relying on untyped values.
 * Use: Import it when declaring, configuring, or consuming the corresponding workspace API.
 */
export interface IntegrationLedger {
  merged: string[];
  conflicts: string[];
  quarantined: string[];
  skipped: string[];
}

/**
 * Why: Gives the workspace DSL an explicit capture options contract instead of relying on untyped values.
 * Use: Import it when declaring, configuring, or consuming the corresponding workspace API.
 */
export interface CaptureOptions {
  paths: string[];
}

/**
 * Why: Gives the workspace DSL an explicit nested workspace options contract instead of relying on untyped values.
 * Use: Import it when declaring, configuring, or consuming the corresponding workspace API.
 */
export interface NestedWorkspaceOptions {
  key: string;
  from?: string;
}

/**
 * Why: Gives the workspace DSL an explicit checkout lease options contract instead of relying on untyped values.
 * Use: Import it when declaring, configuring, or consuming the corresponding workspace API.
 */
export interface CheckoutLeaseOptions {
  key: string;
  checkout: string;
}

/**
 * Why: Provides a disposable direct-write tree for composing and verifying patches before promotion.
 * Use: Receive it inside `ctx.workspace.with` and finish by calling `capture`.
 */
export interface CandidateWorkspaceContext<TaskInput = unknown, TaskOutput = TaskInput>
  extends Ctx<TaskInput, TaskOutput, true> {
  apply(patches: ReadonlyArray<PatchRef>, opts?: ApplyPatchesOptions): Promise<void>;
  capture(opts: CaptureOptions): Promise<PatchRef>;
}

/**
 * Why: Gives the workspace DSL an explicit nested workspace api contract instead of relying on untyped values.
 * Use: Import it when declaring, configuring, or consuming the corresponding workspace API.
 */
export interface NestedWorkspaceApi<TaskInput = unknown, TaskOutput = TaskInput> {
  with<Result>(
    opts: NestedWorkspaceOptions,
    run: (candidate: CandidateWorkspaceContext<TaskInput, TaskOutput>) => Promise<Result> | Result,
  ): Promise<Result>;
  /** Exceptional fallback for environments that cannot be reconstructed in a worktree. */
  lease<Result>(
    opts: CheckoutLeaseOptions,
    run: (workspace: CandidateWorkspaceContext<TaskInput, TaskOutput>) => Promise<Result> | Result,
  ): Promise<Result>;
}

/**
 * Why: Exposes the identity and current generation of a workflow-owned workspace.
 * Use: Read it from `ctx.workspace` inside workflows that declare `workspace` metadata.
 */
export interface ActiveWorkspaceApi<TaskInput = unknown, TaskOutput = TaskInput>
  extends NestedWorkspaceApi<TaskInput, TaskOutput> {
  readonly id: string;
  readonly path: string;
  readonly branch: string;
  readonly head: string;
  readonly tree: string;
  readonly generation: number;
}

/**
 * Why: Separates authorization intent from the operation that may later execute.
 * Use: Pass it to `ctx.gate` with a stable action, risk, and explanatory detail.
 */
export interface GateRequest {
  key?: string;
  action: string;
  risk: Risk;
  detail?: string;
}

/**
 * Why: Records whether policy or a person authorized an action and who supplied the answer.
 * Use: Inspect it before performing the gated operation.
 */
export interface GateResult {
  approved: boolean;
  note?: string;
  answeredBy: "human" | "policy" | "timeout";
}

/**
 * Why: Distinguishes durable report evidence from transient operator logs.
 * Use: Pass it to `ctx.note` for claims, decisions, and risks that must survive replay.
 */
export interface NoteInput {
  kind: "decision" | "claim" | "risk";
  text: string;
  evidence?: string;
}
