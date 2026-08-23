import { randomUUID } from "node:crypto";
import { closeSync, existsSync, promises as fs, fsyncSync, openSync, writeSync } from "node:fs";
import { join } from "node:path";
import type {
  JournalEvent,
  JournalRecord,
  JournalStore,
  Projections,
  RunLease,
  RunListFilter,
  RunStatus,
  RunSummary,
} from "@weft/core";
import { type RunState, reduceState } from "@weft/core";

interface RunCache {
  count: number;
  byteOffset: number;
  watchers: Set<(records: JournalRecord[]) => void>;
}

/**
 * JSONL journal, one directory per run. Appends are a single write + fsync per
 * batch; indices are monotonic per run. watch() serves in-process appends
 * immediately and polls the file for out-of-process writers.
 */
export class FsJournalStore implements JournalStore {
  private cache = new Map<string, RunCache>();

  constructor(readonly runsDir: string) {}

  private runDir(runId: string): string {
    if (!/^[A-Za-z0-9._-]+$/.test(runId) || runId === "." || runId === "..") {
      throw new Error(`invalid runId: ${runId}`);
    }
    return join(this.runsDir, runId);
  }

  private journalPath(runId: string): string {
    return join(this.runDir(runId), "journal.jsonl");
  }

  private async loadCache(runId: string): Promise<RunCache> {
    let cached = this.cache.get(runId);
    if (cached) return cached;
    let count = 0;
    let byteOffset = 0;
    try {
      const raw = await fs.readFile(this.journalPath(runId), "utf8");
      byteOffset = Buffer.byteLength(raw);
      count = raw.split("\n").filter((l) => l.trim().length > 0).length;
    } catch {
      // no journal yet
    }
    cached = { count, byteOffset, watchers: new Set() };
    this.cache.set(runId, cached);
    return cached;
  }

  async append(runId: string, events: JournalEvent[]): Promise<JournalRecord[]> {
    const cached = await this.loadCache(runId);
    await fs.mkdir(this.runDir(runId), { recursive: true });
    await this.reconcile(runId, cached);
    const at = Date.now();
    const records = events.map((ev) => {
      const rec: JournalRecord = { i: cached.count++, at, ev };
      return rec;
    });
    const payload = records.map((r) => JSON.stringify(r)).join("\n") + "\n";
    const fd = openSync(this.journalPath(runId), "a");
    try {
      writeSync(fd, payload);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    cached.byteOffset += Buffer.byteLength(payload);
    for (const w of cached.watchers) w(records);
    return records;
  }

  /**
   * Another live store instance (a CLI answering a run a daemon owns) may have
   * appended since this one cached: fold on-disk growth into count/byteOffset so
   * the indices assigned next continue theirs instead of duplicating them. Only
   * newline-terminated lines count — a torn trailing write is not a record yet.
   */
  private async reconcile(runId: string, cached: RunCache): Promise<void> {
    let size = 0;
    try {
      size = (await fs.stat(this.journalPath(runId))).size;
    } catch {
      return; // no journal yet
    }
    if (size <= cached.byteOffset) return;
    const fh = await fs.open(this.journalPath(runId), "r");
    try {
      const buf = Buffer.alloc(size - cached.byteOffset);
      await fh.read(buf, 0, buf.length, cached.byteOffset);
      const lines = buf.toString("utf8").split("\n");
      for (let i = 0; i < lines.length - 1; i++) {
        cached.byteOffset += Buffer.byteLength(lines[i]!) + 1;
        if (lines[i]!.trim().length > 0) cached.count++;
      }
    } finally {
      await fh.close();
    }
  }

  async *read(runId: string, fromIndex = 0): AsyncIterable<JournalRecord> {
    const path = this.journalPath(runId); // validates runId; must throw, not yield nothing
    let raw: string;
    try {
      raw = await fs.readFile(path, "utf8");
    } catch {
      return;
    }
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      const rec = JSON.parse(line) as JournalRecord;
      if (rec.i >= fromIndex) yield rec;
    }
  }

  async *watch(
    runId: string,
    opts: { fromIndex?: number; signal?: AbortSignal } = {},
  ): AsyncIterable<JournalRecord> {
    const cached = await this.loadCache(runId);
    let cursor = opts.fromIndex ?? 0;
    for await (const rec of this.read(runId, cursor)) {
      cursor = rec.i + 1;
      yield rec;
    }
    const queue: JournalRecord[] = [];
    let wake: (() => void) | undefined;
    const listener = (records: JournalRecord[]) => {
      queue.push(...records);
      wake?.();
    };
    cached.watchers.add(listener);
    const poll = setInterval(() => wake?.(), 400);
    poll.unref?.();
    try {
      while (!opts.signal?.aborted) {
        // Out-of-process writers: pick up lines beyond our cache.
        for await (const rec of this.read(runId, cursor)) {
          cursor = rec.i + 1;
          if (rec.i >= cached.count) cached.count = rec.i + 1;
          yield rec;
        }
        while (queue.length > 0) {
          const rec = queue.shift()!;
          if (rec.i >= cursor) {
            cursor = rec.i + 1;
            yield rec;
          }
        }
        await new Promise<void>((resolve) => {
          wake = resolve;
          opts.signal?.addEventListener("abort", () => resolve(), { once: true });
        });
        wake = undefined;
      }
    } finally {
      clearInterval(poll);
      cached.watchers.delete(listener);
    }
  }

  async list(filter: RunListFilter = {}): Promise<RunSummary[]> {
    let entries: string[] = [];
    try {
      entries = (await fs.readdir(this.runsDir, { withFileTypes: true }))
        .filter((e) => e.isDirectory())
        .map((e) => e.name);
    } catch {
      return [];
    }
    const out: RunSummary[] = [];
    for (const runId of entries) {
      const summary = await this.summarize(runId);
      if (!summary) continue;
      if (filter.status && summary.status !== filter.status) continue;
      if (filter.workflow && summary.workflow !== filter.workflow) continue;
      out.push(summary);
    }
    out.sort((a, b) => b.createdAt - a.createdAt);
    return filter.limit ? out.slice(0, filter.limit) : out;
  }

  private async summarize(runId: string): Promise<RunSummary | undefined> {
    // Prefer the state.json projection; fall back to scanning the journal.
    try {
      const raw = await fs.readFile(join(this.runDir(runId), "state.json"), "utf8");
      const state = JSON.parse(raw) as RunState;
      const stat = await fs.stat(this.journalPath(runId));
      return {
        runId,
        workflow: state.workflow,
        status: state.status,
        createdAt: state.createdAt,
        updatedAt: Math.max(state.updatedAt, stat.mtimeMs),
        ...(state.parentRunId ? { parentRunId: state.parentRunId } : {}),
      };
    } catch {
      // fall through to journal scan
    }
    const records: JournalRecord[] = [];
    for await (const rec of this.read(runId)) records.push(rec);
    if (records.length === 0) return undefined;
    let workflow = "";
    let status: RunStatus = "planning";
    let parentRunId: string | undefined;
    for (const rec of records) {
      if (rec.ev.type === "run.created") {
        workflow = rec.ev.workflow.name;
        parentRunId = rec.ev.parentRunId;
      } else if (rec.ev.type === "run.status") status = rec.ev.status;
      else if (rec.ev.type === "run.completed") status = "complete";
      else if (rec.ev.type === "run.failed") status = "failed";
      else if (rec.ev.type === "run.cancelled") status = "cancelled";
    }
    return {
      runId,
      workflow,
      status,
      createdAt: records[0]!.at,
      updatedAt: records[records.length - 1]!.at,
      ...(parentRunId ? { parentRunId } : {}),
    };
  }

  async snapshot(runId: string, projections: Projections): Promise<void> {
    const dir = this.runDir(runId);
    await fs.mkdir(dir, { recursive: true });
    const writes: Array<Promise<void>> = [];
    const writeAtomic = async (file: string, content: string) => {
      // Unique per write: concurrent snapshots of the same run must not rename
      // each other's temp file out from under themselves (ENOENT / torn mixes).
      const tmp = join(dir, `.${file}.${randomUUID().slice(0, 8)}.tmp`);
      await fs.writeFile(tmp, content);
      await fs.rename(tmp, join(dir, file));
    };
    if (projections.state !== undefined)
      writes.push(writeAtomic("state.json", JSON.stringify(projections.state, null, 2)));
    if (projections.tree !== undefined)
      writes.push(writeAtomic("tree.json", JSON.stringify(projections.tree, null, 2)));
    if (projections.report !== undefined) writes.push(writeAtomic("report.md", projections.report));
    await Promise.all(writes);
  }

  async readSnapshot(runId: string): Promise<Projections | undefined> {
    const dir = this.runDir(runId);
    const projections: Projections = {};
    try {
      projections.state = JSON.parse(await fs.readFile(join(dir, "state.json"), "utf8"));
    } catch {
      // absent
    }
    try {
      projections.report = await fs.readFile(join(dir, "report.md"), "utf8");
    } catch {
      // absent
    }
    try {
      projections.tree = JSON.parse(await fs.readFile(join(dir, "tree.json"), "utf8"));
    } catch {
      // absent
    }
    if (
      projections.state === undefined &&
      projections.report === undefined &&
      projections.tree === undefined
    ) {
      return undefined;
    }
    return projections;
  }

  async exists(runId: string): Promise<boolean> {
    return existsSync(this.journalPath(runId));
  }

  /**
   * Cross-process ownership: an owner.json claim with a TTL. A live claim refuses a
   * second owner (a daemon must not wake a run a CLI is executing); a claim whose
   * owner died expires on its own and can be stolen. Best-effort — a simultaneous
   * steal race is possible but the loser detects it by re-reading its own claim.
   */
  async acquireRun(runId: string, opts: { ttlMs?: number } = {}): Promise<RunLease | undefined> {
    const ttl = opts.ttlMs ?? 15_000;
    const path = join(this.runDir(runId), "owner.json");
    await fs.mkdir(this.runDir(runId), { recursive: true });
    const token = randomUUID();
    const claim = () => JSON.stringify({ owner: token, pid: process.pid, expiresAt: Date.now() + ttl });
    const mine = async (): Promise<boolean> => {
      try {
        return (JSON.parse(await fs.readFile(path, "utf8")) as { owner?: string }).owner === token;
      } catch {
        return false;
      }
    };
    try {
      await fs.writeFile(path, claim(), { flag: "wx" });
    } catch {
      try {
        const prev = JSON.parse(await fs.readFile(path, "utf8")) as { expiresAt?: number };
        if (typeof prev.expiresAt === "number" && prev.expiresAt > Date.now()) return undefined;
      } catch {
        // an unreadable claim counts as stale
      }
      await fs.writeFile(path, claim());
      if (!(await mine())) return undefined; // lost a simultaneous steal to another process
    }
    return {
      refresh: async () => {
        if (await mine()) await fs.writeFile(path, claim());
      },
      release: async () => {
        if (await mine()) await fs.rm(path, { force: true });
      },
    };
  }

  /** Rebuild a run's projections from its journal (used by `weft doctor`/repair). */
  async rebuildProjections(runId: string): Promise<void> {
    const records: JournalRecord[] = [];
    for await (const rec of this.read(runId)) records.push(rec);
    if (records.length === 0) return;
    const state = reduceState(records);
    await this.snapshot(runId, { state });
  }
}
