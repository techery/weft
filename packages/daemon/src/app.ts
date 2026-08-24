/**
 * The daemon's HTTP surface. Like every other host it is a shell over `weft.engine`
 * (C10): each route is one engine call plus the shape it goes over the wire in, and the
 * page at `/` is served from the same JSON API a script would use.
 *
 * Three things here are not pure pass-through:
 *
 *   - Reads fold the journal (C4/C9) rather than the engine's in-memory projection — see
 *     {@link stateOf}, which explains why.
 *   - `GET /api/runs/:id/events` streams `engine.watch()` as SSE, so a browser sees the
 *     journal as it is written rather than polling a projection.
 *   - `POST .../answer` and `POST .../signal` wake the run afterwards when nothing in
 *     this process is waiting on it — the daemon's wake-suspended-runs job.
 */
import type {
  JournalRecord,
  PendingRequest,
  RunListFilter,
  RunState,
  RunStatus,
  RunSummary,
  Weft,
} from "@techery/weft-host";
import { persistedDefOf, reduceState, renderReport, renderTree, resumeOptions } from "@techery/weft-host";
import type { Context } from "hono";
import { Hono } from "hono";
import { INDEX_HTML } from "./ui.ts";

/** A comment line often enough that a proxy (or a sleeping laptop) never calls the stream dead. */
const HEARTBEAT_MS = 15_000;

/** Recorded on every answer this host takes, so the journal says where it came from. */
const CHANNEL = "web";

const SSE_HEADERS = {
  "content-type": "text/event-stream; charset=utf-8",
  "cache-control": "no-cache, no-transform",
  connection: "keep-alive",
  // Nothing buffers a local socket, but a reverse proxy in front of one would.
  "x-accel-buffering": "no",
} as const;

const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

/** True when a Host header or Origin names a loopback host (any port). Unparseable = false. */
function isLoopbackName(value: string): boolean {
  try {
    const url = new URL(value.includes("://") ? value : `http://${value}`);
    return LOOPBACK_HOSTS.has(url.hostname);
  } catch {
    return false;
  }
}

/**
 * Build the app over an assembled {@link Weft}. Kept separate from `startDaemon()` so
 * tests (and anything embedding the daemon) can drive every route through `app.request()`
 * with no socket in the way.
 */
export function createApp(weft: Weft): Hono {
  const app = new Hono();
  const engine = weft.engine;

  // Loopback binding alone does not authenticate a BROWSER: a DNS-rebinding
  // page re-resolves its own hostname to 127.0.0.1 and reaches this API as if
  // same-origin (carrying the attacker's Host), and any cross-site page can
  // fire side-effecting POSTs blind. Both arrive with a header an honest local
  // client never sends — a non-loopback Host or a non-loopback Origin — so the
  // guard runs before every route, answers/cancels/resumes included.
  app.use("*", async (c, next) => {
    const host = c.req.header("host");
    if (host !== undefined && !isLoopbackName(host)) {
      return c.json({ error: "forbidden: non-local Host header" }, 403);
    }
    const origin = c.req.header("origin");
    if (origin !== undefined && !isLoopbackName(origin)) {
      return c.json({ error: "forbidden: cross-site request" }, 403);
    }
    return next();
  });

  app.get("/", (c) => c.body(INDEX_HTML, 200, { "content-type": "text/html; charset=utf-8" }));

  app.get("/api/runs", async (c) => {
    try {
      const summaries = await engine.list(listFilter(c));
      return c.json(await Promise.all(summaries.map((summary) => repaired(weft, summary))));
    } catch (err) {
      return fail(c, err);
    }
  });

  app.get("/api/runs/:id", async (c) => {
    try {
      return c.json(await stateOf(weft, c.req.param("id")));
    } catch (err) {
      return fail(c, err);
    }
  });

  app.get("/api/runs/:id/report", async (c) => {
    try {
      const report = renderReport(await stateOf(weft, c.req.param("id")));
      return c.body(report, 200, { "content-type": "text/markdown; charset=utf-8" });
    } catch (err) {
      return fail(c, err);
    }
  });

  app.get("/api/runs/:id/tree", async (c) => {
    try {
      return c.json(renderTree(await stateOf(weft, c.req.param("id"))));
    } catch (err) {
      return fail(c, err);
    }
  });

  app.get("/api/runs/:id/pending", async (c) => {
    try {
      const runId = c.req.param("id");
      const state = await stateOf(weft, runId);
      return c.json(await pendingAcross(weft, state, new Set([runId])));
    } catch (err) {
      return fail(c, err);
    }
  });

  app.get("/api/runs/:id/events", async (c) => {
    const runId = c.req.param("id");
    try {
      if (!(await engine.journal.exists(runId))) throw new Error(`run ${runId} not found`);
    } catch (err) {
      return fail(c, err);
    }
    // An automatic EventSource reconnect carries its cursor as Last-Event-ID (the
    // last `id:` it saw), not as ?from= — resume one past it so a transient
    // disconnect never replays the whole journal into the UI.
    const from = Number.parseInt(c.req.query("from") ?? "", 10);
    const lastSeen = Number.parseInt(c.req.header("last-event-id") ?? "", 10);
    const fromIndex =
      Number.isFinite(from) && from >= 0
        ? from
        : Number.isFinite(lastSeen) && lastSeen >= 0
          ? lastSeen + 1
          : undefined;
    return streamJournal(weft, runId, {
      ...(fromIndex !== undefined ? { fromIndex } : {}),
      signal: c.req.raw.signal,
    });
  });

  app.post("/api/runs/:id/answer", async (c) => {
    const runId = c.req.param("id");
    try {
      const body = await jsonBody(c);
      const requestId = body["requestId"];
      if (typeof requestId !== "string" || requestId === "") {
        throw new Error("answer: requestId is required");
      }
      if (!("answer" in body)) throw new Error("answer: answer is required (use null for an empty answer)");
      // Decide BEFORE answering: an in-process run may finish (and leave the active
      // map) the moment the answer resolves its wait — that is delivery, not a
      // suspended run needing a wake.
      const heldHere = engine.isActive(runId);
      await engine.answer(runId, requestId, body["answer"], { channel: CHANNEL });
      // Refreshed before the wake, so the runs list never shows the pre-answer status.
      await refreshProjections(weft, runId);
      return c.json({ ok: true, woke: heldHere ? false : wakeIfSuspended(weft, runId) });
    } catch (err) {
      return fail(c, err);
    }
  });

  app.post("/api/runs/:id/signal", async (c) => {
    const runId = c.req.param("id");
    try {
      const body = await jsonBody(c);
      const name = body["name"];
      if (typeof name !== "string" || name === "") throw new Error("signal: name is required");
      const heldHere = engine.isActive(runId);
      await engine.signal(runId, name, "payload" in body ? body["payload"] : null);
      await refreshProjections(weft, runId);
      return c.json({ ok: true, woke: heldHere ? false : wakeIfSuspended(weft, runId) });
    } catch (err) {
      return fail(c, err);
    }
  });

  app.post("/api/runs/:id/cancel", async (c) => {
    const runId = c.req.param("id");
    try {
      await engine.cancel(runId);
      await refreshProjections(weft, runId);
      return c.json({ ok: true });
    } catch (err) {
      return fail(c, err);
    }
  });

  app.post("/api/runs/:id/resume", async (c) => {
    const runId = c.req.param("id");
    try {
      // Same fallback the wake paths use: an inline or path-ref run persisted its
      // definition at start precisely so a registry-less resume can find it here.
      const persisted = await persistedDefOf(weft, runId);
      const handle = await engine.resume(runId, resumeOptions(persisted));
      // The run continues in the background; the caller watches /events or polls the state.
      void handle.outcome().catch(() => undefined);
      return c.json({ ok: true, runId: handle.runId });
    } catch (err) {
      return fail(c, err);
    }
  });

  return app;
}

// ---------------------------------------------------------------------------
// Projections
// ---------------------------------------------------------------------------

/**
 * Every read here folds the run's journal, because the journal is the only record that is
 * always complete (C4). The engine keeps its own projection for a run it is driving, and
 * that copy trails the journal by one append at every suspension — and, for a run this
 * process itself started, never sees `run.created` at all (see the package's frictions
 * note). Folding the journal costs one file read and cannot disagree with the event
 * stream the same page is rendering next to it.
 */
async function stateOf(weft: Weft, runId: string): Promise<RunState> {
  const records: JournalRecord[] = [];
  for await (const record of weft.engine.journal.read(runId)) records.push(record);
  if (records.length === 0) throw new Error(`run ${runId} not found`);
  return reduceState(records);
}

/**
 * Pending requests across the run AND its live descendants: a child suspended
 * on a person suspends the whole tree, and its request lives only in the
 * child's journal. Each entry carries the OWNING run's id, and the engine
 * routes an answer submitted under the parent id to that owner either way.
 */
async function pendingAcross(weft: Weft, state: RunState, seen: Set<string>): Promise<PendingRequest[]> {
  const out = pendingOf(state);
  for (const { childRunId } of state.children) {
    if (seen.has(childRunId)) continue;
    seen.add(childRunId);
    // Only confirmed ABSENCE is skippable (a child scheduled but never
    // journaled). An unreadable child journal must surface instead of /pending
    // silently omitting the child's outstanding approval.
    if (!(await weft.engine.exists(childRunId))) continue;
    const child = await stateOf(weft, childRunId);
    if (child.status === "complete" || child.status === "failed" || child.status === "cancelled") continue;
    out.push(...(await pendingAcross(weft, child, seen)));
  }
  return out;
}

/** The same shape `engine.pending()` reports, derived from the same fold as the rest. */
function pendingOf(state: RunState): PendingRequest[] {
  return state.humans
    .filter((human) => human.status === "pending")
    .map((human) => ({
      runId: state.runId,
      id: human.id,
      kind: human.kind as PendingRequest["kind"],
      question: human.question,
      schema: human.schema,
      createdAt: human.requestedAt,
      ...(human.detail !== undefined ? { detail: human.detail } : {}),
      ...(human.risk !== undefined ? { risk: human.risk } : {}),
      ...(human.deadline !== undefined ? { deadline: human.deadline } : {}),
      ...(human.confirmToken !== undefined ? { confirmToken: human.confirmToken } : {}),
    }));
}

/**
 * The runs list is the one read that has to stay cheap with hundreds of runs, so it takes
 * the store's `state.json`-backed summaries as they come. A summary with no workflow name
 * is one the engine wrote from an incomplete projection (the frictions note again); that
 * run is re-derived from its journal and the projection is rewritten, so the repair costs
 * one fold once rather than one fold per poll.
 */
async function repaired(weft: Weft, summary: RunSummary): Promise<RunSummary> {
  if (summary.workflow !== "") return summary;
  const state = await refreshProjections(weft, summary.runId);
  if (!state) return summary;
  return {
    ...summary,
    workflow: state.workflow,
    status: state.status,
    createdAt: state.createdAt || summary.createdAt,
  };
}

/**
 * Re-derive `state.json` / `tree.json` / `report.md` from the journal. Nothing else does
 * it for a run no process is driving, and the runs list reads the projection — so without
 * this an answered run would keep listing as "waiting_for_human" until someone resumed it.
 * Projections are derived data, safe to rewrite at any time (C9), which is also why a
 * failure here never fails the request that triggered it.
 */
async function refreshProjections(weft: Weft, runId: string): Promise<RunState | undefined> {
  try {
    const state = await stateOf(weft, runId);
    await weft.engine.journal.snapshot(runId, {
      state,
      tree: renderTree(state),
      report: renderReport(state),
    });
    return state;
  } catch {
    // The mutation already landed in the journal; the projection catches up on the next write.
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Waking suspended runs
// ---------------------------------------------------------------------------

/**
 * An answer (or a signal) for a run nothing is holding is durable but undelivered: the
 * event is in the journal and the step that wanted it is not running anywhere. Resuming
 * replays the journal and serves it, which is what makes "answer it hours later, from a
 * browser" work at all.
 *
 * Fire-and-forget on purpose — the POST already succeeded, and a resume that cannot find
 * a definition is a repo problem, not a bad request.
 */
function wakeIfSuspended(weft: Weft, runId: string): boolean {
  if (weft.engine.isActive(runId)) return false;
  void (async () => {
    // The answered run may be a CHILD (requests are answered at their owning
    // run): resuming it alone completes its journal while the inactive
    // parent's workflow step never re-executes to consume the result — the
    // selected root would stay nonterminal forever. Walk to the ROOT of the
    // recorded tree and wake that; its resume re-enters the children.
    let rootId = runId;
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
    if (weft.engine.isActive(rootId)) return;
    const persisted = await persistedDefOf(weft, rootId);
    const handle = await weft.engine.resume(rootId, resumeOptions(persisted));
    await handle.outcome();
  })().catch((err: unknown) => {
    console.error(`weft daemon: waking run ${runId} failed: ${messageOf(err)}`);
  });
  return true;
}

// ---------------------------------------------------------------------------
// SSE
// ---------------------------------------------------------------------------

/**
 * One `data:` line per journal record, in order, starting from what is already on disk.
 * The stream is never closed from this side: a terminal run can still gain records (a
 * resume appends to the same journal), so ending it on `run.completed` would cut off a
 * client that is still watching. It ends when the client goes away.
 */
function streamJournal(
  weft: Weft,
  runId: string,
  opts: { fromIndex?: number; signal?: AbortSignal },
): Response {
  const abort = new AbortController();
  const encoder = new TextEncoder();
  if (opts.signal) {
    if (opts.signal.aborted) abort.abort();
    else opts.signal.addEventListener("abort", () => abort.abort(), { once: true });
  }

  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      let heartbeat: NodeJS.Timeout | undefined;

      const close = (): void => {
        if (closed) return;
        closed = true;
        if (heartbeat) clearInterval(heartbeat);
        abort.abort();
        try {
          controller.close();
        } catch {
          // The client already tore the stream down; nothing left to close.
        }
      };
      const send = (chunk: string): void => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(chunk));
        } catch {
          close();
        }
      };

      heartbeat = setInterval(() => send(": heartbeat\n\n"), HEARTBEAT_MS);
      heartbeat.unref?.();
      abort.signal.addEventListener("abort", close, { once: true });

      // Descendant journals feed the SAME stream as unnumbered `child` events: a
      // question raised inside a sub-workflow must nudge the UI even though the
      // selected run's own journal stays quiet. No `id:` on them — Last-Event-ID
      // keeps meaning "index in the SELECTED run's journal".
      const watched = new Set<string>([runId]);
      const spawnChild = (childId: string): void => {
        if (watched.has(childId)) return;
        watched.add(childId);
        void (async () => {
          try {
            for await (const record of weft.engine.watch(childId, { signal: abort.signal })) {
              if (closed) break;
              send(`event: child\ndata: ${JSON.stringify(record)}\n\n`);
              if (record.ev.type === "step.scheduled" && record.ev.childRunId !== undefined) {
                spawnChild(record.ev.childRunId);
              }
            }
          } catch {
            // a vanished child journal only stops ITS feed
          }
        })();
      };
      // A reconnect resumes PAST the step.scheduled records that name the
      // children, so seed the watches from the current projection too.
      void stateOf(weft, runId)
        .then((state) => {
          for (const child of state.children) spawnChild(child.childRunId);
        })
        .catch(() => undefined);

      void (async () => {
        try {
          for await (const record of weft.engine.watch(runId, {
            signal: abort.signal,
            ...(opts.fromIndex !== undefined ? { fromIndex: opts.fromIndex } : {}),
          })) {
            if (closed) break;
            send(sseRecord(record));
            if (record.ev.type === "step.scheduled" && record.ev.childRunId !== undefined) {
              spawnChild(record.ev.childRunId);
            }
          }
        } catch (err) {
          send(`event: error\ndata: ${JSON.stringify({ error: messageOf(err) })}\n\n`);
        } finally {
          close();
        }
      })();
    },
    cancel() {
      abort.abort();
    },
  });

  return new Response(body, { headers: { ...SSE_HEADERS } });
}

/** `id:` carries the journal index, so a reconnect could resume with `?from=`. */
function sseRecord(record: JournalRecord): string {
  return `id: ${record.i}\ndata: ${JSON.stringify(record)}\n\n`;
}

// ---------------------------------------------------------------------------
// Small shared plumbing
// ---------------------------------------------------------------------------

function listFilter(c: Context): RunListFilter {
  const status = c.req.query("status");
  const workflow = c.req.query("workflow");
  const limit = Number.parseInt(c.req.query("limit") ?? "", 10);
  return {
    ...(status ? { status: status as RunStatus } : {}),
    ...(workflow ? { workflow } : {}),
    ...(Number.isFinite(limit) && limit > 0 ? { limit } : {}),
  };
}

async function jsonBody(c: Context): Promise<Record<string, unknown>> {
  let parsed: unknown;
  try {
    parsed = await c.req.json();
  } catch {
    throw new Error("expected a JSON object body");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("expected a JSON object body");
  }
  return parsed as Record<string, unknown>;
}

/**
 * A run id nobody has journaled is the only 404 this surface has. Everything else a
 * caller can cause — a malformed body, an answer the schema rejects, a resume with no
 * definition on disk — is a 400 carrying the engine's own message, which is the part
 * worth reading.
 */
function fail(c: Context, err: unknown): Response {
  const message = messageOf(err);
  return c.json({ error: message }, /\bnot found\b/i.test(message) ? 404 : 400);
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
