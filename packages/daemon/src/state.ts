/**
 * Journal folds shared by every route that reads a run.
 *
 * These live apart from the routes because more than one endpoint needs them — the runs
 * list, the queue's cross-run pending sweep, and the artifact inventory all fold the same
 * journal — and because a fold is worth testing without a socket or a Context in the way.
 */
import type { JournalRecord, PendingRequest, RunState, RunSummary, Weft } from "@techery/weft-host";
import { reduceState, renderReport, renderTree } from "@techery/weft-host";

/**
 * Every read here folds the run's journal, because the journal is the only record that is
 * always complete (C4). The engine keeps its own projection for a run it is driving, and
 * that copy trails the journal by one append at every suspension — and, for a run this
 * process itself started, never sees `run.created` at all (see the package's frictions
 * note). Folding the journal costs one file read and cannot disagree with the event
 * stream the same page is rendering next to it.
 */
export async function stateOf(weft: Weft, runId: string): Promise<RunState> {
  const records: JournalRecord[] = [];
  for await (const record of weft.engine.journal.read(runId)) records.push(record);
  if (records.length === 0) throw new Error(`run ${runId} not found`);
  return reduceState(records);
}

/**
 * Pending requests across the run AND its live descendants: a child suspended
 * on a person suspends the whole tree, and its request lives only in the
 * child's journal. Each entry carries the OWNING run's id, and the engine
 * routes an answer submitted under the parent id to that owner either way.
 */
export async function pendingAcross(
  weft: Weft,
  state: RunState,
  seen: Set<string>,
): Promise<PendingRequest[]> {
  const out = pendingOf(state);
  for (const { childRunId } of state.children) {
    if (seen.has(childRunId)) continue;
    seen.add(childRunId);
    // Only confirmed ABSENCE is skippable (a child scheduled but never
    // journaled). An unreadable child journal must surface instead of /pending
    // silently omitting the child's outstanding approval.
    if (!(await weft.engine.exists(childRunId))) continue;
    const child = await stateOf(weft, childRunId);
    if (child.status === "complete" || child.status === "failed" || child.status === "cancelled") continue;
    out.push(...(await pendingAcross(weft, child, seen)));
  }
  return out;
}

/** The same shape `engine.pending()` reports, derived from the same fold as the rest. */
export function pendingOf(state: RunState): PendingRequest[] {
  return state.humans
    .filter((human) => human.status === "pending")
    .map((human) => ({
      runId: state.runId,
      id: human.id,
      kind: human.kind as PendingRequest["kind"],
      question: human.question,
      schema: human.schema,
      createdAt: human.requestedAt,
      ...(human.detail !== undefined ? { detail: human.detail } : {}),
      ...(human.risk !== undefined ? { risk: human.risk } : {}),
      ...(human.deadline !== undefined ? { deadline: human.deadline } : {}),
      ...(human.confirmToken !== undefined ? { confirmToken: human.confirmToken } : {}),
      ...(human.artifactRef !== undefined ? { artifactRef: human.artifactRef } : {}),
      ...(human.reviewSubject !== undefined ? { reviewSubject: human.reviewSubject } : {}),
      ...(human.reviewAttachments !== undefined ? { reviewAttachments: human.reviewAttachments } : {}),
      ...(human.ui !== undefined ? { ui: human.ui } : {}),
    }));
}

/**
 * The runs list is the one read that has to stay cheap with hundreds of runs, so it takes
 * the store's `state.json`-backed summaries as they come. A summary with no workflow name
 * is one the engine wrote from an incomplete projection (the frictions note again); that
 * run is re-derived from its journal and the projection is rewritten, so the repair costs
 * one fold once rather than one fold per poll.
 */
export async function repaired(weft: Weft, summary: RunSummary): Promise<RunSummary> {
  if (summary.workflow !== "") return summary;
  const state = await refreshProjections(weft, summary.runId);
  if (!state) return summary;
  return {
    ...summary,
    workflow: state.workflow,
    status: state.status,
    createdAt: state.createdAt || summary.createdAt,
  };
}

/**
 * Re-derive `state.json` / `tree.json` / `report.md` from the journal. Nothing else does
 * it for a run no process is driving, and the runs list reads the projection — so without
 * this an answered run would keep listing as "waiting_for_human" until someone resumed it.
 * Projections are derived data, safe to rewrite at any time (C9), which is also why a
 * failure here never fails the request that triggered it.
 */
export async function refreshProjections(weft: Weft, runId: string): Promise<RunState | undefined> {
  try {
    const state = await stateOf(weft, runId);
    await weft.engine.journal.snapshot(runId, {
      state,
      tree: renderTree(state),
      report: renderReport(state),
    });
    return state;
  } catch {
    // The mutation already landed in the journal; the projection catches up on the next write.
    return undefined;
  }
}
