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
} from "@techery/weft-host";
import { validateSchema } from "@techery/weft-sdk";
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
        await rejectUnknownInput(input, def, name);
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

/**
 * Refuse an input field the workflow's schema silently drops.
 *
 * Dynamic flags accept any `--name value`, and a Zod object strips what it does not know,
 * so `weft run review --basse release-2.0` used to review `main` and say nothing. Every
 * flag a person types is a decision about what this run costs; a typo has to be a
 * refusal, not a default.
 *
 * The test is what the schema DID, not what its shape lists. An open schema —
 * `.passthrough()`, `.loose()`, `.catchall(…)` — has a `shape` too, and reading that
 * would reject the very fields such a workflow exists to receive. Validating and asking
 * what the schema did with each key answers the real question for any Standard Schema,
 * without reaching into one vendor's internals.
 *
 * "Absent from the output" is not yet "dropped", which is why each candidate is put back
 * to the schema twice. A transform consumes the names it reads —
 * `.transform(({ base }) => ({ baseRef: base }))` documents `--base` and returns a
 * different key — so a key-list comparison alone would refuse the workflow's own flag.
 * The question is whether the schema READ the key, and two probes answer it:
 *
 *   - remove it, and
 *   - replace its value with one no declared field would accept.
 *
 * A probe that fails validation, or lands on a different value, is the schema saying it
 * read that key. Only a key that changes nothing under BOTH is treated as unknown.
 * Neither probe suffices alone: removing `--base main` from a field that defaults to
 * `"main"` reproduces the same output and would condemn a perfectly good flag, while a
 * field the transform reads only for its presence survives the substitution and not the
 * removal.
 */
export async function rejectUnknownInput(
  input: Record<string, unknown>,
  def: WorkflowDefinition,
  name: string,
): Promise<void> {
  const keys = Object.keys(input);
  if (keys.length === 0) return;
  const checked = await validateSchema(def.meta.input, input);
  // A schema that REJECTS the input says so in its own words, and the engine surfaces
  // that in a moment. Nothing to add here.
  if (!checked.ok) return;
  const out = checked.value;
  // A transform can return anything; only a plain object compares key-for-key.
  if (typeof out !== "object" || out === null || Array.isArray(out)) return;
  const kept = out as Record<string, unknown>;
  const dropped: string[] = [];
  for (const key of keys) {
    // hasOwn, not `in`: `in` walks the prototype chain, so `--constructor` and
    // `--to-string` would read as kept on any ordinary object literal.
    if (Object.hasOwn(kept, key)) continue;
    const without = { ...input };
    delete without[key];
    const substituted = { ...input, [key]: PROBE };
    const probes = await Promise.all([
      validateSchema(def.meta.input, without),
      validateSchema(def.meta.input, substituted),
    ]);
    if (probes.every((probe) => probe.ok && sameValue(probe.value, out))) dropped.push(key);
  }
  if (dropped.length === 0) return;

  // The shape, where there is one, is used only for the hint.
  const shape = (def.meta.input as { shape?: Record<string, unknown> } | undefined)?.shape;
  const declared = shape && typeof shape === "object" ? Object.keys(shape).sort() : [];
  throw new Error(
    `${name} has no input field ${dropped.map((k) => `"${k}"`).join(", ")}` +
      (declared.length > 0
        ? ` — it takes ${declared.map((k) => `--${kebabCase(k)}`).join(", ")}`
        : " — it takes no input"),
  );
}

/**
 * A value no declared field plausibly accepts and no transform plausibly produces. Put in
 * a key's place, it makes the schema show whether it was reading that key: a typed field
 * rejects it, an open one carries it into the output, and only a key nothing looks at
 * leaves the result untouched.
 */
const PROBE = Object.freeze({ "weft:unknown-input-probe": true });

/**
 * Structural equality over validated output, deliberately CONSERVATIVE: anything it
 * cannot compare with confidence reads as different, and different means "the key
 * mattered". Both errors are possible here and they are not symmetric — missing a typo
 * costs a run that reviewed the wrong branch and said nothing; a false match costs a
 * refusal to run a workflow whose flag was always valid. Only the first is recoverable
 * by the person typing.
 */
function sameValue(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((item, i) => sameValue(item, b[i]));
  }
  // PLAIN objects only. A Date, a Map, a class instance — their identity lives in state
  // this walk cannot reach, and two of them are never assumed equal.
  if (!isPlainObject(a) || !isPlainObject(b)) return false;
  const ak = Object.keys(a);
  const bk = Object.keys(b);
  if (ak.length !== bk.length) return false;
  return ak.every(
    (k) =>
      Object.hasOwn(b, k) && sameValue((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]),
  );
}

function isPlainObject(value: object): boolean {
  const proto = Object.getPrototypeOf(value) as unknown;
  return proto === Object.prototype || proto === null;
}

/** Input schemas are written in TypeScript, so `baseRef` is offered as `--base-ref`. */
function kebabCase(name: string): string {
  return name.replace(/[A-Z]/g, (ch) => `-${ch.toLowerCase()}`);
}
