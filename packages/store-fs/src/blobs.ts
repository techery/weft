import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { dirname, join } from "node:path";
import type { BlobMeta, BlobRef, BlobStore } from "@weft/core";

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

  async get(ref: string): Promise<Uint8Array> {
    try {
      return await fs.readFile(this.pathFor(ref));
    } catch {
      throw new Error(`blob not found: ${ref}`);
    }
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
