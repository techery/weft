/** Declaration-only workspace surface for the Weft DSL prototype. */
import type { PatchRef } from "./agent.ts";
import type { GitConflictResolver } from "./effects.ts";
import type { WriteScope } from "./path-policies.ts";
import type { Risk, WorkspaceSnapshotRef } from "./shared.ts";
import type { Ctx } from "./workflow.ts";

// ---------------------------------------------------------------------------
// Workspaces, patches, integration, gates, and notes
// ---------------------------------------------------------------------------

/** Apply patches options. */
export interface ApplyPatchesOptions<Context = unknown> {
  key: string;
  order?: "sequential";
  onConflict?: "ask" | "fail" | GitConflictResolver<Context>;
}

/** Integrate options. */
export interface IntegrateOptions<Context = unknown> extends ApplyPatchesOptions<Context> {}

/** Integration ledger. */
export interface IntegrationLedger {
  merged: string[];
  conflicts: string[];
  quarantined: string[];
  skipped: string[];
}

/** Capture options. */
export interface CaptureOptions {
  key: string;
  scope: WriteScope;
}

/** Nested workspace options. */
export interface NestedWorkspaceOptions {
  key: string;
  from?: string;
}

/**
 * Why: Provides a disposable direct-write tree for composing and verifying patches before promotion.
 * Use: Receive it inside `ctx.workspace.with` and finish by calling `capture`.
 */
export interface CandidateWorkspaceContext<TaskInput = unknown, TaskOutput = TaskInput>
  extends Ctx<TaskInput, TaskOutput, true> {
  apply(patches: ReadonlyArray<PatchRef>, opts: ApplyPatchesOptions): Promise<void>;
  capture(opts: CaptureOptions): Promise<PatchRef>;
}

/** Nested workspace api. */
export interface NestedWorkspaceApi<TaskInput = unknown, TaskOutput = TaskInput> {
  with<Result>(
    opts: NestedWorkspaceOptions,
    run: (candidate: CandidateWorkspaceContext<TaskInput, TaskOutput>) => Promise<Result> | Result,
  ): Promise<Result>;
}

/**
 * Why: Exposes the identity and current generation of a workflow-owned workspace.
 * Use: Read it from `ctx.workspace` inside workflows that declare `workspace` metadata.
 */
export interface ActiveWorkspaceApi<TaskInput = unknown, TaskOutput = TaskInput>
  extends NestedWorkspaceApi<TaskInput, TaskOutput> {
  readonly snapshot: WorkspaceSnapshotRef;
  readonly id: string;
  readonly path: string;
  readonly branch: string;
  readonly head: string;
  readonly tree: string;
  readonly generation: number;
}

/**
 * Why: Describes a durable policy question used only to choose a workflow branch, never to authorize an effect.
 * Use: Pass it to `ctx.policy.decide`; protected operations and deliveries still require their own nominal authority.
 */
export interface PolicyDecisionRequest {
  key: string;
  action: string;
  risk: Risk;
  detail?: string;
}

/**
 * Why: Makes a branching decision visibly different from candidate-bound authorization.
 * Use: Branch on `outcome`; never pass this value as authority to an operation or delivery.
 */
export interface PolicyDecisionResult {
  readonly outcome: "allow" | "deny";
  readonly note?: string;
  readonly decidedBy: "human" | "policy" | "timeout";
}

/**
 * Why: Names the non-authoritative policy decision surface separately from protected effect authorization.
 * Use: Call `ctx.policy.decide` for business-flow branching only.
 */
export interface PolicyApi {
  decide(request: PolicyDecisionRequest): Promise<PolicyDecisionResult>;
}

/**
 * Why: Distinguishes durable report evidence from transient operator logs.
 * Use: Pass it to `ctx.note` for claims, decisions, and risks that must survive replay.
 */
export interface NoteInput {
  key: string;
  kind: "decision" | "claim" | "risk";
  text: string;
  evidence?: string;
}
