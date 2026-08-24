/**
 * `weft ui` — hand this repo's engine to the local daemon and print the URL. The daemon is
 * loaded through a computed specifier so `@techery/weft` never links it at build or test time:
 * the rich surface is optional, and a checkout without it still has every other command.
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
      say(io, `${pc.bold("weft ui")}  ${pc.cyan(url)}`, pc.dim(`serving ${weft.runsDir} — Ctrl-C to stop`));
      // The server holds the event loop open; there is nothing to await here.
    });
}
