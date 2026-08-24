/**
 * The seven tools a Claude Code or Codex session drives Weft with: run · wait · answer ·
 * resume · list · report · types.
 *
 * Two rules hold for every one of them. First, a reply is a single JSON text block —
 * sessions read fields, never prose, so `weft_wait` returning `{ awaiting: … }` is the
 * only thing standing between a suspended run and the question its user needs to see.
 * Second, anything that goes wrong comes back as `isError` carrying the engine's own
 * message: an answer that fails the request schema tells the session what to fix, and the
 * session can fix it without a person.
 */
import { rm } from "node:fs/promises";
import { join } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  isWorkflowPathRef,
  loadWorkflow,
  mergedAllowBare,
  parseBudget,
  persistedDefOf,
  persistInlineScript,
  persistWorkflowRef,
  type RunListFilter,
  reserveRunId,
  resolveWorkflow,
  type Weft,
  type WorkflowDefinition,
} from "@weft/host";
import { z } from "zod";
import { DEFAULT_TIMEOUT, parseTimeout, RunStore, type TrackedRun, waitForChange } from "./runs.ts";
import { sdkTypings } from "./typings.ts";

/** Mirrors `ReuseMode`; the engine's replay policy is a type, so it cannot be reflected. */
const REUSE = z.enum(["content", "key"]);

/** Mirrors `RunStatus`, for the same reason — a session gets the real filter, not a free string. */
const RUN_STATUS = z.enum([
  "planning",
  "executing",
  "waiting_for_human",
  "waiting_for_signal",
  "integrating",
  "verifying",
  "complete",
  "failed",
  "cancelled",
]);

/** How many runs `weft_list` returns when the caller names no limit. */
const LIST_LIMIT = 20;

/** Register every weft tool against one engine. Returns the store the tools share. */
export function registerTools(server: McpServer, weft: Weft): RunStore {
  const runs = new RunStore();

  server.registerTool(
    "weft_run",
    {
      title: "Start a weft run",
      description:
        "Start a workflow and return its runId immediately — the run keeps going after this call. " +
        "Pass exactly one of `workflow` (a registry name like `review`, or a path to a .ts file) or " +
        "`source` (inline TypeScript; call weft_types first for the authoring surface). " +
        "Follow with weft_wait to get the output or the first question.",
      inputSchema: {
        workflow: z
          .string()
          .optional()
          .describe("Registry name (`review`) or path to a .ts file (`./flows/review.ts`)."),
        source: z
          .string()
          .optional()
          .describe("Inline TypeScript exporting `default defineWorkflow({…}, run)`."),
        input: z
          .unknown()
          .optional()
          .describe(
            "Any JSON value (object, array, string, number, null); validated against the workflow's input schema before the run starts.",
          ),
        budget: z.string().optional().describe('Ceiling for the run: "500k" tokens, "$5", or "500k,$5".'),
        reuse: REUSE.optional().describe(
          '"content" (default) reuses a journaled step only when its inputs are byte-identical; ' +
            '"key" reuses by step key.',
        ),
      },
    },
    async (args) =>
      reply(async () => {
        const started = await startRun(weft, runs, args);
        return { runId: started.handle.runId };
      }),
  );

  server.registerTool(
    "weft_wait",
    {
      title: "Wait for a weft run to change",
      description:
        "Long-poll one run and return on its next reportable change: " +
        '{ status: "complete", output } · { status: "failed", error } · { status: "cancelled" } · ' +
        "{ awaiting: { runId, id, kind, question, schema, … } } when a person must answer · " +
        '{ status: "running" } if the timeout expires first (call again). ' +
        "On `awaiting`, ask your user the question, then call weft_answer with `awaiting.runId` " +
        "(the request's OWNING run — a suspended child of the run you waited on, possibly) " +
        "and a value matching `schema`, then wait again on the original run.",
      inputSchema: {
        runId: z.string().describe("The id weft_run or weft_resume returned."),
        timeout: z
          .string()
          .optional()
          .describe(
            `How long to hold the poll open: "10m", "90s", "250ms", or ms. Default "${DEFAULT_TIMEOUT}".`,
          ),
      },
      annotations: { readOnlyHint: true },
    },
    async (args) =>
      reply(() => {
        // A failed automatic wake (recorded by weft_answer's fire-and-forget
        // resume) would otherwise read as `running` forever: surface it as the
        // error it is, with the fix in hand.
        const wakeFailure = runs.takeWakeFailure(args.runId);
        if (wakeFailure !== undefined) {
          throw new Error(
            `the automatic wake after weft_answer failed: ${wakeFailure} — fix the workflow (or its file) and call weft_resume`,
          );
        }
        return waitForChange(weft, runs, args.runId, parseTimeout(args.timeout ?? DEFAULT_TIMEOUT));
      }),
  );

  server.registerTool(
    "weft_answer",
    {
      title: "Answer a pending weft request",
      description:
        "Answer the request weft_wait reported. The value is validated against that request's schema: " +
        "on a mismatch this returns an error naming the offending field, and the run stays suspended. " +
        'An approval takes { "approved": true } (with an optional "note").',
      inputSchema: {
        runId: z
          .string()
          .describe("`awaiting.runId` from weft_wait — the request's OWNING run, not the one waited on."),
        requestId: z.string().describe("`awaiting.id` from weft_wait."),
        answer: z.unknown().describe("The value, shaped by `awaiting.schema`."),
      },
    },
    async (args) =>
      reply(async () => {
        await weft.engine.answer(args.runId, args.requestId, args.answer, { channel: "mcp" });
        // A run whose owner exited has no runtime to deliver the answer into: wake it
        // so the journal serves it and weft_wait sees progress without an explicit
        // weft_resume. The answered run may be a CHILD (awaiting.runId): resuming it
        // alone completes its journal while the parent's workflow step never
        // re-executes to consume the result — wake the ROOT of the recorded tree,
        // whose resume re-enters the children. Fire-and-forget and lease-protected —
        // when a live process still owns the run, the claim is refused and its
        // tailer delivers instead.
        if (!weft.engine.isActive(args.runId)) {
          let rootId = args.runId;
          const seen = new Set([rootId]);
          for (;;) {
            let parentId: string | undefined;
            try {
              parentId = (await weft.engine.state(rootId)).parentRunId;
            } catch {
              break;
            }
            if (parentId === undefined || seen.has(parentId)) break;
            seen.add(parentId);
            rootId = parentId;
          }
          if (!weft.engine.isActive(rootId)) {
            const woken = rootId;
            const tracked = runs.get(woken);
            void Promise.resolve(tracked?.def ?? persistedDefOf(weft, woken))
              .then((def) => weft.engine.resume(woken, def !== undefined ? { def } : {}))
              .then((handle) => {
                runs.clearWakeFailure(woken);
                runs.track({
                  handle,
                  ...(tracked?.ref !== undefined
                    ? { ref: tracked.ref }
                    : tracked?.def !== undefined
                      ? { def: tracked.def }
                      : {}),
                });
                return handle.outcome();
              })
              .catch((err: unknown) => {
                const message = err instanceof Error ? err.message : String(err);
                // A refused CLAIM is the designed no-op: a live owner still
                // holds the run and its tailer delivers the answer. Everything
                // else (the workflow file deleted, a gate refusal) is a wake
                // nothing will retry — the answer already reported ok, so
                // without retention every later `weft_wait` reads `running`
                // forever. Kept for the next wait to surface.
                if (/active in another process/.test(message)) return;
                runs.noteWakeFailure(woken, message);
              });
          }
        }
        return { ok: true };
      }),
  );

  server.registerTool(
    "weft_resume",
    {
      title: "Resume a suspended or failed weft run",
      description:
        "Re-execute a run against its journal: completed steps are served from it, and only what is missing " +
        "(or no longer matches) runs again. Use after answering out of band, after a failure, or after editing " +
        "the workflow file. Returns the same runId; follow with weft_wait.",
      inputSchema: {
        runId: z.string(),
        reuse: REUSE.optional().describe(
          '"content" (default) or "key" — keep answers by step key while iterating on wording.',
        ),
      },
    },
    async (args) =>
      reply(async () => {
        const tracked = runs.get(args.runId);
        // A registry or file ref is re-resolved from disk so an edit lands; inline source
        // has no file, so the definition it loaded is what resume gets. Everything else
        // falls through to the engine's registry lookup by the name the run journaled.
        const ref = tracked?.ref;
        const def =
          ref !== undefined
            ? (await resolveWorkflow(weft, ref)).def
            : (tracked?.def ?? (await persistedDefOf(weft, args.runId)));
        const handle = await weft.engine.resume(args.runId, {
          ...(def !== undefined ? { def } : {}),
          ...(args.reuse !== undefined ? { reuse: args.reuse } : {}),
        });
        runs.track({
          handle,
          ...(ref !== undefined ? { ref } : def !== undefined ? { def } : {}),
        });
        return { runId: handle.runId, status: "resumed" };
      }),
  );

  server.registerTool(
    "weft_list",
    {
      title: "List weft runs",
      description:
        `Summaries of the runs in this repo, newest first (default ${LIST_LIMIT}): ` +
        "runId, workflow, status, createdAt, updatedAt. Includes runs started by the CLI or another session.",
      inputSchema: {
        status: RUN_STATUS.optional().describe("Keep only runs in this status."),
        workflow: z.string().optional().describe("Keep only runs of this workflow name."),
        limit: z
          .number()
          .int()
          .positive()
          .optional()
          .describe(`Maximum runs to return (default ${LIST_LIMIT}).`),
      },
      annotations: { readOnlyHint: true },
    },
    async (args) =>
      reply(async () => {
        const filter: RunListFilter = {
          limit: args.limit ?? LIST_LIMIT,
          ...(args.status !== undefined ? { status: args.status } : {}),
          ...(args.workflow !== undefined ? { workflow: args.workflow } : {}),
        };
        return { runs: await weft.engine.list(filter) };
      }),
  );

  server.registerTool(
    "weft_report",
    {
      title: "Read a weft run's report",
      description:
        "The run's report.md: outcome, steps and their cost, checks, integration ledger, notes, and anything " +
        "still pending. Safe to call at any point in a run's life.",
      inputSchema: { runId: z.string() },
      annotations: { readOnlyHint: true },
    },
    async (args) => reply(async () => ({ report: await weft.engine.report(args.runId) })),
  );

  server.registerTool(
    "weft_types",
    {
      title: "Read the weft authoring surface",
      description:
        "The @weft/sdk TypeScript source a workflow is written against: the full `ctx` surface, " +
        "`defineWorkflow`, and the schema types. Read this before passing `source` to weft_run.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => reply(async () => ({ types: await sdkTypings() })),
  );

  return runs;
}

// ---------------------------------------------------------------------------
// Starting a run
// ---------------------------------------------------------------------------

interface RunArgs {
  workflow?: string;
  source?: string;
  input?: unknown;
  budget?: string;
  reuse?: "content" | "key";
}

async function startRun(weft: Weft, runs: RunStore, args: RunArgs): Promise<TrackedRun> {
  if ((args.workflow === undefined) === (args.source === undefined)) {
    throw new Error(
      "weft_run: pass exactly one of workflow (a registry name or a path to a .ts file) or source (inline TypeScript)",
    );
  }
  const inline = args.workflow === undefined ? await loadInline(weft, args.source ?? "") : undefined;
  const resolved = inline ?? (await resolveWorkflow(weft, args.workflow ?? ""));

  // Provenance rides with the run: inline source persists its bundled script, a
  // path ref records the path — any later host can reconstruct the definition.
  // Persisted BEFORE the run launches: a crash after start() must never leave a
  // durable run no other process can find a definition for. The id is reserved
  // by an exclusive directory create, so a collision can never write into an
  // EXISTING run's directory.
  const runId = await reserveRunId(weft);
  if (inline?.code !== undefined) await persistInlineScript(weft, runId, inline.code);
  else if (args.workflow !== undefined && isWorkflowPathRef(args.workflow)) {
    await persistWorkflowRef(weft, runId, args.workflow);
  }
  const handle = await weft.engine
    .start(resolved.def, {
      runId,
      // Pass through verbatim: null, arrays, and scalars are valid inputs, and the
      // engine defaults only an actually OMITTED input.
      input: args.input,
      cwd: weft.cwd,
      ...(resolved.hash !== undefined ? { defHash: resolved.hash } : {}),
      ...(args.budget !== undefined ? { budget: parseBudget(args.budget) } : {}),
      ...(args.reuse !== undefined ? { reuse: args.reuse } : {}),
    })
    .catch(async (err: unknown) => {
      // Startup failed before any journal record: the reserved provenance is litter.
      if (!(await weft.engine.journal.exists(runId))) {
        await rm(join(weft.runsDir, runId), { recursive: true, force: true }).catch(() => undefined);
      }
      throw err;
    });
  return runs.track({
    handle,
    ...(args.workflow !== undefined ? { ref: args.workflow } : { def: resolved.def }),
  });
}

/** Inline TypeScript through the same gate a file goes through, resolved against the repo root. */
async function loadInline(
  weft: Weft,
  source: string,
): Promise<{ def: WorkflowDefinition; hash?: string; code?: string }> {
  // Merged with the defaults: config extras must not cost inline code its zod.
  const allowBare = mergedAllowBare(weft.config);
  const loaded = await loadWorkflow({
    source,
    cwd: weft.cwd,
    name: "inline",
    ...(allowBare ? { allowBare } : {}),
  });
  return { def: named(loaded.def, loaded.name), hash: loaded.hash, code: loaded.code };
}

/**
 * A run journals `def.meta.name`, and that name is what a later resume or `ctx.workflow()`
 * looks up. Inline source that does not name itself would otherwise journal as the
 * engine's fallback `"workflow"`, so it is named here — the same thing `resolveWorkflow`
 * does for a file ref.
 */
function named(def: WorkflowDefinition, name: string): WorkflowDefinition {
  if (def.meta.name === name) return def;
  return Object.freeze({ kind: def.kind, meta: Object.freeze({ ...def.meta, name }), run: def.run });
}

// ---------------------------------------------------------------------------
// Replies
// ---------------------------------------------------------------------------

/** One JSON text block on success; the raw message, flagged `isError`, on failure. */
async function reply(produce: () => Promise<unknown>): Promise<CallToolResult> {
  try {
    const value = await produce();
    return { content: [{ type: "text", text: JSON.stringify(value ?? null, null, 2) }] };
  } catch (err) {
    return {
      content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }],
      isError: true,
    };
  }
}
