/**
 * `weft test [pattern]` — run the consuming project's fixture-backed workflow tests.
 *
 * Weft deliberately does not require a third-party test runner. With no pattern it runs
 * each workflow package's nested `.test.ts` files through Node's built-in runner. For an explicit
 * pattern, it prefers a project's local Vitest, then Bun, then Node. Workflow tests stay
 * with their workflow rather than in the CLI package.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { glob, readdir, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { Command } from "commander";
import { globalOptions, openWeft } from "../context.ts";
import type { CliIo } from "../io.ts";

export type TestRunner = "auto" | "node" | "bun" | "vitest";
/** @deprecated Discovery now uses the configured registry, including extra roots. */
export const DEFAULT_WORKFLOW_TEST_PATTERN = ".weft/workflows/*/tests/**/*.test.ts";

interface TestOptions {
  watch?: boolean;
  coverage?: boolean;
  config?: string;
  runner?: TestRunner;
  allowEmpty?: boolean;
}

export function testCommand(io: CliIo): Command {
  return new Command("test")
    .description("run the project's fixture-backed workflow tests")
    .argument(
      "[selection]",
      "workflow name/id, test file, directory, or glob; defaults to all registered workflows",
    )
    .option("--runner <runner>", "test runner: auto, node, bun, or vitest", "auto")
    .option("--watch", "keep the test runner running and watch for changes")
    .option("--coverage", "collect test coverage")
    .option("--config <file>", "Vitest configuration file")
    .option("--allow-empty", "explicitly allow a selection with no test files")
    .action(async (pattern: string | undefined, opts: TestOptions, cmd: Command) => {
      const { cwd } = globalOptions(cmd);
      const weft = await openWeft(cmd);
      let selection: { files: string[]; workflows: number; registered: boolean };
      try {
        selection = await discoverTests(weft.registry, cwd, pattern);
      } finally {
        await weft.close();
      }
      io.out(`discovered ${selection.workflows} workflows, ${selection.files.length} test files`);
      if (selection.files.length === 0) {
        if (opts.allowEmpty) return;
        throw new Error("no test files selected — add workflow tests or use --allow-empty intentionally");
      }
      // Scaffolded package tests use node:test and live under a hidden directory that
      // many Vitest configurations exclude. An explicit pattern retains normal auto-detection.
      const requestedRunner = opts.runner ?? "auto";
      const runner =
        selection.registered && requestedRunner === "auto" ? "node" : selectRunner(cwd, requestedRunner);
      if (runner !== "vitest" && opts.config !== undefined) {
        throw new Error("--config is only supported with the vitest runner");
      }

      const [program, programArgs] =
        runner === "node"
          ? nodeRunnerFor(cwd, selection.files, opts)
          : runner === "bun"
            ? bunRunnerFor(selection.files, opts)
            : runnerFor(cwd, vitestArgs(selection.files, opts));

      io.out(`running ${[program, ...programArgs].join(" ")} (${runner}) in ${cwd}`);
      const exitCode = await runChild(program, programArgs, cwd);
      if (exitCode !== 0) process.exitCode = exitCode;
    });
}

interface TestRegistry {
  listWithIssues(): Promise<{
    entries: Array<{ id: string; name: string; file: string }>;
    issues: Array<{ file: string; error: string }>;
  }>;
  loadIdentity(identity: string): Promise<{ file: string }>;
}

/** Resolve actual files before spawning, so every runner shares the same empty-selection gate. */
export async function discoverTests(
  registry: TestRegistry,
  cwd: string,
  selection?: string,
): Promise<{ files: string[]; workflows: number; registered: boolean }> {
  if (selection !== undefined && (existsSync(resolve(cwd, selection)) || /[*?{[]/.test(selection))) {
    const matches: string[] = [];
    for await (const match of glob(selection, { cwd })) matches.push(resolve(cwd, match));
    const files = (await Promise.all(matches.map((file) => testFiles(file, true)))).flat();
    return { files: [...new Set(files)].sort(), workflows: 0, registered: false };
  }
  const inspection = await registry.listWithIssues();
  if (selection === undefined && inspection.issues.length > 0) {
    throw new Error(
      `workflow discovery failed:\n${inspection.issues.map((issue) => `${issue.file}: ${issue.error}`).join("\n")}`,
    );
  }
  const entries = selection === undefined ? inspection.entries : [await registry.loadIdentity(selection)];
  const files = (
    await Promise.all(entries.map((entry) => testFiles(join(dirname(entry.file), "tests"))))
  ).flat();
  return { files: [...new Set(files)].sort(), workflows: entries.length, registered: true };
}

async function testFiles(target: string, explicitFile = false): Promise<string[]> {
  const info = await stat(target);
  if (info.isFile()) return explicitFile || /\.test\.[cm]?[jt]s$/.test(target) ? [target] : [];
  if (!info.isDirectory()) return [];
  const entries = await readdir(target, { withFileTypes: true });
  return (
    await Promise.all(
      entries
        .filter((entry) => entry.isFile() || entry.isDirectory())
        .map((entry) => testFiles(join(target, entry.name))),
    )
  ).flat();
}

export function selectRunner(cwd: string, requested: TestRunner): Exclude<TestRunner, "auto"> {
  if (requested === "node" || requested === "bun" || requested === "vitest") return requested;
  if (requested !== "auto") throw new Error(`invalid --runner ${JSON.stringify(requested)}`);
  if (hasLocalPackage(cwd, "vitest")) return "vitest";
  return hasBunLock(cwd) ? "bun" : "node";
}

function vitestArgs(pattern: string | string[], opts: TestOptions): string[] {
  const args = ["vitest", ...(opts.watch ? [] : ["run"]), ...asPatterns(pattern)];
  if (opts.coverage) args.push("--coverage");
  if (opts.config) args.push("--config", opts.config);
  return args;
}

export function nodeRunnerFor(
  cwd: string,
  pattern: string | string[],
  opts: Pick<TestOptions, "watch" | "coverage">,
): [string, string[]] {
  // A local tsx hook supports the full TypeScript syntax used by linked, unpublished Weft
  // packages. Otherwise keep the dependency-free Node 22.12+ strip-only fallback for ordinary
  // workflow tests. (Node 26 removed --experimental-transform-types.)
  const args = hasLocalPackage(cwd, "tsx")
    ? ["--import", "tsx", "--test"]
    : ["--experimental-strip-types", "--test"];
  if (opts.watch) args.unshift("--watch");
  if (opts.coverage) args.push("--experimental-test-coverage");
  args.push(...asPatterns(pattern));
  // Resolve Node from the consuming project's PATH so version managers and the project's
  // selected runtime win over the runtime that happened to launch a globally installed CLI.
  return ["node", args];
}

export function bunRunnerFor(
  pattern: string | string[],
  opts: Pick<TestOptions, "watch" | "coverage">,
): [string, string[]] {
  const args = ["test"];
  if (opts.watch) args.push("--watch");
  if (opts.coverage) args.push("--coverage");
  args.push(...asPatterns(pattern));
  return ["bun", args];
}

function asPatterns(pattern: string | string[]): string[] {
  return typeof pattern === "string" ? [pattern] : pattern;
}

/** Pick the package manager already used by the project; never install dependencies implicitly. */
export function runnerFor(cwd: string, vitestArgs: string[]): [string, string[]] {
  if (existsSync(`${cwd}/pnpm-lock.yaml`)) return ["pnpm", ["exec", ...vitestArgs]];
  if (existsSync(`${cwd}/yarn.lock`)) return ["yarn", ["exec", ...vitestArgs]];
  if (existsSync(`${cwd}/bun.lockb`) || existsSync(`${cwd}/bun.lock`)) {
    return ["bun", ["x", "--no-install", ...vitestArgs]];
  }
  return ["npx", ["--no-install", ...vitestArgs]];
}

function hasLocalPackage(cwd: string, packageName: string): boolean {
  return (
    existsSync(join(cwd, "node_modules", packageName)) ||
    existsSync(join(cwd, "node_modules", ".bin", packageName))
  );
}

function hasBunLock(cwd: string): boolean {
  return existsSync(join(cwd, "bun.lockb")) || existsSync(join(cwd, "bun.lock"));
}

function runChild(program: string, args: string[], cwd: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(program, args, { cwd, stdio: "inherit" });
    child.once("error", reject);
    child.once("close", (code, signal) => resolve(code ?? (signal === null ? 1 : 1)));
  });
}
