/**
 * Failure model. Steps never resolve to prose or null: they either return a
 * schema-validated value or throw a StepError. Inside fan-out, StepErrors are
 * collected per branch as Settled entries.
 */

export type StepErrorCode =
  | "schema_repair_exhausted"
  | "max_turns"
  | "timeout"
  | "provider_error"
  | "budget_exceeded"
  | "cancelled"
  | "gate_denied"
  | "human_denied"
  | "human_timeout"
  | "exec_failed"
  | "fetch_denied"
  | "fetch_failed"
  | "git_failed"
  | "scope_violation"
  | "conflict"
  | "check_failed"
  | "invalid_answer"
  | "invalid_input"
  | "invalid_output"
  | "depth_exceeded"
  | "unintegrated_patches"
  | "detached"
  | "internal";

/** Identity of the step an error belongs to, for logs, reports, and tests. */
export interface StepRef {
  seq?: number;
  key?: string;
  kind?: string;
  label?: string;
  runId?: string;
}

export interface SerializedStepError {
  name: "StepError";
  code: StepErrorCode;
  message: string;
  step: StepRef;
  attempts?: number;
  detail?: unknown;
}

export class StepError extends Error {
  readonly code: StepErrorCode;
  readonly step: StepRef;
  readonly attempts?: number;
  readonly detail?: unknown;

  constructor(
    code: StepErrorCode,
    message: string,
    opts: { step?: StepRef; attempts?: number; detail?: unknown; cause?: unknown } = {},
  ) {
    super(message, opts.cause !== undefined ? { cause: opts.cause } : undefined);
    this.name = "StepError";
    this.code = code;
    this.step = opts.step ?? {};
    if (opts.attempts !== undefined) this.attempts = opts.attempts;
    if (opts.detail !== undefined) this.detail = opts.detail;
  }

  serialize(): SerializedStepError {
    return {
      name: "StepError",
      code: this.code,
      message: this.message,
      step: this.step,
      ...(this.attempts !== undefined ? { attempts: this.attempts } : {}),
      ...(this.detail !== undefined ? { detail: this.detail } : {}),
    };
  }

  static deserialize(s: SerializedStepError): StepError {
    return new StepError(s.code, s.message, {
      step: s.step,
      ...(s.attempts !== undefined ? { attempts: s.attempts } : {}),
      ...(s.detail !== undefined ? { detail: s.detail } : {}),
    });
  }

  static from(err: unknown, step: StepRef = {}): StepError {
    if (err instanceof StepError) return err;
    const message = err instanceof Error ? err.message : String(err);
    return new StepError("internal", message, { step, cause: err });
  }
}

/** Thrown from the next step once the run's token/USD ceiling is exhausted. */
export class BudgetExceededError extends StepError {
  constructor(message: string, step: StepRef = {}) {
    super("budget_exceeded", message, { step });
    this.name = "BudgetExceededError";
  }
}

/** Thrown when the run is aborted; parallel/pipeline propagate it (they never swallow aborts). */
export class CancelledError extends StepError {
  constructor(message = "run cancelled", step: StepRef = {}) {
    super("cancelled", message, { step });
    this.name = "CancelledError";
  }
}

export function isCancellation(err: unknown): boolean {
  return err instanceof CancelledError || (err instanceof StepError && err.code === "cancelled");
}
