/**
 * `weft test [pattern]` — run the consuming project's fixture-backed workflow tests.
 *
 * Weft deliberately does not require a third-party test runner. The command prefers a
 * project's locally installed Vitest for compatibility, then Bun's native runner for Bun
 * projects, and otherwise Node's built-in node:test runner. Workflow tests stay in the
 * project rather than in the CLI package.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { Command } from "commander";
import { globalOptions } from "../context.ts";
import type { CliIo } from "../io.ts";

export type TestRunner = "auto" | "node" | "bun" | "vitest";

interface TestOptions {
  watch?: boolean;
  coverage?: boolean;
  config?: string;
  runner?: TestRunner;
}

export function testCommand(io: CliIo): Command {
  return new Command("test")
    .description("run the project's fixture-backed workflow tests")
    .argument("[pattern]", "test file or directory", "test/workflows")
    .option("--runner <runner>", "test runner: auto, node, bun, or vitest", "auto")
    .option("--watch", "keep the test runner running and watch for changes")
    .option("--coverage", "collect test coverage")
    .option("--config <file>", "Vitest configuration file")
    .action(async (pattern: string, opts: TestOptions, cmd: Command) => {
      const { cwd } = globalOptions(cmd);
      const runner = selectRunner(cwd, opts.runner ?? "auto");
      if (runner !== "vitest" && opts.config !== undefined) {
        throw new Error("--config is only supported with the vitest runner");
      }

      const [program, programArgs] =
        runner === "node"
          ? nodeRunnerFor(pattern, opts)
          : runner === "bun"
            ? bunRunnerFor(pattern, opts)
            : runnerFor(cwd, vitestArgs(pattern, opts));

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
