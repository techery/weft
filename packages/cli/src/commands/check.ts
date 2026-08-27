/**
 * `weft check [name]` — the gate, ahead of a run. Every `.ts` file in the workflow
 * directory is bundled and instantiated exactly the way a run would do it, so a banned
 * global hiding in `./schemas.ts` fails here rather than three agent steps in.
 *
 * Findings print as `file:line:col  rule  message` with the fix-it underneath, and any
 * finding at all fails the command. The `tsc --noEmit` pass that catches a missing
 * `schema:` runs after, best effort: a repo without TypeScript installed still gets a gate.
 */
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { promisify } from "node:util";
import { toWireSchema } from "@techery/weft-core";
import { type GateDiagnostic, GateError, loadWorkflow } from "@techery/weft-host";
import { Command } from "commander";
import pc from "picocolors";
import { allowBareOf, openWeft, workflowDirs } from "../context.ts";
import { type CliIo, say } from "../io.ts";

const run = promisify(execFile);

interface CheckOptions {
  /** `--no-tsc` turns off the type-check pass. */
  tsc?: boolean;
}

export function checkCommand(io: CliIo): Command {
  return new Command("check")
    .description("gate (and type-check) the workflows in this repo")
    .argument("[name]", "check one workflow instead of all of them")
    .option("--no-tsc", "skip the best-effort tsc --noEmit pass")
    .action(async (name: string | undefined, opts: CheckOptions, cmd: Command) => {
      const weft = await openWeft(cmd);
      try {
        const dirs = workflowDirs(weft);
        const files = await filesToCheck(weft.registry, dirs, name);
        if (files.length === 0) {
          io.out(pc.dim(`nothing to check in ${dirs.join(", ")} — scaffold one with: weft new <name>`));
          return;
        }

        const findings: GateDiagnostic[] = [];
        for (const file of files) {
          const relative = path.relative(weft.cwd, file);
          const outcome = await gate(file, allowBareOf(weft));
          if (outcome === "helper") {
            io.out(`${pc.dim("-")} ${pc.dim(`${relative} (module, not a workflow)`)}`);
          } else if (outcome.diagnostics.length === 0) {
            io.out(`${pc.green("✓")} ${relative}`);
            for (const warning of outcome.warnings) {
              io.out(`  ${pc.yellow("schema")} ${warning}`);
            }
          } else {
            io.out(`${pc.red("✗")} ${relative}`);
            findings.push(...outcome.diagnostics);
          }
        }

        if (findings.length > 0) {
          say(io, "", ...findings.flatMap((d) => renderDiagnostic(d)));
          io.out(pc.red(`${findings.length} violation${findings.length === 1 ? "" : "s"}`));
          process.exitCode = 1;
          return;
        }
        if (opts.tsc !== false) {
          const result = await typecheck(files, weft.cwd);
          say(io, ...result.lines);
          if (result.failed) process.exitCode = 1;
        }
      } finally {
        await weft.close();
      }
    });
}

/** Gate one file. `"helper"` = it bundles cleanly but exports no workflow (a `./lib` module). */
async function gate(
  file: string,
  allowBare: { allowBare?: string[] },
): Promise<{ diagnostics: GateDiagnostic[]; warnings: string[] } | "helper"> {
  try {
    const { def } = await loadWorkflow({ entry: file, ...allowBare });
    const schemas = [
      ["input", def.meta.input],
      ["output", def.meta.output],
      ...(def.meta.tasks?.extensions ? ([["tasks.extensions", def.meta.tasks.extensions]] as const) : []),
    ] as const;
    return {
      diagnostics: [],
      warnings: schemas.flatMap(([label, schema]) =>
        toWireSchema(schema).lints.map((warning) => `${label}: ${warning}`),
      ),
    };
  } catch (err) {
    if (!(err instanceof GateError)) throw err;
    if (err.diagnostics.length === 0) {
      return {
        diagnostics: [{ rule: "gate", message: err.message, file, line: 0, column: 0 }],
        warnings: [],
      };
    }
    if (err.diagnostics.every((d) => d.rule === "no-workflow-export")) return "helper";
    return { diagnostics: err.diagnostics, warnings: [] };
  }
}

function renderDiagnostic(d: GateDiagnostic): string[] {
  const where = pc.dim(`${d.file}:${d.line}:${d.column}`);
  const lines = [`  ${where}  ${pc.yellow(d.rule)}  ${d.message}`];
  if (d.fixIt) lines.push(`    ${pc.cyan("fix:")} ${d.fixIt}`);
  return lines;
}

// ---------------------------------------------------------------------------
// File selection
// ---------------------------------------------------------------------------

interface NamedRegistry {
  list(): Promise<Array<{ name: string; file: string }>>;
}

async function filesToCheck(
  registry: NamedRegistry,
  dirs: readonly string[],
  name?: string,
): Promise<string[]> {
  if (name === undefined) {
    const files: string[] = [];
    for (const dir of dirs) {
      let entries: string[];
      try {
        entries = await readdir(dir);
      } catch (err) {
        // Only genuine ABSENCE means "nothing to check". Any other failure —
        // EACCES, EIO, a stray FILE at the directory's path — would silently
        // skip every workflow and let CI pass having validated nothing.
        if ((err as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw new Error(`cannot read ${dir}: ${(err as Error).message}`);
      }
      files.push(
        ...entries
          .filter((entry) => entry.endsWith(".ts") && !entry.endsWith(".d.ts"))
          .sort()
          .map((entry) => path.join(dir, entry)),
      );
    }
    return [...new Set(files)];
  }

  // A workflow may rename itself, so the filename is only the first guess; the registry
  // knows the rest — but it can only list the files that already load.
  const hit = (await registry.list().catch(() => [])).find((entry) => entry.name === name);
  if (hit) return [hit.file];
  const direct = dirs.map((dir) => path.join(dir, `${name}.ts`));
  const directHits = (
    await Promise.all(direct.map(async (file) => ((await isFile(file)) ? file : undefined)))
  ).filter((file): file is string => file !== undefined);
  if (directHits.length > 0) return directHits;
  throw new Error(
    `unknown workflow "${name}" — no ${direct.map((file) => path.relative(process.cwd(), file)).join(", ")} and nothing named it`,
  );
}

async function isFile(file: string): Promise<boolean> {
  try {
    return (await stat(file)).isFile();
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// tsc — best effort when unavailable, authoritative when it runs
// ---------------------------------------------------------------------------

/**
 * A missing `schema:` is a type error, not a rule violation, so the type-checker is part of
 * `weft check`. It is advisory here: workflow files are standalone, this synthesises flags
 * for them rather than adopting the repo's tsconfig. An unavailable compiler or SDK is a
 * visible skip; actual diagnostics fail the command, just like gate diagnostics do.
 */
async function typecheck(
  files: readonly string[],
  cwd: string,
): Promise<{ lines: string[]; failed: boolean }> {
  const tsc = resolveTsc();
  if (!tsc) {
    return {
      lines: [pc.dim("tsc: typescript is not installed here — skipping the type-check pass")],
      failed: false,
    };
  }
  const args = [
    tsc,
    "--noEmit",
    "--strict",
    "--target",
    "es2023",
    "--module",
    "nodenext",
    "--moduleResolution",
    "nodenext",
    "--jsx",
    "react-jsx",
    "--allowImportingTsExtensions",
    "--skipLibCheck",
    ...files,
  ];
  try {
    await run(process.execPath, args, { cwd });
    return { lines: [pc.dim("tsc: no type errors")], failed: false };
  } catch (err) {
    const output = `${(err as { stdout?: string }).stdout ?? ""}${(err as { stderr?: string }).stderr ?? ""}`;
    const lines = output.split("\n").filter((line) => line.trim() !== "");
    // Without `@techery/weft-sdk` on disk every `ctx` parameter is implicitly `any`, so the whole
    // report is one missing install echoed a hundred times. Say that instead.
    const sdkMissing = lines.some((line) => line.includes("TS2307") && line.includes("@techery/weft-sdk"));
    const actionable = lines.filter(
      (line) =>
        !(line.includes("TS2307") && line.includes("@techery/weft-sdk")) &&
        !(sdkMissing && line.includes("TS7006") && line.includes("implicitly has an 'any' type")),
    );
    if (sdkMissing && actionable.length === 0) {
      return {
        lines: [pc.dim("tsc: @techery/weft-sdk is not installed here — skipping the type-check pass")],
        failed: false,
      };
    }
    return {
      lines: [pc.red("tsc:"), ...lines.map((line) => pc.dim(`  ${line}`))],
      failed: true,
    };
  }
}

function resolveTsc(): string | undefined {
  try {
    const pkg = createRequire(import.meta.url).resolve("typescript/package.json");
    const bin = path.join(path.dirname(pkg), "bin", "tsc");
    return existsSync(bin) ? bin : undefined;
  } catch {
    return undefined;
  }
}
