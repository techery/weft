/**
 * Projections (C9): state.json, tree.json, and report.md are all folds over the
 * journal — re-derivable at any time, never a source of truth.
 */
import type { Risk, SerializedStepError, Usage } from "@weft/sdk";
import type { BlobRefJson, JournalRecord, RunStatus, StepKind } from "./events.ts";

export interface StepState {
  seq: number;
  kind: StepKind;
  key?: string;
  label?: string;
  phase?: string;
  parentSeq?: number;
  route?: { provider: string; model?: string; effort?: string };
  status: "running" | "ok" | "failed";
  startedAt: number;
  endedAt?: number;
  usage?: Usage;
  attempts?: number;
  error?: SerializedStepError;
  output?: unknown;
  patchRef?: string;
  childRunId?: string;
}

export interface HumanState {
  id: string;
  seq: number;
  kind: string;
  question: string;
  detail?: string;
  risk?: Risk;
  schema: unknown;
  status: "pending" | "answered";
  answer?: unknown;
  answeredBy?: string;
  deadline?: number;
  confirmToken?: string;
  artifactRef?: BlobRefJson;
  requestedAt: number;
}

export interface CheckState {
  name: string;
  status: "pass" | "fail" | "trust-prior" | "skipped";
  evidence?: string;
  required: boolean;
}

export interface RunState {
  runId: string;
  workflow: string;
  defHash?: string;
  status: RunStatus;
  input: unknown;
  output?: unknown;
  error?: SerializedStepError;
  createdAt: number;
  updatedAt: number;
  parentRunId?: string;
  depth: number;
  cwd: string;
  baseRef?: string;
  phases: Array<{ name: string; steps: number[] }>;
  steps: StepState[];
  humans: HumanState[];
  checks: CheckState[];
  notes: Array<{ kind: string; text: string; evidence?: string }>;
  logs: string[];
  drops: Array<{ key?: string; seq?: number; reason: string }>;
  patches: {
    captured: Array<{ key: string; ref: string; files: string[]; outOfScope?: string[] }>;
    merged: Array<{ key: string; ref: string; conflicted?: boolean }>;
    discarded: Array<{ key: string; ref: string }>;
    violations: Array<{ key: string; files: string[]; mode: string }>;
  };
  budget: { tokens: number; usd: number };
  replay: { salvaged: number; diverged: number };
  children: Array<{ seq: number; childRunId: string }>;
}

export function reduceState(records: JournalRecord[]): RunState {
  const state: RunState = {
    runId: "",
    workflow: "",
    status: "planning",
    input: undefined,
    createdAt: 0,
    updatedAt: 0,
    depth: 0,
    cwd: "",
    phases: [],
    steps: [],
    humans: [],
    checks: [],
    notes: [],
    logs: [],
    drops: [],
    patches: { captured: [], merged: [], discarded: [], violations: [] },
    budget: { tokens: 0, usd: 0 },
    replay: { salvaged: 0, diverged: 0 },
    children: [],
  };
  // seq restarts at 0 on resume, so one seq can be scheduled twice across passes;
  // keep every occurrence in the list while completed/failed apply to the latest.
  const allSteps: StepState[] = [];
  const stepsBySeq = new Map<number, StepState>();
  const humansById = new Map<string, HumanState>();
  // Check metadata keyed by seq, overwritten at every (re)schedule: a completion
  // processed in journal order then reads the schedule it actually belongs to,
  // never an earlier pass's check that happened to reuse the same seq.
  const checkMetaBySeq = new Map<number, { name?: string; required: boolean }>();
  let currentPhase: string | undefined;

  for (const rec of records) {
    state.updatedAt = rec.at;
    const ev = rec.ev;
    switch (ev.type) {
      case "run.created":
        state.runId = ev.runId;
        state.workflow = ev.workflow.name;
        if (ev.workflow.defHash !== undefined) state.defHash = ev.workflow.defHash;
        state.input = ev.input;
        state.createdAt = rec.at;
        state.depth = ev.depth;
        state.cwd = ev.cwd;
        if (ev.baseRef !== undefined) state.baseRef = ev.baseRef;
        if (ev.parentRunId !== undefined) state.parentRunId = ev.parentRunId;
        break;
      case "run.status":
        state.status = ev.status;
        break;
      case "run.completed":
        state.status = "complete";
        state.output = ev.output;
        break;
      case "run.failed":
        state.status = "failed";
        state.error = ev.error;
        break;
      case "run.cancelled":
        state.status = "cancelled";
        break;
      case "phase": {
        currentPhase = ev.name;
        if (!state.phases.some((p) => p.name === ev.name)) state.phases.push({ name: ev.name, steps: [] });
        break;
      }
      case "step.scheduled": {
        const step: StepState = {
          seq: ev.seq,
          kind: ev.kind,
          status: "running",
          startedAt: rec.at,
          ...(ev.key !== undefined ? { key: ev.key } : {}),
          ...(ev.label !== undefined ? { label: ev.label } : {}),
          ...(ev.phase !== undefined ? { phase: ev.phase } : {}),
          ...(ev.parentSeq !== undefined ? { parentSeq: ev.parentSeq } : {}),
          ...(ev.route !== undefined ? { route: ev.route } : {}),
          ...(ev.childRunId !== undefined ? { childRunId: ev.childRunId } : {}),
        };
        allSteps.push(step);
        stepsBySeq.set(ev.seq, step);
        if (ev.kind === "check") {
          const payload = ev.payload as { name?: string; required?: boolean } | undefined;
          checkMetaBySeq.set(ev.seq, {
            ...(payload?.name !== undefined ? { name: payload.name } : {}),
            required: payload?.required === true,
          });
        }
        const phaseName = ev.phase ?? currentPhase;
        if (phaseName) {
          let phase = state.phases.find((p) => p.name === phaseName);
          if (!phase) {
            phase = { name: phaseName, steps: [] };
            state.phases.push(phase);
          }
          if (!phase.steps.includes(ev.seq)) phase.steps.push(ev.seq);
        }
        if (ev.childRunId) state.children.push({ seq: ev.seq, childRunId: ev.childRunId });
        break;
      }
      case "step.completed": {
        const step = stepsBySeq.get(ev.seq);
        if (!step) break;
        step.status = "ok";
        step.endedAt = rec.at;
        step.output = ev.output;
        if (ev.usage !== undefined) step.usage = ev.usage;
        if (ev.attempts !== undefined) step.attempts = ev.attempts;
        if (ev.patchRef !== undefined) step.patchRef = ev.patchRef;
        if (step.kind === "check") {
          const out = ev.output as { status?: CheckState["status"]; evidence?: string } | null;
          const meta = checkMetaBySeq.get(ev.seq);
          const payloadName = meta?.name ?? step.label?.replace(/^check:/, "") ?? String(ev.seq);
          if (out?.status) {
            state.checks.push({
              name: payloadName,
              status: out.status,
              required: meta?.required === true,
              ...(out.evidence !== undefined ? { evidence: out.evidence } : {}),
            });
          }
        }
        break;
      }
      case "step.failed": {
        const step = stepsBySeq.get(ev.seq);
        if (!step) break;
        step.status = "failed";
        step.endedAt = rec.at;
        step.error = ev.error;
        if (ev.attempts !== undefined) step.attempts = ev.attempts;
        break;
      }
      case "human.requested": {
        const human: HumanState = {
          id: ev.id,
          seq: ev.seq,
          kind: ev.kind,
          question: ev.question,
          schema: ev.schema,
          status: "pending",
          requestedAt: rec.at,
          ...(ev.detail !== undefined ? { detail: ev.detail } : {}),
          ...(ev.risk !== undefined ? { risk: ev.risk } : {}),
          ...(ev.deadline !== undefined ? { deadline: ev.deadline } : {}),
          ...(ev.confirmToken !== undefined ? { confirmToken: ev.confirmToken } : {}),
          ...(ev.artifactRef !== undefined ? { artifactRef: ev.artifactRef } : {}),
        };
        humansById.set(ev.id, human);
        state.humans.push(human);
        break;
      }
      case "human.answered": {
        const human = humansById.get(ev.id);
        if (!human) break;
        human.status = "answered";
        human.answer = ev.answer;
        human.answeredBy = ev.answeredBy;
        break;
      }
      case "human.rejected": {
        // The answer failed the authoritative schema: the request is pending again.
        const human = humansById.get(ev.id);
        if (!human) break;
        human.status = "pending";
        delete human.answer;
        delete human.answeredBy;
        break;
      }
      case "note":
        state.notes.push({
          kind: ev.kind,
          text: ev.text,
          ...(ev.evidence !== undefined ? { evidence: ev.evidence } : {}),
        });
        break;
      case "log":
        state.logs.push(ev.message);
        break;
      case "drop":
        state.drops.push({
          reason: ev.reason,
          ...(ev.key !== undefined ? { key: ev.key } : {}),
          ...(ev.seq !== undefined ? { seq: ev.seq } : {}),
        });
        break;
      case "patch.captured":
        state.patches.captured.push({
          key: ev.key,
          ref: ev.ref,
          files: ev.files,
          ...(ev.outOfScope !== undefined ? { outOfScope: ev.outOfScope } : {}),
        });
        break;
      case "patch.merged":
        state.patches.merged.push({
          key: ev.key,
          ref: ev.ref,
          ...(ev.conflicted ? { conflicted: true } : {}),
        });
        break;
      case "patch.discarded":
        state.patches.discarded.push({ key: ev.key, ref: ev.ref });
        break;
      case "scope.violation":
        state.patches.violations.push({ key: ev.key, files: ev.files, mode: ev.mode });
        break;
      case "budget.sampled":
        state.budget = { tokens: ev.tokens, usd: ev.usd };
        break;
      case "replay.salvaged":
        state.replay.salvaged++;
        break;
      case "replay.diverged":
        state.replay.diverged++;
        break;
      default:
        break;
    }
  }
  state.steps = [...allSteps].sort((a, b) => a.seq - b.seq);
  return state;
}

// ---------------------------------------------------------------------------
// Tree
// ---------------------------------------------------------------------------

export interface TreeNode {
  seq: number;
  kind: string;
  label: string;
  status: "running" | "ok" | "failed";
  usage?: Usage;
  children: TreeNode[];
}

export interface TreePhase {
  name: string;
  nodes: TreeNode[];
}

export function renderTree(state: RunState): TreePhase[] {
  // Duplicate seqs (a resumed run's second pass) display their LATEST occurrence.
  const nodesBySeq = new Map<number, TreeNode>();
  for (const step of state.steps) {
    nodesBySeq.set(step.seq, {
      seq: step.seq,
      kind: step.kind,
      label: step.label ?? step.key ?? `${step.kind}#${step.seq}`,
      status: step.status,
      ...(step.usage !== undefined ? { usage: step.usage } : {}),
      children: [],
    });
  }
  const roots: number[] = [];
  for (const node of nodesBySeq.values()) {
    const step = state.steps.findLast((s) => s.seq === node.seq)!;
    if (step.parentSeq !== undefined && nodesBySeq.has(step.parentSeq) && step.parentSeq !== step.seq) {
      nodesBySeq.get(step.parentSeq)!.children.push(node);
    } else {
      roots.push(step.seq);
    }
  }
  const phases: TreePhase[] = state.phases.map((p) => ({
    name: p.name,
    nodes: p.steps.filter((s) => roots.includes(s)).map((s) => nodesBySeq.get(s)!),
  }));
  const inPhase = new Set(state.phases.flatMap((p) => p.steps));
  const orphans = roots.filter((s) => !inPhase.has(s));
  if (orphans.length > 0) phases.push({ name: "(no phase)", nodes: orphans.map((s) => nodesBySeq.get(s)!) });
  return phases;
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

export function renderReport(state: RunState): string {
  const lines: string[] = [];
  lines.push(`# ${state.workflow} — run ${state.runId}`);
  lines.push("");
  lines.push(`**Status:** ${state.status}`);
  const agentSteps = state.steps.filter((s) => s.kind === "agent");
  lines.push(
    `**Cost:** ${state.budget.tokens.toLocaleString()} tokens · $${state.budget.usd.toFixed(2)} · ${agentSteps.length} agent steps`,
  );
  if (state.error) lines.push(`**Error:** \`${state.error.code}\` — ${state.error.message}`);
  lines.push("");

  if (state.output !== undefined) {
    lines.push("## Outcome");
    lines.push("```json");
    lines.push(JSON.stringify(state.output, null, 2));
    lines.push("```");
    lines.push("");
  }

  if (state.patches.merged.length + state.patches.captured.length > 0) {
    lines.push("## Changes");
    for (const p of state.patches.merged) {
      const captured = state.patches.captured.find((c) => c.ref === p.ref);
      lines.push(
        `- **${p.key}** merged${p.conflicted ? " (with conflicts kept)" : ""}: ${captured?.files.join(", ") ?? p.ref}`,
      );
    }
    for (const p of state.patches.discarded) lines.push(`- ~~${p.key}~~ discarded`);
    const pending = state.patches.captured.filter(
      (c) =>
        !state.patches.merged.some((m) => m.ref === c.ref) &&
        !state.patches.discarded.some((d) => d.ref === c.ref),
    );
    for (const p of pending)
      lines.push(`- ⚠ **${p.key}** captured but not integrated (${p.files.join(", ")})`);
    lines.push("");
  }

  if (state.checks.length > 0) {
    lines.push("## Checks");
    lines.push("| Check | Status | Required |");
    lines.push("|---|---|---|");
    for (const c of state.checks) lines.push(`| ${c.name} | ${c.status} | ${c.required ? "yes" : ""} |`);
    lines.push("");
  }

  if (state.notes.length > 0) {
    lines.push("## Ledger");
    for (const n of state.notes) {
      lines.push(`- **${n.kind}**: ${n.text}${n.evidence ? ` _(evidence: ${n.evidence})_` : ""}`);
    }
    lines.push("");
  }

  const failedSteps = state.steps.filter((s) => s.status === "failed");
  if (failedSteps.length + state.drops.length > 0) {
    lines.push("## Failures & drops");
    for (const s of failedSteps)
      lines.push(`- step ${s.key ?? s.label ?? s.seq}: ${s.error?.code} — ${s.error?.message}`);
    for (const d of state.drops) lines.push(`- dropped ${d.key ?? d.seq ?? "?"}: ${d.reason}`);
    lines.push("");
  }

  const pendingHumans = state.humans.filter((h) => h.status === "pending");
  const risks: string[] = [];
  for (const v of state.patches.violations) {
    risks.push(`scope violation (${v.mode}): ${v.key} touched ${v.files.join(", ")}`);
  }
  for (const h of pendingHumans) risks.push(`waiting on ${h.id} (${h.kind}): ${h.question}`);
  if (state.replay.diverged > 0)
    risks.push(`${state.replay.diverged} step(s) diverged from the journal on the last resume`);
  if (risks.length > 0) {
    lines.push("## Remaining risk");
    for (const r of risks) lines.push(`- ${r}`);
    lines.push("");
  }

  if (pendingHumans.length > 0) {
    lines.push("## Next step");
    const h = pendingHumans[0]!;
    lines.push(`Answer request **${h.id}**: ${h.question}`);
    lines.push("```");
    lines.push(`weft answer ${state.runId} ${h.id} '<json>'`);
    lines.push("```");
    lines.push("");
  }
  return lines.join("\n");
}
