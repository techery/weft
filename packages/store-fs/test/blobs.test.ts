/**
 * Blobs are content-addressed: the ref *is* the sha256 of the bytes, so writing
 * the same patch twice costs one file and journals can share refs across runs.
 */
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { sha256Hex } from "@weft/core";
import { afterEach, describe, expect, test } from "vitest";
import { FsBlobStore } from "../src/blobs.ts";
import { createFsStores } from "../src/index.ts";
import { removeTemps, runCreated, tempDir } from "./helpers.ts";

afterEach(removeTemps);

describe("FsBlobStore", () => {
  test("put/get/getText/has round-trip strings and bytes", async () => {
    const store = new FsBlobStore(await tempDir());

    const text = await store.put("diff --git a/x b/x\n");
    expect(await store.getText(text.hash)).toBe("diff --git a/x b/x\n");
    expect(text.size).toBe(19);
    expect(await store.has(text.hash)).toBe(true);

    const bytes = new Uint8Array([0, 1, 2, 253, 254, 255]);
    const binary = await store.put(bytes);
    expect(Buffer.from(await store.get(binary.hash))).toEqual(Buffer.from(bytes));
    expect(binary.size).toBe(6);
  });

  test("the ref is the sha256 of the content, whoever writes it", async () => {
    const a = new FsBlobStore(await tempDir());
    const b = new FsBlobStore(await tempDir());
    const payload = "the same bytes";

    const fromA = await a.put(payload);
    const fromB = await b.put(new TextEncoder().encode(payload));
    expect(fromA.hash).toBe(sha256Hex(payload));
    expect(fromB.hash).toBe(fromA.hash);
    expect((await a.put("different bytes")).hash).not.toBe(fromA.hash);
  });

  test("a second put of the same content is a no-op, not a rewrite", async () => {
    const dir = await tempDir();
    const store = new FsBlobStore(dir);
    const first = await store.put("idempotent");
    const second = await store.put("idempotent");
    expect(second).toEqual(first);

    const shard = join(dir, first.hash.slice(0, 2));
    expect(await readdir(shard)).toEqual([first.hash]);
    expect(await store.getText(first.hash)).toBe("idempotent");
  });

  test("advisory metadata lands beside the blob", async () => {
    const dir = await tempDir();
    const store = new FsBlobStore(dir);
    const ref = await store.put("PATCH", { kind: "patch", contentType: "text/x-diff" });

    const meta = join(dir, ref.hash.slice(0, 2), `${ref.hash}.meta.json`);
    expect(JSON.parse(await readFile(meta, "utf8"))).toEqual({ kind: "patch", contentType: "text/x-diff" });
    // Metadata never changes the ref, and the blob itself is untouched by it.
    expect(await store.getText(ref.hash)).toBe("PATCH");
  });

  test("a missing blob throws and an unknown ref is not `has`", async () => {
    const store = new FsBlobStore(await tempDir());
    const absent = sha256Hex("never stored");
    expect(await store.has(absent)).toBe(false);
    await expect(store.get(absent)).rejects.toThrow(/blob not found/);
    await expect(store.getText(absent)).rejects.toThrow(/blob not found/);
  });

  test("a ref that is not a sha256 is rejected", async () => {
    const store = new FsBlobStore(await tempDir());
    for (const bad of ["../../etc/passwd", "NOTAHASH", "abc", `${sha256Hex("x")}extra`]) {
      await expect(store.get(bad)).rejects.toThrow();
      expect(await store.has(bad)).toBe(false);
    }
  });
});

describe("createFsStores", () => {
  test("lays out runs/ and blobs/ under one .weft directory", async () => {
    const weftDir = join(await tempDir(), ".weft");
    const stores = createFsStores(weftDir);
    expect(stores.runsDir).toBe(join(weftDir, "runs"));
    expect(stores.blobsDir).toBe(join(weftDir, "blobs"));

    await stores.journal.append("run-a", [runCreated("run-a", "audit")]);
    const ref = await stores.blobs.put("transcript");
    expect(await stores.journal.exists("run-a")).toBe(true);
    expect(await readFile(join(weftDir, "runs", "run-a", "journal.jsonl"), "utf8")).toContain("run.created");
    expect(await stores.blobs.getText(ref.hash)).toBe("transcript");
  });
});
