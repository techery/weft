/**
 * `weft test [pattern]` — run the consuming project's fixture-backed workflow tests.
 *
 * Weft deliberately does not own a test runner. The command is a small, discoverable
 * bridge to the project's locally installed Vitest, keeping workflow tests in the project
 * rather than in the CLI package.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { Command } from "commander";
import { globalOptions } from "../context.ts";
import type { CliIo } from "../io.ts";

interface TestOptions {
  watch?: boolean;
  coverage?: boolean;
  config?: string;
}

export function testCommand(io: CliIo): Command {
  return new Command("test")
    .description("run the project's fixture-backed workflow tests")
    .argument("[pattern]", "test file or directory", "test/workflows")
    .option("--watch", "keep Vitest running and watch for changes")
    .option("--coverage", "collect Vitest coverage")
    .option("--config <file>", "Vitest configuration file")
    .action(async (pattern: string, opts: TestOptions, cmd: Command) => {
      const { cwd } = globalOptions(cmd);
      const args = ["vitest", ...(opts.watch ? [] : ["run"]), pattern];
      if (opts.coverage) args.push("--coverage");
      if (opts.config) args.push("--config", opts.config);

      const [program, programArgs] = runnerFor(cwd, args);
      io.out(`running ${[program, ...programArgs].join(" ")} in ${cwd}`);
      const exitCode = await runChild(program, programArgs, cwd);
      if (exitCode !== 0) process.exitCode = exitCode;
    });
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

function runChild(program: string, args: string[], cwd: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(program, args, { cwd, stdio: "inherit" });
    child.once("error", reject);
    child.once("close", (code, signal) => resolve(code ?? (signal === null ? 1 : 1)));
  });
}
