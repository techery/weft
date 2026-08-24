/**
 * `weft resume <run>` — replay the journal and continue. The definition comes from the
 * registry by the name the run journaled, so a resume works in a process that never saw
 * the file, and after the file changed: `content` (default) re-runs a step whose prompt or
 * options moved, `key` keeps it by identity for fast iteration.
 */
import { persistedDefOf } from "@weft/host";
import { Command } from "commander";
import pc from "picocolors";
import { openWeft, parseReuse } from "../context.ts";
import type { CliIo } from "../io.ts";
import { reportOutcome, watchRun } from "../outcome.ts";

interface ResumeOptions {
  reuse?: string;
  watch?: boolean;
}

export function resumeCommand(io: CliIo): Command {
  return new Command("resume")
    .description("replay a run's journal and continue it")
    .argument("<run>", "run id")
    .option("--reuse <mode>", "content (default) reuses unchanged steps; key reuses by identity")
    .option("--watch", "render a live tree until the run settles or suspends")
    .action(async (runId: string, opts: ResumeOptions, cmd: Command) => {
      const weft = await openWeft(cmd);
      try {
        const reuse = parseReuse(opts.reuse);
        const before = await weft.engine.state(runId);
        // A path or inline run persisted its provenance (a re-resolvable ref, or the
        // bundled script); registry runs fall through to the name the run journaled.
        const persisted = await persistedDefOf(weft, runId);
        const handle = await weft.engine.resume(runId, {
          ...(persisted !== undefined ? { def: persisted } : {}),
          ...(reuse !== undefined ? { reuse } : {}),
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
