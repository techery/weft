/**
 * The runs screen's filters. A filter is a question about a run's state, so it lives with
 * the domain rather than with whatever list happens to render it.
 */
import type { RunState } from "./types";

export const RUN_FILTERS = ["All", "Needs you", "Running", "Finished"] as const;
export type RunFilter = (typeof RUN_FILTERS)[number];

/** How a run state reads in the runs table's State column. */
export const RUN_STATE_LABEL: Record<RunState, string> = {
  waiting: "needs you",
  running: "running",
  done: "done",
  failed: "failed",
  stopped: "stopped",
};

export function passesFilter(state: RunState, filter: RunFilter): boolean {
  if (filter === "All") return true;
  if (filter === "Needs you") return state === "waiting";
  if (filter === "Running") return state === "running";
  return state === "done" || state === "failed" || state === "stopped";
}
