/**
 * `GET /api/meta` — what this daemon is, and what it is configured to do.
 *
 * Everything here was previously knowable only in-process: which repo the daemon is
 * serving, which providers are actually wired, the resolved pool size and the approval
 * tiers. A UI that shows "pool 8 agents · default budget $8.00" in its status bar has to
 * read it from somewhere, and guessing is worse than not showing it.
 *
 * Resolved values, not the config file: {@link /api/config} serves the file. These are
 * what the running engine decided after defaults were applied.
 */
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { fileURLToPath } from "node:url";
import type { Weft } from "@techery/weft-host";
import type { Hono } from "hono";
import { fail } from "../http.ts";

/**
 * This package's own version, read once. `../../package.json` resolves the same from
 * `src/api/` in a checkout and from `dist/api/` in a published install.
 */
const VERSION = readVersion();

function readVersion(): string {
  try {
    const path = fileURLToPath(new URL("../../package.json", import.meta.url));
    const pkg = JSON.parse(readFileSync(path, "utf8")) as { version?: unknown };
    return typeof pkg.version === "string" ? pkg.version : "0.0.0";
  } catch {
    // A daemon that cannot read its own manifest still serves runs.
    return "0.0.0";
  }
}

export function registerMetaRoutes(app: Hono, weft: Weft): void {
  app.get("/api/meta", (c) => {
    try {
      const engine = weft.engine.config;
      return c.json({
        version: VERSION,
        repo: {
          name: basename(weft.cwd),
          cwd: weft.cwd,
          weftDir: weft.weftDir,
          runsDir: weft.runsDir,
        },
        defaults: engine.defaults,
        limits: engine.limits,
        approvalPolicy: engine.approvalPolicy,
        // `undefined` means every host is allowed; null says that explicitly over JSON.
        fetchAllow: engine.fetchAllow ?? null,
        providers: providersOf(weft),
      });
    } catch (err) {
      return fail(c, err);
    }
  });
}

/**
 * Every provider named in config plus every one actually registered, so a UI can show
 * "configured but not wired" rather than silently omitting it.
 */
function providersOf(weft: Weft): Array<{ id: string; registered: boolean; concurrency?: number }> {
  const registered = new Set(weft.engine.providers.ids());
  const ids = new Set([...registered, ...Object.keys(weft.engine.config.providers)]);
  return [...ids].sort().map((id) => {
    const concurrency = weft.engine.config.providers[id]?.concurrency;
    return {
      id,
      registered: registered.has(id),
      ...(concurrency !== undefined ? { concurrency } : {}),
    };
  });
}
