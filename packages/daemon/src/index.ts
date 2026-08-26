/**
 * @techery/weft-daemon — the local host. An HTTP API over `weft.engine`, the journal as SSE, and
 * one self-contained page that is the rich surface for every local run whichever host
 * started it (C10). It also wakes suspended runs: an answer or a signal that arrives for
 * a run no process is holding is resumed here so the waiting step actually receives it.
 *
 * ```ts
 * const daemon = await startDaemon({ cwd: process.cwd() });
 * console.log(daemon.url); // http://127.0.0.1:4781
 * ```
 *
 * Pages: `GET /` (the workflow manager, or the built-in page when none is built) and
 * `GET /legacy` (always the built-in page). Anything else that is not an `/api/` path is
 * served the manager's document, so its client-side routes survive a reload.
 *
 * Runs: `GET /api/runs` (`?spend=1` adds token/dollar totals), `GET /api/runs/:id`,
 * `.../report`, `.../tree`, `.../pending`, `.../artifacts`, `.../patch`, `.../events`
 * (SSE); `POST /api/runs` starts one, and `POST .../answer`, `.../signal`, `.../cancel`,
 * `.../resume` act on one.
 *
 * Everything else: `GET /api/meta`, `GET /api/pending` (across every run),
 * `GET /api/workflows`, `/api/workflows/issues`, `/api/workflows/:name`,
 * `/api/workflows/:name/stats`,
 * `GET /api/blobs/:ref`, and `GET`/`PUT /api/config`.
 */
export { type FileStat, parseDiffStats, registerArtifactRoutes } from "./api/artifacts.ts";
export { registerBlobRoutes } from "./api/blobs.ts";
export { registerConfigRoutes } from "./api/config.ts";
export { registerMetaRoutes } from "./api/meta.ts";
export { type PendingEntry, registerPendingRoutes } from "./api/pending.ts";
export { registerPresentationRoutes } from "./api/presentations.ts";
export { registerStartRoutes } from "./api/starts.ts";
export { registerWorkflowRoutes } from "./api/workflows.ts";
export { type CreateAppOptions, createApp } from "./app.ts";
export { detailOf, type RunDetail } from "./detail.ts";
export { fail, jsonBody, messageOf, page } from "./http.ts";
export type { DaemonHandle, StartDaemonOptions } from "./server.ts";
export { DEFAULT_PORT, startDaemon } from "./server.ts";
export { pendingAcross, pendingOf, refreshProjections, repaired, stateOf } from "./state.ts";
export { INDEX_HTML } from "./ui.ts";
export { BUNDLED_WEB_ROOT, openWebBundle, type WebAsset, type WebBundle } from "./web.ts";
