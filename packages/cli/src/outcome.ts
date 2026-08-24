/**
 * What `weft run` and `weft resume` do with a handle: either watch it live, or wait for
 * it to settle or suspend. `handle.outcome()` resolves at a terminal state *or* when the
 * run parks on a human — the CLI process is meant to exit there, and the answer can
 * arrive hours later from another process (C5).
 */
import type { RunHandle, RunOutcome, RunState, Weft } from "@techery/weft-host";
import { renderTree } from "@techery/weft-host";
import pc from "picocolors";
import { costLine, jsonBlock, pendingLines, treeLines } from "./format.ts";
import { type CliIo, paintStatus, say, warn } from "./io.ts";

const FRAME_MS = 500;

export interface RunLabel {
  runId: string;
  workflow: string;
}

/**
 * One live frame: header, cost, tree. Recomputed from the projection, never accumulated.
 * The label is passed in because a run that is still live in this process reduces from
 * records the engine started collecting after `run.created`, so its identity fields can
 * be empty until the first resume.
 */
export function liveFrame(state: RunState, label: RunLabel, now: number): string {
  const name = state.workflow || label.workflow;
  const head = `${pc.bold(name)}  ${pc.dim("run")} ${label.runId}  ${paintStatus(state.status)}`;
  return [head, costLine(state, now), ...treeLines(state, renderTree(state))].join("\n");
}

/**
 * Re-render the tree every {@link FRAME_MS} until the run settles or suspends. The frame
 * is a whole block handed to `io.live` (log-update in a terminal), so nothing scrolls.
 */
export async function watchRun(
  io: CliIo,
  weft: Weft,
  handle: RunHandle,
  workflow: string,
): Promise<RunOutcome> {
  const label: RunLabel = { runId: handle.runId, workflow };
  const settled = handle.outcome();
  let running = true;
  void settled.then(() => {
    running = false;
  });
  while (running) {
    io.live?.(liveFrame(await weft.engine.state(handle.runId), label, Date.now()));
    await Promise.race([settled, sleep(FRAME_MS)]);
  }
  io.live?.(liveFrame(await weft.engine.state(handle.runId), label, Date.now()));
  io.liveDone?.();
  return settled;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

/**
 * Print the end of a run the way the next command should read: the output for a complete
 * run, the exact `weft answer …` line for a suspended one, the error for a failure. A
 * failure sets `process.exitCode` — a library never calls `process.exit`.
 */
export async function reportOutcome(
  io: CliIo,
  weft: Weft,
  runId: string,
  outcome: RunOutcome,
): Promise<void> {
  switch (outcome.status) {
    case "complete":
      say(io, jsonBlock(outcome.output), `${pc.green("complete")}  ${pc.dim("run")} ${runId}`);
      return;
    case "cancelled":
      warn(io, `${pc.dim("cancelled")}  run ${runId} — still resumable with: weft resume ${runId}`);
      process.exitCode = 1;
      return;
    case "failed":
      warn(io, `${pc.red("failed")}  run ${runId}`, `  ${outcome.error.code}: ${outcome.error.message}`);
      if (outcome.error.step.key) warn(io, `  ${pc.dim(`at step ${outcome.error.step.key}`)}`);
      warn(io, `  ${pc.dim(`weft explain ${runId} <key|seq> · weft resume ${runId}`)}`);
      process.exitCode = 1;
      return;
    default: {
      const kind = outcome.status === "waiting_for_signal" ? "a signal" : "an answer";
      say(io, `${pc.yellow(outcome.status)}  run ${runId} is waiting for ${kind}`);
      const pending = outcome.pending.length > 0 ? outcome.pending : await weft.engine.pending(runId);
      for (const request of pending) say(io, ...pendingLines(runId, request));
      say(io, pc.dim(`then: weft resume ${runId}`));
    }
  }
}
