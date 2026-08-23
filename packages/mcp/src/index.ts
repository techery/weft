/**
 * @weft/mcp — the MCP server that puts Weft inside a Claude Code or Codex session:
 * `weft_run` · `weft_wait` · `weft_answer` · `weft_resume` · `weft_list` · `weft_report` ·
 * `weft_types`.
 *
 * ```ts
 * const { server, weft } = await createWeftMcpServer({ cwd: process.cwd() });
 * await server.connect(transport);
 * ```
 */

export type { AwaitingRequest, TrackedRun, WaitResult } from "./runs.ts";
export { DEFAULT_TIMEOUT, parseTimeout, RunStore, waitForChange } from "./runs.ts";
export type { CreateWeftMcpServerOptions, WeftMcpServer } from "./server.ts";
export { createWeftMcpServer, main } from "./server.ts";

export { registerTools } from "./tools.ts";
export { sdkTypings } from "./typings.ts";
