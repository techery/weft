/**
 * A critical section that outlives the 10s stale threshold survives only
 * because its renewal keeps the lock's mtime fresh. When renewal itself FAILS,
 * contenders will judge the lock stale and steal it — so the operation must
 * treat the mutex as lost instead of finishing as if it still held it.
 */
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { FsJournalStore } from "../src/journal.ts";
import { removeTemps, tempDir } from "./helpers.ts";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const utimes = (async () => {
    throw new Error("EIO: metadata write failed");
  }) as typeof actual.promises.utimes;
  return { ...actual, promises: { ...actual.promises, utimes } };
});

afterEach(removeTemps);

describe("lock renewal failure", () => {
  test("a critical section that cannot renew its lock fails instead of finishing unowned", async () => {
    vi.useFakeTimers();
    try {
      const dir = await tempDir();
      const store = new FsJournalStore(dir);
      const locked = store as unknown as {
        withFileLock<T>(lockPath: string, what: string, fn: () => Promise<T>): Promise<T>;
      };
      const slow = locked.withFileLock(join(dir, "x.lock"), "run x", async () => {
        // Four failed renewals span the stale threshold while this runs.
        await new Promise((resolve) => setTimeout(resolve, 12_000));
        return "finished";
      });
      const guarded = expect(slow).rejects.toThrow(/renewal failed/);
      await vi.advanceTimersByTimeAsync(13_000);
      await guarded;
    } finally {
      vi.useRealTimers();
    }
  });
});
