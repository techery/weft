/**
 * Run-id reservation must be an EXCLUSIVE create: a random-id collision that
 * silently reused an existing run's directory would overwrite that run's
 * persisted definition, and the old run would later resume as something else.
 */
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { persistInlineScript, reserveRunId, type Weft } from "@techery/weft-host";
import { afterEach, describe, expect, test, vi } from "vitest";

const mocked = vi.hoisted(() => ({ queue: [] as string[] }));

vi.mock("node:crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:crypto")>();
  return {
    ...actual,
    randomUUID: (() => mocked.queue.shift() ?? actual.randomUUID()) as typeof actual.randomUUID,
  };
});

const temps: string[] = [];

afterEach(async () => {
  mocked.queue.length = 0;
  for (const dir of temps.splice(0)) await rm(dir, { recursive: true, force: true });
});

describe("reserveRunId", () => {
  test("a colliding id is retried, never reusing an existing run's directory", async () => {
    const dir = await mkdtemp(join(tmpdir(), "weft-reserve-"));
    temps.push(dir);
    const weft = { runsDir: join(dir, "runs") } as unknown as Weft;

    // An existing run with persisted provenance…
    await mkdir(join(dir, "runs", "deadbeef"), { recursive: true });
    await writeFile(join(dir, "runs", "deadbeef", "script.ts"), "original", "utf8");
    // …and a random generator that hands out that very id first.
    mocked.queue.push("deadbeef-0000-4000-8000-000000000000", "fee1600d-0000-4000-8000-000000000000");

    const runId = await reserveRunId(weft);
    expect(runId).toBe("fee1600d");
    expect(existsSync(join(dir, "runs", "fee1600d"))).toBe(true);
    await persistInlineScript(weft, runId, "fresh code");

    // The colliding run's provenance is untouched.
    expect(await readFile(join(dir, "runs", "deadbeef", "script.ts"), "utf8")).toBe("original");
  });
});
