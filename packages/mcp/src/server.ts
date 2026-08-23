/**
 * The MCP host: how a Claude Code or Codex session reaches the engine. It is a shell over
 * `weft.engine` like every other host (C10) — `createWeft` does the assembling, this file
 * only decides what a session is allowed to say and what shape it hears back.
 *
 * ```jsonc
 * // .mcp.json
 * { "mcpServers": { "weft": { "command": "npx", "args": ["-y", "@weft/mcp"] } } }
 * ```
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createWeft, type Weft } from "@weft/host";
import { registerTools } from "./tools.ts";

/** Kept in step with package.json; reported to the client on initialize. */
const VERSION = "0.1.0";

export interface CreateWeftMcpServerOptions {
  /** Repo root the runs execute in, and the root `.weft/` is read from. */
  cwd: string;
  /** `"real"` (default) wires the Claude and Codex adapters; `"mock"` wires fixtures only. */
  providers?: "real" | "mock";
}

export interface WeftMcpServer {
  server: McpServer;
  /** The assembled engine behind the tools — the same object the CLI and daemon hold. */
  weft: Weft;
}

/**
 * The loop this server exists for, written where the session will read it: run, wait, and
 * when the wait comes back `awaiting`, put the question to the person and answer it.
 */
const INSTRUCTIONS = `Weft runs durable, journaled, schema-validated multi-agent workflows in this repo.

The loop:
  1. weft_run { workflow | source, input } -> { runId }, immediately; the run continues in the background.
  2. weft_wait { runId } long-polls and returns the next change.
  3. If it returns { awaiting: { id, question, schema, … } }, ask YOUR user that question, then
     weft_answer { runId, requestId: awaiting.id, answer } and wait again. Never answer on their behalf,
     and never guess a value the schema rejects — the error tells you what it wanted.
  4. { status: "complete", output } ends the loop. { status: "running" } just means the timeout expired: wait again.

Every reply is JSON — read its fields, do not summarise from prose. weft_report explains a finished
(or stuck) run; weft_list finds runs started elsewhere; weft_resume picks a run back up after a failure
or after you edit its workflow file; weft_types returns the SDK source to write an inline workflow against.`;

/** Build a server over one repo. Nothing is connected: hand `server` a transport. */
export async function createWeftMcpServer(opts: CreateWeftMcpServerOptions): Promise<WeftMcpServer> {
  const weft = await createWeft({
    cwd: opts.cwd,
    ...(opts.providers !== undefined ? { providers: opts.providers } : {}),
  });
  const server = new McpServer({ name: "weft", version: VERSION }, { instructions: INSTRUCTIONS });
  registerTools(server, weft);
  return { server, weft };
}

/** stdio entry point: `npx @weft/mcp` from a session's MCP config. */
export async function main(): Promise<void> {
  const { server } = await createWeftMcpServer({ cwd: process.cwd() });
  // stdout is the transport — anything this process wants to say goes to stderr.
  await server.connect(new StdioServerTransport());
}
