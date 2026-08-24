/**
 * `weft report <run>` — the generated markdown report: outcome, changes, checks, ledger,
 * failures, remaining risk. A projection of the journal, re-derived on every call.
 */
import { Command } from "commander";
import { openWeft } from "../context.ts";
import { type CliIo, say } from "../io.ts";

export function reportCommand(io: CliIo): Command {
  return new Command("report")
    .description("print a run's markdown report")
    .argument("<run>", "run id")
    .action(async (runId: string, _opts: unknown, cmd: Command) => {
      const weft = await openWeft(cmd);
      try {
        say(io, ...(await weft.engine.report(runId)).split("\n"));
      } finally {
        await weft.close();
      }
    });
}
