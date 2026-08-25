import type { PillKind, RunState, StepState, WorkflowState } from "./types";

/**
 * The status-dot colour table. Run states, step states and workflow states all
 * read from one map because the prototype paints them with one swatch set.
 */
export const STATUS_COLOR: Record<RunState | StepState | WorkflowState, string> = {
  running: "#5db8a6",
  run: "#5db8a6",
  waiting: "#cc785c",
  done: "#c4bdb2",
  idle: "#c4bdb2",
  wait: "#e6dfd8",
  fail: "#b0483a",
  stopped: "#8e8b82",
};

export const PILL_BG: Record<PillKind, string> = {
  fail: "#f7e4e1",
  human: "#f6e2d8",
  run: "#d7ece7",
  done: "#efe9de",
};

export const PILL_FG: Record<PillKind, string> = {
  fail: "#b0483a",
  human: "#8a4630",
  run: "#275a51",
  done: "#3d3d3a",
};

/** Which pill palette a run's own state pill uses. */
export function runPillKind(state: RunState): PillKind {
  if (state === "waiting") return "human";
  if (state === "running") return "run";
  if (state === "stopped") return "fail";
  return "done";
}

/** Shape-strip and rail chips share the kind → colour mapping. */
export const KIND_BG: Record<string, string> = {
  agent: "#d7ece7",
  human: "#f6e2d8",
  task: "#efe9de",
};

export const KIND_FG: Record<string, string> = {
  agent: "#275a51",
  human: "#8a4630",
  task: "#3d3d3a",
};

/** Success bar fill: calm at 95%+, warm below, hot under 88%. */
export function successBarColor(ok: number): string {
  if (ok >= 95) return "#c4bdb2";
  if (ok >= 88) return "#dd9b80";
  return "#cc785c";
}

/** Artifact type badge colours — markdown and patches get their own. */
export function artifactBadgeColors(type: string): { bg: string; fg: string } {
  if (type === "md") return { bg: "#d7ece7", fg: "#275a51" };
  if (type === "patch") return { bg: "#f6e2d8", fg: "#8a4630" };
  return { bg: "#efe9de", fg: "#3d3d3a" };
}

/** File-extension badge colour in the changes tree. */
export function extColor(ext: string): string {
  if (ext === "TS") return "#35786b";
  if (ext === "JSON") return "#a9583e";
  if (ext === "MD") return "#6c6a64";
  return "#8e8b82";
}

/** Journal tag colours on the terminal ground. */
export function journalTagColor(tag: string): string {
  if (tag === "agent") return "#7fc9b9";
  if (tag === "tool") return "#dd9b80";
  if (tag === "human") return "#eac6b4";
  return "#a09d96";
}
