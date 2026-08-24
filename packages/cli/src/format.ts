/**
 * Rendering helpers shared by the read-only commands. Everything here is a pure function
 * of a projection — the CLI never derives run facts of its own, it only formats what
 * `reduceState` / `renderTree` already computed.
 */
import type { RunState, StepState, TreeNode } from "@techery/weft-host";
import pc from "picocolors";
import { stepMark } from "./io.ts";

/** Pretty JSON, the shape `weft run` prints and `weft answer` accepts back. */
export function jsonBlock(value: unknown): string {
  return JSON.stringify(value ?? null, null, 2);
}

/** One-line JSON, clipped — for tables and diffs where a block would drown the row. */
export function jsonLine(value: unknown, max = 72): string {
  const text = JSON.stringify(value ?? null) ?? "undefined";
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/**
 * A left-aligned table. Widths come from the widest cell in each column, so the caller
 * hands over rows and gets a block that lines up regardless of content.
 */
export function table(head: readonly string[], rows: ReadonlyArray<readonly string[]>): string[] {
  const columns = Math.max(head.length, ...rows.map((r) => r.length), 0);
  const widths: number[] = [];
  for (let c = 0; c < columns; c++) {
    const cells = [head[c] ?? "", ...rows.map((r) => r[c] ?? "")];
    widths[c] = Math.max(...cells.map((cell) => visibleLength(cell)));
  }
  const line = (cells: readonly string[], paint: (s: string) => string): string =>
    cells
      .map((cell, c) => pad(paint(cell), cell, widths[c] ?? 0))
      .join("  ")
      .trimEnd();
  const body = rows.map((r) => line(r, (s) => s));
  return head.length === 0 ? body : [line(head, (s) => pc.dim(s)), ...body];
}

function pad(painted: string, plain: string, width: number): string {
  return painted + " ".repeat(Math.max(0, width - visibleLength(plain)));
}

/** Colour codes take no columns; measure the text without them. */
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");

function visibleLength(text: string): number {
  return text.replace(ANSI, "").length;
}

// ---------------------------------------------------------------------------
// Runs
// ---------------------------------------------------------------------------

export function shortAge(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "-";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h`;
  return `${Math.round(h / 24)}d`;
}

/** `12 steps · 2 agents · 184k tok · $2.41 · 4m` — the cost line under every header. */
export function costLine(state: RunState, now: number): string {
  const agents = state.steps.filter((s) => s.kind === "agent").length;
  // A run still live in this process reduces from records collected after `run.created`,
  // so `createdAt` can be 0; the first step's clock is the next best origin.
  const started = state.createdAt || state.steps[0]?.startedAt || 0;
  const elapsed = started > 0 ? shortAge((state.updatedAt || now) - started) : "-";
  return pc.dim(
    [
      `${state.steps.length} steps`,
      `${agents} agents`,
      `${compactTokens(state.budget.tokens)} tok`,
      `$${state.budget.usd.toFixed(2)}`,
      elapsed,
    ].join(" · "),
  );
}

export function compactTokens(tokens: number): string {
  if (tokens < 1_000) return String(tokens);
  if (tokens < 1_000_000) return `${(tokens / 1_000).toFixed(tokens < 10_000 ? 1 : 0)}k`;
  return `${(tokens / 1_000_000).toFixed(1)}m`;
}

/** The label the tree and `weft explain` address a step by. */
export function stepLabel(step: StepState | TreeNode): string {
  const named = step as { key?: string; label?: string; kind: string; seq: number };
  return named.key ?? named.label ?? `${named.kind}#${named.seq}`;
}

/**
 * The compact tree: one line per phase, one indented line per step, nested steps
 * indented under their parent. Same shape live (`--watch`) and after the fact
 * (`weft status`), so a run reads the same whenever you look at it.
 */
export function treeLines(
  state: RunState,
  phases: ReadonlyArray<{ name: string; nodes: TreeNode[] }>,
): string[] {
  const lines: string[] = [];
  for (const phase of phases) {
    lines.push(pc.bold(phase.name));
    for (const node of phase.nodes) lines.push(...nodeLines(node, 1));
  }
  if (lines.length === 0 && state.steps.length === 0) lines.push(pc.dim("(no steps yet)"));
  return lines;
}

function nodeLines(node: TreeNode, depth: number): string[] {
  const indent = "  ".repeat(depth);
  const usage = node.usage ? pc.dim(` ${compactTokens(node.usage.input + node.usage.output)} tok`) : "";
  const lines = [`${indent}${stepMark(node.status)} ${node.label}${pc.dim(` ${node.kind}`)}${usage}`];
  for (const child of node.children) lines.push(...nodeLines(child, depth + 1));
  return lines;
}

// ---------------------------------------------------------------------------
// Human requests
// ---------------------------------------------------------------------------

export interface AnswerableRequest {
  id: string;
  kind: string;
  question: string;
  detail?: string;
  risk?: string;
  schema: unknown;
  /** The run that OWNS the request, when it differs from the run being shown. */
  runId?: string;
}

/**
 * The pending request block: what is being asked, and the exact command that answers it.
 * The sample JSON comes from the journaled schema, so an approval prints
 * `weft answer 7f3a h1 '{"approved":true}'` and not a placeholder to guess at.
 */
export function pendingLines(runId: string, request: AnswerableRequest): string[] {
  const risk = request.risk ? pc.dim(` (${request.risk})`) : "";
  const lines = [`${pc.yellow(request.id)} ${pc.bold(request.kind)}: ${request.question}${risk}`];
  if (request.detail) lines.push(pc.dim(`  ${request.detail}`));
  lines.push(`  ${pc.cyan(answerLine(runId, request))}`);
  return lines;
}

export function answerLine(runId: string, request: AnswerableRequest): string {
  // Request ids are run-LOCAL (h1, h2…): two parallel children can both hold an
  // h1, and a parent-addressed answer would land on whichever pends first. The
  // request's owning run id keeps the rendered command unambiguous.
  return `weft answer ${request.runId ?? runId} ${request.id} '${sampleJson(request.schema)}'`;
}

/** A minimal value the journaled JSON Schema would accept, or `<json>` when unguessable. */
export function sampleJson(schema: unknown): string {
  const sample = sampleValue(schema, 0);
  return sample === undefined ? "<json>" : JSON.stringify(sample);
}

function sampleValue(schema: unknown, depth: number): unknown {
  if (depth > 3 || typeof schema !== "object" || schema === null) return undefined;
  const s = schema as Record<string, unknown>;
  if (Array.isArray(s.enum)) return s.enum[0];
  const type = Array.isArray(s.type) ? s.type[0] : s.type;
  switch (type) {
    case "boolean":
      return true;
    case "number":
    case "integer":
      return 0;
    case "string":
      return "";
    case "array":
      return [];
    case "object": {
      const props = (s.properties ?? {}) as Record<string, unknown>;
      const required = Array.isArray(s.required) ? (s.required as string[]) : Object.keys(props);
      const out: Record<string, unknown> = {};
      for (const key of required) {
        const value = sampleValue(props[key], depth + 1);
        if (value === undefined) return undefined;
        out[key] = value;
      }
      return out;
    }
    default:
      return undefined;
  }
}
