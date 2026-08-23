/**
 * `weft cancel <run>` — abort in-flight work. The journal is untouched apart from the
 * cancellation itself, so the run stays resumable.
 */
import { Command } from "commander";
import pc from "picocolors";
import { openWeft } from "../context.ts";
import { type CliIo, say } from "../io.ts";
import { refreshProjections } from "../runio.ts";

export function cancelCommand(io: CliIo): Command {
  return new Command("cancel")
    .description("cancel a run; it stays resumable")
    .argument("<run>", "run id")
    .action(async (runId: string, _opts: unknown, cmd: Command) => {
      const weft = await openWeft(cmd);
      try {
        await weft.engine.cancel(runId);
        await refreshProjections(weft, runId);
        say(io, `${pc.dim("cancelled")} ${runId}`, pc.dim(`resume it with: weft resume ${runId}`));
      } finally {
        await weft.close();
      }
    });
}
