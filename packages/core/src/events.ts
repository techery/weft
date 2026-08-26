/**
 * The journal model. A run is an append-only sequence of these events; everything
 * else (state.json, report.md, the live tree) is a projection. Replay re-executes
 * workflow code and serves completed steps from here.
 */
import type { Risk, SerializedStepError, Usage } from "@techery/weft-sdk";

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
  | "ui"
  | "sideeffect";

/** Reference to a blob in the content-addressed store. */
export interface BlobRefJson {
  $blob: string;
  size: number;
  /** Small leading excerpt kept inline so projections render without loading the blob. */
  preview?: string;
}

export type UiPropsJson = { inline: unknown; hash: string } | { ref: BlobRefJson; hash: string };

export interface UiPresentation {
  id: string;
  asset: {
    id: string;
    revision: string;
    bundleRef: BlobRefJson;
    protocol: 1;
  };
  props: UiPropsJson;
  mode: "display" | "input";
  slot?: string;
}

export type HumanKind = "gate" | "ask" | "approve" | "review" | "confirm";

export interface HumanRequestEvent {
  type: "human.requested";
  id: string;
  seq: number;
  hash: string;
  key?: string;
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
  ui?: UiPresentation;
}

export interface HumanSupersededEvent {
  type: "human.superseded";
  id: string;
  byId: string;
  reason: string;
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
      /**
       * `defHash` is the host's bundle hash (absent for library callers). `bodyHash`
       * is the engine's own version stamp for the workflow body, always present, and is
       * what resume compares to decide whether step POSITIONS still mean anything.
       */
      workflow: {
        id?: string;
        name: string;
        defHash?: string;
        bodyHash?: string;
        /** Version of the implicit agent task-context envelope used by this run. */
        taskContextVersion?: number;
        taskSchemaBinding?: string;
        taskSchemaVersion?: number;
      };
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
      /** JSON Schema for the validated output, when this step declared one. */
      schema?: unknown;
      childRunId?: string;
    }
  // `usage` on a retry attempt is what the FAILED previous attempt spent — journaled
  // here so a resume restores spend the completion event will never carry.
  | { type: "step.attempt"; seq: number; attempt: number; detail?: string; usage?: Usage }
  | {
      type: "step.completed";
      seq: number;
      output: unknown;
      usage?: Usage;
      sessionId?: string;
      transcriptRef?: BlobRefJson;
      patchRef?: string;
      attempts?: number;
      presentation?: UiPresentation;
    }
  /** `settle` means execution completed and only its journal-backed side effects failed. */
  | {
      type: "step.failed";
      seq: number;
      error: SerializedStepError;
      attempts?: number;
      phase?: "execute" | "settle";
    }
  /** A previously completed step's `onSettle` hook has succeeded. */
  | { type: "step.settled"; seq: number }
  // humans & external
  | HumanRequestEvent
  | HumanAnsweredEvent
  | HumanRejectedEvent
  | HumanSupersededEvent
  | { type: "signal.received"; name: string; payload: unknown }
  // A delivered payload the waiting step REFUSED (schema violation): replay must
  // treat that delivery as consumed, or resume re-takes it ahead of any
  // corrected payload appended later and the run wedges permanently.
  | { type: "signal.rejected"; seq: number; name: string }
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
