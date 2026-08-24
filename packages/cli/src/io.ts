/**
 * The output seam. Every line a command prints goes through `CliIo`, so the tests drive
 * `buildProgram()` with a collector instead of scraping a terminal, and the live tree
 * degrades to nothing when nobody is watching one.
 *
 * `out` is the only required member: `buildProgram({ out })` is a complete host.
 */

import type { RunStatus } from "@techery/weft-host";
import pc from "picocolors";

export interface CliIo {
  out(line: string): void;
  /** Diagnostics and failures; defaults to {@link CliIo.out} when absent. */
  err?(line: string): void;
  /** Whole-frame renderer for `--watch` (log-update in the real CLI). */
  live?(frame: string): void;
  /** Freeze the last live frame in the scrollback. */
  liveDone?(): void;
}

export function say(io: CliIo, ...lines: string[]): void {
  for (const line of lines) io.out(line);
}

export function warn(io: CliIo, ...lines: string[]): void {
  for (const line of lines) (io.err ?? io.out)(line);
}

/** Print an error the way a command failure should read, and mark the process failed. */
export function fail(io: CliIo, message: string): void {
  warn(io, `${pc.red("error")} ${message}`);
  process.exitCode = 1;
}

// ---------------------------------------------------------------------------
// Marks & colour
// ---------------------------------------------------------------------------

/** Status marks for the tree. Symbols, never emoji: they align in every terminal. */
export function stepMark(status: "running" | "ok" | "failed"): string {
  if (status === "ok") return pc.green("✓");
  if (status === "failed") return pc.red("✗");
  return pc.yellow("◐");
}

export function paintStatus(status: RunStatus | string): string {
  switch (status) {
    case "complete":
      return pc.green(status);
    case "failed":
      return pc.red(status);
    case "cancelled":
      return pc.dim(status);
    case "waiting_for_human":
    case "waiting_for_signal":
      return pc.yellow(status);
    default:
      return pc.cyan(status);
  }
}
