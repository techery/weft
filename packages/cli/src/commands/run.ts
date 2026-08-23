/**
 * `weft run <name|file|->` — the one command that starts a run. Input can arrive three
 * ways and they compose: `--args '{…}'` first, then the dynamic `--flag value` pairs over
 * it, so a saved JSON blob can be tweaked from the shell without re-typing it.
 */
import { loadWorkflow, parseBudget, resolveWorkflow, type Weft, type WorkflowDefinition } from "@weft/host";
import { Command } from "commander";
import pc from "picocolors";
import { allowBareOf, openWeft, parseReuse } from "../context.ts";
import { parseArgsJson, parseDynamicFlags, readStdin } from "../flags.ts";
import type { CliIo } from "../io.ts";
import { reportOutcome, watchRun } from "../outcome.ts";

interface RunOptions {
  args?: string;
  budget?: string;
  reuse?: string;
  watch?: boolean;
}

export function runCommand(io: CliIo): Command {
  return new Command("run")
    .description('start a run; input fields become flags ("-" reads a script from stdin)')
    .argument("<ref>", "registry name, path to a .ts file, or - for stdin")
    .option("--args <json>", "input as a JSON object; --flags merge over it")
    .option("--budget <spec>", 'ceiling for this run, e.g. "500k", "$5", "500k,$5"')
    .option("--reuse <mode>", "replay reuse on a re-run: content | key")
    .option("--watch", "render a live tree until the run settles or suspends")
    .allowUnknownOption()
    .allowExcessArguments()
    .action(async (ref: string, opts: RunOptions, cmd: Command) => {
      const weft = await openWeft(cmd);
      try {
        const input = { ...parseArgsJson(opts.args), ...parseDynamicFlags(cmd.args.slice(1)) };
        const { def, name, hash } = await resolveRef(weft, ref, io);
        const reuse = parseReuse(opts.reuse);
        const budget = opts.budget === undefined ? undefined : parseBudget(opts.budget);

        const handle = await weft.engine.start(def, {
          input,
          cwd: weft.cwd,
          ...(hash !== undefined ? { defHash: hash } : {}),
          ...(budget !== undefined ? { budget } : {}),
          ...(reuse !== undefined ? { reuse } : {}),
        });
        io.out(`${pc.bold(name)}  ${pc.dim("run")} ${handle.runId}`);

        const outcome = opts.watch ? await watchRun(io, weft, handle, name) : await handle.outcome();
        await reportOutcome(io, weft, handle.runId, outcome);
      } finally {
        await weft.close();
      }
    });
}

interface ResolvedRef {
  def: WorkflowDefinition;
  name: string;
  hash?: string;
}

/**
 * `-` reads the script from stdin and gates it like any file. An inline script has no file
 * to be found again by, so it is named before it starts: the journal pins that name, and
 * `weft resume` needs a workflow of that name in the registry to replay against.
 */
async function resolveRef(weft: Weft, ref: string, io: CliIo): Promise<ResolvedRef> {
  if (ref !== "-") return resolveWorkflow(weft, ref);
  const source = await readStdin();
  const loaded = await loadWorkflow({ source, cwd: weft.cwd, ...allowBareOf(weft) });
  io.out(pc.dim(`inline script gated and hashed as ${loaded.name} (${loaded.hash.slice(0, 12)})`));
  const def: WorkflowDefinition =
    loaded.def.meta.name === loaded.name
      ? loaded.def
      : { kind: loaded.def.kind, meta: { ...loaded.def.meta, name: loaded.name }, run: loaded.def.run };
  return { def, name: loaded.name, hash: loaded.hash };
}
