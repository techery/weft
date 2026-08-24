import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { dirname, join } from "node:path";
import type { BlobMeta, BlobRef, BlobStore } from "@techery/weft-core";
import { BlobCorruptError, BlobMissingError } from "@techery/weft-core";

/**
 * Content-addressed blob directory: blobs/<aa>/<sha256>. Writes are idempotent
 * (same content, same path); metadata is advisory and stored alongside as
 * <hash>.meta.json when provided.
 */
export class FsBlobStore implements BlobStore {
  constructor(readonly dir: string) {}

  private pathFor(hash: string): string {
    if (!/^[0-9a-f]{64}$/.test(hash)) throw new Error(`invalid blob ref: ${hash}`);
    return join(this.dir, hash.slice(0, 2), hash);
  }

  async put(bytes: Uint8Array | string, meta?: BlobMeta): Promise<BlobRef> {
    const data = typeof bytes === "string" ? Buffer.from(bytes, "utf8") : Buffer.from(bytes);
    const hash = createHash("sha256").update(data).digest("hex");
    const path = this.pathFor(hash);
    await fs.mkdir(dirname(path), { recursive: true });
    // Write-then-rename: the hash-named file must only ever exist COMPLETE. A
    // direct write that crashed partway would leave a truncated file whose
    // pathname promises this hash — every later put of the same content would
    // see it "already stored" and the corruption would become permanent. The
    // rename lands whole bytes over any such torn leftover (same content, same
    // path: replacing an intact copy with identical bytes is harmless).
    const tmp = `${path}.${randomUUID().slice(0, 8)}.tmp`;
    await fs.writeFile(tmp, data);
    await fs.rename(tmp, path);
    if (meta && (meta.kind || meta.contentType)) {
      await fs.writeFile(`${path}.meta.json`, JSON.stringify(meta)).catch(() => undefined);
    }
    return { hash, size: data.byteLength };
  }

  /**
   * Reads verify their own name. `put` only ever lands complete bytes, but the file it
   * lands is on someone's disk afterwards: a torn restore, a truncated copy, a half-synced
   * volume. A blob holds a step's output, a captured patch, a transcript — served short,
   * a patch integrates the wrong change and a journaled output replays as a different
   * answer, both silently. The store is content-addressed, so the check is the name.
   */
  async get(ref: string): Promise<Uint8Array> {
    let data: Buffer;
    try {
      data = await fs.readFile(this.pathFor(ref));
    } catch (err) {
      // ABSENCE only. Reporting EACCES or EIO as "not found" tells the caller the data is
      // gone when the volume is merely unreachable — and a journaled output that reads as
      // gone is re-run, duplicating the step's side effects and its provider charge.
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") throw err;
      throw new BlobMissingError(ref);
    }
    const actual = createHash("sha256").update(data).digest("hex");
    if (actual !== ref) throw new BlobCorruptError(ref, actual, data.byteLength);
    return data;
  }

  async getText(ref: string): Promise<string> {
    return Buffer.from(await this.get(ref)).toString("utf8");
  }

  async has(ref: string): Promise<boolean> {
    try {
      await fs.access(this.pathFor(ref));
      return true;
    } catch {
      return false;
    }
  }
}
