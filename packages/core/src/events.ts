/**
 * The journal model. A run is an append-only sequence of these events; everything
 * else (state.json, report.md, the live tree) is a projection. Replay re-executes
 * workflow code and serves completed steps from here.
 */
import type { Risk, SerializedStepError, Usage } from "@weft/sdk";

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
  | "sleep"
  | "signal"
  | "sideeffect";

/** Reference to a blob in the content-addressed store. */
export interface BlobRefJson {
  $blob: string;
  size: number;
  /** Small leading excerpt kept inline so projections render without loading the blob. */
  preview?: string;
}

export type HumanKind = "gate" | "ask" | "approve" | "review" | "confirm";

export interface HumanRequestEvent {
  type: "human.requested";
  id: string;
  seq: number;
  hash: string;
  kind: HumanKind;
  question: string;
  detail?: string;
  artifactRef?: BlobRefJson;
  schema: unknown;
  risk?: Risk;
  /** Epoch ms deadline when a timeout policy applies. */
  deadline?: number;
  onTimeout?: "deny" | "escalate" | "default";
  timeoutDefault?: unknown;
  /** Token the answer must echo for irreversible confirmations. */
  confirmToken?: string;
}

export interface HumanAnsweredEvent {
  type: "human.answered";
  id: string;
  answer: unknown;
  answeredBy: "human" | "policy" | "timeout";
  channel?: string;
}

/**
 * The owning runtime refused a journaled answer: it passed the wire-schema check some
 * other process ran, but failed the step's authoritative schema. The request is waiting
 * again, and a replacement answer for the same id may follow.
 */
export interface HumanRejectedEvent {
  type: "human.rejected";
  id: string;
  reason: string;
}

export type JournalEvent =
  // run lifecycle
  | {
      type: "run.created";
      runId: string;
      workflow: { name: string; defHash?: string };
      input: unknown;
      cwd: string;
      baseRef?: string;
      parentRunId?: string;
      depth: number;
      /** Hard budget ceiling; journaled so resume keeps enforcing it. */
      budget?: { tokens?: number; usd?: number };
    }
  | { type: "run.status"; status: RunStatus }
  | { type: "run.completed"; output: unknown }
  | { type: "run.failed"; error: SerializedStepError }
  | { type: "run.cancelled" }
  // steps
  | {
      type: "step.scheduled";
      seq: number;
      hash: string;
      kind: StepKind;
      key?: string;
      label?: string;
      phase?: string;
      parentSeq?: number;
      route?: { provider: string; model?: string; effort?: string };
      scope?: { paths: string[]; also?: string[]; mode: "warn" | "strict" };
      payload?: unknown;
      childRunId?: string;
    }
  | { type: "step.attempt"; seq: number; attempt: number; detail?: string }
  | {
      type: "step.completed";
      seq: number;
      output: unknown;
      usage?: Usage;
      sessionId?: string;
      transcriptRef?: BlobRefJson;
      patchRef?: string;
      attempts?: number;
    }
  | { type: "step.failed"; seq: number; error: SerializedStepError; attempts?: number }
  // humans & external
  | HumanRequestEvent
  | HumanAnsweredEvent
  | HumanRejectedEvent
  | { type: "signal.received"; name: string; payload: unknown }
  | { type: "timer.fired"; seq: number; deadline: number }
  // patches
  | { type: "patch.captured"; seq: number; key: string; ref: string; files: string[]; outOfScope?: string[] }
  | {
      type: "patch.merged";
      key: string;
      ref: string;
      baseTree: string;
      resultTree: string;
      conflicted?: boolean;
    }
  | { type: "patch.discarded"; key: string; ref: string }
  | { type: "scope.violation"; seq: number; key: string; files: string[]; mode: "warn" | "strict" }
  // ledger & audit
  | {
      type: "check";
      name: string;
      status: "pass" | "fail" | "trust-prior" | "skipped";
      evidence?: string;
      required?: boolean;
    }
  | { type: "note"; kind: "decision" | "claim" | "risk"; text: string; evidence?: string }
  | { type: "drop"; seq?: number; key?: string; reason: string }
  | { type: "budget.sampled"; tokens: number; usd: number }
  | { type: "phase"; name: string }
  | { type: "log"; message: string }
  | { type: "replay.salvaged"; seq: number; fromSeq: number }
  | { type: "replay.diverged"; seq: number; reason: string };

/** One journal line: monotonic index, wall-clock, event. */
export interface JournalRecord {
  i: number;
  at: number;
  ev: JournalEvent;
}

export function isBlobRef(v: unknown): v is BlobRefJson {
  return typeof v === "object" && v !== null && typeof (v as { $blob?: unknown }).$blob === "string";
}

export const TERMINAL_STATUSES: ReadonlySet<RunStatus> = new Set(["complete", "failed", "cancelled"]);
