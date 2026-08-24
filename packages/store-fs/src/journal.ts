import { randomUUID } from "node:crypto";
import { closeSync, promises as fs, fsyncSync, openSync, writeSync } from "node:fs";
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
} from "@techery/weft-core";
import { type RunState, reduceState } from "@techery/weft-core";

interface RunCache {
  count: number;
  byteOffset: number;
  watchers: Set<(records: JournalRecord[]) => void>;
}

/** True only for genuine path ABSENCE — the one condition safe to read as "no journal". */
function absent(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException).code;
  return code === "ENOENT" || code === "ENOTDIR";
}

/** Live view of a held file lock: `held()` turns false when renewal fails past the stale threshold. */
interface LockMutex {
  held(): boolean;
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
    } catch (err) {
      // Only ABSENCE means "no journal yet". EACCES/EIO would seed a zero cache
      // over a real journal — the next append's reconcile-and-truncate would
      // then be reasoning from a lie about a file it cannot even read.
      if (!absent(err)) throw err;
    }
    cached = { count, byteOffset, watchers: new Set() };
    this.cache.set(runId, cached);
    return cached;
  }

  async append(runId: string, events: JournalEvent[]): Promise<JournalRecord[]> {
    return (await this.appendLocked(runId, events)) as JournalRecord[];
  }

  async appendIf(
    runId: string,
    expectedCount: number,
    events: JournalEvent[],
  ): Promise<JournalRecord[] | undefined> {
    return this.appendLocked(runId, events, expectedCount);
  }

  private async appendLocked(
    runId: string,
    events: JournalEvent[],
    expectedCount?: number,
  ): Promise<JournalRecord[] | undefined> {
    const cached = await this.loadCache(runId);
    await fs.mkdir(this.runDir(runId), { recursive: true });
    // Reconcile → truncate → write must be atomic ACROSS PROCESSES: without the
    // lock, a writer that reconciled before a peer's complete record landed would
    // "recover" that committed record as a torn tail and truncate it away.
    return this.withAppendLock(runId, async (mutex) => {
      await this.reconcile(runId, cached);
      // Conditional append (appendIf): the caller acted on a journal of
      // expectedCount records; anything a peer committed since invalidates that
      // read, so decline INSIDE the lock and let the caller re-fold.
      if (expectedCount !== undefined && cached.count !== expectedCount) return undefined;
      // A mutex whose renewal failed past the stale threshold may already belong
      // to another writer: truncating or appending now could cut or interleave
      // with THEIR records.
      if (!mutex.held()) throw new Error(`run ${runId}: append lock lost mid-operation`);
      // Anything on disk past the committed offset is a crashed writer's torn tail
      // (reconcile consumed every complete line): cut it or this append corrupts it
      // into an unparseable record that blocks resume and repair forever.
      try {
        const { size } = await fs.stat(this.journalPath(runId));
        if (size > cached.byteOffset) await fs.truncate(this.journalPath(runId), cached.byteOffset);
      } catch (err) {
        if (!absent(err)) throw err; // a stat failure is not "no journal yet"
      }
      // Indices are TENTATIVE until the payload is durably on disk: a stringify or
      // I/O failure that had already advanced the cache would poison every later
      // append (indices past the real count; appendIf never matching again).
      const at = Date.now();
      const base = cached.count;
      const records = events.map((ev, offset) => {
        const rec: JournalRecord = { i: base + offset, at, ev };
        return rec;
      });
      const payload = Buffer.from(records.map((r) => JSON.stringify(r)).join("\n") + "\n");
      const fd = openSync(this.journalPath(runId), "a");
      try {
        // writeSync may return SHORT without throwing; treating a partial write
        // as landed would fsync torn JSON and advance the cache past bytes that
        // never hit the file — loop until the whole payload is down.
        let written = 0;
        while (written < payload.length) {
          written += writeSync(fd, payload, written, payload.length - written);
        }
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      cached.count = base + records.length;
      cached.byteOffset += payload.length;
      for (const w of cached.watchers) w(records);
      return records;
    });
  }

  private withAppendLock<T>(runId: string, fn: (mutex: LockMutex) => Promise<T>): Promise<T> {
    return this.withFileLock(join(this.runDir(runId), "journal.lock"), `run ${runId}`, fn);
  }

  /**
   * A tiny cross-process mutex (exclusive-create of the lock file) held for the
   * few milliseconds an append or a lease operation takes. A holder RENEWS the
   * lock's mtime every 2.5s while it works, so staleness (10s) only ever expires
   * a holder whose process died — never one merely slowed by a huge reconcile or
   * sluggish storage. (A process frozen whole — SIGSTOP, VM pause — longer than
   * the renewal slack can still be expired; the owner-checked release below keeps
   * even that from cascading.) Acquisition gives up loudly after 30s rather than
   * hanging.
   */
  private async withFileLock<T>(
    lockPath: string,
    what: string,
    fn: (mutex: LockMutex) => Promise<T>,
  ): Promise<T> {
    const token = randomUUID();
    const started = Date.now();
    for (;;) {
      // Checked at the TOP so every retry path — the stat-failure `continue`
      // included — passes the deadline instead of spinning past it.
      if (Date.now() - started > 30_000) {
        throw new Error(`${what}: lock held too long (${lockPath})`);
      }
      try {
        const fd = openSync(lockPath, "wx");
        try {
          // Looped like the journal write: a torn token would fail the
          // owner-checked release and strand our own lock until staleness.
          const tokenBuf = Buffer.from(token);
          let written = 0;
          while (written < tokenBuf.length) {
            written += writeSync(fd, tokenBuf, written, tokenBuf.length - written);
          }
        } finally {
          closeSync(fd);
        }
        break;
      } catch (err) {
        // Only CONTENTION retries. EACCES, EROFS, ENOSPC and friends would loop
        // here forever — the filesystem is broken, not busy; surface it.
        if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
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
            if (grabbedAge > 10_000) {
              await fs.rm(aside, { force: true });
            } else {
              // Fresh after all (renewed inside our stat window): put it back
              // WITHOUT clobbering — link() fails where a rename() would
              // silently REPLACE a lock a faster contender created during the
              // gap, handing two processes the same critical section. If a
              // contender did squeeze in, its lock stands; the orphaned copy
              // is removed (owner-checked release consults the PATH, never it).
              try {
                await fs.link(aside, lockPath);
              } catch (err) {
                if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
              }
              await fs.rm(aside, { force: true });
            }
            continue; // then retry the exclusive create at once
          }
        } catch {
          continue; // released or stolen between our attempts: retry at once
        }
        if (Date.now() - started > 30_000) {
          throw new Error(`${what}: lock held too long (${lockPath})`);
        }
        await new Promise((resolve) => setTimeout(resolve, 5 + Math.random() * 15));
      }
    }
    // Keep the held lock visibly alive: contenders judge staleness by mtime, and
    // without renewal a slow critical section would get "stolen" mid-write.
    // Renewal FAILURES are counted: four misses span the 10s stale threshold,
    // after which a contender may legitimately steal the lock — the critical
    // section no longer holds the mutex and must stop mutating shared state.
    let renewalMisses = 0;
    let lost = false;
    const renew = setInterval(() => {
      // Renewal verifies IDENTITY first: a process paused past the stale
      // threshold (SIGSTOP, VM freeze) can wake to find its lock stolen and
      // replaced — blindly touching mtime then would renew the CONTENDER's
      // lock and hide the theft.
      void fs
        .readFile(lockPath, "utf8")
        .then((holder) => {
          if (holder !== token) {
            lost = true;
            return;
          }
          const now = new Date();
          return fs.utimes(lockPath, now, now).then(() => {
            renewalMisses = 0;
          });
        })
        .catch(() => {
          renewalMisses++;
          if (renewalMisses >= 4) lost = true;
        });
    }, 2_500);
    renew.unref?.();
    const mutex: LockMutex = { held: () => !lost };
    try {
      const result = await fn(mutex);
      if (lost) {
        throw new Error(`${what}: lock renewal failed and the mutex may be stolen (${lockPath})`);
      }
      return result;
    } finally {
      clearInterval(renew);
      // Owner-checked release: if this append overran the stale threshold and lost
      // the lock to a contender, removing by pathname would delete the NEW owner's
      // lock and let a third writer in — remove only a lock that is still ours.
      await fs
        .readFile(lockPath, "utf8")
        .then((held) => (held === token ? fs.rm(lockPath, { force: true }) : undefined))
        .catch(() => undefined);
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
    } catch (err) {
      if (!absent(err)) throw err;
      return; // no journal yet
    }
    if (size <= cached.byteOffset) return;
    const fh = await fs.open(this.journalPath(runId), "r");
    try {
      const buf = Buffer.alloc(size - cached.byteOffset);
      // read() may return SHORT: parsing the zero-filled remainder would stop
      // the fold mid-file, and appendLocked would then truncate the committed
      // records past it as a "torn tail". Loop until the range is consumed
      // (bytesRead 0 = the file shrank since stat; fold only what arrived).
      let filled = 0;
      while (filled < buf.length) {
        const { bytesRead } = await fh.read(buf, filled, buf.length - filled, cached.byteOffset + filled);
        if (bytesRead === 0) break;
        filled += bytesRead;
      }
      const lines = buf.toString("utf8", 0, filled).split("\n");
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
    } catch (err) {
      // An absent journal reads as an empty run; an UNREADABLE one must not —
      // resume/state/indexing would report a durable run as "not found" and
      // hide the storage failure.
      if (!absent(err)) throw err;
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
    // One abort listener for the whole watch: registering inside the loop would leave
    // an unfired closure behind on every poll wake-up, growing for as long as the
    // watched run stays suspended.
    const onAbort = () => wake?.();
    opts.signal?.addEventListener("abort", onAbort);
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
          if (opts.signal?.aborted) resolve(); // aborted inside this iteration
        });
        wake = undefined;
      }
    } finally {
      opts.signal?.removeEventListener("abort", onAbort);
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
    } catch (err) {
      // A runs directory that does not exist yet lists nothing; one that cannot
      // be READ must not masquerade as empty.
      if (!absent(err)) throw err;
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
    // Prefer the state.json projection — while it is FRESH. An append can land
    // (fsynced) with its follow-up snapshot lost to a crash, and a stale
    // projection would then report a terminal run as executing forever. A
    // journal newer than the projection folds the journal instead; that costs a
    // read only for runs whose journal moved past their last snapshot.
    try {
      const statePath = join(this.runDir(runId), "state.json");
      const [projStat, jStat] = await Promise.all([fs.stat(statePath), fs.stat(this.journalPath(runId))]);
      if (jStat.mtimeMs <= projStat.mtimeMs) {
        const raw = await fs.readFile(statePath, "utf8");
        const state = JSON.parse(raw) as RunState;
        return {
          runId,
          workflow: state.workflow,
          status: state.status,
          createdAt: state.createdAt,
          updatedAt: Math.max(state.updatedAt, jStat.mtimeMs),
          ...(state.parentRunId ? { parentRunId: state.parentRunId } : {}),
        };
      }
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
    const publish = async () => {
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
    };
    // Atomic renames prevent torn files, not stale ORDER: an engine and a
    // daemon reducing the same run concurrently could let the older reduction
    // land last and stand until the next journal write. The reduction's covered
    // record count orders them (the journal is append-only), compared and
    // published under one cross-process lock.
    const covered = (projections.state as { records?: number } | undefined)?.records;
    if (typeof covered !== "number") return publish();
    return this.withFileLock(join(dir, "snapshot.lock"), `snapshot ${runId}`, async () => {
      try {
        const standing = JSON.parse(await fs.readFile(join(dir, "state.json"), "utf8")) as {
          records?: number;
        };
        if (typeof standing.records === "number" && standing.records > covered) return;
      } catch {
        // no standing snapshot (or an unreadable one): publish
      }
      await publish();
    });
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
    // Only ABSENCE is false: existsSync folds EACCES/ELOOP/EIO into "not
    // found", and callers (resume, cancel, the descendant pending walks) rely
    // on exists() to tell a never-journaled run from an UNREADABLE journal —
    // a storage failure must surface, not report the run missing.
    try {
      await fs.stat(this.journalPath(runId));
      return true;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ENOTDIR") return false;
      throw err;
    }
  }

  /**
   * Cross-process ownership: an owner.json claim with a TTL. A live claim refuses a
   * second owner (a daemon must not wake a run a CLI is executing); a claim whose
   * owner died expires on its own and can be taken over. EVERY claim operation —
   * acquire, takeover, refresh, release — runs under the same owner.lock mutex, so
   * each one is an atomic compare-and-swap on the claim: a refresh can never land
   * over a takeover that happened after its ownership check, and vice versa. A
   * refresh that finds a foreign token reports the loss (resolves false) so the
   * holder stops executing instead of writing to a journal that is no longer its.
   */
  async acquireRun(runId: string, opts: { ttlMs?: number } = {}): Promise<RunLease | undefined> {
    const ttl = opts.ttlMs ?? 15_000;
    const path = join(this.runDir(runId), "owner.json");
    const lockPath = join(this.runDir(runId), "owner.lock");
    await fs.mkdir(this.runDir(runId), { recursive: true });
    const token = randomUUID();
    const claim = () => JSON.stringify({ owner: token, pid: process.pid, expiresAt: Date.now() + ttl });
    const readOwner = async (): Promise<{ owner?: string; expiresAt?: number } | undefined> => {
      let raw: string;
      try {
        raw = await fs.readFile(path, "utf8");
      } catch (err) {
        // Claims are written atomically (tmp+rename), so only ABSENCE means
        // unowned. An EIO/EACCES — or the parse failure below — must abort the
        // operation: reading it as "no owner" would authorize overwriting a
        // still-live claim and set two processes on the same run.
        if (!absent(err)) throw err;
        return undefined;
      }
      return JSON.parse(raw) as { owner?: string; expiresAt?: number };
    };
    const writeClaim = async (): Promise<void> => {
      // Atomic rename so a crash mid-write can never leave a torn claim behind.
      const tmp = `${path}.${token.slice(0, 8)}.tmp`;
      await fs.writeFile(tmp, claim());
      await fs.rename(tmp, path);
    };
    const guard = <T>(fn: (mutex: LockMutex) => Promise<T>): Promise<T> =>
      this.withFileLock(lockPath, `run ${runId}`, fn);
    // Every owner mutation re-checks the mutex right before writing: a lock
    // whose renewal failed past the stale threshold may already be a
    // contender's, and writing then would evict a live claim.
    const acquired = await guard(async (mutex) => {
      const prev = await readOwner();
      if (prev && typeof prev.expiresAt === "number" && prev.expiresAt > Date.now()) return false;
      if (!mutex.held()) throw new Error(`run ${runId}: owner lock lost mid-acquisition`);
      await writeClaim(); // free or expired: safe to take under the mutex
      return true;
    });
    if (!acquired) return undefined;
    return {
      refresh: () =>
        guard(async (mutex) => {
          // CAS: the expiry-based takeover above can move the claim to a new owner
          // the moment ours expires, so re-check IDENTITY inside the mutex — an
          // unconditional rewrite here would evict that owner mid-execution.
          if ((await readOwner())?.owner !== token) return false; // lost: caller must stop
          if (!mutex.held()) throw new Error(`run ${runId}: owner lock lost mid-refresh`);
          await writeClaim();
          return true;
        }),
      release: () =>
        guard(async (mutex) => {
          if ((await readOwner())?.owner === token && mutex.held()) await fs.rm(path, { force: true });
        }),
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
