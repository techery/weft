/**
 * `weft replay --dry <run>` — re-execute the code against the journal without calling a
 * provider or appending an event. It answers the only question that matters before an
 * edit lands: how much of this run survives, and where does it start costing money again.
 */
import { Command } from "commander";
import pc from "picocolors";
import { openWeft, parseReuse } from "../context.ts";
import { type CliIo, say } from "../io.ts";

interface ReplayOptions {
  dry?: boolean;
  reuse?: string;
}

export function replayCommand(io: CliIo): Command {
  return new Command("replay")
    .description("preview a resume: what replays, what diverges — no providers, no writes")
    .argument("<run>", "run id")
    .option("--dry", "the only supported mode; a real replay is: weft resume")
    .option("--reuse <mode>", "content (default) or key")
    .action(async (runId: string, opts: ReplayOptions, cmd: Command) => {
      if (!opts.dry) throw new Error("weft replay needs --dry — to replay for real, use: weft resume <run>");
      const weft = await openWeft(cmd);
      try {
        const reuse = parseReuse(opts.reuse);
        const result = await weft.engine.replayDry(runId, { ...(reuse !== undefined ? { reuse } : {}) });
        say(
          io,
          `${pc.dim("replay --dry")} ${runId}`,
          `  ${pc.green("hits")}      ${result.hits}`,
          `  ${pc.cyan("salvaged")}  ${result.salvaged}`,
          `  ${result.diverged.length > 0 ? pc.yellow("diverged") : pc.dim("diverged")}  ${result.diverged.length}`,
          `  ${pc.dim("pending")}   ${result.pendingRequests.length}`,
        );
        for (const step of result.diverged) {
          const at = step.key ?? (step.seq !== undefined ? `seq ${step.seq}` : "?");
          io.out(`  ${pc.yellow("~")} ${at}${step.kind ? pc.dim(` (${step.kind})`) : ""}`);
        }
        for (const id of result.pendingRequests) io.out(`  ${pc.yellow("?")} still waiting on ${id}`);
        io.out(
          result.completed
            ? pc.dim("the run replays to completion — a resume would only re-run what diverged")
            : pc.dim(`a resume would continue from the first miss: weft resume ${runId}`),
        );
      } finally {
        await weft.close();
      }
    });
}
