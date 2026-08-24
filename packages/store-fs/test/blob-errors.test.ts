/**
 * A blob read can fail in two entirely different ways, and the store is the only layer
 * that still knows which happened.
 *
 * ABSENT or CORRUPT is a cache miss: the step that produced the blob can produce it
 * again, so a run whose only problem is one lost file stays resumable. Anything else —
 * a permission error, an unreadable mount, an I/O fault — means the data is fine and
 * the volume is not, and reporting that as "not found" makes the caller re-run a
 * completed step: the same side effects a second time, and the provider charged again
 * to recover an answer that was never lost.
 *
 * `get` used to collapse every readFile failure into "blob not found", so the
 * distinction was destroyed before any caller could act on it.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { isBlobBeyondRepair, sha256Hex } from "@techery/weft-core";
import { afterEach, describe, expect, test } from "vitest";
import { FsBlobStore } from "../src/blobs.ts";
import { removeTemps, tempDir } from "./helpers.ts";

afterEach(removeTemps);

/** Whatever `get` threw, without the store's own error types getting in the way. */
async function failureOf(store: FsBlobStore, ref: string): Promise<unknown> {
  try {
    await store.get(ref);
  } catch (err) {
    return err;
  }
  throw new Error(`expected get(${ref}) to reject`);
}

describe("blob read failures", () => {
  test("absence is repairable", async () => {
    const store = new FsBlobStore(await tempDir());
    const err = await failureOf(store, sha256Hex("never stored"));
    expect((err as { code?: string }).code).toBe("blob_missing");
    expect(isBlobBeyondRepair(err)).toBe(true);
  });

  test("corruption is repairable, and names what it found", async () => {
    const dir = await tempDir();
    const store = new FsBlobStore(dir);
    const body = "x".repeat(4096);
    const { hash } = await store.put(body);
    await writeFile(join(dir, hash.slice(0, 2), hash), body.slice(0, 100));

    const err = await failureOf(store, hash);
    expect((err as { code?: string }).code).toBe("blob_corrupt");
    expect(isBlobBeyondRepair(err)).toBe(true);
    // The message carries the evidence: a person reading it can tell a short file from
    // a substituted one without opening the store.
    expect((err as Error).message).toContain("100 bytes on disk");
  });

  test("a shard path that is a FILE reads as absence, not as a fault", async () => {
    // A stray file where the two-character shard directory belongs: the blob is not
    // there, and no amount of retrying that volume will make it appear.
    const dir = await tempDir();
    const store = new FsBlobStore(dir);
    const ref = sha256Hex("under a shard that is not a directory");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, ref.slice(0, 2)), "not a directory");

    const err = await failureOf(store, ref);
    expect((err as { code?: string }).code).toBe("blob_missing");
    expect(isBlobBeyondRepair(err)).toBe(true);
  });

  test("an unreadable blob propagates as itself — it is NOT reported as missing", async () => {
    // A directory standing where the blob file belongs stands in for every read that
    // fails without the data being gone (EACCES, EIO, a stalled network mount): the
    // path exists, and readFile refuses it.
    const dir = await tempDir();
    const store = new FsBlobStore(dir);
    const ref = sha256Hex("present but unreadable");
    await mkdir(join(dir, ref.slice(0, 2), ref), { recursive: true });

    const err = await failureOf(store, ref);
    expect((err as NodeJS.ErrnoException).code).toBe("EISDIR");
    // The point of the test: this must NOT look like a repairable miss.
    expect(isBlobBeyondRepair(err)).toBe(false);
    expect((err as Error).message).not.toMatch(/blob not found/);
  });
});
