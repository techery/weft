/**
 * Reading a run back. The projections carry everything except the journaled step payload
 * (the prompt, the command, the URL) and outputs that were offloaded to the blob store, so
 * `weft explain` and `weft diff` go to the journal and the blobs for those two.
 */
import { type JournalRecord, renderReport, renderTree, type StepState, type Weft } from "@techery/weft-host";

/**
 * Re-derive `state.json` / `tree.json` / `report.md` after this process appended to the
 * journal of a run nobody is driving. The engine snapshots projections for the runs it
 * holds; an `answer` or a `cancel` that lands on a suspended run does not, and `weft ls`
 * reads the projection — so without this the listing keeps showing the pre-answer status.
 * Projections are derived data, safe to rewrite from the journal at any time (C9).
 */
export async function refreshProjections(weft: Weft, runId: string): Promise<void> {
  if (weft.engine.isActive(runId)) return; // the engine is already snapshotting this one
  const state = await weft.engine.state(runId);
  await weft.engine.journal.snapshot(runId, {
    state,
    tree: renderTree(state),
    report: renderReport(state),
  });
}

export async function readRecords(weft: Weft, runId: string): Promise<JournalRecord[]> {
  const records: JournalRecord[] = [];
  for await (const record of weft.engine.journal.read(runId)) records.push(record);
  if (records.length === 0) throw new Error(`run ${runId} not found`);
  return records;
}

/** A big step output lives in the blob store as `{ $outputBlob }`; bring it back. */
export async function resolveOutput(weft: Weft, value: unknown): Promise<unknown> {
  const ref = blobRefOf(value);
  if (ref === undefined) return value;
  const text = await weft.engine.blobs.getText(ref);
  return JSON.parse(text) as unknown;
}

function blobRefOf(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const ref = (value as { $outputBlob?: unknown }).$outputBlob;
  return typeof ref === "string" ? ref : undefined;
}

/** The journaled payload of one step: the agent prompt, the shell command, the git args. */
export function payloadOf(records: readonly JournalRecord[], seq: number): unknown {
  for (const record of records) {
    if (record.ev.type === "step.scheduled" && record.ev.seq === seq) return record.ev.payload;
  }
  return undefined;
}

/**
 * Step outputs by key — what `weft diff` compares. Only keyed steps take part: a step
 * without a key has no identity to match across runs (that is what `key:` is for).
 */
export async function keyedOutputs(weft: Weft, runId: string): Promise<Map<string, unknown>> {
  const state = await weft.engine.state(runId);
  const out = new Map<string, unknown>();
  for (const step of state.steps) {
    if (step.key === undefined || step.status !== "ok") continue;
    out.set(step.key, await resolveOutput(weft, step.output));
  }
  return out;
}

/** Find a step by `key` or by sequence number, the two ways `weft explain` addresses one. */
export function findStep(steps: readonly StepState[], target: string): StepState | undefined {
  const byKey = steps.find((s) => s.key === target || s.label === target);
  if (byKey) return byKey;
  const seq = Number(target);
  return Number.isInteger(seq) ? steps.find((s) => s.seq === seq) : undefined;
}
