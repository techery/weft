/**
 * `POST /api/runs` — start a run.
 *
 * This is the one thing the API could not do at all: every other route reads or answers a
 * run that something else began. Without it a browser is a viewer, and "run a workflow"
 * has to drop to a terminal.
 *
 * Registry names only, deliberately. `resolveWorkflow` also accepts a path to any `.ts`
 * file, which would turn one local POST into "bundle and execute this file" — a much
 * larger thing to hang off an HTTP surface than the loopback guard is meant to hold. The
 * registry is a reviewed directory in the repo; a caller that wants an arbitrary file has
 * the CLI, where the person typing it is the person choosing it.
 */
import { rm } from "node:fs/promises";
import { join } from "node:path";
import type { StartOptions, Weft } from "@techery/weft-host";
import { parseBudget, rejectUnknownInput, reserveRunId, resolveWorkflow } from "@techery/weft-host";
import type { Hono } from "hono";
import { fail, jsonBody } from "../http.ts";

const REUSE = new Set(["content", "key"]);

export function registerStartRoutes(app: Hono, weft: Weft): void {
  app.post("/api/runs", async (c) => {
    try {
      const body = await jsonBody(c);
      const name = body["workflow"];
      if (typeof name !== "string" || name.trim() === "") {
        throw new Error("start: workflow is required (a name from .weft/workflows)");
      }
      if (/[/\\]/.test(name) || name.endsWith(".ts")) {
        throw new Error(
          `start: ${JSON.stringify(name)} looks like a path — this endpoint starts registry ` +
            "workflows only; use the CLI to run a file",
        );
      }

      const input = body["input"] ?? {};
      if (typeof input !== "object" || input === null || Array.isArray(input)) {
        throw new Error("start: input must be a JSON object");
      }

      const budget = budgetOf(body["budget"]);
      const reuse = reuseOf(body["reuse"]);

      // Through resolveWorkflow, not registry.load, for two reasons the CLI already
      // relies on. It stamps the registry name onto the definition — `engine.start` falls
      // back to the literal "workflow" when `meta.name` is absent, and a run journaled
      // under that name can never be resumed by name again, which is most of what this
      // daemon exists to do. And it draws the line between a miss and a file that exists
      // but does not build: the second is the caller's actual problem and its gate
      // diagnostics are the only useful part of the response.
      const resolved = await resolveWorkflow(weft, name);

      // A field the schema silently drops is a typo that buys an agent run against the
      // wrong input, so it is refused here exactly as it is on the command line.
      await rejectUnknownInput(input as Record<string, unknown>, resolved.def, resolved.name);

      // The id is reserved by an exclusive directory create, so two concurrent starts
      // cannot land in the same run's directory. A registry name needs no provenance
      // written beside it: the journaled name finds the definition again on resume.
      const runId = await reserveRunId(weft);
      const opts: StartOptions = {
        runId,
        input,
        cwd: weft.cwd,
        ...(resolved.hash !== undefined ? { defHash: resolved.hash } : {}),
        ...(budget !== undefined ? { budget } : {}),
        ...(reuse !== undefined ? { reuse } : {}),
      };

      const handle = await weft.engine.start(resolved.def, opts).catch(async (err: unknown) => {
        // Startup failed before any journal record: the reserved directory is litter.
        if (!(await weft.engine.journal.exists(runId))) {
          await rm(join(weft.runsDir, runId), { recursive: true, force: true }).catch(() => undefined);
        }
        throw err;
      });

      // The run continues in this process; the caller watches /events or polls the state.
      // Its rejection is the run's own outcome, already journaled — not this request's.
      void handle.outcome().catch(() => undefined);

      return c.json({ ok: true, runId: handle.runId, workflow: resolved.name }, 202);
    } catch (err) {
      return fail(c, err);
    }
  });
}

/** Same grammar as `--budget`, so the CLI and a browser cannot mean different things. */
function budgetOf(value: unknown): { tokens?: number; usd?: number } | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value === "string") return parseBudget(value);
  if (typeof value === "object" && !Array.isArray(value)) {
    const raw = value as { tokens?: unknown; usd?: unknown };
    // Strict, like the config schema and `parseBudget` itself: a misspelled axis that
    // degrades to `{}` is a run the caller believes is capped and is not.
    const unknown = Object.keys(raw).filter((key) => key !== "tokens" && key !== "usd");
    if (unknown.length > 0) {
      throw new Error(
        `start: budget has no field ${unknown.map((k) => JSON.stringify(k)).join(", ")} — it takes tokens, usd`,
      );
    }
    const out: { tokens?: number; usd?: number } = {};
    if (raw.tokens !== undefined) {
      if (typeof raw.tokens !== "number" || !Number.isFinite(raw.tokens) || raw.tokens < 0) {
        throw new Error("start: budget.tokens must be a non-negative number");
      }
      out.tokens = raw.tokens;
    }
    if (raw.usd !== undefined) {
      if (typeof raw.usd !== "number" || !Number.isFinite(raw.usd) || raw.usd < 0) {
        throw new Error("start: budget.usd must be a non-negative number");
      }
      out.usd = raw.usd;
    }
    if (out.tokens === undefined && out.usd === undefined) {
      throw new Error("start: budget must set tokens, usd, or both");
    }
    return out;
  }
  throw new Error('start: budget must be a string like "500k" or "$5", or { tokens, usd }');
}

function reuseOf(value: unknown): "content" | "key" | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || !REUSE.has(value)) {
    throw new Error('start: reuse must be "content" or "key"');
  }
  return value as "content" | "key";
}
