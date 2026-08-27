/**
 * @techery/weft-provider-claude — the AgentProvider over the Claude Agent SDK.
 *
 * Structured output is a terminating tool (the universal baseline, C7): one
 * sdk-mcp tool named `structured_output` carries the step's JSON Schema in its
 * description, and calling it is the only way out of the step. What the agent
 * passes is returned raw — the ENGINE validates it against the real schema, so a
 * lying provider cannot smuggle a value past the contract.
 *
 * pinned against @anthropic-ai/claude-agent-sdk@0.3.241: query({ prompt, options }),
 * Options.{cwd,model,maxTurns,effort,resume,abortController,mcpServers,canUseTool,
 * permissionMode}, createSdkMcpServer({ name, version, tools }), tool(name, description,
 * zodRawShape, handler), CanUseTool -> PermissionResult, SDKMessage.{assistant,result}
 * with result.{usage.{input_tokens,output_tokens,cache_read_input_tokens},total_cost_usd,
 * session_id}. A rename upstream lands in this file.
 */

import { isAbsolute } from "node:path";
import {
  createSdkMcpServer,
  type Options,
  query,
  type SDKMessage,
  tool,
} from "@anthropic-ai/claude-agent-sdk";
import type {
  AgentProvider,
  AgentRequest,
  AgentResult,
  ProviderCapabilities,
  RunControl,
} from "@techery/weft-core";
import * as z from "zod";
import { createToolGate } from "./gate.ts";
import { MCP_SERVER_NAME, STRUCTURED_OUTPUT_TOOL } from "./tools.ts";

export type { ToolGateOptions } from "./gate.ts";
export { createToolGate, READ_ONLY_MESSAGE, workspacePath } from "./gate.ts";
export { EDIT_TOOLS, MCP_SERVER_NAME, STRUCTURED_OUTPUT_TOOL } from "./tools.ts";

/**
 * `Usage` and `SchemaIssue` live in @techery/weft-sdk, which is not a dependency of this
 * package; both are reachable through the frozen provider contract instead.
 */
type Usage = AgentResult["usage"];
type SchemaIssue = NonNullable<Parameters<AgentProvider["repair"]>[2][number]>;

/** The SDK's `query` signature — this provider's only entry point into the vendor SDK. */
export type QueryFn = typeof query;

export interface ClaudeProviderOptions {
  /** DI seam: tests pass a fake so no session, credential, or socket is ever created. */
  queryFn?: QueryFn;
  /** Registry id; defaults to "claude". */
  id?: string;
}

interface ClaudeStepOptions {
  permissionMode?: "default" | "dontAsk";
}

function claudeStepOptions(value: unknown): ClaudeStepOptions {
  if (value === undefined) return {};
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("claude: provider options must be an object");
  }
  const options = value as Record<string, unknown>;
  const unknown = Object.keys(options).filter((key) => key !== "permissionMode");
  if (unknown.length > 0) throw new Error(`claude: unknown provider option(s): ${unknown.join(", ")}`);
  if (
    options.permissionMode !== undefined &&
    options.permissionMode !== "default" &&
    options.permissionMode !== "dontAsk"
  ) {
    throw new Error('claude: permissionMode must be "default" or "dontAsk"');
  }
  return options as ClaudeStepOptions;
}

/** Sent when a stream ended without the terminating tool and `onMaxTurns` is "finalize". */
const FINALIZE_PROMPT = `Call ${STRUCTURED_OUTPUT_TOOL} now with your best final answer matching the schema.`;

const NO_OUTPUT = `agent finished without calling ${STRUCTURED_OUTPUT_TOOL}`;

/** Node clamps a single timer past this to ~1ms, so long deadlines arm in chunks. */
const MAX_TIMER_MS = 2_147_483_647;

/** Everything one query() stream contributes; a step may span two (run + finalize). */
interface Turn {
  /** Boxed so a legitimate `null` or `undefined` result is still "captured". */
  captured?: { value: unknown };
  input: number;
  output: number;
  cacheRead: number;
  usd: number;
  usdSeen: boolean;
  sessionId?: string;
  transcript: string[];
  files: string[];
}

function newTurn(): Turn {
  return { input: 0, output: 0, cacheRead: 0, usd: 0, usdSeen: false, transcript: [], files: [] };
}

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/** The `## Output` contract appended to every prompt, repair and finalize turns included. */
function withOutputSection(req: AgentRequest): string {
  return (
    `${req.prompt}\n\n## Output\n` +
    `Finish by calling the \`${STRUCTURED_OUTPUT_TOOL}\` tool exactly once, passing your final ` +
    `answer as \`result\`: a JSON value matching this schema.\n\n` +
    `\`\`\`json\n${JSON.stringify(req.schema)}\n\`\`\`\n\n` +
    "Prose is not an answer — that tool call is the only accepted way to end this task."
  );
}

/**
 * What the agent passed, still unvalidated — the engine checks it against the real
 * schema.
 *
 * The string branch is DEFENSIVE, not a rescue path: the tool declares `result` as an
 * object and the sdk-mcp server validates that before this handler runs, so a model that
 * stringified its answer is refused at the boundary and retries — which is the intended
 * behaviour, and is what keeps the declared shape steering the model. This only matters
 * if a value ever reaches the handler unvalidated. A string that parses as JSON is the
 * value it meant; one that does not is handed on untouched so the engine's error names
 * the real problem instead of a parse failure.
 */
function capturedValue(args: unknown): unknown {
  const result = (args as { result?: unknown }).result;
  if (typeof result !== "string") return result;
  try {
    return JSON.parse(result) as unknown;
  } catch {
    return result;
  }
}

function toolDescription(schema: unknown): string {
  return (
    `Return the final result for this task. Call exactly once with the final result; this ends the task. ` +
    `Pass the answer as \`result\`, a JSON value matching this schema: ${JSON.stringify(schema)}`
  );
}

/**
 * Keep engine-owned task state outside the agent's filesystem capability while
 * preserving a writable shell inside its worktree. Requiring the sandbox to be
 * available is load-bearing: silently degrading would expose the host paths.
 */
function protectedPathSandbox(req: AgentRequest): Options["sandbox"] | undefined {
  if (!req.protectedPaths?.length) return undefined;
  const relativePath = req.protectedPaths.find((path) => !isAbsolute(path));
  if (relativePath !== undefined) {
    throw new Error(`claude: protected path must be absolute: ${JSON.stringify(relativePath)}`);
  }
  const protectedPaths = [...new Set(req.protectedPaths)];
  return {
    enabled: true,
    failIfUnavailable: true,
    autoAllowBashIfSandboxed: false,
    allowUnsandboxedCommands: false,
    filesystem: {
      denyRead: protectedPaths,
      denyWrite: protectedPaths,
    },
  };
}

function repairPrompt(req: AgentRequest, errors: readonly SchemaIssue[]): string {
  const issues = errors.map((issue) => `- ${issue.path || "(root)"}: ${issue.message}`).join("\n");
  return (
    `The result you returned did not validate against the required schema:\n${issues}\n\n` +
    `Call ${STRUCTURED_OUTPUT_TOOL} again with a corrected object matching this schema.\n\n` +
    `\`\`\`json\n${JSON.stringify(req.schema)}\n\`\`\``
  );
}

class ClaudeProvider implements AgentProvider {
  constructor(
    readonly id: string,
    private readonly queryFn: QueryFn,
  ) {}

  capabilities(): ProviderCapabilities {
    return { structured: "tool", permissionHook: true, sessionResume: true, reportsUsd: true };
  }

  validateOptions(options: unknown): void {
    claudeStepOptions(options);
  }

  async run(req: AgentRequest, ctl: RunControl): Promise<AgentResult> {
    const turn = newTurn();
    await this.stream(req, ctl, turn, withOutputSection(req));
    if (!turn.captured && req.onMaxTurns === "finalize") {
      // One forced turn in the same session: the step is worth more than the turn budget.
      await this.stream(req, ctl, turn, FINALIZE_PROMPT, turn.sessionId);
    }
    if (!turn.captured) throw noOutput(turn);
    return toResult(turn);
  }

  async repair(
    sessionId: string | undefined,
    req: AgentRequest,
    errors: SchemaIssue[],
    ctl: RunControl,
  ): Promise<AgentResult> {
    if (sessionId === undefined) return this.run(req, ctl);
    const turn = newTurn();
    await this.stream(req, ctl, turn, repairPrompt(req, errors), sessionId);
    if (!turn.captured) throw noOutput(turn);
    return toResult(turn);
  }

  /** One query() stream, folded into `turn`. `resume` continues an existing session. */
  private async stream(
    req: AgentRequest,
    ctl: RunControl,
    turn: Turn,
    prompt: string,
    resume?: string,
  ): Promise<void> {
    const server = createSdkMcpServer({
      name: MCP_SERVER_NAME,
      version: "0.1.0",
      tools: [
        tool(
          STRUCTURED_OUTPUT_TOOL,
          toolDescription(req.schema),
          // Declared as an object, not left unknown, and that is load-bearing: given an
          // untyped parameter the model serializes its answer to a JSON *string*, and
          // every step then dies as "expected object, received string". The engine's
          // wire schema is always object-rooted (toWireSchema wraps anything that is
          // not), so this is the honest shape rather than a constraint. It stays
          // permissive about the CONTENTS — validation is the engine's job, and
          // rejecting here would cost a turn without telling the agent anything.
          { result: z.record(z.string(), z.unknown()) },
          async (args) => {
            turn.captured = { value: capturedValue(args) };
            return { content: [{ type: "text" as const, text: "final result recorded" }] };
          },
        ),
      ],
    });

    const controller = new AbortController();
    const onAbort = (): void => controller.abort(ctl.signal.reason);
    if (ctl.signal.aborted) controller.abort(ctl.signal.reason);
    else ctl.signal.addEventListener("abort", onAbort, { once: true });
    // The engine's own step timeout allows 10s of grace on top of this one, so the
    // agent gets aborted cleanly before the step is torn down around it. Armed in
    // CHUNKS: Node clamps a single timer past 2^31-1ms to ~1ms, which would abort
    // a 30-day agent almost immediately.
    let timer: NodeJS.Timeout | undefined;
    if (req.timeoutMs !== undefined && req.timeoutMs > 0) {
      const deadline = Date.now() + req.timeoutMs;
      const arm = (): void => {
        if (controller.signal.aborted) return;
        const remaining = deadline - Date.now();
        if (remaining <= 0) {
          controller.abort(new Error(`claude: agent step timed out after ${req.timeoutMs}ms`));
          return;
        }
        timer = setTimeout(arm, Math.min(remaining, MAX_TIMER_MS));
      };
      arm();
    }

    const protectedSandbox = protectedPathSandbox(req);
    const stepOptions = claudeStepOptions(req.providerOptions);
    const options: Options = {
      cwd: req.cwd,
      abortController: controller,
      mcpServers: { [MCP_SERVER_NAME]: server },
      canUseTool: createToolGate({
        req,
        onEdit: (path) => {
          if (!turn.files.includes(path)) turn.files.push(path);
        },
      }),
      // canUseTool is only consulted in "default" mode: acceptEdits/bypassPermissions
      // pre-approve, "dontAsk" denies what is not pre-approved without asking, and
      // "plan" runs no tools at all.
      permissionMode: stepOptions.permissionMode ?? "default",
      ...(protectedSandbox ? { sandbox: protectedSandbox } : {}),
      ...(req.model !== undefined ? { model: req.model } : {}),
      ...(req.maxTurns !== undefined ? { maxTurns: req.maxTurns } : {}),
      // Effort maps 1:1 onto Options.effort — same five tiers, same names.
      ...(req.effort !== undefined ? { effort: req.effort } : {}),
      ...(resume !== undefined ? { resume } : {}),
    };

    try {
      for await (const message of this.queryFn({ prompt, options })) {
        absorb(message, turn);
      }
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      ctl.signal.removeEventListener("abort", onAbort);
    }
  }
}

/** Fold one SDK message into the turn: transcript lines, usage totals, session id. */
function absorb(message: SDKMessage, turn: Turn): void {
  const sessionId = (message as { session_id?: unknown }).session_id;
  if (typeof sessionId === "string" && sessionId.length > 0) turn.sessionId = sessionId;

  if (message.type === "assistant") {
    for (const block of message.message?.content ?? []) {
      if (block.type === "text") {
        const text = block.text.trim();
        if (text.length > 0) turn.transcript.push(`assistant: ${text}`);
      } else if (block.type === "tool_use") {
        turn.transcript.push(`assistant → tool: ${block.name}`);
      }
    }
    return;
  }

  if (message.type === "result") {
    turn.input += num(message.usage?.input_tokens);
    turn.output += num(message.usage?.output_tokens);
    turn.cacheRead += num(message.usage?.cache_read_input_tokens);
    if (typeof message.total_cost_usd === "number" && Number.isFinite(message.total_cost_usd)) {
      turn.usd += message.total_cost_usd;
      turn.usdSeen = true;
    }
    turn.transcript.push(`result: ${message.subtype}`);
  }
}

function usageOf(turn: Turn): Usage {
  const usage: Usage = { input: turn.input, output: turn.output };
  if (turn.cacheRead > 0) usage.cacheRead = turn.cacheRead;
  if (turn.usdSeen) usage.usd = turn.usd;
  return usage;
}

/**
 * The turns already cost money even though no structured output ever arrived:
 * the spend rides the error (a duck-typed `usage` the engine folds into the
 * failure record) so a resume's budget restore still counts this paid call.
 */
function noOutput(turn: Turn): Error {
  return Object.assign(new Error(NO_OUTPUT), { usage: usageOf(turn) });
}

function toResult(turn: Turn): AgentResult {
  return {
    output: turn.captured?.value,
    usage: usageOf(turn),
    ...(turn.sessionId !== undefined ? { sessionId: turn.sessionId } : {}),
    transcript: turn.transcript.join("\n"),
    filesTouched: turn.files,
  };
}

/**
 * Build the Claude provider. Construction is pure: no credential lookup, no
 * process spawn, no network — the first query() happens inside run().
 */
export function createClaudeProvider(opts: ClaudeProviderOptions = {}): AgentProvider {
  return new ClaudeProvider(opts.id ?? "claude", opts.queryFn ?? query);
}
