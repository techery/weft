/**
 * The assertion surface over a finished run. Every field here is folded out of the
 * journal records themselves, so a view over a resumed run reads exactly like a
 * view over a live one — and `toJSON()` is stable enough to snapshot.
 */
import type { JournalRecord, StepKind } from "@weft/core";
import type { Usage } from "@weft/sdk";

export type StepStatus = "running" | "ok" | "failed";

export interface StepView {
  seq: number;
  kind: StepKind;
  key?: string;
  label?: string;
  phase?: string;
  status: StepStatus;
  /** The journaled output verbatim; agent steps journal `{ value, files, patch }`. */
  output?: unknown;
  /** Agent steps: the prompt as journaled, before the engine appends its scope preamble. */
  prompt?: string;
  route?: { provider: string; model?: string; effort?: string };
  usage?: Usage;
}

/** One `toJSON()` entry: identity and outcome only — nothing that varies run to run. */
export interface JournalSnapshotEntry {
  seq: number;
  kind: StepKind;
  key?: string;
  label?: string;
  phase?: string;
  status: StepStatus;
}

export interface JournalView {
  records: JournalRecord[];
  steps(filter?: { kind?: StepKind; phase?: string }): StepView[];
  /** The step (or human request) carrying this key; throws listing the known keys. */
  step(key: string): StepView;
  /** Snapshot-stable projection: no timestamps, no run ids, no outputs. */
  toJSON(): JournalSnapshotEntry[];
}

/**
 * Human requests are steps too: they get a `seq` from the same counter, so they
 * appear in `steps({ kind: "human" })` keyed by their request id (`h1`, `h2`…)
 * and labelled with the question.
 */
export function buildJournalView(records: JournalRecord[]): JournalView {
  const bySeq = new Map<number, StepView>();
  const humansById = new Map<string, StepView>();
  let currentPhase: string | undefined;

  for (const rec of records) {
    const ev = rec.ev;
    switch (ev.type) {
      case "phase":
        currentPhase = ev.name;
        break;
      case "step.scheduled": {
        const payload = ev.payload as { prompt?: unknown } | undefined;
        const phase = ev.phase ?? currentPhase;
        bySeq.set(ev.seq, {
          seq: ev.seq,
          kind: ev.kind,
          status: "running",
          ...(ev.key !== undefined ? { key: ev.key } : {}),
          ...(ev.label !== undefined ? { label: ev.label } : {}),
          ...(phase !== undefined ? { phase } : {}),
          ...(ev.route !== undefined ? { route: ev.route } : {}),
          ...(typeof payload?.prompt === "string" ? { prompt: payload.prompt } : {}),
        });
        break;
      }
      case "step.completed": {
        const view = bySeq.get(ev.seq);
        if (!view) break;
        view.status = "ok";
        view.output = ev.output;
        if (ev.usage !== undefined) view.usage = ev.usage;
        break;
      }
      case "step.failed": {
        const view = bySeq.get(ev.seq);
        if (view) view.status = "failed";
        break;
      }
      case "human.requested": {
        const view: StepView = {
          seq: ev.seq,
          kind: "human",
          key: ev.id,
          label: ev.question,
          status: "running",
          ...(currentPhase !== undefined ? { phase: currentPhase } : {}),
        };
        bySeq.set(ev.seq, view);
        humansById.set(ev.id, view);
        break;
      }
      case "human.answered": {
        const view = humansById.get(ev.id);
        if (!view) break;
        view.status = "ok";
        view.output = ev.answer;
        break;
      }
      case "human.rejected": {
        // The answer failed the authoritative schema: the request is waiting again.
        const view = humansById.get(ev.id);
        if (!view) break;
        view.status = "running";
        delete view.output;
        break;
      }
      default:
        break;
    }
  }

  const all = [...bySeq.values()].sort((a, b) => a.seq - b.seq);

  return {
    records,
    steps(filter) {
      return all.filter(
        (s) =>
          (filter?.kind === undefined || s.kind === filter.kind) &&
          (filter?.phase === undefined || s.phase === filter.phase),
      );
    },
    step(key) {
      const found = all.find((s) => s.key === key);
      if (found) return found;
      const known = all.flatMap((s) => (s.key !== undefined ? [s.key] : []));
      throw new Error(
        `journal.step: no step with key "${key}" — known keys: ${known.length > 0 ? known.join(", ") : "(none declared a key)"}`,
      );
    },
    toJSON() {
      return all.map((s) => ({
        seq: s.seq,
        kind: s.kind,
        ...(s.key !== undefined ? { key: s.key } : {}),
        ...(s.label !== undefined ? { label: s.label } : {}),
        ...(s.phase !== undefined ? { phase: s.phase } : {}),
        status: s.status,
      }));
    },
  };
}
