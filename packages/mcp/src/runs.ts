/**
 * What `weft_wait` is: one long poll that returns on the next thing a session can act on —
 * the run's output, its failure, or the question it is blocked on. A session never parses
 * prose and never busy-polls, so the shape of every answer is fixed here, once.
 *
 * Two paths reach the same shapes. A run this process started has a {@link RunHandle},
 * whose `outcome()` resolves at a terminal state *or* the moment the run suspends on a
 * person — no polling at all. A run started elsewhere (another session, the CLI, a
 * daemon) has no handle here, so its journal is polled instead; the projection carries
 * the same pending requests the handle would have reported.
 */
import type { PendingRequest, RunHandle, RunState, Weft, WorkflowDefinition } from "@weft/host";

/** How often the journal is re-read for a run this process did not start. */
const POLL_MS = 500;

/** Long polls default to this when the caller names no timeout. */
export const DEFAULT_TIMEOUT = "10m";

const TIMED_OUT = Symbol("weft.timeout");

/** The pending request a session must put to its user before the run can continue. */
export interface AwaitingRequest {
  id: string;
  kind: string;
  question: string;
  detail?: string;
  /** JSON Schema the answer must satisfy; `weft_answer` validates against it. */
  schema: unknown;
  risk?: string;
}

/**
 * Every `weft_wait` reply. `running` is the timeout case — the run is alive and the
 * session should wait again; anything else is a change worth reporting to a person.
 */
export type WaitResult =
  | { status: "complete"; output: unknown }
  | { status: "failed"; error: unknown }
  | { status: "cancelled" }
  | { awaiting: AwaitingRequest }
  | { status: "running" };

/**
 * A run this server started. `ref` is kept so a resume re-resolves the workflow from disk
 * (that is what makes "edit the file, resume the run" reuse the steps that still match);
 * `def` is kept only for inline source, which has no file to re-read.
 */
export interface TrackedRun {
  handle: RunHandle;
  ref?: string;
  def?: WorkflowDefinition;
}

/** The handles this server owns. Runs it never started are served from the journal. */
export class RunStore {
  private readonly runs = new Map<string, TrackedRun>();

  track(run: TrackedRun): TrackedRun {
    this.runs.set(run.handle.runId, run);
    return run;
  }

  get(runId: string): TrackedRun | undefined {
    return this.runs.get(runId);
  }
}

/** Resolve on the next reportable change, or `{ status: "running" }` when the clock runs out. */
export async function waitForChange(
  weft: Weft,
  runs: RunStore,
  runId: string,
  timeoutMs: number,
): Promise<WaitResult> {
  const deadline = Date.now() + timeoutMs;
  const tracked = runs.get(runId);
  return tracked ? liveWait(weft, tracked.handle, deadline) : pollWait(weft, runId, deadline);
}

async function liveWait(weft: Weft, handle: RunHandle, deadline: number): Promise<WaitResult> {
  const outcome = await race(handle.outcome(), deadline - Date.now());
  if (outcome === TIMED_OUT) return { status: "running" };
  if (outcome.status === "complete") return { status: "complete", output: outcome.output };
  if (outcome.status === "failed") return { status: "failed", error: outcome.error.serialize() };
  if (outcome.status === "cancelled") return { status: "cancelled" };
  const first = outcome.pending[0];
  if (first) return { awaiting: awaitingOf(first) };
  // Suspended on a signal or a timer: there is nothing for a person to answer, so the poll
  // has to stay open. The rest of the window is served from the journal rather than by
  // re-arming `outcome()` in a loop — each call leaves an idle callback behind.
  return pollWait(weft, handle.runId, deadline);
}

async function pollWait(weft: Weft, runId: string, deadline: number): Promise<WaitResult> {
  for (;;) {
    // Throws for a run id nobody has ever journaled — the caller's mistake, not a status.
    const state = await weft.engine.state(runId);
    const terminal = terminalOf(state);
    if (terminal) return terminal;
    const pending = state.humans.find((h) => h.status === "pending");
    if (pending) return { awaiting: awaitingOf(pending) };
    if (!(await tick(deadline))) return { status: "running" };
  }
}

function terminalOf(state: RunState): WaitResult | undefined {
  switch (state.status) {
    case "complete":
      return { status: "complete", output: state.output };
    case "failed":
      return { status: "failed", error: state.error ?? { message: "the run failed without a recorded error" } };
    case "cancelled":
      return { status: "cancelled" };
    default:
      return undefined;
  }
}

/** Both a live `PendingRequest` and a journaled `HumanState` carry exactly these fields. */
function awaitingOf(request: PendingRequest | RunState["humans"][number]): AwaitingRequest {
  return {
    id: request.id,
    kind: request.kind,
    question: request.question,
    schema: request.schema,
    ...(request.detail !== undefined ? { detail: request.detail } : {}),
    ...(request.risk !== undefined ? { risk: request.risk } : {}),
  };
}

/** Sleep until the next poll; false once the deadline has passed. */
async function tick(deadline: number): Promise<boolean> {
  const remaining = deadline - Date.now();
  if (remaining <= 0) return false;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, Math.min(POLL_MS, remaining));
    timer.unref?.();
  });
  return true;
}

async function race<T>(promise: Promise<T>, ms: number): Promise<T | typeof TIMED_OUT> {
  if (ms <= 0) return TIMED_OUT;
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<typeof TIMED_OUT>((resolve) => {
        timer = setTimeout(() => resolve(TIMED_OUT), ms);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

const DURATION = /^(\d+(?:\.\d+)?)(ms|s|m|h|d)?$/;
const UNIT_MS: Record<string, number> = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 };

/**
 * `"10m"`, `"90s"`, `"250ms"`, or a bare number of milliseconds — the same Duration
 * spelling the SDK accepts. (@weft/sdk is not a dependency of this package; see the
 * package README note on why the parser is repeated rather than imported.)
 */
export function parseTimeout(text: string): number {
  const match = DURATION.exec(text.trim());
  if (!match) {
    throw new Error(`invalid timeout ${JSON.stringify(text)} — expected e.g. "10m", "2h", "90s", or a number of ms`);
  }
  return Number(match[1]) * (match[2] ? (UNIT_MS[match[2]] ?? 1) : 1);
}
