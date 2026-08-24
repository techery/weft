/**
 * @techery/weft-provider-codex — the AgentProvider over the OpenAI Codex SDK.
 *
 * Structured output is native here (C7/§04): the step's JSON Schema goes in as the
 * turn's `outputSchema` and the agent's final message is the JSON value. It is still
 * only parsed, never trusted — the ENGINE validates it against the real schema, and a
 * response that will not parse is handed back verbatim so schema repair gets a turn
 * instead of the step throwing the agent's work away.
 *
 * Write scope is post-hoc on Codex (§09): the SDK exposes no per-tool hook, so the
 * sandbox is the only live guard and the engine's worktree + `git diff` is what
 * actually enforces the scope. `filesTouched` is left empty for that reason — the
 * patch capture, not this adapter, is the authority on what a step changed.
 *
 * pinned against @openai/codex-sdk@0.149.0: `new Codex(options)`, `codex.startThread(
 * ThreadOptions{ model, sandboxMode, workingDirectory, skipGitRepoCheck,
 * modelReasoningEffort, approvalPolicy })`, `codex.resumeThread(id, ThreadOptions)`,
 * `thread.id`, `thread.run(input, TurnOptions{ outputSchema, signal })` → `Turn{ items,
 * finalResponse, usage: { input_tokens, cached_input_tokens, output_tokens } | null }`.
 * A rename upstream lands in this file.
 */
import {
  Codex,
  type RunResult,
  type SandboxMode,
  type ThreadOptions,
  type TurnOptions,
} from "@openai/codex-sdk";
import type {
  AgentProvider,
  AgentRequest,
  AgentResult,
  ProviderCapabilities,
  RunControl,
} from "@techery/weft-core";
import { renderTranscript } from "./transcript.ts";

export { renderTranscript } from "./transcript.ts";

/**
 * `Usage` and `SchemaIssue` live in @techery/weft-sdk, which is not a dependency of this
 * package; both are reachable through the frozen provider contract instead.
 */
type Usage = AgentResult["usage"];
type SchemaIssue = NonNullable<Parameters<AgentProvider["repair"]>[2][number]>;

/** The one thread method this adapter calls, plus the id a repair resumes from. */
export interface CodexThreadLike {
  readonly id: string | null;
  run(input: string, options?: TurnOptions): Promise<RunResult>;
}

/** The slice of the SDK's `Codex` class this adapter uses; a real `Codex` satisfies it. */
export interface CodexLike {
  startThread(options?: ThreadOptions): CodexThreadLike;
  resumeThread(id: string, options?: ThreadOptions): CodexThreadLike;
}

export interface CodexProviderOptions {
  /** DI seam: tests pass a fake so no CLI is ever spawned and no session is created. */
  codex?: CodexLike;
  /** Registry id; defaults to "codex". */
  id?: string;
}

/** Thrown when the run was cancelled around a turn; the engine maps it to a StepError. */
const ABORTED = "aborted";

/** The `## Output` contract appended to every prompt; repair turns restate it their own way. */
function withOutputNote(req: AgentRequest): string {
  return (
    `${req.prompt}\n\n## Output\n` +
    "Finish by replying with a single JSON value matching this schema. The JSON is the " +
    "answer, so send it alone — no prose around it, no code fence.\n\n" +
    `\`\`\`json\n${JSON.stringify(req.schema)}\n\`\`\``
  );
}

function repairPrompt(req: AgentRequest, errors: readonly SchemaIssue[]): string {
  const issues = errors.map((issue) => `- ${issue.path || "(root)"}: ${issue.message}`).join("\n");
  return (
    `The result you returned did not validate against the required schema:\n${issues}\n\n` +
    "Produce the corrected JSON object only — no prose, no code fence — matching this schema.\n\n" +
    `\`\`\`json\n${JSON.stringify(req.schema)}\n\`\`\``
  );
}

/**
 * The sandbox is the only live guard on a Codex step, so a read-only step gets the
 * strictest mode the SDK offers rather than being trusted to behave.
 */
function sandboxFor(req: AgentRequest): SandboxMode {
  return (req.tools?.allowEdits ?? true) === true ? "workspace-write" : "read-only";
}

function threadOptions(req: AgentRequest): ThreadOptions {
  return {
    workingDirectory: req.cwd,
    sandboxMode: sandboxFor(req),
    // A write step runs in a worktree the engine just created; the repo check would
    // second-guess a directory the engine already chose.
    skipGitRepoCheck: true,
    // Approvals would block on a TTY no run has, and capabilities() already tells the
    // engine there is no permission hook here — the sandbox decides alone.
    approvalPolicy: "never",
    ...(req.model !== undefined ? { model: req.model } : {}),
    // Weft's five effort tiers are a subset of ModelReasoningEffort's names.
    ...(req.effort !== undefined ? { modelReasoningEffort: req.effort } : {}),
  };
}

/** Node clamps a single timer past this to ~1ms, so long deadlines arm in chunks. */
const MAX_TIMER_MS = 2_147_483_647;

/**
 * ctl.signal, widened with the step's own deadline when the engine set one.
 * `done` releases the deadline's timer: a chunked long deadline is otherwise
 * cleared only on abort, so every SUCCESSFUL long-timeout turn would pin its
 * timer (and the request it closes over) until the full deadline elapsed.
 */
function turnSignal(req: AgentRequest, ctl: RunControl): { signal: AbortSignal; done: () => void } {
  // The engine's own step timeout allows 10s of grace on top of this one, so the agent
  // is aborted cleanly before the step is torn down around it. AbortSignal.timeout()
  // inherits Node's timer ceiling, so long deadlines are chunked by hand.
  if (req.timeoutMs === undefined || req.timeoutMs <= 0) return { signal: ctl.signal, done: () => {} };
  if (req.timeoutMs <= MAX_TIMER_MS) {
    return { signal: AbortSignal.any([ctl.signal, AbortSignal.timeout(req.timeoutMs)]), done: () => {} };
  }
  const timeout = new AbortController();
  const deadline = Date.now() + req.timeoutMs;
  let timer: NodeJS.Timeout | undefined;
  let settled = false;
  const done = (): void => {
    settled = true;
    if (timer) clearTimeout(timer);
    timer = undefined;
  };
  const arm = (): void => {
    if (settled || ctl.signal.aborted) return;
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      timeout.abort(new Error(`codex: agent step timed out after ${req.timeoutMs}ms`));
      return;
    }
    timer = setTimeout(arm, Math.min(remaining, MAX_TIMER_MS));
    timer.unref?.();
  };
  arm();
  ctl.signal.addEventListener("abort", done, { once: true });
  return { signal: AbortSignal.any([ctl.signal, timeout.signal]), done };
}

/**
 * JSON Schema keyword positions, so the walk below rewrites SCHEMAS and nothing else.
 *
 * A blind `Object.entries` recursion cannot tell a schema from data. It descends into
 * `const`, `default`, `enum` and `examples` — literal values a workflow chose — and if one
 * happens to be an object with a `type: "object"` and a `properties` key, it comes back
 * rewritten, with `additionalProperties: false` and a `required` list bolted on. The value
 * the model is shown is then not the value the author wrote.
 */
/** Keyword whose value is a single subschema. */
const SCHEMA_KEYWORDS = new Set([
  "additionalItems",
  "additionalProperties",
  "contains",
  "else",
  "if",
  "items",
  "not",
  "propertyNames",
  "then",
  "unevaluatedItems",
  "unevaluatedProperties",
]);

/** Keyword whose value is an array of subschemas. */
const SCHEMA_LIST_KEYWORDS = new Set(["allOf", "anyOf", "oneOf", "prefixItems"]);

/** Keyword whose value maps names to subschemas. */
const SCHEMA_MAP_KEYWORDS = new Set([
  "$defs",
  "definitions",
  "dependentSchemas",
  "patternProperties",
  "properties",
]);

/**
 * OpenAI's structured outputs accept a strict subset of JSON Schema, and the engine's
 * wire schema is not written in it: `z.toJSONSchema` leaves `additionalProperties`
 * unset, and it omits any property carrying a default from `required`. Both are hard
 * errors on this path — the API answers `invalid_json_schema` and the step never runs.
 *
 * So the schema is adapted to the vendor on the way out: every object gets
 * `additionalProperties: false`, and every object's `required` lists all of its
 * properties, which is what OpenAI documents. Tightening the WIRE schema cannot make a
 * bad value pass — the engine still validates the response against the real schema, and
 * a field the model was forced to emit is one the real schema either accepts or repairs.
 *
 * Two things are deliberately left alone. A meaningful `additionalProperties` (a Zod
 * `.catchall()`) is not overwritten with `false`: the vendor cannot express it, and an
 * API error naming the schema is better than silently dropping the keys it allowed.
 * `items` on an array is a subschema, not an object's property map, so a tuple or an
 * array of objects is rewritten one level down and not at the array itself.
 */
export function toStrictSchema(node: unknown): unknown {
  if (Array.isArray(node)) return node;
  if (typeof node !== "object" || node === null) return node;

  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    if (SCHEMA_KEYWORDS.has(key)) {
      out[key] = toStrictSchema(value);
    } else if (SCHEMA_LIST_KEYWORDS.has(key)) {
      out[key] = Array.isArray(value) ? value.map(toStrictSchema) : value;
    } else if (SCHEMA_MAP_KEYWORDS.has(key)) {
      out[key] =
        typeof value === "object" && value !== null && !Array.isArray(value)
          ? Object.fromEntries(
              Object.entries(value as Record<string, unknown>).map(([name, sub]) => [
                name,
                toStrictSchema(sub),
              ]),
            )
          : value;
    } else {
      // Not a schema position: `const`, `default`, `enum`, `examples`, `title`, `type`…
      // carry data or metadata and pass through byte for byte.
      out[key] = value;
    }
  }

  const properties = out.properties;
  if (isObjectSchema(out) && typeof properties === "object" && properties !== null) {
    if (out.additionalProperties === undefined || out.additionalProperties === false) {
      out.additionalProperties = false;
    }
    // A property with a default is optional to Zod but must still be listed here: the
    // model has to produce every key, and the real schema decides what the value means.
    out.required = Object.keys(properties as Record<string, unknown>);
  }
  return out;
}

/** `type` may be a union (`["object", "null"]`) — an object schema either way. */
function isObjectSchema(node: Record<string, unknown>): boolean {
  const type = node.type;
  return type === "object" || (Array.isArray(type) && type.includes("object"));
}

async function runTurn(
  thread: CodexThreadLike,
  prompt: string,
  req: AgentRequest,
  ctl: RunControl,
): Promise<AgentResult> {
  // The SDK takes the signal, but the bracket checks are what make abort a guarantee
  // rather than a request: an already-cancelled step never reaches the model, and a
  // turn that finished after cancellation is not reported as a result.
  if (ctl.signal.aborted) throw new Error(ABORTED);
  const deadline = turnSignal(req, ctl);
  try {
    const result = await thread.run(prompt, {
      signal: deadline.signal,
      ...(req.schema !== undefined ? { outputSchema: toStrictSchema(req.schema) } : {}),
    });
    if (ctl.signal.aborted) throw new Error(ABORTED);
    return toResult(thread, result);
  } finally {
    deadline.done();
  }
}

function toResult(thread: CodexThreadLike, turn: RunResult): AgentResult {
  const result: AgentResult = {
    output: parseOutput(turn.finalResponse),
    usage: toUsage(turn.usage),
    // Post-hoc scope (§09): the engine worktrees the step and diffs it, and that diff
    // is the truth. Reporting a partial list here would only compete with it.
    filesTouched: [],
  };
  // Populated once the first turn has started; a resumed thread already has it.
  if (typeof thread.id === "string" && thread.id.length > 0) result.sessionId = thread.id;
  const transcript = renderTranscript(turn.items);
  if (transcript.length > 0) result.transcript = transcript;
  return result;
}

const FENCE = /^```(?:json)?\s*\n?([\s\S]*?)\n?```$/;

/**
 * `outputSchema` makes Codex answer in JSON, so this parses on the first try in the
 * normal case; a fenced block is unwrapped because that is the one wrapper a chatty
 * turn actually produces. Anything else is returned as the raw string — the engine's
 * schema check then fails it and repair re-prompts the same session.
 */
function parseOutput(finalResponse: unknown): unknown {
  if (typeof finalResponse !== "string") return finalResponse;
  const text = finalResponse.trim();
  const direct = tryParse(text);
  if (direct.ok) return direct.value;
  const fenced = FENCE.exec(text);
  if (fenced !== null) {
    const inner = tryParse((fenced[1] ?? "").trim());
    if (inner.ok) return inner.value;
  }
  return finalResponse;
}

function tryParse(text: string): { ok: true; value: unknown } | { ok: false } {
  if (text.length === 0) return { ok: false };
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false };
  }
}

/** Codex reports `usage: null` for a turn it could not account for; that reads as zero. */
function toUsage(codexUsage: RunResult["usage"]): Usage {
  const usage: Usage = { input: num(codexUsage?.input_tokens), output: num(codexUsage?.output_tokens) };
  const cacheRead = num(codexUsage?.cached_input_tokens);
  if (cacheRead > 0) usage.cacheRead = cacheRead;
  // `usd` is deliberately absent: Codex reports tokens only, and the engine prices them
  // from the config price table (C8).
  return usage;
}

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

class CodexProvider implements AgentProvider {
  constructor(
    readonly id: string,
    private client: CodexLike | undefined,
  ) {}

  capabilities(): ProviderCapabilities {
    // reportsUsd false: the Codex SDK reports tokens only, so USD cost exists only
    // when the host configures a price for the model.
    return { structured: "native", permissionHook: false, sessionResume: true, reportsUsd: false };
  }

  async run(req: AgentRequest, ctl: RunControl): Promise<AgentResult> {
    if (ctl.signal.aborted) throw new Error(ABORTED);
    const thread = this.codex().startThread(threadOptions(req));
    return runTurn(thread, withOutputNote(req), req, ctl);
  }

  async repair(
    sessionId: string | undefined,
    req: AgentRequest,
    errors: SchemaIssue[],
    ctl: RunControl,
  ): Promise<AgentResult> {
    // No session to resume means the first turn never reported a thread id; a fresh run
    // is a worse deal than a resumed one but still better than failing the step.
    if (sessionId === undefined) return this.run(req, ctl);
    if (ctl.signal.aborted) throw new Error(ABORTED);
    const thread = this.codex().resumeThread(sessionId, threadOptions(req));
    return runTurn(thread, repairPrompt(req, errors), req, ctl);
  }

  /** The SDK client is built on first use — never at createCodexProvider() time. */
  private codex(): CodexLike {
    this.client ??= new Codex();
    return this.client;
  }
}

/**
 * Build the Codex provider. Construction is pure: no credential lookup, no CLI
 * process, no network — the first `startThread()` happens inside run().
 */
export function createCodexProvider(opts: CodexProviderOptions = {}): AgentProvider {
  return new CodexProvider(opts.id ?? "codex", opts.codex);
}
