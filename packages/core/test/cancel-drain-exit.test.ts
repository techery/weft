/**
 * `cancel()`'s drain is a BOUND, and a bound only holds if the process is still there
 * when it expires.
 *
 * The drain timer used to be unref'd, in the same spirit as the engine's other timers —
 * but those merely watch work that keeps the process alive on its own, while this one IS
 * the remaining work. A step covers itself: its timeout timer is referenced and outlives
 * a hung provider. A workflow BODY that wedges outside any step has no such timer, and an
 * unreferenced drain left nothing holding the loop: `weft cancel` exited mid-wait, before
 * `run.cancelled` was journaled and the run retired. The guarantee vanished in precisely
 * the case it exists for.
 *
 * Only a separate process can show this — a test runner always holds the loop open — so
 * the scenario lives in test/fixtures/cancel-drain-exit.ts and is run for its exit code.
 */
import { fileURLToPath } from "node:url";
import { execa } from "execa";
import { describe, expect, test } from "vitest";

const fixture = fileURLToPath(new URL("./fixtures/cancel-drain-exit.ts", import.meta.url));

describe("cancel() in a one-shot process", () => {
  test("outlives its own drain and journals the cancellation before exiting", async () => {
    const result = await execa(process.execPath, ["--import", "tsx", fixture], {
      reject: false,
      timeout: 25_000,
      // Inherit nothing that could hold the child's loop open on our behalf.
      stdin: "ignore",
    });

    // Exit code 13 is Node's "unsettled top-level await": the process walked out on the
    // `await engine.cancel(...)` because nothing referenced was left to wait for.
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("STATUS=cancelled");
    // And it exits on its own once the drain is done — a referenced timer that is never
    // cleared would hang here until the timeout above kills it.
    expect(result.timedOut).toBe(false);
  }, 30_000);
});
