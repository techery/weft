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
 *
 * `/` serves the built workflow manager when one is bundled beside this package, and the
 * built-in page otherwise; the built-in page keeps a fixed address at `/legacy` either
 * way. Client-side routes fall through to the manager's document, so a deep link like
 * `/runs/r-045` survives a page load.
 */
import type { JournalRecord, RunListFilter, RunStatus, Weft } from "@techery/weft-host";
import { persistedDefOf, renderReport, renderTree, resumeOptions } from "@techery/weft-host";
import type { Context } from "hono";
import { Hono } from "hono";
import { registerArtifactRoutes } from "./api/artifacts.ts";
import { registerBlobRoutes } from "./api/blobs.ts";
import { registerConfigRoutes } from "./api/config.ts";
import { registerMetaRoutes } from "./api/meta.ts";
import { registerPendingRoutes } from "./api/pending.ts";
import { registerStartRoutes } from "./api/starts.ts";
import { registerWorkflowRoutes } from "./api/workflows.ts";
import { detailOf } from "./detail.ts";
import { fail, jsonBody, messageOf, page } from "./http.ts";
import { pendingAcross, refreshProjections, repaired, stateOf } from "./state.ts";
import { INDEX_HTML } from "./ui.ts";
import { BUNDLED_WEB_ROOT, openWebBundle, type WebBundle } from "./web.ts";

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

export interface CreateAppOptions {
  /**
   * The built workflow manager to serve at `/`. Defaults to the bundle shipped beside
   * this package; pass `null` to serve the built-in page there instead, or a bundle
   * opened from somewhere else.
   */
  web?: WebBundle | null;
}

/**
 * Build the app over an assembled {@link Weft}. Kept separate from `startDaemon()` so
 * tests (and anything embedding the daemon) can drive every route through `app.request()`
 * with no socket in the way.
 */
export function createApp(weft: Weft, opts: CreateAppOptions = {}): Hono {
  const app = new Hono();
  const engine = weft.engine;
  const web = opts.web === undefined ? openWebBundle(BUNDLED_WEB_ROOT) : (opts.web ?? undefined);

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

  app.get("/", (c) => page(c, web ? web.index : INDEX_HTML));

  // The built-in page reads the live journal, so it stays reachable at one fixed address
  // whether or not the manager is the thing on `/`.
  app.get("/legacy", (c) => page(c, INDEX_HTML));

  app.get("/api/runs", async (c) => {
    try {
      const summaries = await engine.list(listFilter(c));
      const rows = await Promise.all(summaries.map((summary) => repaired(weft, summary)));
      // `?spend=1` folds each run's journal for its token and dollar totals. Off by
      // default because the plain list has to stay one read per run however many there
      // are; on when a caller is rendering a cost column and would otherwise do the
      // same folds one request at a time.
      if (c.req.query("spend") !== "1") return c.json(rows);
      return c.json(
        await Promise.all(
          rows.map(async (row) => {
            const state = await stateOf(weft, row.runId).catch(() => undefined);
            return {
              ...row,
              spend: state ? state.budget : { tokens: 0, usd: 0 },
              steps: state ? state.steps.length : 0,
              running: state ? state.steps.filter((step) => step.status === "running").length : 0,
            };
          }),
        ),
      );
    } catch (err) {
      return fail(c, err);
    }
  });

  app.get("/api/runs/:id", async (c) => {
    try {
      // `?detail=1` folds the same records for the two things the projection drops: the
      // ceiling the run was started with, and what each step was scheduled with.
      if (c.req.query("detail") === "1") {
        const { state, budget, inputs } = await detailOf(weft, c.req.param("id"));
        return c.json({ ...state, budget: state.budget, limits: budget, inputs });
      }
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

  // Everything above is run-scoped and predates the workflow manager. These are the
  // surfaces the manager needs and the API did not have: the registry, starting a run,
  // the bytes behind a ref, the config file, and one cross-run view of what is waiting.
  registerMetaRoutes(app, weft);
  registerPendingRoutes(app, weft);
  registerWorkflowRoutes(app, weft);
  registerStartRoutes(app, weft);
  registerBlobRoutes(app, weft);
  registerArtifactRoutes(app, weft);
  registerConfigRoutes(app, weft);

  /*
   * Last, so every route above wins first: the manager's own assets, then its
   * client-side routes. An unmatched `/api/` path is a missing endpoint, not a page —
   * answering it with HTML would turn a typo into a parse error somewhere else.
   */
  app.get("*", async (c) => {
    const path = c.req.path;
    if (path.startsWith("/api/") || web === undefined) {
      return c.json({ error: `no route for GET ${path}` }, 404);
    }
    const asset = await web.read(path);
    if (asset !== undefined) {
      return c.body(asset.body, 200, {
        "content-type": asset.contentType,
        "cache-control": asset.immutable ? "public, max-age=31536000, immutable" : "no-cache",
      });
    }
    return page(c, web.index);
  });

  return app;
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
