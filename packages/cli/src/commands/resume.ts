/**
 * `weft resume <run>` — replay the journal and continue. The definition comes from the
 * registry by the name the run journaled, so a resume works in a process that never saw
 * the file, and after the file changed: `content` (default) re-runs a step whose prompt or
 * options moved, `key` keeps it by identity for fast iteration.
 */
import { persistedDefOf, resumeOptions, retainedDefOf } from "@techery/weft-host";
import { Command } from "commander";
import pc from "picocolors";
import { openWeft, parseReuse } from "../context.ts";
import type { CliIo } from "../io.ts";
import { reportOutcome, watchRun } from "../outcome.ts";

interface ResumeOptions {
  reuse?: string;
  watch?: boolean;
  mode?: string;
}

export function resumeCommand(io: CliIo): Command {
  return new Command("resume")
    .description("replay a run's journal and continue it")
    .argument("<run>", "run id")
    .option("--reuse <mode>", "content (default) reuses unchanged steps; key reuses by identity")
    .option(
      "--mode <mode>",
      "strict checks current source; retained loads saved source; edit-tolerant (default) permits changes",
    )
    .option("--watch", "render a live tree until the run settles or suspends")
    .action(async (runId: string, opts: ResumeOptions, cmd: Command) => {
      const weft = await openWeft(cmd);
      try {
        if (
          opts.mode !== undefined &&
          opts.mode !== "strict" &&
          opts.mode !== "retained" &&
          opts.mode !== "edit-tolerant"
        )
          throw new Error("--mode must be strict, retained, or edit-tolerant");
        const reuse = parseReuse(opts.reuse);
        const before = await weft.engine.state(runId);
        // A path or inline run persisted its provenance (a re-resolvable ref, or the
        // bundled script); registry runs fall through to the name the run journaled.
        const persisted =
          opts.mode === "retained" ? await retainedDefOf(weft, runId) : await persistedDefOf(weft, runId);
        if (opts.mode === "retained" && !persisted)
          throw new Error(
            `run ${runId}: no retained executable source; inspect current source and choose strict or edit-tolerant explicitly`,
          );
        const handle = await weft.engine.resume(runId, {
          ...resumeOptions(persisted),
          ...(reuse !== undefined ? { reuse } : {}),
          ...(opts.mode
            ? { mode: opts.mode === "retained" ? "strict" : (opts.mode as "strict" | "edit-tolerant") }
            : {}),
        });
        io.out(`${pc.dim("resuming")} ${pc.bold(before.workflow)} ${handle.runId}`);
        const outcome = opts.watch
          ? await watchRun(io, weft, handle, before.workflow)
          : await handle.outcome();
        await reportOutcome(io, weft, handle.runId, outcome);
      } finally {
        await weft.close();
      }
    });
}
