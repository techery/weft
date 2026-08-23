/**
 * `startDaemon()` — the app on a socket. One daemon per machine, bound to loopback and
 * nothing else: it can answer, cancel, and resume every run in the repo, so it is not a
 * thing to expose on an interface a network can reach.
 *
 * ```ts
 * const daemon = await startDaemon({ cwd: process.cwd() });
 * console.log(daemon.url); // http://127.0.0.1:4781
 * await daemon.close();
 * ```
 */
import type { AddressInfo } from "node:net";
import { type ServerType, serve } from "@hono/node-server";
import { createWeft, type Weft } from "@weft/host";
import { createApp } from "./app.ts";

/** The design's default port; `weft ui` prints whatever it actually got. */
export const DEFAULT_PORT = 4781;

/** Loopback only — see the note above. */
const HOSTNAME = "127.0.0.1";

export interface StartDaemonOptions {
  /** Repo root: what runs execute in, and where `.weft/` is read from. */
  cwd: string;
  /** Defaults to {@link DEFAULT_PORT}; `0` asks the OS for a free one. */
  port?: number;
  /** `"real"` (default) wires the Claude and Codex adapters; `"mock"` wires fixtures only. */
  providers?: "real" | "mock";
  /**
   * An engine that is already assembled — what `weft ui` hands over, so the CLI and the
   * daemon share one process's stores and one set of live runs. `cwd` and `providers` are
   * then unused, and `close()` leaves it open for its owner.
   */
  weft?: Weft;
}

export interface DaemonHandle {
  /** `http://127.0.0.1:<port>` — the real port, even when `port: 0` asked for any. */
  url: string;
  port: number;
  /** Stop listening (and drop open SSE streams). Idempotent. */
  close(): Promise<void>;
  /** The engine behind the routes — the same object the CLI and MCP server hold. */
  weft: Weft;
}

export async function startDaemon(opts: StartDaemonOptions): Promise<DaemonHandle> {
  const owned = opts.weft === undefined;
  const weft =
    opts.weft ??
    (await createWeft({
      cwd: opts.cwd,
      ...(opts.providers !== undefined ? { providers: opts.providers } : {}),
    }));

  const app = createApp(weft);
  let server: ServerType | undefined;
  let address: AddressInfo;
  try {
    address = await new Promise<AddressInfo>((resolve, reject) => {
      const listening = serve(
        { fetch: app.fetch, port: opts.port ?? DEFAULT_PORT, hostname: HOSTNAME },
        resolve,
      );
      server = listening;
      listening.on("error", reject);
    });
  } catch (err) {
    // A port already in use must not leave the caller's index handle open behind it.
    if (owned) await weft.close().catch(() => undefined);
    throw err;
  }

  const listening = server as ServerType;
  const port = address.port;
  let closed = false;

  return {
    url: `http://${HOSTNAME}:${port}`,
    port,
    weft,
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      await new Promise<void>((resolve, reject) => {
        listening.close((err) => (err ? reject(err) : resolve()));
        // An open event stream is a request that never ends; without this, close() waits
        // for a browser tab to be shut.
        if ("closeAllConnections" in listening) listening.closeAllConnections();
      });
      if (owned) await weft.close();
    },
  };
}
