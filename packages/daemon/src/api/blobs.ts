/**
 * `GET /api/blobs/:ref` — the bytes behind a journaled reference.
 *
 * Artifacts, captured patches and oversized step outputs are all journaled as a hash and
 * a size, never inline (C4). Every surface that wants to *show* one of those — the run's
 * artifact viewer, the diff pane — therefore needs a door to the blob store, and until
 * now there wasn't one: the refs were readable over the API and the content was not.
 *
 * Content-addressed means the response is immutable by construction, so it is cached
 * forever and needs no validator.
 */
import type { Weft } from "@techery/weft-host";
import type { Hono } from "hono";
import { fail } from "../http.ts";

/** Blob refs are sha256 hex. Anything else never reaches the store. */
const REF = /^[0-9a-f]{64}$/;

export function registerBlobRoutes(app: Hono, weft: Weft): void {
  app.get("/api/blobs/:ref", async (c) => {
    const ref = c.req.param("ref");
    try {
      // Shape-checked before the store sees it: the fs store maps a ref onto a path, and
      // a ref is the one part of this surface a caller controls completely.
      if (!REF.test(ref)) throw new Error(`blob ref must be 64 hex characters, got ${JSON.stringify(ref)}`);
      if (!(await weft.engine.blobs.has(ref))) throw new Error(`blob ${ref} not found`);

      const bytes = await weft.engine.blobs.get(ref);
      // A blob's type is not recorded with it, so the caller says how it wants the bytes
      // rather than this route guessing from content.
      const as = c.req.query("as");
      const contentType =
        as === "text"
          ? "text/plain; charset=utf-8"
          : as === "json"
            ? "application/json; charset=utf-8"
            : "application/octet-stream";

      // The Uint8Array itself, not its `.buffer`: an ArrayBuffer falls off
      // @hono/node-server's lightweight-response path and gets copied again by undici on
      // the way out, so the naive spelling costs a third full-size copy of the blob for
      // nothing. (A copy remains because the store hands back a view whose ArrayBuffer
      // type the response types will not accept; one copy, not two.)
      return c.body(new Uint8Array(bytes), 200, {
        "content-type": contentType,
        "cache-control": "public, max-age=31536000, immutable",
        // Named by its hash: a browser "save as" then produces a file you can verify.
        "content-disposition": `inline; filename="${ref.slice(0, 12)}"`,
      });
    } catch (err) {
      return fail(c, err);
    }
  });
}
