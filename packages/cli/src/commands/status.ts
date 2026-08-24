/**
 * `weft status <run>` — one run at a glance: header, cost, tree, and whatever it is
 * waiting on, with the command that unblocks it.
 */
import { renderTree } from "@techery/weft-host";
import { Command } from "commander";
import pc from "picocolors";
import { openWeft } from "../context.ts";
import { costLine, jsonBlock, pendingLines, treeLines } from "../format.ts";
import { type CliIo, paintStatus, say } from "../io.ts";

export function statusCommand(io: CliIo): Command {
  return new Command("status")
    .description("show one run: status, cost, tree, pending requests")
    .argument("<run>", "run id")
    .action(async (runId: string, _opts: unknown, cmd: Command) => {
      const weft = await openWeft(cmd);
      try {
        const state = await weft.engine.state(runId);
        say(
          io,
          `${pc.bold(state.workflow)}  ${pc.dim("run")} ${state.runId}  ${paintStatus(state.status)}`,
          costLine(state, Date.now()),
        );
        if (state.defHash) io.out(pc.dim(`script ${state.defHash.slice(0, 12)}  cwd ${state.cwd}`));
        say(io, ...treeLines(state, renderTree(state)));

        if (state.error) {
          say(io, `${pc.red("error")} ${state.error.code}: ${state.error.message}`);
        }
        if (state.output !== undefined) say(io, pc.bold("output"), jsonBlock(state.output));

        const pending = state.humans.filter((h) => h.status === "pending");
        if (pending.length > 0) {
          io.out(pc.bold(`pending (${pending.length})`));
          for (const request of pending) say(io, ...pendingLines(state.runId, request));
        }
      } finally {
        await weft.close();
      }
    });
}
