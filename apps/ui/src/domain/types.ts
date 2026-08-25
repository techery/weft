/** Lifecycle of a whole run, as the journal records it. */
import type { JsonSchema } from "~/api/types";

export type RunState = "running" | "waiting" | "done" | "stopped" | "failed";

/**
 * Lifecycle of a single step. `waiting` is a human gate that wants an answer;
 * `wait` is a machine step that has not been opened yet; `idle` is a step that
 * was never run because the run stopped first.
 */
export type StepState = "done" | "run" | "fail" | "waiting" | "wait" | "idle";

export type StepKind = "task" | "agent" | "human";

/** Which of the four pill palettes a status pill paints itself with. */
export type PillKind = "done" | "run" | "fail" | "human";

export type RiskTier = "read" | "write" | "network" | "destructive";
export type PolicyMode = "auto" | "ask";

export type WorkflowState = "running" | "waiting" | "idle";

export type Labelled = { k: string; v: string };

export type WorkflowLabel = { name: string; meta: string };

export type RecentRunRef = { id: string; outcome: string; ago: string };

export type WorkflowInputKind = "text" | "seg" | "chips" | "file" | "flag";

export type WorkflowInput = {
  key: string;
  label: string;
  kind: WorkflowInputKind;
  /** `seg`/`chips` choices, or the on/off captions of a `flag`. */
  options: string[];
  required: boolean;
};

export type Workflow = {
  file: string;
  name: string;
  desc: string;
  state: WorkflowState;
  lastLabel: string;
  /** Success rate over the journal window as a whole percent, or null when never scored. */
  ok: number | null;
  p50: string;
  cost: string;
  labels: WorkflowLabel[];
  /** 14 entries, 1 = succeeded, 0 = failed — oldest first. */
  history: number[];
  historyNote: string;
  facts: Labelled[];
  recent: RecentRunRef[];
  inputs: WorkflowInput[];
};

export type RailStep = {
  id: string;
  kind: StepKind;
  label: string;
  meta: string;
  state: StepState;
  /** Artifact filename this step produced, or "" for none. */
  artifact: string;
};

export type RailGroup = { name: string; meta: string; steps: RailStep[] };

export type ActiveStep = { label: string; name: string; meta: string; stepId: string };

export type Finding = {
  id: string;
  msg: string;
  loc: string;
  sev: string;
  stepLabel: string;
  chip: string;
  /** True once the step this finding opened has finished. */
  settled: boolean;
  /** The step this finding opened, when the record links one. */
  stepId?: string;
};

export type CodeArtifactView = { kind: "code"; lines: string[] };
export type MarkdownArtifactView = {
  kind: "md";
  title: string;
  paras: string[];
  rows: { k: string; t: string; v: string }[];
};
export type ArtifactView = CodeArtifactView | MarkdownArtifactView;

export type Artifact = {
  name: string;
  type: string;
  size: string;
  /** Label of the step or gate that produced it. */
  step: string;
  ago: string;
  /** Content-addressed ref — the bytes are fetched from the blob store on demand. */
  ref: string;
  /** False when the journal still names a ref the store no longer holds. */
  available: boolean;
  /** Loaded lazily; absent until the bytes arrive. */
  view?: ArtifactView;
};

export type FileChange = { path: string; adds: number; dels: number };

export type JournalEntry = { time: string; tag: string; text: string };

export type AgentTranscript = {
  sessionId: string;
  transcriptRef: string;
  transcriptSize: number;
};

export type StepCell = { k: string; v: string; color?: string };

export type StepInputKind = "record" | "file" | "text" | "pills";

export type StepInput = {
  k: string;
  kind: StepInputKind;
  /** Record reference (an id or filename); empty for other kinds. */
  ref: string;
  title: string;
  sub: string;
  pills: string[];
};

export type ToolCall = { cmd: string; meta: string; running: boolean };

export type StepDetail = {
  title: string;
  pill: string;
  pillKind: PillKind;
  /** Caption of the single action button in the step footer. */
  action: string;
  cells: StepCell[];
  input: StepInput[];
  /** The exact scheduled payload, rendered through the same data surface as output. */
  inputValue: unknown;
  inputSchema: JsonSchema | null;
  outTitle: string;
  outNote: string;
  /** The validated value and schema drive the structured output view. */
  outValue: unknown;
  outSchema: JsonSchema | null;
  out: string[];
  streaming: boolean;
  /** The coding-session log belongs to this step, never to a run-level surface. */
  agentTranscript: AgentTranscript | null;
  tools: ToolCall[];
  toolsTitle: string;
  /** The dashed strip under the output — an error, or what the step is waiting on. */
  next: { k: string; v: string; goToGate: boolean } | null;
};

export type GateQuestionKind = "cards" | "chips" | "choice" | "select" | "toggle" | "text" | "list" | "note";

export type GateOption = { label: string; meta: string; desc: string };

export type GateQuestion = {
  key: string;
  label: string;
  kind: GateQuestionKind;
  options: GateOption[];
  required: boolean;
};

export type Gate = {
  id: string;
  /** The run that owns the request — not necessarily the one being viewed. */
  runId?: string;
  /** `approve` and `confirm` can be denied; an `ask` can only be answered. */
  deniable?: boolean;
  risk: string;
  blocks: string;
  title: string;
  detail: string;
  submitLabel: string;
  denyLabel: string;
  questions: GateQuestion[];
  artifactRef?: { ref: string; size: number; preview?: string };
};

export type Run = {
  id: string;
  wf: string;
  file: string;
  state: RunState;
  /** The mono strip in the run header: step count · clock · spend. */
  chrome: string;
  pill: string;
  gateStep: string | null;
  railTitle: string;
  rail: RailGroup[];
  active: ActiveStep[];
  findings: Finding[];
  artifacts: Artifact[];
  files: FileChange[];
  committed: boolean;
  changesNote: string;
  branchNote: string;
  journal: JournalEntry[];
  gate: Gate | null;
  steps: Record<string, StepDetail>;
};

export type DiffLine = {
  /** Old-side line number, or "" for an added line. */
  ln: string;
  /** New-side line number, or "" for a removed line. */
  rn: string;
  text: string;
  sign: "+" | "-" | "";
};

export type FileDiff = { hunk: string; lines: DiffLine[] };

/** Gate answers, keyed by gate id then question key. */
export type GateAnswerValue = string | string[] | boolean;
export type GateAnswers = Record<string, Record<string, GateAnswerValue>>;

/** Everything the run fixtures need in order to reflect what you answered. */
export type AnswerState = {
  answered: Record<string, boolean>;
  denied: Record<string, boolean>;
  ans: GateAnswers;
};

/** Launcher input values, keyed by workflow file then input key. */
export type LauncherInputValue = string | string[] | boolean;
export type LauncherInputs = Record<string, Record<string, LauncherInputValue>>;
