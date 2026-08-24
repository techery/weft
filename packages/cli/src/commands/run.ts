/**
 * `weft run <name|file|->` — the one command that starts a run. Input can arrive three
 * ways and they compose: `--args '{…}'` first, then the dynamic `--flag value` pairs over
 * it, so a saved JSON blob can be tweaked from the shell without re-typing it.
 */
import { rm } from "node:fs/promises";
import { join } from "node:path";
import {
  isWorkflowPathRef,
  loadWorkflow,
  parseBudget,
  persistInlineScript,
  persistWorkflowRef,
  reserveRunId,
  resolveWorkflow,
  type Weft,
  type WorkflowDefinition,
} from "@weft/host";
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
        const { def, name, hash, code } = await resolveRef(weft, ref, io);
        const reuse = parseReuse(opts.reuse);
        const budget = opts.budget === undefined ? undefined : parseBudget(opts.budget);

        // Provenance rides with the run: inline scripts persist their bundled source,
        // and path refs record the path — a later `weft resume` re-resolves either.
        // Registry names need nothing; the journaled name finds them. Persisted
        // BEFORE the run launches: a crash after start() must never leave a
        // durable run no other process can find a definition for. The id is
        // reserved by an exclusive directory create, so a collision can never
        // write into an EXISTING run's directory.
        const runId = await reserveRunId(weft);
        if (code !== undefined) await persistInlineScript(weft, runId, code);
        else if (isWorkflowPathRef(ref)) await persistWorkflowRef(weft, runId, ref);
        const handle = await weft.engine
          .start(def, {
            runId,
            input,
            cwd: weft.cwd,
            ...(hash !== undefined ? { defHash: hash } : {}),
            ...(budget !== undefined ? { budget } : {}),
            ...(reuse !== undefined ? { reuse } : {}),
          })
          .catch(async (err: unknown) => {
            // Startup failed before any journal record: the reserved provenance is litter.
            if (!(await weft.engine.journal.exists(runId))) {
              await rm(join(weft.runsDir, runId), { recursive: true, force: true }).catch(() => undefined);
            }
            throw err;
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
  /** The bundled source, present only for inline (stdin) scripts — persisted with the run. */
  code?: string;
}

/**
 * `-` reads the script from stdin and gates it like any file. An inline script has no file
 * to be found again by, so it is named before it starts and its bundled source rides with
 * the run — `weft resume` reconstructs the definition from that script.
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
  return { def, name: loaded.name, hash: loaded.hash, code: loaded.code };
}
