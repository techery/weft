#!/usr/bin/env node
/**
 * `npx @techery/weft-mcp` — what a session's MCP config spawns.
 *
 * Same two-mode entry as the CLI: `exports` says which shape this install is (see
 * `packages/cli/bin/weft.js`). The module it loads speaks JSON-RPC over stdio, so it keeps
 * startup failures off stdout and reports them on stderr itself.
 */
import { readFileSync } from "node:fs";

const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const published = String(manifest.exports?.["."]?.default ?? "").startsWith("./dist/");

if (!published) {
  const { register } = await import("tsx/esm/api");
  register();
}

await import(new URL(published ? "../dist/bin.js" : "../src/bin.ts", import.meta.url).href);
