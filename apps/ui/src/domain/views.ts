import { QUEUE_COPY, RUN_INDEX, type RunFilter, type RunIndexRow } from "./fixtures/runList";
import { extColor } from "./palette";
import type { Artifact, FileChange, Gate, GateAnswers, Labelled, Run, RunState } from "./types";

/* ── Queue ─────────────────────────────────────────────────────────────── */

export type QueueCard = {
  runId: string;
  /** True when the run is blocked on a human answer. */
  needsYou: boolean;
  wf: string;
  sub: string;
  ask: string;
  detail: string;
  /** Risk tier of the pending gate, or "" when there is nothing to warn about. */
  risk: string;
  action: string;
  facts: Labelled[];
};

function queueCard(run: Run, needsYou: boolean): QueueCard {
  const copy = QUEUE_COPY[run.id];
  const elapsed = run.chrome.split(" · ")[1] ?? "";
  return {
    runId: run.id,
    needsYou,
    wf: run.wf,
    sub: needsYou ? `${run.id} · waiting · ${copy?.wait ?? ""}` : `${run.id} · running · ${elapsed}`,
    ask: needsYou ? (run.gate?.title ?? "") : (copy?.runAsk ?? ""),
    detail: needsYou ? (run.gate?.detail ?? "") : (copy?.runDetail ?? ""),
    risk: needsYou ? (copy?.risk ?? "") : "",
    action: needsYou ? "Answer →" : "Open",
    facts: (needsYou ? copy?.facts : copy?.runFacts) ?? [],
  };
}

/** The queue is one pass over the live runs, split by who is holding them up. */
export function queueGroups(runs: Record<string, Run>, order: string[]) {
  const live = order.map((id) => runs[id]).filter((r): r is Run => !!r);
  return {
    waiting: live.filter((r) => r.state === "waiting").map((r) => queueCard(r, true)),
    running: live.filter((r) => r.state === "running").map((r) => queueCard(r, false)),
  };
}

/* ── Runs table ────────────────────────────────────────────────────────── */

export type RunTableRow = RunIndexRow;

/**
 * The index rows, refreshed against the live runs: a run you just resumed says
 * what it is doing now rather than what the journal recorded on load.
 */
export function runTableRows(runs: Record<string, Run>): RunTableRow[] {
  return RUN_INDEX.map((row) => {
    const live = runs[row.id];
    const state: RunState = live ? live.state : row.state;
    const outcome =
      state === "stopped"
        ? "stopped at the gate"
        : state === "running" && live && live.state !== row.state
          ? live.pill
          : row.outcome;
    return { ...row, state, outcome };
  });
}

export function passesRunFilter(row: RunTableRow, filter: RunFilter): boolean {
  if (filter === "All") return true;
  if (filter === "Needs you") return row.state === "waiting";
  if (filter === "Running") return row.state === "running";
  return row.state === "done" || row.state === "stopped";
}

/* ── Run detail ────────────────────────────────────────────────────────── */

/** Where a run was opened from, so its back button can say so. */
export type RunOrigin = "queue" | "runs";

export const RUN_TABS = ["steps", "findings", "artifacts", "changes", "journal"] as const;
export type RunTab = (typeof RUN_TABS)[number];

export type RunTabDef = { key: RunTab; label: string; badge: string };

/** Findings and Changes disappear entirely when a run produced neither. */
export function runTabs(run: Run, pendingGate: boolean): RunTabDef[] {
  const defs: RunTabDef[] = [
    { key: "steps", label: "Steps", badge: pendingGate ? "1" : "" },
    { key: "findings", label: "Findings", badge: String(run.findings.length) },
    { key: "artifacts", label: "Artifacts", badge: String(run.artifacts.length) },
    { key: "changes", label: "Changes", badge: String(run.files.length) },
    { key: "journal", label: "Journal", badge: "" },
  ];
  return defs.filter((t) => !((t.key === "findings" || t.key === "changes") && t.badge === "0"));
}

export function isRunTab(value: string | undefined): value is RunTab {
  return !!value && (RUN_TABS as readonly string[]).includes(value);
}

/** A gate is pending until you either approve or deny it. */
export function hasPendingGate(run: Run, answered: Record<string, boolean>): boolean {
  return !!run.gate && !answered[run.id];
}

/** Fall back to the pending gate, then to whatever step the run recorded first. */
export function resolveStepId(run: Run, requested: string | undefined, pendingGate: boolean): string {
  if (requested && run.steps[requested]) return requested;
  if (pendingGate && run.gateStep) return run.gateStep;
  return Object.keys(run.steps)[0] ?? "";
}

export function resolveArtifact(run: Run, requested: string | undefined): Artifact | undefined {
  return run.artifacts.find((a) => a.name === requested) ?? run.artifacts[0];
}

export function resolveFile(run: Run, requested: string | undefined): FileChange | undefined {
  return run.files.find((f) => f.path === requested) ?? run.files[0];
}

export function totalAdds(files: FileChange[]): number {
  return files.reduce((n, f) => n + f.adds, 0);
}

export function totalDels(files: FileChange[]): number {
  return files.reduce((n, f) => n + f.dels, 0);
}

/* ── Changes tree ──────────────────────────────────────────────────────── */

export type TreeNode = {
  key: string;
  name: string;
  isFile: boolean;
  depth: number;
  path: string;
  /** File statistics, "" for directories. */
  stat: string;
  ext: string;
  extColor: string;
};

/** Flatten the changed paths into the always-expanded tree the design shows. */
export function fileTree(files: FileChange[]): TreeNode[] {
  const rows: TreeNode[] = [];
  const seen = new Set<string>();
  for (const file of files) {
    const parts = file.path.split("/");
    const name = parts.pop() ?? "";
    let path = "";
    parts.forEach((part, depth) => {
      path = path ? `${path}/${part}` : part;
      if (seen.has(path)) return;
      seen.add(path);
      rows.push({
        key: `dir:${path}`,
        name: part,
        isFile: false,
        depth,
        path,
        stat: "",
        ext: "",
        extColor: "",
      });
    });
    const ext = (name.split(".").pop() ?? "").toUpperCase();
    rows.push({
      key: `file:${file.path}`,
      name,
      isFile: true,
      depth: parts.length,
      path: file.path,
      stat: `+${file.adds} −${file.dels}`,
      ext,
      extColor: extColor(ext),
    });
  }
  return rows;
}

/* ── Gate ──────────────────────────────────────────────────────────────── */

/** The object literal shown in the gate footer — what the next step receives. */
export function gatePayload(gate: Gate, answers: GateAnswers): string {
  const body = gate.questions
    .map((q) => {
      const value = answers[gate.id]?.[q.key];
      if (Array.isArray(value)) return `${q.key}: [${value.map((v) => `"${v}"`).join(", ")}]`;
      if (typeof value === "boolean") return `${q.key}: ${String(value)}`;
      return `${q.key}: "${value ?? ""}"`;
    })
    .join(", ");
  return `{ ${body} }`;
}

/**
 * Caption beside a gate toggle. The prototype uses one pair of captions for
 * every toggle it renders, so this stays a single mapping.
 */
export function gateToggleLabel(on: boolean): string {
  return on ? "wait for verify to pass" : "commit without waiting";
}
