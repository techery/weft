/**
 * The narrowest race in the lock protocol: a contender renames a stale-LOOKING
 * lock aside, discovers it was renewed inside the stat window, and must put it
 * back. During the gap a THIRD process can create a fresh lock at the path —
 * a rename-based restore silently REPLACES that lock and hands two processes
 * the same critical section. The mock below forces exactly that interleaving.
 */
import { utimesSync, writeFileSync } from "node:fs";
import { readFile, rm, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { FsJournalStore } from "../src/journal.ts";
import { removeTemps, tempDir } from "./helpers.ts";

const hooks = vi.hoisted(() => ({
  onAsideRename: undefined as ((aside: string, lockPath: string) => void) | undefined,
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const rename = (async (from: string, to: string) => {
    await actual.promises.rename(from, to);
    // Fire the injected interleaving the moment the steal moves a lock aside —
    // strictly BEFORE the stealer's next stat.
    if (to.includes(".stale-")) {
      hooks.onAsideRename?.(to, from);
      hooks.onAsideRename = undefined;
    }
  }) as typeof actual.promises.rename;
  return { ...actual, promises: { ...actual.promises, rename } };
});

afterEach(async () => {
  hooks.onAsideRename = undefined;
  await removeTemps();
});

describe("stale-steal restore", () => {
  test("restoring a freshly-renewed lock never clobbers a contender's new lock", async () => {
    const dir = await tempDir();
    const store = new FsJournalStore(dir);
    const lock = join(dir, "x.lock");
    // A lock that LOOKS stale (its holder is slow to renew)…
    await writeFile(lock, "original-holder");
    const past = new Date(Date.now() - 60_000);
    await utimes(lock, past, past);
    // …renewed the instant the steal moves it aside, while a contender grabs
    // the now-free path.
    hooks.onAsideRename = (aside) => {
      const now = new Date();
      utimesSync(aside, now, now);
      writeFileSync(lock, "contender");
    };

    const locked = store as unknown as {
      withFileLock<T>(lockPath: string, what: string, fn: () => Promise<T>): Promise<T>;
    };
    const attempt = locked.withFileLock(lock, "run x", async () => "entered");
    // Give the steal cycle time to run its restore branch, then check WHOSE
    // lock stands: a rename restore would have replaced the contender's.
    await new Promise((r) => setTimeout(r, 150));
    expect(await readFile(lock, "utf8")).toBe("contender");
    // Free the path so the caller's loop can finish cleanly.
    await rm(lock, { force: true });
    expect(await attempt).toBe("entered");
  });
});
