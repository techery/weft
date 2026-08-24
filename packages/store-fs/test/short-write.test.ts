/**
 * writeSync is allowed to return SHORT without throwing. This file forces that
 * (a mock caps every write at 7 bytes) and demands the journal still land
 * whole — a single un-looped write would fsync a torn record and advance the
 * cache past bytes that never reached the file.
 */
import { afterEach, describe, expect, test, vi } from "vitest";
import { FsJournalStore } from "../src/journal.ts";
import { logged, removeTemps, runCreated, tempDir } from "./helpers.ts";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const shortWrite = ((fd: number, data: string | NodeJS.ArrayBufferView, ...rest: unknown[]) => {
    const buf =
      typeof data === "string"
        ? Buffer.from(data)
        : Buffer.from(data.buffer, data.byteOffset, data.byteLength);
    const offset = typeof rest[0] === "number" ? rest[0] : 0;
    const length = typeof rest[1] === "number" ? rest[1] : buf.length - offset;
    return actual.writeSync(fd, buf, offset, Math.min(length, 7));
  }) as typeof actual.writeSync;
  return { ...actual, writeSync: shortWrite };
});

afterEach(removeTemps);

describe("short writes", () => {
  test("a payload the OS lands in pieces still commits whole records", async () => {
    const dir = await tempDir();
    const store = new FsJournalStore(dir);
    const first = await store.append("run-a", [runCreated("run-a", "audit")]);
    expect(first.map((r) => r.i)).toEqual([0]);
    const second = await store.append("run-a", [logged("a".repeat(100)), logged("b".repeat(100))]);
    expect(second.map((r) => r.i)).toEqual([1, 2]);

    // A fresh instance parses every record intact — nothing torn, nothing lost.
    const fresh = new FsJournalStore(dir);
    const out: Array<{ i: number }> = [];
    for await (const rec of fresh.read("run-a")) out.push(rec);
    expect(out.map((r) => r.i)).toEqual([0, 1, 2]);
    // And appends keep working on top (the lock token write is looped too).
    const more = await fresh.append("run-a", [logged("after")]);
    expect(more.map((r) => r.i)).toEqual([3]);
  });
});
