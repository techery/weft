/**
 * `weft lint [name]` — enforce Weft's fixed workflow lint profile.
 *
 * The profile has two layers: bundled Biome recommended rules over every TypeScript file
 * in each workflow package, and the Weft gate over executable workflow code. The latter
 * owns replay-safety rules such as no ambient clock, randomness, timers, fetch, environment,
 * locale, GC, CommonJS, or undeclared bare imports. Project linter choice and configuration
 * deliberately do not change this command's result.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { GateDiagnostic, WorkflowInspection, WorkflowLoadIssue } from "@techery/weft-host";
import { Command } from "commander";
import pc from "picocolors";
import { openWeft, workflowDirs } from "../context.ts";
import { type CliIo, say } from "../io.ts";

interface LintOptions {
  fix?: boolean;
}

export function lintCommand(io: CliIo): Command {
  return new Command("lint")
    .description("enforce the fixed Weft lint profile on workflow packages")
    .argument("[name]", "lint one registered workflow instead of every workflow")
    .option("--fix", "apply safe fixes for the general TypeScript rules")
    .action(async (name: string | undefined, opts: LintOptions, cmd: Command) => {
      const weft = await openWeft(cmd);
      try {
        const dirs = workflowDirs(weft);
        const inspection = await weft.registry.listWithIssues();
        const selection = selectWorkflows(inspection, dirs, name);

        if (selection.targets.length === 0 && selection.issues.length === 0) {
          io.out(pc.dim(`nothing to lint in ${dirs.join(", ")} — scaffold one with: weft new <name>`));
          return;
        }

        for (const issue of selection.issues) renderIssue(io, weft.cwd, issue);
        const diagnostics = selection.issues.flatMap((issue) => issue.diagnostics);
        if (diagnostics.length > 0) say(io, "", ...diagnostics.flatMap(renderDiagnostic));

        io.out(
          `running Weft lint (${selection.targets.map((target) => displayPath(weft.cwd, target)).join(", ")})`,
        );
        const biomeExit = await runWeftLint(selection.targets, weft.cwd, opts);
        if (selection.issues.length > 0 || biomeExit !== 0) process.exitCode = biomeExit || 1;
      } finally {
        await weft.close();
      }
    });
}

interface LintSelection {
  targets: string[];
  issues: WorkflowLoadIssue[];
}

export function selectWorkflows(
  inspection: WorkflowInspection,
  dirs: readonly string[],
  name?: string,
): LintSelection {
  if (name === undefined) {
    return {
      targets: [...new Set(dirs.filter((dir) => existsSync(dir)))],
      issues: inspection.issues,
    };
  }

  const entry = inspection.entries.find((candidate) => candidate.name === name || candidate.id === name);
  if (entry) return { targets: [path.dirname(entry.file)], issues: [] };

  const issues = inspection.issues.filter((issue) => issueName(issue) === name);
  if (issues.length > 0) return { targets: [...new Set(issues.map(issueTarget))], issues };
  throw new Error(
    `unknown workflow ${JSON.stringify(name)} — inspect available names with: weft workflow list`,
  );
}

/** The bundled executable and config make the enforced rule set independent of the project. */
export function weftLintRunner(
  targets: readonly string[],
  opts: Pick<LintOptions, "fix"> = {},
): [string, string[]] {
  return [
    process.execPath,
    [
      bundledBiomePath(),
      "lint",
      "--config-path",
      weftLintConfigPath(),
      "--error-on-warnings",
      ...(opts.fix ? ["--write"] : []),
      ...targets,
    ],
  ];
}

/** Run the fixed general-rule layer; callers add their own gate diagnostics to its exit. */
export async function runWeftLint(
  targets: readonly string[],
  cwd: string,
  opts: Pick<LintOptions, "fix"> = {},
): Promise<number> {
  const [program, args] = weftLintRunner(targets, opts);
  return runChild(program, args, cwd);
}

function bundledBiomePath(): string {
  return createRequire(import.meta.url).resolve("@biomejs/biome/bin/biome");
}

function weftLintConfigPath(): string {
  return fileURLToPath(new URL("../../weft-lint-biome.json", import.meta.url));
}

function issueName(issue: WorkflowLoadIssue): string {
  const target = issueTarget(issue);
  return path.basename(target, path.extname(target));
}

function issueTarget(issue: WorkflowLoadIssue): string {
  return path.basename(issue.file) === "main.ts" ? path.dirname(issue.file) : issue.file;
}

function renderIssue(io: CliIo, cwd: string, issue: WorkflowLoadIssue): void {
  io.out(`${pc.red("✗")} ${displayPath(cwd, issue.file)}`);
  if (issue.diagnostics.length === 0) io.out(`  ${pc.yellow("weft/package-layout")} ${issue.error}`);
}

function renderDiagnostic(diagnostic: GateDiagnostic): string[] {
  const where = pc.dim(`${diagnostic.file}:${diagnostic.line}:${diagnostic.column}`);
  const lines = [`  ${where}  ${pc.yellow(`weft/${diagnostic.rule}`)}  ${diagnostic.message}`];
  if (diagnostic.fixIt) lines.push(`    ${pc.cyan("fix:")} ${diagnostic.fixIt}`);
  return lines;
}

function displayPath(cwd: string, target: string): string {
  const relative = path.relative(cwd, target);
  return relative === "" || relative === ".." || relative.startsWith(`..${path.sep}`) ? target : relative;
}

function runChild(program: string, args: string[], cwd: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(program, args, { cwd, stdio: "inherit" });
    child.once("error", reject);
    child.once("close", (code) => resolve(code ?? 1));
  });
}
