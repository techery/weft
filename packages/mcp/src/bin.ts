#!/usr/bin/env node
/**
 * `npx @weft/mcp` — what a session's MCP config spawns. It speaks JSON-RPC over stdio, so
 * a startup failure has to leave stdout alone and report on stderr.
 */
import { main } from "./index.ts";

main().catch((err: unknown) => {
  process.stderr.write(`weft mcp: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exitCode = 1;
});
