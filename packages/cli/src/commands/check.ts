/**
 * `weft check [name]` — the unified pre-run validation command. It enforces the fixed
 * Weft lint profile, validates package layout and executable contracts, bundles relative
 * imports, reports schema warnings, and runs a best-effort TypeScript typecheck.
 *
 * Findings print as `file:line:col  rule  message` with the fix-it underneath, and any
 * finding at all fails the command. The `tsc --noEmit` pass that catches a missing
 * `schema:` runs after, best effort: a repo without TypeScript installed still gets a gate.
 */
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { promisify } from "node:util";
import { toWireSchema } from "@techery/weft-core";
import { type GateDiagnostic, GateError, loadWorkflow } from "@techery/weft-host";
import { Command } from "commander";
import pc from "picocolors";
import { allowBareOf, openWeft, workflowDirs } from "../context.ts";
import { type CliIo, say } from "../io.ts";
import { runWeftLint } from "./lint.ts";

const run = promisify(execFile);

interface CheckOptions {
  /** `--no-tsc` turns off the type-check pass. */
  tsc?: boolean;
}

export function checkCommand(io: CliIo): Command {
  return new Command("check")
    .description("lint, gate, bundle, schema-check, and type-check workflows")
    .argument("[name]", "check one workflow instead of all of them")
    .option("--no-tsc", "skip the best-effort tsc --noEmit pass")
    .action(async (name: string | undefined, opts: CheckOptions, cmd: Command) => {
      const weft = await openWeft(cmd);
      try {
        const dirs = workflowDirs(weft);
        const selection = await filesToCheck(weft.registry, dirs, name);
        const { files } = selection;
        if (files.length === 0) {
          if (selection.issues.length === 0) {
            io.out(pc.dim(`nothing to check in ${dirs.join(", ")} — scaffold one with: weft new <name>`));
          }
          for (const issue of selection.issues) renderIssue(io, issue);
          const diagnostics = selection.issues.flatMap((issue) => issue.diagnostics);
          if (diagnostics.length > 0) say(io, ...diagnostics.flatMap((d) => renderDiagnostic(d)));
          let lintExit = 0;
          if (selection.lintTargets.length > 0) {
            io.out(pc.dim("lint: fixed Weft TypeScript profile"));
            lintExit = await runWeftLint(selection.lintTargets, weft.cwd);
          }
          if (selection.issues.length > 0 || lintExit !== 0) {
            const violations =
              diagnostics.length + selection.issues.filter((issue) => issue.diagnostics.length === 0).length;
            if (violations > 0) {
              io.out(pc.red(`${violations} violation${violations === 1 ? "" : "s"}`));
            }
            process.exitCode = 1;
          }
          return;
        }

        const findings: GateDiagnostic[] = selection.issues.flatMap((issue) => issue.diagnostics);
        for (const issue of selection.issues) renderIssue(io, issue);
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

        io.out(pc.dim("lint: fixed Weft TypeScript profile"));
        const lintExit = await runWeftLint(selection.lintTargets, weft.cwd);

        if (findings.length > 0 || selection.issues.length > 0 || lintExit !== 0) {
          if (findings.length > 0) say(io, "", ...findings.flatMap((d) => renderDiagnostic(d)));
          const violations =
            findings.length + selection.issues.filter((issue) => issue.diagnostics.length === 0).length;
          if (violations > 0) io.out(pc.red(`${violations} violation${violations === 1 ? "" : "s"}`));
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
      ...(def.meta.tasks?.extensions ? ([["tasks.extensions", def.meta.tasks.extensions]] as const) : []),
    ] as const;
    // Only provider-bound/input schemas need the portable wire subset. Workflow outputs
    // are validated locally against their authoritative Standard Schema.
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
  listWithIssues(): Promise<{
    entries: Array<{ name: string; file: string }>;
    issues: Array<{ file: string; error: string; diagnostics: GateDiagnostic[] }>;
  }>;
}

async function filesToCheck(
  registry: NamedRegistry,
  dirs: readonly string[],
  name?: string,
): Promise<{
  files: string[];
  lintTargets: string[];
  issues: Array<{ file: string; error: string; diagnostics: GateDiagnostic[] }>;
}> {
  const inspection = await registry.listWithIssues();
  if (name === undefined) {
    return {
      files: inspection.entries.map((entry) => entry.file),
      lintTargets: [...new Set(dirs.filter((dir) => existsSync(dir)))],
      issues: inspection.issues,
    };
  }

  const hit = inspection.entries.find((entry) => entry.name === name);
  if (hit) return { files: [hit.file], lintTargets: [path.dirname(hit.file)], issues: [] };
  const packageDirs = dirs.map((dir) => path.join(dir, name));
  const directIssues = inspection.issues.filter((issue) =>
    packageDirs.some(
      (packageDir) => issue.file === packageDir || issue.file.startsWith(`${packageDir}${path.sep}`),
    ),
  );
  if (directIssues.length > 0) {
    return {
      files: [],
      lintTargets: [
        ...new Set(
          directIssues.map((issue) =>
            path.basename(issue.file) === "main.ts" ? path.dirname(issue.file) : issue.file,
          ),
        ),
      ],
      issues: directIssues,
    };
  }
  throw new Error(
    `unknown workflow "${name}" — no ${packageDirs.map((dir) => path.relative(process.cwd(), dir)).join(", ")} and nothing named it`,
  );
}

function renderIssue(io: CliIo, issue: { file: string; error: string; diagnostics: GateDiagnostic[] }): void {
  io.out(`${pc.red("✗")} ${issue.file}`);
  if (issue.diagnostics.length === 0) {
    io.out(`  ${pc.yellow("layout")} ${issue.error}`);
  }
}

// ---------------------------------------------------------------------------
// tsc — best effort when unavailable, authoritative when it runs
// ---------------------------------------------------------------------------

/**
 * A missing `schema:` is a type error, not a rule violation, so the type-checker is part of
 * `weft check`. It is advisory here: workflow packages are standalone, this synthesises flags
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
