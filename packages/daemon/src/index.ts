/**
 * @weft/daemon — the local host. An HTTP API over `weft.engine`, the journal as SSE, and
 * one self-contained page that is the rich surface for every local run whichever host
 * started it (C10). It also wakes suspended runs: an answer or a signal that arrives for
 * a run no process is holding is resumed here so the waiting step actually receives it.
 *
 * ```ts
 * const daemon = await startDaemon({ cwd: process.cwd() });
 * console.log(daemon.url); // http://127.0.0.1:4781
 * ```
 *
 * Routes: `GET /` (the page), `GET /api/runs`, `GET /api/runs/:id`, `.../report`,
 * `.../tree`, `.../pending`, `.../events` (SSE), and `POST .../answer`, `.../signal`,
 * `.../cancel`, `.../resume`.
 */
export { createApp } from "./app.ts";
export type { DaemonHandle, StartDaemonOptions } from "./server.ts";
export { DEFAULT_PORT, startDaemon } from "./server.ts";
export { INDEX_HTML } from "./ui.ts";
