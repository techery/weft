import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { JournalEvent } from "@techery/weft-core";

const temps: string[] = [];

/** A throwaway directory per test; removeTemps() cleans up every one of them. */
export async function tempDir(prefix = "weft-store-fs-"): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  temps.push(dir);
  return dir;
}

export async function removeTemps(): Promise<void> {
  for (const dir of temps.splice(0))
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
}

export const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Poll until `cond` holds; throws on timeout so a stalled watch fails loudly instead of hanging. */
export async function waitFor(cond: () => boolean, timeout = 5_000, step = 25): Promise<void> {
  const deadline = Date.now() + timeout;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`waitFor timed out after ${timeout}ms`);
    await sleep(step);
  }
}

// ---------------------------------------------------------------------------
// Journal event builders
// ---------------------------------------------------------------------------

export function runCreated(
  runId: string,
  workflow: string,
  opts: { parentRunId?: string } = {},
): JournalEvent {
  return {
    type: "run.created",
    runId,
    workflow: { name: workflow },
    input: { n: 1 },
    cwd: "/repo",
    depth: 0,
    ...(opts.parentRunId ? { parentRunId: opts.parentRunId } : {}),
  };
}

export function logged(message: string): JournalEvent {
  return { type: "log", message };
}
