/**
 * writeSync and FileHandle.read are allowed to return SHORT without throwing.
 * This file forces both (a mock caps every write and read at 7 bytes) and
 * demands the journal still land — and fold — whole: an un-looped write would
 * fsync a torn record, and an un-looped reconcile read would parse a zero-filled
 * remainder and truncate committed records as a "torn tail".
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

  // FileHandle.read capped the same way, via a proxy over the real handle.
  const open = (async (...args: Parameters<typeof actual.promises.open>) => {
    const fh = await actual.promises.open(...args);
    return new Proxy(fh, {
      get(target, prop) {
        if (prop === "read") {
          return (buffer: Buffer, offset: number, length: number, position: number) =>
            fh.read(buffer, offset, Math.min(length, 7), position);
        }
        const value = Reflect.get(target, prop);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  }) as typeof actual.promises.open;

  return { ...actual, writeSync: shortWrite, promises: { ...actual.promises, open } };
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

describe("short reads", () => {
  test("a reconcile whose reads land in pieces never truncates committed records", async () => {
    const dir = await tempDir();
    // Instance A caches the journal at one record…
    const a = new FsJournalStore(dir);
    await a.append("run-b", [runCreated("run-b", "audit")]);
    // …a peer (as in another process) appends two long records behind A's back…
    const b = new FsJournalStore(dir);
    await b.append("run-b", [logged("x".repeat(120)), logged("y".repeat(120))]);
    // …and A's next append must fold that growth through 7-byte reads. A partial
    // fold would leave byteOffset short and TRUNCATE the peer's records as torn.
    const appended = await a.append("run-b", [logged("after the peer")]);
    expect(appended.map((r) => r.i)).toEqual([3]);
    const out: Array<{ i: number }> = [];
    for await (const rec of a.read("run-b")) out.push(rec);
    expect(out.map((r) => r.i)).toEqual([0, 1, 2, 3]);
  });
});
