/**
 * The `weft` program. Every command is a shell over `weft.engine` (C10) and every line it
 * prints goes through an injectable writer, so `buildProgram({ out })` is a complete,
 * testable CLI with no terminal attached.
 *
 * ```ts
 * const lines: string[] = [];
 * const program = buildProgram({ out: (line) => lines.push(line) }).exitOverride();
 * await program.parseAsync(["run", "review", "--base", "main"], { from: "user" });
 * ```
 */
import { Command } from "commander";
import logUpdate from "log-update";
import pc from "picocolors";
import { answerCommand } from "./commands/answer.ts";
import { cancelCommand } from "./commands/cancel.ts";
import { checkCommand } from "./commands/check.ts";
import { diffCommand } from "./commands/diff.ts";
import { doctorCommand } from "./commands/doctor.ts";
import { explainCommand } from "./commands/explain.ts";
import { lintCommand } from "./commands/lint.ts";
import { lsCommand } from "./commands/ls.ts";
import { newCommand } from "./commands/new.ts";
import { replayCommand } from "./commands/replay.ts";
import { reportCommand } from "./commands/report.ts";
import { resumeCommand } from "./commands/resume.ts";
import { runCommand } from "./commands/run.ts";
import { skillCommand } from "./commands/skill.ts";
import { statusCommand } from "./commands/status.ts";
import { taskCommand } from "./commands/task.ts";
import { testCommand } from "./commands/test.ts";
import { uiCommand } from "./commands/ui.ts";
import { workflowCommand } from "./commands/workflow.ts";
import { type CliIo, warn } from "./io.ts";

/** Writes to the terminal: plain lines to stdout, live frames through log-update. */
export const consoleIo: CliIo = {
  out: (line) => console.log(line),
  err: (line) => console.error(line),
  live: (frame) => logUpdate(frame),
  liveDone: () => logUpdate.done(),
};

/**
 * Build the program. `io` defaults to the console; pass a collector to drive the CLI from
 * a test. The returned `Command` is un-parsed — call `parseAsync(argv, { from: "user" })`.
 */
export function buildProgram(io: CliIo = consoleIo): Command {
  const program = new Command("weft")
    .description("durable, journaled, schema-validated multi-agent workflows")
    .option("--cwd <dir>", "repo root to run in", process.cwd())
    .option(
      "--extra-workflow-dir <dir>",
      "add a workflow directory without moving run state (repeatable)",
      collect,
      [],
    )
    .option(
      "--mock",
      "wire the fixture provider instead of Claude/Codex; agent steps then need fixtures and fail loudly without them",
    )
    .showHelpAfterError()
    .configureOutput({
      writeOut: (text) => io.out(trimEol(text)),
      writeErr: (text) => warn(io, trimEol(text)),
    });

  for (const factory of [
    runCommand,
    resumeCommand,
    lsCommand,
    statusCommand,
    answerCommand,
    cancelCommand,
    replayCommand,
    reportCommand,
    explainCommand,
    diffCommand,
    checkCommand,
    lintCommand,
    newCommand,
    skillCommand,
    doctorCommand,
    taskCommand,
    testCommand,
    uiCommand,
    workflowCommand,
  ]) {
    program.addCommand(factory(io));
  }
  return program;
}

function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}

function trimEol(text: string): string {
  return text.replace(/\n$/, "");
}

/**
 * The bin entry. Commander handles `--help` and usage errors itself; anything a command
 * throws lands here as one error line and a failed exit code — never `process.exit`, so a
 * pending journal write still flushes.
 */
export async function run(argv: string[] = process.argv.slice(2)): Promise<void> {
  const program = buildProgram();
  try {
    await program.parseAsync(argv, { from: "user" });
  } catch (err) {
    logUpdate.done();
    warn(consoleIo, `${pc.red("error")} ${messageOf(err)}`);
    process.exitCode = 1;
  }
}

function messageOf(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
