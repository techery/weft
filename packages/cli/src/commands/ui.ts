/**
 * `weft ui` — hand this repo's engine to the local daemon and print the URL. The daemon is
 * loaded through a computed specifier so `@techery/weft` never links it at build or test time:
 * the rich surface is optional, and a checkout without it still has every other command.
 *
 * What lands on `/` is the workflow manager (`apps/ui`, built into the daemon's `web/`).
 * A checkout that has not built it gets the daemon's own built-in page instead, and this
 * command says so rather than leaving you wondering which one you are looking at.
 */
import type { Weft } from "@techery/weft-host";
import { Command } from "commander";
import pc from "picocolors";
import { openWeft } from "../context.ts";
import { type CliIo, say } from "../io.ts";

/** One daemon per machine; the design's default port. */
const DEFAULT_PORT = 4781;

interface DaemonModule {
  startDaemon?: (opts: { weft: Weft; port: number }) => Promise<DaemonHandle | undefined>;
}

interface DaemonHandle {
  url?: string;
  port?: number;
  /** `"manager"` when the built UI is being served on `/`, `"builtin"` when it is not. */
  surface?: "manager" | "builtin";
}

interface UiOptions {
  port?: string;
}

export function uiCommand(io: CliIo): Command {
  return new Command("ui")
    .description("serve the local web UI (runs, live tree, explain, answer)")
    .option("--port <n>", `port to listen on (default ${DEFAULT_PORT})`)
    .action(async (opts: UiOptions, cmd: Command) => {
      const port = opts.port === undefined ? DEFAULT_PORT : Number(opts.port);
      if (!Number.isInteger(port) || port <= 0 || port > 65_535) {
        throw new Error(`invalid --port ${JSON.stringify(opts.port)}`);
      }
      const weft = await openWeft(cmd);

      let daemon: DaemonModule;
      try {
        const specifier = "@techery/weft-daemon";
        daemon = (await import(specifier)) as DaemonModule;
      } catch (err) {
        await weft.close();
        throw new Error(
          `the web UI needs @techery/weft-daemon, which is not available here (${(err as Error).message}). ` +
            "Everything else — run, status, explain, answer — works without it.",
        );
      }
      if (typeof daemon.startDaemon !== "function") {
        await weft.close();
        throw new Error(
          "@techery/weft-daemon does not export startDaemon() — upgrade it, or use the CLI commands",
        );
      }

      const handle = (await daemon.startDaemon({ weft, port })) ?? {};
      const url = handle.url ?? `http://localhost:${handle.port ?? port}`;
      say(
        io,
        `${pc.bold("weft ui")}  ${pc.cyan(url)}`,
        pc.dim(`serving ${weft.runsDir} — Ctrl-C to stop`),
        handle.surface === "builtin"
          ? pc.dim(
              "the workflow manager is not built in this checkout — run `pnpm build` to serve it; " +
                "showing the built-in page",
            )
          : pc.dim(`live journal page: ${url}/legacy`),
      );
      // The server holds the event loop open; there is nothing to await here.
    });
}
