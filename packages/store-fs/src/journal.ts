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
      // Only newline-terminated lines are committed records: a writer killed
      // mid-write leaves a torn tail, which must never count (or the next append
      // would allocate past it and glue new JSON onto the fragment).
      const lines = raw.split("\n");
      for (let i = 0; i < lines.length - 1; i++) {
        byteOffset += Buffer.byteLength(lines[i] as string) + 1;
        if ((lines[i] as string).trim().length > 0) count++;
      }
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
    // Reconcile → truncate → write must be atomic ACROSS PROCESSES: without the
    // lock, a writer that reconciled before a peer's complete record landed would
    // "recover" that committed record as a torn tail and truncate it away.
    return this.withAppendLock(runId, async () => {
      await this.reconcile(runId, cached);
      // Anything on disk past the committed offset is a crashed writer's torn tail
      // (reconcile consumed every complete line): cut it or this append corrupts it
      // into an unparseable record that blocks resume and repair forever.
      try {
        const { size } = await fs.stat(this.journalPath(runId));
        if (size > cached.byteOffset) await fs.truncate(this.journalPath(runId), cached.byteOffset);
      } catch {
        // no journal yet
      }
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
    });
  }

  /**
   * A tiny cross-process mutex (exclusive-create of journal.lock) held for the few
   * milliseconds an append takes. A lock whose holder crashed goes stale and is
   * stolen after 10s; acquisition gives up loudly after 30s rather than hanging.
   */
  private async withAppendLock<T>(runId: string, fn: () => Promise<T>): Promise<T> {
    const lockPath = join(this.runDir(runId), "journal.lock");
    const started = Date.now();
    for (;;) {
      try {
        closeSync(openSync(lockPath, "wx"));
        break;
      } catch {
        try {
          const age = Date.now() - (await fs.stat(lockPath)).mtimeMs;
          if (age > 10_000) {
            // Identity-safe steal: RENAME the stale file aside — of two contenders
            // only one rename succeeds, so a plain rm can never delete the FRESH
            // lock a faster contender just created at the same path. If what we
            // grabbed turns out fresh after all (created inside our stat window),
            // put it back for its owner.
            const aside = `${lockPath}.stale-${randomUUID().slice(0, 8)}`;
            await fs.rename(lockPath, aside);
            const grabbedAge = Date.now() - (await fs.stat(aside)).mtimeMs;
            if (grabbedAge > 10_000) await fs.rm(aside, { force: true });
            else await fs.rename(aside, lockPath);
            continue; // then retry the exclusive create at once
          }
        } catch {
          continue; // released or stolen between our attempts: retry at once
        }
        if (Date.now() - started > 30_000) {
          throw new Error(`run ${runId}: journal append lock held too long (journal.lock)`);
        }
        await new Promise((resolve) => setTimeout(resolve, 5 + Math.random() * 15));
      }
    }
    try {
      return await fn();
    } finally {
      await fs.rm(lockPath, { force: true }).catch(() => undefined);
    }
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
    // The final element is "" when the file ends with \n, or a crashed writer's
    // torn fragment — either way, never a committed record.
    const lines = raw.split("\n");
    for (let i = 0; i < lines.length - 1; i++) {
      const line = lines[i] as string;
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
        // Out-of-process writers: pick up lines beyond our cache. The append cache is
        // deliberately NOT touched here — advancing count without byteOffset would make
        // the next append's reconcile() re-count these very lines and skip indices;
        // reconcile() folds external growth into both fields together.
        for await (const rec of this.read(runId, cursor)) {
          cursor = rec.i + 1;
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
   * owner died expires on its own and can be stolen. Every write of the claim is an
   * atomic rename, so a reader can never observe a truncated claim and mistake a live
   * owner for a stale one; refreshes and steals verify their own token AFTER writing,
   * so of two simultaneous writers exactly one keeps believing it owns the run.
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
    const writeClaim = async (): Promise<void> => {
      const tmp = `${path}.${token.slice(0, 8)}.tmp`;
      await fs.writeFile(tmp, claim());
      await fs.rename(tmp, path);
    };
    try {
      // Exclusive create settles the common fresh-run case atomically.
      await fs.writeFile(path, claim(), { flag: "wx" });
    } catch {
      try {
        const prev = JSON.parse(await fs.readFile(path, "utf8")) as { expiresAt?: number };
        if (typeof prev.expiresAt === "number" && prev.expiresAt > Date.now()) return undefined;
      } catch {
        // claims are written atomically, so unreadable means corrupt — treat as stale
      }
      await writeClaim();
      if (!(await mine())) return undefined; // lost a simultaneous steal to another process
    }
    return {
      refresh: async () => {
        if (!(await mine())) return; // the claim was stolen or released — never clobber it
        // If a thief renames between the check and this rename, whoever landed LAST
        // holds the file — the other side's next mine() is false and it stops renewing,
        // so exactly one owner survives the race.
        await writeClaim();
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
