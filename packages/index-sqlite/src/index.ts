/**
 * @weft/index-sqlite — an optional `node:sqlite` index over local runs, derived
 * from their journals. It makes `weft ls` / search / the UI's run list fast
 * without ever becoming a source of truth: the file can be deleted at any time
 * and `RunIndex.rebuild(journalStore)` puts it back.
 *
 *   .weft/index.db   ← derived; drop it and rebuild
 *
 * The schema is versioned with `PRAGMA user_version`; a mismatch drops the table
 * and recreates it instead of migrating.
 */

export type { IndexedRun, RunIndexOptions, RunIndexStats, RunSearchQuery } from "./run-index.ts";
export { DEFAULT_SEARCH_LIMIT, RunIndex, SCHEMA_VERSION } from "./run-index.ts";
