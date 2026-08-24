import type { JournalEvent, JournalRecord, JournalStore, RunStatus, StepKind } from "@weft/core";

export interface StepSpec {
  key: string;
  label?: string;
  kind?: StepKind;
  usage?: { input: number; output: number; usd?: number };
}

export interface RunSpec {
  runId: string;
  workflow: string;
  parentRunId?: string;
  /** Terminal (or in-flight) status recorded after the steps. */
  status?: RunStatus;
  steps?: StepSpec[];
  /** Each becomes a `human.requested` whose question feeds the searchable text. */
  questions?: string[];
  /** When set, a `budget.sampled` event lands last and becomes the run's spend. */
  budget?: { tokens: number; usd: number };
}

/**
 * Writes a hand-built journal for one run and hands back its records. Batches are
 * appended separately so `createdAt` and `updatedAt` differ under a stepping clock.
 */
export async function seedRun(store: JournalStore, spec: RunSpec): Promise<JournalRecord[]> {
  await store.append(spec.runId, [
    {
      type: "run.created",
      runId: spec.runId,
      workflow: { name: spec.workflow },
      input: {},
      cwd: "/repo",
      depth: spec.parentRunId ? 1 : 0,
      ...(spec.parentRunId ? { parentRunId: spec.parentRunId } : {}),
    },
  ]);

  const body: JournalEvent[] = [];
  spec.steps?.forEach((step, i) => {
    body.push({
      type: "step.scheduled",
      seq: i + 1,
      hash: `hash-${spec.runId}-${i}`,
      kind: step.kind ?? "agent",
      key: step.key,
      ...(step.label !== undefined ? { label: step.label } : {}),
    });
    body.push({
      type: "step.completed",
      seq: i + 1,
      output: { ok: true },
      ...(step.usage !== undefined ? { usage: step.usage } : {}),
    });
  });
  spec.questions?.forEach((question, i) => {
    body.push({
      type: "human.requested",
      id: `q${i + 1}`,
      seq: 100 + i,
      hash: `human-${spec.runId}-${i}`,
      kind: "ask",
      question,
      schema: { type: "string" },
    });
  });
  if (body.length > 0) await store.append(spec.runId, body);

  const tail: JournalEvent[] = [];
  if (spec.budget) tail.push({ type: "budget.sampled", tokens: spec.budget.tokens, usd: spec.budget.usd });
  if (spec.status === "complete") tail.push({ type: "run.completed", output: { ok: true } });
  else if (spec.status === "cancelled") tail.push({ type: "run.cancelled" });
  else if (spec.status === "failed") {
    tail.push({
      type: "run.failed",
      error: { name: "StepError", code: "internal", message: "boom", step: {} },
    });
  } else if (spec.status) tail.push({ type: "run.status", status: spec.status });
  if (tail.length > 0) await store.append(spec.runId, tail);

  return readRecords(store, spec.runId);
}

export async function readRecords(store: JournalStore, runId: string): Promise<JournalRecord[]> {
  const out: JournalRecord[] = [];
  for await (const rec of store.read(runId)) out.push(rec);
  return out;
}

/** A monotonic fake clock so seeded runs sort deterministically by createdAt. */
export function steppingClock(start = 1_700_000_000_000, step = 1_000): () => number {
  let t = start;
  return () => {
    t += step;
    return t;
  };
}
