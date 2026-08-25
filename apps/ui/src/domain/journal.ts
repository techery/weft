/**
 * Journal records as the lines the Journal tab shows.
 *
 * The journal is the one view of a run that is not a projection, so this is a formatter
 * and nothing else: one record in, one line out, no folding and no interpretation. Where
 * an event carries a number worth seeing — a duration, a token count, a file count — it
 * goes in the text, because that is the difference between a log you read and a log you
 * scroll past.
 */
import type { JournalEvent, JournalRecord } from "~/api/types";
import type { JournalEntry } from "./types";

/** Elapsed since the run's first record, which is what the design's gutter shows. */
export function formatElapsed(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "00:00";
  const total = Math.floor(ms / 1000);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${pad(minutes)}:${pad(seconds)}`;
}

export function journalEntries(records: JournalRecord[]): JournalEntry[] {
  const start = records[0]?.at ?? 0;
  // Only `step.scheduled` names a step's kind; its completion and its failure carry a seq
  // and nothing else. Remembering the kind is what keeps a step's lines under one tag
  // instead of starting as "agent" and finishing as "step".
  const kindBySeq = new Map<number, string>();
  const labelBySeq = new Map<number, string>();
  return records.map((record) => {
    const ev = record.ev;
    if (ev.type === "step.scheduled" && typeof ev.seq === "number") {
      if (typeof ev.kind === "string") kindBySeq.set(ev.seq, ev.kind);
      const named = str(ev.label) || str(ev.key);
      if (named) labelBySeq.set(ev.seq, named);
    }
    return {
      time: formatElapsed(record.at - start),
      tag: tagOf(ev, kindBySeq),
      text: textOf(ev, labelBySeq),
    };
  });
}

/** The tag column: who did this, in one word. */
function tagOf(ev: JournalEvent, kindBySeq: Map<number, string>): string {
  const type = ev.type;
  if (type.startsWith("run.")) return "run";
  if (type.startsWith("human.")) return "human";
  if (type.startsWith("patch.")) return "patch";
  if (type.startsWith("signal.")) return "signal";
  if (type.startsWith("replay.")) return "replay";
  if (type.startsWith("step.")) {
    if (typeof ev.kind === "string") return ev.kind;
    const remembered = typeof ev.seq === "number" ? kindBySeq.get(ev.seq) : undefined;
    return remembered ?? "step";
  }
  if (type === "budget.sampled") return "budget";
  if (type === "scope.violation") return "scope";
  return type;
}

function textOf(ev: JournalEvent, labelBySeq: Map<number, string> = new Map()): string {
  const seq = typeof ev.seq === "number" ? `#${ev.seq}` : "";
  // Only `step.scheduled` names a step; its completion and failure carry a seq alone, so
  // the name is remembered rather than letting a finished step read as "#12 ok".
  const remembered = typeof ev.seq === "number" ? (labelBySeq.get(ev.seq) ?? "") : "";
  const named = label(ev) || remembered || seq || "";

  switch (ev.type) {
    case "run.created":
      return `run.started · ${str(nested(ev, "workflow", "name")) || "workflow"}${inputSuffix(ev)}`;
    case "run.status":
      return `run.status · ${str(ev.status)}`;
    case "run.completed":
      return "run.finished";
    case "run.failed":
      return `run.failed · ${str(nested(ev, "error", "code"))} ${str(nested(ev, "error", "message"))}`.trim();
    case "run.cancelled":
      return "run.cancelled";
    case "phase":
      return `phase · ${str(ev.name)}`;
    case "step.scheduled":
      return `${named} started${route(ev)}`;
    case "step.attempt":
      return `${named} retry ${num(ev.attempt)}${ev.detail ? ` · ${str(ev.detail)}` : ""}`;
    case "step.completed":
      return `${named} ok${usage(ev)}`;
    case "step.failed":
      return `${named} failed · ${str(nested(ev, "error", "code"))} ${str(nested(ev, "error", "message"))}`.trim();
    case "human.requested":
      return `human.requested ${str(ev.id)} · ${str(ev.question)}${ev.risk ? ` · risk ${str(ev.risk)}` : ""}`;
    case "human.answered":
      return `human.answered ${str(ev.id)}${ev.answeredBy ? ` · answered_by: ${str(ev.answeredBy)}` : ""}`;
    case "human.rejected":
      return `human.rejected ${str(ev.id)} · ${str(ev.reason)}`;
    case "patch.captured":
      return `patch captured · ${str(ev.key)} · ${count(ev.files, "file")}`;
    case "patch.merged":
      return `patch merged · ${str(ev.key)}${ev.conflicted ? " · conflicted" : ""}`;
    case "patch.discarded":
      return `patch discarded · ${str(ev.key)}`;
    case "scope.violation":
      return `scope violation · ${str(ev.key)} · ${count(ev.files, "file")} · ${str(ev.mode)}`;
    case "check":
      return `check ${str(ev.name)} · ${str(ev.status)}${ev.evidence ? ` · ${str(ev.evidence)}` : ""}`;
    case "note":
      return `${str(ev.kind) || "note"} · ${str(ev.text)}`;
    case "log":
      return str(ev.text) || str(ev.message);
    case "budget.sampled":
      return `budget · ${num(ev.tokens)} tok · $${money(ev.usd)}`;
    case "signal.received":
      return `signal ${str(ev.name)}`;
    case "signal.rejected":
      return `signal ${str(ev.name)} rejected`;
    case "timer.fired":
      return `timer fired${named ? ` · ${named}` : ""}`;
    case "replay.salvaged":
      return `replay salvaged ${named}`;
    case "replay.diverged":
      return `replay diverged ${named} · ${str(ev.reason)}`;
    case "drop":
      return `dropped ${named} · ${str(ev.reason)}`;
    default:
      // An event this UI has not been taught still belongs in the journal, named.
      return ev.type;
  }
}

function label(ev: JournalEvent): string {
  return str(ev.label) || str(ev.key) || "";
}

function route(ev: JournalEvent): string {
  const provider = str(nested(ev, "route", "provider"));
  if (!provider) return "";
  const model = str(nested(ev, "route", "model"));
  return ` · ${provider}${model ? `/${model}` : ""}`;
}

function usage(ev: JournalEvent): string {
  const usageValue = ev.usage;
  if (typeof usageValue !== "object" || usageValue === null) return "";
  const record = usageValue as Record<string, unknown>;
  const tokens = (asNumber(record.input) ?? 0) + (asNumber(record.output) ?? 0);
  const usd = asNumber(record.usd);
  const parts: string[] = [];
  if (tokens > 0) parts.push(`${tokens.toLocaleString()} tok`);
  if (usd !== undefined && usd > 0) parts.push(`$${money(usd)}`);
  return parts.length > 0 ? ` · ${parts.join(" · ")}` : "";
}

function inputSuffix(ev: JournalEvent): string {
  const input = ev.input;
  if (typeof input !== "object" || input === null || Array.isArray(input)) return "";
  const keys = Object.keys(input as Record<string, unknown>);
  return keys.length > 0 ? ` · inputs { ${keys.join(", ")} }` : "";
}

function nested(ev: JournalEvent, outer: string, inner: string): unknown {
  const value = ev[outer];
  if (typeof value !== "object" || value === null) return undefined;
  return (value as Record<string, unknown>)[inner];
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function num(value: unknown): string {
  const n = asNumber(value);
  return n === undefined ? "" : n.toLocaleString();
}

function money(value: unknown): string {
  return (asNumber(value) ?? 0).toFixed(2);
}

function count(value: unknown, noun: string): string {
  const n = Array.isArray(value) ? value.length : 0;
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
