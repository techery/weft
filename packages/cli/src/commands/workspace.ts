import { cleanupOwnedWorkspace } from "@techery/weft-core";
import { Command } from "commander";
import { openWeft } from "../context.ts";
import { type CliIo, say } from "../io.ts";

export function workspaceCommand(io: CliIo): Command {
  return new Command("workspace")
    .description("inspect a run-owned workspace; explicit cleanup preserves the branch and commits")
    .argument("<run>", "run id")
    .option(
      "--cleanup",
      "remove a clean terminal worktree only; refuses uncertain operations and ignored files",
    )
    .action(async (runId: string, options: { cleanup?: boolean }, cmd: Command) => {
      const weft = await openWeft(cmd);
      try {
        if (options.cleanup) {
          const removed = await cleanupOwnedWorkspace(weft.engine.journal, runId);
          say(
            io,
            `Removed owned worktree ${removed.path}. Branch ${removed.branch} and its commits are retained.`,
          );
        } else {
          const state = await weft.engine.state(runId);
          say(
            io,
            JSON.stringify(
              {
                runId,
                status: state.status,
                workspace: state.workspace ?? null,
                candidates: state.candidates ?? [],
                attention: state.attention ?? [],
              },
              null,
              2,
            ),
          );
        }
      } finally {
        await weft.close();
      }
    });
}
