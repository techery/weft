/**
 * `GET /api/pending` — every question waiting on a person, across every run.
 *
 * The per-run route already existed, which made "what is waiting on me?" an N+1: list the
 * runs, then fetch each one's pending set. That is the first screen anyone opens, so it is
 * worth one request.
 *
 * It walks the runs that OWN requests rather than walking roots down to them. A request
 * belongs to the run that asked it, and that run is necessarily non-terminal while the
 * question stands — so listing non-terminal runs and folding each one finds every
 * outstanding request by construction. Descending from roots does not: a parent can fail,
 * or be cancelled from another process, while a concurrent child stays parked on a person
 * (cancel appends `run.cancelled` to the parent's journal, never the child's), and the
 * child's still-answerable question then hangs off a terminal root that a root-first walk
 * has already skipped.
 *
 * Each entry names the run to post the answer to, and the root of its tree, which is what
 * a queue groups by.
 */
import type { PendingRequest, RunSummary, Weft } from "@techery/weft-host";
import type { Hono } from "hono";
import { fail } from "../http.ts";
import { pendingOf, stateOf } from "../state.ts";

/**
 * A run in one of these states has finished and cannot be holding a question of its own.
 * Everything else is folded, rather than filtering on `waiting_for_*`: a summary's status
 * comes from a projection that trails the journal by one append, so a run that just parked
 * on a person still reads `executing` for a moment, and filtering on the lagging value
 * drops the newest question in the queue — the one most likely to be looked for.
 */
const TERMINAL = new Set(["complete", "failed", "cancelled"]);

/** Journals folded at once. A repo with hundreds of live runs should not open all of them. */
const CONCURRENCY = 8;

export interface PendingEntry extends PendingRequest {
  /** The workflow of the run that owns the request — not necessarily the root's. */
  workflow: string;
  /** The root of this request's run tree, which is what a queue groups by. */
  rootRunId: string;
  rootWorkflow: string;
}

/** A run whose journal could not be read, reported rather than silently dropped. */
export interface UnreadableRun {
  runId: string;
  error: string;
}

export interface PendingResponse {
  pending: PendingEntry[];
  /**
   * Non-empty when a journal could not be folded. Reported alongside the requests that
   * WERE read: a storage fault must not render as "nothing is waiting on you".
   */
  unreadable: UnreadableRun[];
}

export function registerPendingRoutes(app: Hono, weft: Weft): void {
  app.get("/api/pending", async (c) => {
    try {
      const summaries = await weft.engine.list();
      const byId = new Map(summaries.map((summary) => [summary.runId, summary]));
      const live = summaries.filter((summary) => !TERMINAL.has(summary.status));

      const pending: PendingEntry[] = [];
      const unreadable: UnreadableRun[] = [];

      // Bounded fan-out, in order, so a repo with 500 live runs opens eight journals at a
      // time rather than all of them.
      for (let i = 0; i < live.length; i += CONCURRENCY) {
        const batch = live.slice(i, i + CONCURRENCY);
        const folded = await Promise.all(
          batch.map(async (summary) => {
            try {
              return { summary, state: await stateOf(weft, summary.runId) };
            } catch (err) {
              return { summary, error: err instanceof Error ? err.message : String(err) };
            }
          }),
        );
        for (const result of folded) {
          if (result.error !== undefined) {
            unreadable.push({ runId: result.summary.runId, error: result.error });
            continue;
          }
          const state = result.state;
          // This run's OWN requests: a descendant's are found when that descendant is
          // folded in its own turn, so nothing is reported twice.
          for (const request of pendingOf(state)) {
            const root = rootOf(byId, state.runId);
            pending.push({
              ...request,
              workflow: state.workflow,
              rootRunId: root?.runId ?? state.runId,
              rootWorkflow: root?.workflow ?? state.workflow,
            });
          }
        }
      }

      // Oldest first: the thing that has been blocked longest is the thing to answer.
      pending.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
      return c.json({ pending, unreadable } satisfies PendingResponse);
    } catch (err) {
      return fail(c, err);
    }
  });
}

/**
 * Walk to the root of the recorded tree using the summaries already in hand — no extra
 * journal reads. A parent missing from the listing (its journal is damaged, and the store
 * skips it) ends the walk at the deepest run that IS listed, which is still a truer group
 * than pretending the child is its own root.
 */
function rootOf(byId: Map<string, RunSummary>, runId: string): RunSummary | undefined {
  let current = byId.get(runId);
  const seen = new Set<string>([runId]);
  while (current?.parentRunId !== undefined) {
    if (seen.has(current.parentRunId)) break;
    seen.add(current.parentRunId);
    const parent = byId.get(current.parentRunId);
    if (parent === undefined) break;
    current = parent;
  }
  return current;
}
