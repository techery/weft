/**
 * @weft/store-fs — the default stores: one portable run directory per run
 * (journal.jsonl + projections) and a content-addressed blob directory shared
 * across runs (patches and transcripts dedupe naturally).
 *
 *   .weft/runs/<id>/journal.jsonl   ← truth
 *   .weft/runs/<id>/state.json      ← projection
 *   .weft/runs/<id>/tree.json       ← projection
 *   .weft/runs/<id>/report.md       ← projection
 *   .weft/blobs/<aa>/<hash>         ← content-addressed blobs
 */

export { FsBlobStore } from "./blobs.ts";
export { FsJournalStore } from "./journal.ts";

import { join } from "node:path";
import type { BlobStore, JournalStore } from "@weft/core";
import { FsBlobStore } from "./blobs.ts";
import { FsJournalStore } from "./journal.ts";

export interface FsStores {
  journal: JournalStore;
  blobs: BlobStore;
  runsDir: string;
  blobsDir: string;
}

/** Standard layout under a `.weft` directory (usually `<repo>/.weft`). */
export function createFsStores(weftDir: string): FsStores {
  const runsDir = join(weftDir, "runs");
  const blobsDir = join(weftDir, "blobs");
  return {
    journal: new FsJournalStore(runsDir),
    blobs: new FsBlobStore(blobsDir),
    runsDir,
    blobsDir,
  };
}
