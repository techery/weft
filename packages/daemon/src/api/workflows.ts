/**
 * `GET /api/workflows`, `/api/workflows/:name`, `/api/workflows/:name/stats` — the
 * registry, over HTTP.
 *
 * `weft.registry` could always list and load; nothing exposed it. Without this a browser
 * cannot show what is runnable, cannot build a form for a workflow's declared input, and
 * cannot say whether the last fourteen runs of it went well — all three of which are
 * questions about the workflow, not about any one run.
 *
 * Two things here are load-bearing and not obvious.
 *
 * Loading a workflow EXECUTES its module top level, because reading `meta.input` means
 * instantiating the definition. So `:name` is checked against a registry-name shape before
 * the registry sees it: `path.join(dir, name + ".ts")` with a percent-encoded slash in
 * `name` selects any file on the filesystem, and neither Hono nor the node adapter decodes
 * `%2f` into a path separator on the way in. The name check is the boundary; the bundler's
 * determinism gate is explicitly not one.
 *
 * And both the listing and the run index are cached for a few seconds. `registry.list()`
 * runs one esbuild build per file in the directory on every call (the cache key IS the
 * bundle hash, so nothing can be reused before the build), and `reindex()` re-reads every
 * journal in the repo. Either one, uncached, turns the screen a UI opens first into
 * seconds of CPU per poll.
 */
import { relative } from "node:path";
import { toWireSchema } from "@techery/weft-core";
import type { IndexedRun, RunIndex, Weft, WorkflowDefinition } from "@techery/weft-host";
import type { Hono } from "hono";
import * as z from "zod";
import { fail } from "../http.ts";

/** Runs older than this are outside the window every stat here is quoted over. */
const WINDOW_DAYS = 30;

/** How many recent runs a stats response lists, and how many bars a sparkline gets. */
const RECENT = 14;

/**
 * Rows one stats request will read. Reached only by a workflow run more than ~17 times a
 * day for a month, and the response says when it was hit rather than quietly reporting a
 * partial window as a whole one.
 */
const SEARCH_LIMIT = 5_000;

/** How long a listing or an index rebuild is reused. Long enough for a poll, short enough to notice a change. */
const CACHE_MS = 3_000;

/**
 * A registry name is a bare workflow package name. Anything with a separator, a traversal segment,
 * or a `.ts` suffix is a path, and a path is not something this endpoint resolves.
 */
const NAME = /^[A-Za-z0-9._-]+$/;

function assertRegistryName(name: string): void {
  if (!NAME.test(name) || name === "." || name === ".." || name.endsWith(".ts")) {
    throw new Error(
      `${JSON.stringify(name)} is not a registry workflow name — it must be a bare name from ` +
        ".weft/workflows, with no path separators",
    );
  }
}

interface Cached<T> {
  at: number;
  value: Promise<T>;
}

export function registerWorkflowRoutes(app: Hono, weft: Weft): void {
  let listing: Cached<Awaited<ReturnType<Weft["registry"]["listWithIssues"]>>> | undefined;
  let index: Cached<RunIndex> | undefined;

  /**
   * Memoize a fulfilled value for {@link CACHE_MS}, and drop a rejected one immediately: a
   * cached rejection would turn one transient storage fault into a permanently broken
   * endpoint that only a daemon restart clears.
   */
  const cache = <T>(
    slot: () => Cached<T> | undefined,
    set: (c: Cached<T> | undefined) => void,
    load: () => Promise<T>,
  ) => {
    const now = Date.now();
    const held = slot();
    if (held !== undefined && now - held.at < CACHE_MS) return held.value;
    const value = load().catch((err: unknown) => {
      set(undefined);
      throw err;
    });
    set({ at: now, value });
    return value;
  };

  const inspectWorkflows = () =>
    cache(
      () => listing,
      (c) => {
        listing = c;
      },
      () => weft.registry.listWithIssues(),
    );

  const listWorkflows = () => inspectWorkflows().then((inspection) => inspection.entries);

  const runIndex = () =>
    cache(
      () => index,
      (c) => {
        index = c;
      },
      // Rebuilt rather than opened: nothing else in the repo indexes a run as it happens,
      // so a handle held from the first request reports the world as it was then.
      () => weft.reindex(),
    );

  app.get("/api/workflows", async (c) => {
    try {
      const entries = await listWorkflows();
      return c.json(
        entries.map((entry) => ({
          id: entry.id,
          name: entry.name,
          file: relative(weft.cwd, entry.file),
          description: entry.description,
        })),
      );
    } catch (err) {
      return fail(c, err);
    }
  });

  app.get("/api/workflows/issues", async (c) => {
    try {
      const inspection = await inspectWorkflows();
      return c.json(
        inspection.issues.map((issue) => ({
          file: relative(weft.cwd, issue.file),
          error: issue.error,
          diagnostics: issue.diagnostics.map((diagnostic) => ({
            ...diagnostic,
            file: relative(weft.cwd, diagnostic.file),
          })),
        })),
      );
    } catch (err) {
      return fail(c, err);
    }
  });

  app.get("/api/workflows/:name", async (c) => {
    const name = c.req.param("name");
    try {
      assertRegistryName(name);
      const loaded = await weft.registry.load(name).catch((err: unknown) => {
        // A plain miss is a 404; a file that exists and does not build is the caller's
        // actual problem, and its gate diagnostics are the useful part of the answer.
        if (isRegistryMiss(err)) throw new Error(`workflow ${name} not found`);
        throw err;
      });
      const meta = loaded.def.meta;
      const input = jsonSchemaOf(loaded.def, "input");
      const output = jsonSchemaOf(loaded.def, "output");
      const taskExtensions = taskSchemaOf(loaded.def);
      return c.json({
        id: meta.id ?? meta.name ?? name,
        name: meta.name ?? name,
        file: relative(weft.cwd, loaded.file),
        hash: loaded.hash,
        description: meta.description,
        input: input.schema,
        output: output.schema,
        taskExtensions: taskExtensions.schema,
        schemaWarnings: [
          ...input.warnings.map((warning) => `input: ${warning}`),
          ...output.warnings.map((warning) => `output: ${warning}`),
          ...taskExtensions.warnings.map((warning) => `taskExtensions: ${warning}`),
        ],
        taskExtensionSchemaVersion: loaded.def.meta.tasks?.schemaVersion ?? 1,
        tasksConfigured: loaded.def.meta.tasks !== undefined,
        defaults: meta.defaults ?? null,
      });
    } catch (err) {
      return fail(c, err);
    }
  });

  app.get("/api/workflows/:name/stats", async (c) => {
    const name = c.req.param("name");
    try {
      assertRegistryName(name);
      const since = Date.now() - WINDOW_DAYS * 86_400_000;
      const found = (await runIndex()).search({ workflow: name, limit: SEARCH_LIMIT });
      const runs = found.filter((run) => run.createdAt >= since).sort((a, b) => b.createdAt - a.createdAt);

      const ok = runs.filter((run) => run.status === "complete");
      const failed = runs.filter((run) => run.status === "failed");
      const cancelled = runs.filter((run) => run.status === "cancelled");
      // Cancelled runs are excluded from the rate and from the latency sample: someone
      // stopping their own run is not the workflow failing, and a run cancelled two
      // seconds in is not evidence of how long it takes.
      const scored = [...ok, ...failed];
      const durations = scored
        .map((run) => run.updatedAt - run.createdAt)
        .filter((ms) => ms >= 0)
        .sort((a, b) => a - b);

      const spend = ownSpend(runs);
      return c.json({
        name,
        windowDays: WINDOW_DAYS,
        runs: runs.length,
        // A window this endpoint could not read whole, said out loud rather than reported
        // as if it were complete.
        truncated: found.length >= SEARCH_LIMIT,
        settled: scored.length + cancelled.length,
        ok: ok.length,
        failed: failed.length,
        cancelled: cancelled.length,
        successRate: scored.length === 0 ? null : Math.round((ok.length / scored.length) * 100),
        p50Ms: percentile(durations, 0.5),
        p95Ms: percentile(durations, 0.95),
        usd: round2(spend.usd),
        tokens: spend.tokens,
        p50Usd: percentile(
          scored.map((run) => run.usd).sort((a, b) => a - b),
          0.5,
        ),
        lastRunAt: runs[0]?.createdAt ?? null,
        // Newest first: a sparkline reads oldest-first, so a client reverses.
        recent: runs.slice(0, RECENT).map((run) => ({
          runId: run.runId,
          status: run.status,
          createdAt: run.createdAt,
          updatedAt: run.updatedAt,
          usd: round2(run.usd),
          tokens: run.tokens,
          agentSteps: run.agentSteps,
        })),
      });
    } catch (err) {
      return fail(c, err);
    }
  });

  app.get("/api/workflows/:name/tasks", async (c) => {
    const name = c.req.param("name");
    try {
      assertRegistryName(name);
      const entry = (await listWorkflows()).find((candidate) => candidate.name === name);
      if (!entry) throw new Error(`workflow ${name} not found`);
      const loaded = await weft.registry.load(name);
      const workflowId = loaded.def.meta.id ?? loaded.def.meta.name ?? name;
      await weft.tasks.registerWorkflow(
        { id: workflowId, name: loaded.def.meta.name ?? name },
        loaded.def.meta.tasks?.extensions,
        taskSchemaOf(loaded.def).schema,
        loaded.def.meta.tasks,
      );
      const tasks = (await weft.tasks.list(workflowId)).map(
        ({ appliedOperations: _internal, ...task }) => task,
      );
      return c.json(tasks);
    } catch (err) {
      return fail(c, err);
    }
  });
}

/**
 * Total spend across a workflow's runs, skipping any run that is a descendant of another
 * run in the same set. An indexed run's spend INCLUDES its children's, so a workflow that
 * invokes itself (directly, or around a cycle through another) would otherwise have the
 * inner runs counted once on their own row and again inside every ancestor's.
 */
function ownSpend(runs: IndexedRun[]): { usd: number; tokens: number } {
  const present = new Set(runs.map((run) => run.runId));
  let usd = 0;
  let tokens = 0;
  for (const run of runs) {
    if (run.parentRunId !== undefined && present.has(run.parentRunId)) continue;
    usd += run.usd;
    tokens += run.tokens;
  }
  return { usd, tokens };
}

/** The registry reports a plain miss as a GateError carrying no diagnostics. */
function isRegistryMiss(err: unknown): boolean {
  const diagnostics = (err as { diagnostics?: unknown } | undefined)?.diagnostics;
  const message = err instanceof Error ? err.message : "";
  return Array.isArray(diagnostics) && diagnostics.length === 0 && message.includes("not found in");
}

/**
 * A workflow declares any Standard Schema. Zod converts precisely; other vendors and
 * unrepresentable schemas expose the same permissive provider schema the runtime uses,
 * plus warnings, rather than an unexplained `null`.
 *
 * Each side is converted in its own direction. The input side is what a caller must send;
 * the output side is what a run actually produced, and asking for the input side of an
 * output schema describes a shape no client will ever see — defaults reported as required
 * fields that are optional, transformed values typed as their pre-transform input.
 */
function jsonSchemaOf(
  def: WorkflowDefinition,
  which: "input" | "output",
): { schema: unknown; warnings: string[] } {
  try {
    return {
      schema: z.toJSONSchema(def.meta[which] as z.ZodType, {
        io: which === "input" ? "input" : "output",
        unrepresentable: "any",
      }),
      warnings: [],
    };
  } catch {
    const wire = toWireSchema(def.meta[which]);
    return { schema: wire.json, warnings: wire.lints };
  }
}

/** Workflow-specific task extensions use their input shape at the CLI boundary. */
function taskSchemaOf(def: WorkflowDefinition): { schema: unknown | null; warnings: string[] } {
  const schema = def.meta.tasks?.extensions;
  if (schema === undefined) return { schema: null, warnings: [] };
  try {
    return {
      schema: z.toJSONSchema(schema as z.ZodType, { io: "input", unrepresentable: "any" }),
      warnings: [],
    };
  } catch {
    const wire = toWireSchema(schema);
    return { schema: wire.json, warnings: wire.lints };
  }
}

/** Nearest-rank percentile over a pre-sorted array; `null` when there is nothing to rank. */
function percentile(sorted: number[], q: number): number | null {
  if (sorted.length === 0) return null;
  const rank = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1));
  return sorted[rank] ?? null;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
