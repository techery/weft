/**
 * The two things a run's journal records and its projection drops.
 *
 * `reduceState` keeps a step's OUTPUT and not its input, and keeps spend and not the
 * ceiling spend was measured against — both reasonable for a projection whose job is the
 * current state, and both things a reader looking at one step wants to see. They are one
 * pass over records the fold already read, so they ride along with it rather than costing
 * a second read.
 */
import type { JournalRecord, RunState, Weft } from "@techery/weft-host";
import { reduceState } from "@techery/weft-host";

export interface RunDetail {
  state: RunState;
  /** The ceiling this run was started with, as `run.created` journaled it. */
  budget: { tokens?: number; usd?: number } | null;
  /** What each step was scheduled WITH, keyed by seq. */
  inputs: Record<number, unknown>;
}

export async function detailOf(weft: Weft, runId: string): Promise<RunDetail> {
  const records: JournalRecord[] = [];
  for await (const record of weft.engine.journal.read(runId)) records.push(record);
  if (records.length === 0) throw new Error(`run ${runId} not found`);

  let budget: RunDetail["budget"] = null;
  const inputs: Record<number, unknown> = {};
  for (const { ev } of records) {
    if (ev.type === "run.created") {
      const declared = (ev as { budget?: { tokens?: number; usd?: number } }).budget;
      // An empty object means "started with no ceiling", which is not the same as a run
      // whose event carried no budget field at all — both read as null here because
      // neither imposes a limit, and a UI showing "/ $0.00" would be a lie.
      if (declared && (declared.tokens !== undefined || declared.usd !== undefined)) budget = declared;
      continue;
    }
    if (ev.type === "step.scheduled" && ev.payload !== undefined) {
      // A resumed run can schedule a second step at the same seq; the later one is what
      // the projection shows, so it is what this must agree with.
      inputs[ev.seq] = ev.payload;
    }
  }

  return { state: reduceState(records), budget, inputs };
}
