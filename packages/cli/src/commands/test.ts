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
import { join } from "node:path";
import { Command } from "commander";
import { globalOptions } from "../context.ts";
import type { CliIo } from "../io.ts";

export type TestRunner = "auto" | "node" | "bun" | "vitest";
export const DEFAULT_WORKFLOW_TEST_PATTERN = ".weft/workflows/*/tests/**/*.test.ts";

interface TestOptions {
  watch?: boolean;
  coverage?: boolean;
  config?: string;
  runner?: TestRunner;
}

export function testCommand(io: CliIo): Command {
  return new Command("test")
    .description("run the project's fixture-backed workflow tests")
    .argument("[pattern]", "test file, directory, or glob; defaults to packaged workflow tests")
    .option("--runner <runner>", "test runner: auto, node, bun, or vitest", "auto")
    .option("--watch", "keep the test runner running and watch for changes")
    .option("--coverage", "collect test coverage")
    .option("--config <file>", "Vitest configuration file")
    .action(async (pattern: string | undefined, opts: TestOptions, cmd: Command) => {
      const { cwd } = globalOptions(cmd);
      const selectedPattern = pattern ?? DEFAULT_WORKFLOW_TEST_PATTERN;
      // Scaffolded package tests use node:test and live under a hidden directory that
      // many Vitest configurations exclude. An explicit pattern retains normal auto-detection.
      const requestedRunner = opts.runner ?? "auto";
      const runner =
        pattern === undefined && requestedRunner === "auto" ? "node" : selectRunner(cwd, requestedRunner);
      if (runner !== "vitest" && opts.config !== undefined) {
        throw new Error("--config is only supported with the vitest runner");
      }

      const [program, programArgs] =
        runner === "node"
          ? nodeRunnerFor(selectedPattern, opts)
          : runner === "bun"
            ? bunRunnerFor(selectedPattern, opts)
            : runnerFor(cwd, vitestArgs(selectedPattern, opts));

      io.out(`running ${[program, ...programArgs].join(" ")} (${runner}) in ${cwd}`);
      const exitCode = await runChild(program, programArgs, cwd);
      if (exitCode !== 0) process.exitCode = exitCode;
    });
}

export function selectRunner(cwd: string, requested: TestRunner): Exclude<TestRunner, "auto"> {
  if (requested === "node" || requested === "bun" || requested === "vitest") return requested;
  if (requested !== "auto") throw new Error(`invalid --runner ${JSON.stringify(requested)}`);
  if (hasLocalPackage(cwd, "vitest")) return "vitest";
  return hasBunLock(cwd) ? "bun" : "node";
}

function vitestArgs(pattern: string, opts: TestOptions): string[] {
  const args = ["vitest", ...(opts.watch ? [] : ["run"]), pattern];
  if (opts.coverage) args.push("--coverage");
  if (opts.config) args.push("--config", opts.config);
  return args;
}

export function nodeRunnerFor(
  pattern: string,
  opts: Pick<TestOptions, "watch" | "coverage">,
): [string, string[]] {
  // Node 22.12+ can strip TypeScript annotations without a project dependency.
  const args = ["--experimental-strip-types", "--test"];
  if (opts.watch) args.unshift("--watch");
  if (opts.coverage) args.push("--experimental-test-coverage");
  args.push(pattern);
  return [process.execPath, args];
}

export function bunRunnerFor(
  pattern: string,
  opts: Pick<TestOptions, "watch" | "coverage">,
): [string, string[]] {
  const args = ["test"];
  if (opts.watch) args.push("--watch");
  if (opts.coverage) args.push("--coverage");
  args.push(pattern);
  return ["bun", args];
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
