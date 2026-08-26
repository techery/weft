/**
 * The daemon's shapes, as the screens' shapes.
 *
 * The UI was built against a design's data model, which is richer than the journal in a
 * few places and poorer in others. This is where that is reconciled, once, so no component
 * has to know which fields are real:
 *
 *   - Derived where it can be. A workflow's shape strip comes from its most recent run's
 *     step kinds; its phase labels come from that run's phases. Neither is declared
 *     anywhere, and both are true of the thing that actually ran.
 *   - Omitted where nothing records it. A step's tool calls exist only as prose inside an
 *     agent transcript, and "what weft will do next" is not journaled at all — so those
 *     read as absent rather than as invented. The rail likewise shows only steps that have
 *     started, which is what the design's own caption says it does.
 *   - Never faked. A run started with no ceiling shows its spend and no denominator.
 */
import type {
  ArtifactEntry,
  HumanState,
  JsonSchema,
  Meta,
  PendingRequest,
  RunDetail,
  RunRow,
  RunStatus,
  StepState,
  WorkflowDetail,
  WorkflowRow,
  WorkflowStats,
} from "~/api/types";
import { formatElapsed } from "./journal";
import type {
  StepState as DomainStepState,
  Finding,
  Gate,
  GateOption,
  GateQuestion,
  GateQuestionKind,
  Labelled,
  RailGroup,
  RailStep,
  Run,
  RunState,
  StepCell,
  StepDetail,
  StepInput,
  StepKind,
  Workflow,
  WorkflowLabel,
} from "./types";

/* ── Identity ─────────────────────────────────────────────────────────────
   Step ids have to survive being a URL search param, so they are derived from
   what the journal guarantees is stable: a step's seq, a request's id. */

export const stepId = (seq: number): string => `step:${seq}`;
export const gateStepId = (requestId: string): string => `gate:${requestId}`;

/* ── Status ─────────────────────────────────────────────────────────────── */

const RUN_STATE: Record<RunStatus, RunState> = {
  planning: "running",
  executing: "running",
  integrating: "running",
  verifying: "running",
  waiting_for_human: "waiting",
  waiting_for_signal: "waiting",
  complete: "done",
  failed: "failed",
  cancelled: "stopped",
};

export function runState(status: RunStatus): RunState {
  return RUN_STATE[status] ?? "running";
}

/** The three buckets the design's rail and shape strip paint with. */
export function stepBucket(kind: string): StepKind {
  if (kind === "agent") return "agent";
  if (kind === "human") return "human";
  return "task";
}

function stepStatus(step: StepState): DomainStepState {
  if (step.status === "ok") return "done";
  if (step.status === "failed") return "fail";
  return "run";
}

/* ── Formatting ───────────────────────────────────────────────────────────── */

export function money(usd: number): string {
  return `$${usd.toFixed(2)}`;
}

/**
 * What a run cost, in whatever unit the providers actually reported. Codex reports tokens
 * and no dollars, so a bare "$0.00" beside three million tokens reads as free rather than
 * as unpriced.
 */
export function spend(budget: { tokens: number; usd: number }): string {
  if (budget.usd > 0) return money(budget.usd);
  if (budget.tokens > 0) return `${compactTokens(budget.tokens)} tok`;
  return "$0.00";
}

function compactTokens(count: number): string {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  if (count >= 1_000) return `${Math.round(count / 1_000)}k`;
  return String(count);
}

export function tokens(step: StepState): number {
  return (step.usage?.input ?? 0) + (step.usage?.output ?? 0);
}

/** How long ago, in the design's terse voice. */
export function ago(at: number | null | undefined, now = Date.now()): string {
  if (at === null || at === undefined) return "";
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h`;
  const days = Math.round(hours / 24);
  return days === 1 ? "yesterday" : `${days} d`;
}

/** A wall-clock stamp for a list column, in the local zone. */
export function clock(at: number): string {
  return new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

export function duration(from: number, to: number | undefined): string {
  return formatElapsed((to ?? Date.now()) - from);
}

/* ── Runs ─────────────────────────────────────────────────────────────────── */

export interface RunExtras {
  /** The workflow's file, when the registry listing has been loaded. */
  file?: string;
  /** Journal-derived lines, when the stream has delivered them. */
  journal?: Run["journal"];
  /** The request blocking this run, from the queue. */
  pending?: PendingRequest;
  /** Changed files, from the patch route. */
  files?: Run["files"];
  /** The run's artifact inventory. */
  artifacts?: Run["artifacts"];
  /** Completion-only fields recovered directly from journal records for older daemon projections. */
  agentSessions?: Record<string, { sessionId?: string; transcriptRef?: { $blob: string; size: number } }>;
}

export function adaptRun(detail: RunDetail, extras: RunExtras = {}): Run {
  const state = runState(detail.status);
  // A resumed run journals the same seq twice, and the projection keeps both occurrences
  // so the earlier one stays readable. Everything counted here — the step total, what is
  // active, the rail — means DISTINCT steps, so it reads the latest of each.
  const steps = latestBySeq(detail.steps);
  const running = steps.filter((step) => step.status === "running");
  const pending = detail.humans.filter((human) => human.status === "pending");
  const gate = extras.pending ? adaptGate(extras.pending) : adaptGateFromState(detail, pending[0]);

  return {
    id: detail.runId,
    wf: detail.workflow,
    file: extras.file ?? "",
    state,
    chrome: chromeOf(detail, steps.length),
    pill: pillOf(detail, running.length, pending.length),
    gateStep: gate ? gateStepId(gate.id) : null,
    railTitle: railTitleOf(detail, steps.length),
    rail: railOf(detail, steps, pending, terminal(detail.status)),
    // A finished run has nothing active. A step still marked `running` in one never
    // recorded its completion, and counting elapsed time from its start would report the
    // age of the run as its duration.
    active: terminal(detail.status)
      ? []
      : running.map((step) => ({
          label: step.phase ?? "",
          name: labelOf(step),
          meta: duration(step.startedAt, undefined),
          stepId: stepId(step.seq),
        })),
    findings: findingsOf(detail),
    artifacts: extras.artifacts ?? [],
    files: extras.files ?? [],
    // "Committed" is not a thing the journal records; a merged patch is the nearest true
    // statement, and it is what decides whether the changes pane still offers actions.
    committed: detail.patches.merged.length > 0,
    changesNote: changesNoteOf(detail),
    branchNote: branchNoteOf(detail),
    journal: extras.journal ?? [],
    gate,
    steps: stepsOf(detail, steps, pending, extras.agentSessions),
  };
}

function chromeOf(detail: RunDetail, stepCount: number): string {
  const parts = [
    `${stepCount} step${stepCount === 1 ? "" : "s"}`,
    duration(detail.createdAt, terminal(detail.status) ? detail.updatedAt : undefined),
  ];
  const cap = detail.limits?.usd;
  // No ceiling means no denominator: "$0.12 / $0.00" would read as over budget.
  parts.push(cap === undefined ? spend(detail.budget) : `${money(detail.budget.usd)} / ${money(cap)}`);
  return parts.join(" · ");
}

function pillOf(detail: RunDetail, running: number, pending: number): string {
  switch (detail.status) {
    case "waiting_for_human":
      return pending > 1 ? `waiting on you · ${pending} questions` : "waiting on you";
    case "waiting_for_signal":
      return "waiting for a signal";
    case "complete":
      return `done · ${ago(detail.updatedAt)}`;
    case "failed":
      return `failed · ${detail.error?.code ?? "error"}`;
    case "cancelled":
      return "stopped";
    default:
      return running === 1 ? "1 step active" : `${running} steps active`;
  }
}

function railTitleOf(detail: RunDetail, stepCount: number): string {
  return terminal(detail.status)
    ? `Run tree · ${stepCount} step${stepCount === 1 ? "" : "s"} recorded`
    : "Run tree · appended as steps start";
}

/**
 * The rail, grouped by phase. Steps a workflow never labelled fall into one trailing
 * group, the same way `renderTree` gathers them, so nothing is dropped for lacking a name.
 * A pending human request is shown as `waiting`, which the step's own status cannot say —
 * a human step is "running" right up until it is answered.
 */
function railOf(
  detail: RunDetail,
  steps: StepState[],
  pending: HumanState[],
  runFinished: boolean,
): RailGroup[] {
  const waitingSeqs = new Set(pending.map((human) => human.seq));
  const bySeq = new Map(steps.map((step) => [step.seq, step]));

  // A resumed run schedules the same seq again, so the projection can list one step under
  // two phases. The projection's own rule for a duplicate seq is that the LATEST occurrence
  // counts, and the same holds here: a step shows once, under the phase that was current
  // when it last ran.
  const phaseOf = new Map<number, string>();
  for (const phase of detail.phases) {
    for (const seq of phase.steps) phaseOf.set(seq, phase.name);
  }

  const groups: RailGroup[] = [];
  const grouped = new Set<number>();
  for (const phase of detail.phases) {
    const steps = phase.steps
      .filter((seq) => phaseOf.get(seq) === phase.name)
      .map((seq) => bySeq.get(seq))
      .filter((step): step is StepState => step !== undefined);
    if (steps.length === 0) continue;
    for (const step of steps) grouped.add(step.seq);
    groups.push({
      name: phase.name,
      meta: groupMeta(steps),
      steps: steps.map((step) => railStep(step, waitingSeqs, runFinished)),
    });
  }

  const loose = steps.filter((step) => !grouped.has(step.seq));
  if (loose.length > 0) {
    groups.push({
      name: "no phase",
      meta: groupMeta(loose),
      steps: loose.map((step) => railStep(step, waitingSeqs, runFinished)),
    });
  }
  return groups;
}

/** A group's one-line summary. The count is said once, never twice. */

function groupMeta(steps: StepState[]): string {
  const kinds = new Set(steps.map((step) => step.kind));
  const parallel = steps.filter((step) => step.status === "running").length > 1;
  const shape =
    kinds.size === 1
      ? `${[...kinds][0]}${steps.length > 1 ? ` ×${steps.length}` : ""}`
      : `${steps.length} steps`;
  return `${shape}${parallel ? " ∥" : ""}`;
}

function railStep(step: StepState, waiting: Set<number>, runFinished: boolean): RailStep {
  const isWaiting = step.kind === "human" && waiting.has(step.seq);
  // A step left running by a run that has since finished never recorded a completion.
  const stranded = runFinished && step.status === "running";
  return {
    id: stepId(step.seq),
    kind: stepBucket(step.kind),
    label: labelOf(step),
    meta: stepMeta(step, isWaiting, stranded),
    state: isWaiting ? "waiting" : stranded ? "idle" : stepStatus(step),
    artifact: step.patchRef ? "patch" : "",
  };
}

function stepMeta(step: StepState, waiting: boolean, stranded: boolean): string {
  if (waiting) return "waiting on you";
  if (stranded) return "never finished";
  if (step.status === "failed") return `failed${step.error?.code ? ` · ${step.error.code}` : ""}`;
  const count = tokens(step);
  if (count > 0) return `${(count / 1000).toFixed(1)}k tok`;
  return duration(step.startedAt, step.endedAt);
}

function labelOf(step: StepState): string {
  return step.label ?? step.key ?? `${step.kind}#${step.seq}`;
}

/**
 * Findings, from the notes a run journaled. The design's findings each opened a step;
 * `ctx.note` records no such link, so a note names itself and the card omits the footer
 * rather than pointing at a step nothing chose.
 */
function findingsOf(detail: RunDetail): Finding[] {
  return detail.notes.map((note, index) => ({
    id: `n-${index + 1}`,
    msg: note.text,
    loc: note.evidence ?? "",
    sev: note.kind,
    stepLabel: "",
    chip: "",
    settled: true,
  }));
}

function changesNoteOf(detail: RunDetail): string {
  if (detail.patches.captured.length === 0) return "";
  if (detail.patches.merged.length > 0) return "Merged into the working tree.";
  if (detail.patches.discarded.length > 0) return "Discarded — nothing was applied.";
  return "Captured in an isolated worktree. Nothing is in your tree until it is merged.";
}

function branchNoteOf(detail: RunDetail): string {
  const captured = detail.patches.captured.length;
  if (captured === 0) return "";
  const merged = detail.patches.merged.length;
  return `${captured} patch${captured === 1 ? "" : "es"} captured · ${merged} merged`;
}

function terminal(status: RunStatus): boolean {
  return status === "complete" || status === "failed" || status === "cancelled";
}

/* ── Steps ────────────────────────────────────────────────────────────────── */

function stepsOf(
  detail: RunDetail,
  steps: StepState[],
  pending: HumanState[],
  sessions: RunExtras["agentSessions"] = {},
): Record<string, StepDetail> {
  const out: Record<string, StepDetail> = {};
  const waitingIds = new Set(pending.map((human) => human.id));

  for (const step of steps) {
    out[stepId(step.seq)] = machineStep(detail, step, sessions?.[String(step.seq)]);
  }
  for (const human of detail.humans) {
    out[gateStepId(human.id)] = humanStep(human, waitingIds.has(human.id));
  }
  return out;
}

function machineStep(
  detail: RunDetail,
  step: StepState,
  session?: { sessionId?: string; transcriptRef?: { $blob: string; size: number } },
): StepDetail {
  const cost = step.usage?.usd;
  const cells: StepCell[] = [
    { k: "kind", v: step.kind },
    ...(step.route
      ? [{ k: "provider", v: `${step.route.provider}${step.route.model ? `/${step.route.model}` : ""}` }]
      : []),
    { k: step.endedAt === undefined ? "elapsed" : "duration", v: duration(step.startedAt, step.endedAt) },
    ...(tokens(step) > 0 ? [{ k: "tokens", v: tokens(step).toLocaleString() }] : []),
    ...(cost !== undefined && cost > 0 ? [{ k: "cost", v: money(cost) }] : []),
    ...(step.attempts !== undefined && step.attempts > 1
      ? [{ k: "attempts", v: String(step.attempts) }]
      : []),
    ...(step.phase !== undefined ? [{ k: "phase", v: step.phase }] : []),
    ...(step.childRunId !== undefined ? [{ k: "child run", v: step.childRunId, color: "#a9583e" }] : []),
    ...(step.error ? [{ k: "error", v: step.error.code ?? "failed", color: "#b0483a" }] : []),
  ];

  const output = visibleStepOutput(step);
  const input = detail.inputs?.[String(step.seq)];
  const failed = step.status === "failed";
  const transcript = step.transcriptRef ?? session?.transcriptRef;
  return {
    title: `${labelOf(step)} · step ${step.seq}`,
    pill: failed
      ? "failed"
      : step.status === "ok"
        ? `done · ${duration(step.startedAt, step.endedAt)}`
        : `running · ${duration(step.startedAt, undefined)}`,
    pillKind: failed ? "fail" : step.status === "ok" ? "done" : "run",
    action: "Copy step id",
    cells,
    input: inputRows(input),
    inputValue: input,
    inputSchema: null,
    outTitle: failed ? "step error" : step.status === "ok" ? "step output" : "step output · running",
    outNote: failed ? "" : output === undefined ? "" : "schema-validated",
    outValue: failed ? (step.error?.message ?? step.error?.code) : output,
    outSchema: failed ? null : (step.schema ?? null),
    out: failed
      ? [step.error?.message ?? step.error?.code ?? "the step failed with no message"]
      : jsonLines(output),
    streaming: step.status === "running",
    agentTranscript:
      step.kind === "agent"
        ? {
            sessionId: step.sessionId ?? session?.sessionId ?? "",
            transcriptRef: transcript?.$blob ?? "",
            transcriptSize: transcript?.size ?? 0,
          }
        : null,
    tools: [],
    toolsTitle: "",
    next: failed && step.error?.message ? { k: "error", v: step.error.message, goToGate: false } : null,
    ...(step.presentation !== undefined ? { presentation: step.presentation } : {}),
  };
}

/** Agent journal entries carry execution metadata around the schema-validated value. */
function visibleStepOutput(step: StepState): unknown {
  const output = step.output;
  if (step.kind !== "agent" || typeof output !== "object" || output === null || Array.isArray(output)) {
    return output;
  }
  return "value" in output ? (output as Record<string, unknown>).value : output;
}

function humanStep(human: HumanState, waiting: boolean): StepDetail {
  return {
    title: `${human.kind}: ${human.question}`,
    pill: waiting ? "waiting on you" : `answered${human.answeredBy ? ` · ${human.answeredBy}` : ""}`,
    pillKind: waiting ? "human" : "done",
    action: "Copy gate id",
    cells: [
      { k: "kind", v: "human" },
      { k: "asks", v: human.kind },
      ...(human.risk ? [{ k: "risk", v: human.risk, color: "#a9583e" }] : []),
      { k: "requested", v: clock(human.requestedAt) },
      ...(human.answeredBy ? [{ k: "answered by", v: human.answeredBy }] : []),
    ],
    input: [
      { k: "question", kind: "text", ref: "", title: human.question, sub: "", pills: [] },
      ...(human.detail !== undefined
        ? [{ k: "detail", kind: "text" as const, ref: "", title: human.detail, sub: "", pills: [] }]
        : []),
    ],
    inputValue: {
      question: human.question,
      ...(human.detail !== undefined ? { detail: human.detail } : {}),
    },
    inputSchema: null,
    outTitle: "answer",
    outNote: waiting ? "" : "journaled verbatim",
    outValue: waiting ? undefined : human.answer,
    outSchema: waiting ? null : (human.schema as JsonSchema),
    out: waiting ? ["pending — nothing moves until this is answered"] : jsonLines(human.answer),
    streaming: false,
    agentTranscript: null,
    tools: [],
    toolsTitle: "",
    next: waiting ? { k: "needs you", v: "This question is holding the run.", goToGate: true } : null,
    ...(human.ui !== undefined ? { presentation: human.ui } : {}),
  };
}

/** A step's scheduled payload, as the design's key/value rows. */
function inputRows(payload: unknown): StepInput[] {
  if (payload === undefined || payload === null) return [];
  if (typeof payload !== "object" || Array.isArray(payload)) {
    return [{ k: "payload", kind: "text", ref: "", title: compact(payload), sub: "", pills: [] }];
  }
  return Object.entries(payload as Record<string, unknown>).map(([key, value]) => {
    // A list of short strings reads better as pills than as JSON.
    if (Array.isArray(value) && value.every((v) => typeof v === "string" && v.length < 40)) {
      return { k: key, kind: "pills" as const, ref: "", title: "", sub: "", pills: value as string[] };
    }
    return { k: key, kind: "text" as const, ref: "", title: compact(value), sub: "", pills: [] };
  });
}

/**
 * The latest occurrence of each step. A replay that could not trust step positions
 * re-schedules a seq, and the projection keeps both records on purpose; the second is what
 * actually ran.
 */
function latestBySeq(steps: StepState[]): StepState[] {
  const bySeq = new Map<number, StepState>();
  for (const step of steps) bySeq.set(step.seq, step);
  return [...bySeq.values()].sort((a, b) => a.seq - b.seq);
}

/** Pretty-printed JSON as lines, or one line for a scalar. */
export function jsonLines(value: unknown): string[] {
  if (value === undefined) return [];
  if (typeof value === "string") return value.split("\n");
  try {
    return JSON.stringify(value, null, 2).split("\n");
  } catch {
    return [String(value)];
  }
}

function compact(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

/* ── Gates ────────────────────────────────────────────────────────────────── */

const DENIABLE = new Set(["approve", "confirm"]);

export function adaptGate(request: PendingRequest): Gate {
  const deniable = DENIABLE.has(request.kind);
  return {
    id: request.id,
    runId: request.runId,
    deniable,
    risk: request.risk ?? "",
    blocks: "holds the run until answered",
    title: request.question,
    detail: request.detail ?? "",
    submitLabel: deniable ? "Approve & resume" : "Answer & resume",
    denyLabel: "Deny & stop",
    // The two buttons ARE the verdict for a deniable gate, so the schema's own boolean is
    // not shown as a third control saying the same thing — a toggle reading "no" beside a
    // button reading "Approve" is a question about which one the run will hear.
    questions: schemaQuestions(request.schema as JsonSchema | null).filter(
      (question) => !(deniable && question.key === VERDICT_FIELD),
    ),
    ...(request.artifactRef
      ? {
          artifactRef: {
            ref: request.artifactRef.$blob,
            size: request.artifactRef.size,
            ...(request.artifactRef.preview !== undefined ? { preview: request.artifactRef.preview } : {}),
          },
        }
      : {}),
    ...(request.ui !== undefined ? { ui: request.ui } : {}),
  };
}

/** The field `ctx.human.approve` declares for the verdict itself. */
export const VERDICT_FIELD = "approved";

/** The same gate, built from a run's own projection when the queue was not the way in. */
function adaptGateFromState(detail: RunDetail, human: HumanState | undefined): Gate | null {
  if (human === undefined) return null;
  return adaptGate({
    runId: detail.runId,
    id: human.id,
    kind: human.kind,
    question: human.question,
    schema: human.schema,
    createdAt: human.requestedAt,
    workflow: detail.workflow,
    rootRunId: detail.parentRunId ?? detail.runId,
    rootWorkflow: detail.workflow,
    ...(human.detail !== undefined ? { detail: human.detail } : {}),
    ...(human.risk !== undefined ? { risk: human.risk } : {}),
    ...(human.artifactRef !== undefined ? { artifactRef: human.artifactRef } : {}),
    ...(human.ui !== undefined ? { ui: human.ui } : {}),
  });
}

/**
 * A gate's form, from the JSON Schema of the answer it expects.
 *
 * The control is chosen from the declaration, never guessed from the field name: an enum
 * is a set of pills, a boolean is a toggle, a long-form string is a note, everything else
 * is a text field. An `anyOf` of consts carrying descriptions is the one shape that gets
 * cards, because it is the only one that supplies anything to put on them.
 */
export function schemaQuestions(schema: JsonSchema | null): GateQuestion[] {
  if (!schema || schema.properties === undefined) return [];
  const required = new Set(schema.required ?? []);
  return Object.entries(schema.properties).map(([key, property]) => {
    const options = optionsOf(property);
    return {
      key,
      label: property.title ?? key,
      kind: controlOf(key, property, options),
      options,
      required: required.has(key),
    };
  });
}

function controlOf(key: string, property: JsonSchema, options: GateOption[]): GateQuestionKind {
  if (property.type === "boolean") return "toggle";
  if (options.length > 0) {
    if (options.some((option) => option.desc !== "")) return "cards";
    if (property.type === "array") return "chips";
    return options.length > 4 ? "select" : "choice";
  }
  if (property.type === "array") return "list";
  // A field described as prose, or named like one, gets room to write in.
  if (property.description !== undefined && property.description.length > 60) return "note";
  if (/note|detail|reason|message|description/i.test(key)) return "note";
  return "text";
}

function optionsOf(property: JsonSchema): GateOption[] {
  const source = property.type === "array" ? (property.items ?? {}) : property;
  if (Array.isArray(source.enum)) {
    return source.enum.map((value) => ({ label: String(value), meta: "", desc: "" }));
  }
  const branches = source.anyOf ?? source.oneOf;
  if (branches) {
    const consts = branches.filter((branch) => branch.const !== undefined);
    if (consts.length === branches.length && consts.length > 0) {
      return consts.map((branch) => ({
        label: String(branch.const),
        meta: "",
        desc: branch.description ?? "",
      }));
    }
  }
  return [];
}

/** The answer object to POST, from the collected values and the schema's own types. */
export function gateAnswer(schema: JsonSchema | null, values: Record<string, unknown>): unknown {
  if (!schema || schema.properties === undefined) return values;
  const out: Record<string, unknown> = {};
  for (const [key, property] of Object.entries(schema.properties)) {
    const value = values[key];
    if (value === undefined || value === "") continue;
    if (property.type === "number" || property.type === "integer") {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) out[key] = parsed;
      continue;
    }
    if (property.type === "array" && typeof value === "string") {
      const items = value
        .split(/[\n,]/)
        .map((item) => item.trim())
        .filter(Boolean)
        .map((item) => {
          if (property.items?.type !== "number" && property.items?.type !== "integer") return item;
          const parsed = Number(item);
          return Number.isFinite(parsed) ? parsed : item;
        });
      if (items.length > 0) out[key] = items;
      continue;
    }
    out[key] = value;
  }
  return out;
}

/* ── Workflows ────────────────────────────────────────────────────────────── */

export interface WorkflowExtras {
  stats?: WorkflowStats;
  detail?: WorkflowDetail;
  /** The most recent run of this workflow, folded — the only source of its shape. */
  shapeSource?: RunDetail;
}

export function adaptWorkflow(row: WorkflowRow, extras: WorkflowExtras = {}): Workflow {
  const stats = extras.stats;
  const recent = stats?.recent ?? [];
  return {
    file: row.file,
    name: row.name,
    desc: row.description,
    state: workflowStateOf(recent),
    lastLabel: ago(stats?.lastRunAt),
    // `null` means "never scored", which is not the same as "scored perfectly".
    ok: stats?.successRate ?? null,
    p50: stats?.p50Ms === null || stats?.p50Ms === undefined ? "—" : formatElapsed(stats.p50Ms),
    cost: costOf(stats),
    labels: labelsOf(extras.shapeSource),
    // Newest-first from the API; the sparkline reads oldest-first.
    history: [...recent].reverse().map((run) => (run.status === "complete" ? 1 : 0)),
    historyNote: historyNoteOf(stats),
    facts: factsOf(row, extras),
    recent: recent.map((run) => ({
      id: run.runId,
      outcome: run.status,
      ago: ago(run.createdAt),
    })),
    inputs: [],
  };
}

/** Median run cost, in whatever unit was reported — or nothing, for a workflow never run. */
function costOf(stats: WorkflowStats | undefined): string {
  if (stats === undefined || stats.runs === 0) return "—";
  if (stats.p50Usd !== null && stats.p50Usd > 0) return money(stats.p50Usd);
  if (stats.tokens > 0) return `${compactTokens(Math.round(stats.tokens / Math.max(stats.runs, 1)))} tok`;
  return "—";
}

function workflowStateOf(recent: WorkflowStats["recent"]): Workflow["state"] {
  const live = recent.find(
    (run) => run.status === "waiting_for_human" || run.status === "waiting_for_signal",
  );
  if (live) return "waiting";
  const running = recent.find(
    (run) => run.status === "executing" || run.status === "planning" || run.status === "verifying",
  );
  return running ? "running" : "idle";
}

function labelsOf(run: RunDetail | undefined): WorkflowLabel[] {
  if (!run) return [];
  return run.phases.map((phase) => {
    const steps = phase.steps
      .map((seq) => run.steps.find((step) => step.seq === seq))
      .filter((step): step is StepState => step !== undefined);
    const counts = new Map<StepKind, number>();
    for (const step of steps) {
      const kind = stepBucket(step.kind);
      counts.set(kind, (counts.get(kind) ?? 0) + 1);
    }
    const summary = [...counts].map(([kind, count]) => `${kind}${count > 1 ? ` ×${count}` : ""}`);
    if (hasOverlap(steps)) summary.push("parallel");
    return { name: phase.name, meta: summary.join(" · ") };
  });
}

function hasOverlap(steps: StepState[]): boolean {
  const ordered = [...steps].sort((a, b) => a.startedAt - b.startedAt);
  let activeUntil = Number.NEGATIVE_INFINITY;
  for (const step of ordered) {
    if (step.startedAt < activeUntil) return true;
    activeUntil = Math.max(activeUntil, step.endedAt ?? Number.POSITIVE_INFINITY);
  }
  return false;
}

function historyNoteOf(stats: WorkflowStats | undefined): string {
  if (!stats || stats.runs === 0) return "no runs in the window";
  const parts: string[] = [];
  if (stats.failed > 0) parts.push(`${stats.failed} failed`);
  if (stats.cancelled > 0) parts.push(`${stats.cancelled} cancelled`);
  if (parts.length === 0) parts.push(`no failures in ${stats.windowDays}d`);
  if (stats.truncated) parts.push("window truncated");
  return parts.join(" · ");
}

/**
 * Facts about a workflow that are actually recorded. The design listed a schedule and an
 * owner; weft has neither concept, so this reports what it does know — where the code is,
 * what it costs, and what the gate policy will do to it.
 */
function factsOf(row: WorkflowRow, extras: WorkflowExtras): Labelled[] {
  const stats = extras.stats;
  const out: Labelled[] = [{ k: "file", v: row.file }];
  if (extras.detail?.defaults?.provider) {
    out.push({ k: "provider", v: extras.detail.defaults.provider });
  }
  if (extras.detail?.tasksConfigured) {
    out.push({ k: "task schema", v: `v${extras.detail.taskExtensionSchemaVersion}` });
  }
  if (stats) {
    out.push({ k: "runs · 30d", v: String(stats.runs) });
    out.push({ k: "spend · 30d", v: money(stats.usd) });
    if (stats.p95Ms !== null) out.push({ k: "p95", v: formatElapsed(stats.p95Ms) });
  }
  return out;
}

/* ── Artifacts ────────────────────────────────────────────────────────────── */

export function adaptArtifacts(entries: ArtifactEntry[]): Run["artifacts"] {
  return entries.map((entry) => ({
    name: entry.kind === "patch" ? (entry.key ?? entry.id) : entry.id,
    type: entry.kind === "patch" ? "patch" : "artifact",
    size: entry.size === null ? "" : formatBytes(entry.size),
    step: entry.producedBy?.label ?? entry.gate?.question ?? "",
    ago: ago(entry.at),
    ref: entry.ref,
    available: entry.available,
    ...(entry.preview !== undefined
      ? { view: { kind: "code" as const, lines: entry.preview.split("\n") } }
      : {}),
  }));
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/* ── Runs table ───────────────────────────────────────────────────────────── */

export interface RunTableEntry {
  id: string;
  wf: string;
  state: RunState;
  outcome: string;
  started: string;
  dur: string;
  cost: string;
}

export function adaptRunRows(rows: RunRow[], pendingByRun: Map<string, PendingRequest>): RunTableEntry[] {
  return [...rows]
    .sort((a, b) => b.createdAt - a.createdAt)
    .map((row) => ({
      id: row.runId,
      wf: row.workflow || "—",
      state: runState(row.status),
      outcome: outcomeOf(row, pendingByRun.get(row.runId)),
      started: clock(row.createdAt),
      dur: duration(row.createdAt, terminal(row.status) ? row.updatedAt : undefined),
      cost: row.spend ? spend(row.spend) : "",
    }));
}

/**
 * The one-line "where it stands". It must say something the State column does not — a row
 * reading "done · done" spends a column to repeat itself.
 */
function outcomeOf(row: RunRow, pending: PendingRequest | undefined): string {
  if (pending) return pending.question;
  const steps = row.steps ?? 0;
  const recorded = steps === 1 ? "1 step" : `${steps} steps`;
  switch (row.status) {
    case "complete":
      return steps > 0 ? `finished ${recorded}` : "";
    case "failed":
      return steps > 0 ? `failed after ${recorded}` : "failed";
    case "cancelled":
      return steps > 0 ? `stopped after ${recorded}` : "stopped";
    case "waiting_for_signal":
      return "waiting for a signal";
    default: {
      const running = row.running ?? 0;
      return running === 1 ? "1 step active" : `${running} steps active`;
    }
  }
}

/* ── Chrome ───────────────────────────────────────────────────────────────── */

export function statusBarFacts(meta: Meta | undefined): { pool: string; budget: string; version: string } {
  return {
    pool: meta ? `${meta.limits.concurrency} agents` : "—",
    budget: meta ? `${meta.defaults.provider}${meta.defaults.model ? `/${meta.defaults.model}` : ""}` : "—",
    version: meta ? `weft v${meta.version}` : "weft",
  };
}
