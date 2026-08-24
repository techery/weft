/**
 * `weft ls` — the run list, straight off the journal store. No index required: the
 * sqlite index is derived and deletable, so the listing everyone always needs must not
 * depend on it.
 */
import type { RunListFilter, RunStatus, RunSummary, Weft } from "@techery/weft-host";
import { Command } from "commander";
import pc from "picocolors";
import { openWeft } from "../context.ts";
import { shortAge, table } from "../format.ts";
import { type CliIo, paintStatus, say } from "../io.ts";

interface LsOptions {
  status?: string;
  workflow?: string;
  limit?: string;
}

export function lsCommand(io: CliIo): Command {
  return new Command("ls")
    .description("list runs, newest first")
    .option("--status <status>", "only runs in this status")
    .option("--workflow <name>", "only runs of this workflow")
    .option("--limit <n>", "at most n runs", "20")
    .action(async (opts: LsOptions, cmd: Command) => {
      const weft = await openWeft(cmd);
      try {
        const limit = Number(opts.limit ?? "20");
        if (!Number.isInteger(limit) || limit <= 0)
          throw new Error(`invalid --limit ${JSON.stringify(opts.limit)}`);
        const filter: RunListFilter = {
          limit,
          ...(opts.status !== undefined ? { status: opts.status as RunStatus } : {}),
          ...(opts.workflow !== undefined ? { workflow: opts.workflow } : {}),
        };
        const runs = await weft.engine.list(filter);
        if (runs.length === 0) {
          io.out(pc.dim("no runs yet — start one with: weft run <workflow>"));
          return;
        }
        const now = Date.now();
        const rows: string[][] = [];
        for (const run of runs) {
          rows.push([
            run.runId,
            await workflowNameOf(weft, run),
            paintStatus(run.status),
            shortAge(now - run.updatedAt),
            run.parentRunId ? pc.dim(`child of ${run.parentRunId}`) : "",
          ]);
        }
        say(io, ...table(["RUN", "WORKFLOW", "STATUS", "AGE", ""], rows));
      } finally {
        await weft.close();
      }
    });
}

/**
 * The store answers from the `state.json` projection, which a first-time run currently
 * snapshots without its `run.created` fields — so the name can come back empty. The
 * journal always has it: re-derive for the rows that need it rather than showing a blank
 * column. (Engine bug, not a listing feature; see the frictions note.)
 */
async function workflowNameOf(weft: Weft, run: RunSummary): Promise<string> {
  if (run.workflow !== "") return run.workflow;
  const state = await weft.engine.state(run.runId).catch(() => undefined);
  return state?.workflow ?? pc.dim("(unknown)");
}
