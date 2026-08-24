/**
 * Store contracts. The fs implementations live in @techery/weft-store-fs; the in-memory
 * implementations here back tests and @techery/weft-testing. Only the journal must
 * survive — projections are re-derivable.
 */
import { sha256Hex } from "./canonical.ts";
import type { JournalEvent, JournalRecord, RunStatus } from "./events.ts";

export interface RunSummary {
  runId: string;
  workflow: string;
  status: RunStatus;
  createdAt: number;
  updatedAt: number;
  parentRunId?: string;
}

export interface RunListFilter {
  status?: RunStatus;
  workflow?: string;
  limit?: number;
}

export interface Projections {
  state?: unknown;
  tree?: unknown;
  report?: string;
}

/** A live claim on a run. The holder refreshes it while executing and releases it at the end. */
export interface RunLease {
  /**
   * Extend the claim; called periodically while the run stays active. Resolves
   * false when the claim now belongs to someone else (it expired and was taken
   * over) — the holder must STOP executing the run, not merely stop renewing:
   * another process may already be appending to the journal.
   */
  refresh(): Promise<boolean>;
  release(): Promise<void>;
}

export interface JournalStore {
  /** Atomic append of a batch; assigns monotonic indices; returns the appended records. */
  append(runId: string, events: JournalEvent[]): Promise<JournalRecord[]>;
  /**
   * Conditional append for writers racing the run's owner: append only while the
   * journal still holds exactly `expectedCount` records, otherwise write nothing
   * and return undefined. Lets a non-owner (a CLI cancelling a daemon-owned run)
   * re-check the folded status it acted on and the append land as one atomic
   * step, so a terminal event committed in the read/write gap can never be
   * overridden. Optional: a store without it accepts that (tiny) race.
   */
  appendIf?(
    runId: string,
    expectedCount: number,
    events: JournalEvent[],
  ): Promise<JournalRecord[] | undefined>;
  read(runId: string, fromIndex?: number): AsyncIterable<JournalRecord>;
  /** Live-follow a run's journal (yields records already present, then new ones). */
  watch(runId: string, opts?: { fromIndex?: number; signal?: AbortSignal }): AsyncIterable<JournalRecord>;
  list(filter?: RunListFilter): Promise<RunSummary[]>;
  /** Persist derived projections (state.json / tree.json / report.md). Never replaces replay. */
  snapshot(runId: string, projections: Projections): Promise<void>;
  /** Read back the last snapshot; absent for stores/runs that never snapshotted. */
  readSnapshot?(runId: string): Promise<Projections | undefined>;
  /** True when the run has at least one journal record. */
  exists(runId: string): Promise<boolean>;
  /**
   * Best-effort single-owner coordination: claim a run before EXECUTING it (appending
   * answers/signals needs no claim). Returns undefined while another live claim holds,
   * so a second process cannot wake a run into concurrent double execution. Claims
   * expire on their own if the owner dies. Optional: a store without it relies on its
   * host to not double-run.
   */
  acquireRun?(runId: string, opts?: { ttlMs?: number }): Promise<RunLease | undefined>;
}

export interface BlobMeta {
  kind?: string;
  contentType?: string;
}

export interface BlobRef {
  hash: string;
  size: number;
}

export interface BlobStore {
  put(bytes: Uint8Array | string, meta?: BlobMeta): Promise<BlobRef>;
  get(ref: string): Promise<Uint8Array>;
  getText(ref: string): Promise<string>;
  has(ref: string): Promise<boolean>;
}

// ---------------------------------------------------------------------------
// In-memory implementations (tests, @techery/weft-testing)
// ---------------------------------------------------------------------------

interface MemoryRun {
  records: JournalRecord[];
  projections: Projections;
  watchers: Set<(r: JournalRecord) => void>;
}

export class MemoryJournalStore implements JournalStore {
  private runs = new Map<string, MemoryRun>();
  private owners = new Map<string, symbol>();
  private now: () => number;

  constructor(opts: { now?: () => number } = {}) {
    this.now = opts.now ?? Date.now;
  }

  /** In one process a claim never goes stale, so it holds until released. */
  async acquireRun(runId: string): Promise<RunLease | undefined> {
    if (this.owners.has(runId)) return undefined;
    const token = Symbol(runId);
    this.owners.set(runId, token);
    return {
      refresh: async () => this.owners.get(runId) === token,
      release: async () => {
        if (this.owners.get(runId) === token) this.owners.delete(runId);
      },
    };
  }

  private runFor(runId: string): MemoryRun {
    let run = this.runs.get(runId);
    if (!run) {
      run = { records: [], projections: {}, watchers: new Set() };
      this.runs.set(runId, run);
    }
    return run;
  }

  async append(runId: string, events: JournalEvent[]): Promise<JournalRecord[]> {
    const run = this.runFor(runId);
    const at = this.now();
    const appended = events.map((ev) => {
      const rec: JournalRecord = { i: run.records.length, at, ev };
      run.records.push(rec);
      return rec;
    });
    for (const rec of appended) for (const w of run.watchers) w(rec);
    return appended;
  }

  async appendIf(
    runId: string,
    expectedCount: number,
    events: JournalEvent[],
  ): Promise<JournalRecord[] | undefined> {
    // Single-threaded: length check and append share one synchronous section.
    if (this.runFor(runId).records.length !== expectedCount) return undefined;
    return this.append(runId, events);
  }

  async *read(runId: string, fromIndex = 0): AsyncIterable<JournalRecord> {
    const run = this.runs.get(runId);
    if (!run) return;
    for (const rec of run.records.slice(fromIndex)) yield rec;
  }

  async *watch(
    runId: string,
    opts: { fromIndex?: number; signal?: AbortSignal } = {},
  ): AsyncIterable<JournalRecord> {
    const run = this.runFor(runId);
    let cursor = opts.fromIndex ?? 0;
    const queue: JournalRecord[] = [];
    let wake: (() => void) | undefined;
    const listener = (r: JournalRecord) => {
      queue.push(r);
      wake?.();
    };
    run.watchers.add(listener);
    // One abort listener for the whole watch: one per loop iteration would pile up
    // an unfired closure every time a record (not the abort) woke the wait.
    const onAbort = () => wake?.();
    opts.signal?.addEventListener("abort", onAbort);
    try {
      while (!opts.signal?.aborted) {
        while (cursor < run.records.length) yield run.records[cursor++]!;
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
      run.watchers.delete(listener);
    }
  }

  async list(filter: RunListFilter = {}): Promise<RunSummary[]> {
    const out: RunSummary[] = [];
    for (const [runId, run] of this.runs) {
      if (run.records.length === 0) continue;
      let workflow = "";
      let status: RunStatus = "planning";
      let parentRunId: string | undefined;
      for (const rec of run.records) {
        if (rec.ev.type === "run.created") {
          workflow = rec.ev.workflow.name;
          parentRunId = rec.ev.parentRunId;
        } else if (rec.ev.type === "run.status") status = rec.ev.status;
        else if (rec.ev.type === "run.completed") status = "complete";
        else if (rec.ev.type === "run.failed") status = "failed";
        else if (rec.ev.type === "run.cancelled") status = "cancelled";
      }
      if (filter.status && status !== filter.status) continue;
      if (filter.workflow && workflow !== filter.workflow) continue;
      out.push({
        runId,
        workflow,
        status,
        createdAt: run.records[0]!.at,
        updatedAt: run.records[run.records.length - 1]!.at,
        ...(parentRunId ? { parentRunId } : {}),
      });
    }
    out.sort((a, b) => b.createdAt - a.createdAt);
    return filter.limit ? out.slice(0, filter.limit) : out;
  }

  async snapshot(runId: string, projections: Projections): Promise<void> {
    const run = this.runFor(runId);
    // The journal is append-only, so a reduction covering fewer records is
    // OLDER: publishing it over a newer one would freeze a stale status.
    const covered = (projections.state as { records?: number } | undefined)?.records;
    const standing = (run.projections.state as { records?: number } | undefined)?.records;
    if (typeof covered === "number" && typeof standing === "number" && standing > covered) return;
    Object.assign(run.projections, projections);
  }

  async readSnapshot(runId: string): Promise<Projections | undefined> {
    return this.runs.get(runId)?.projections;
  }

  async exists(runId: string): Promise<boolean> {
    return (this.runs.get(runId)?.records.length ?? 0) > 0;
  }
}

export class MemoryBlobStore implements BlobStore {
  private blobs = new Map<string, Uint8Array>();

  async put(bytes: Uint8Array | string): Promise<BlobRef> {
    const data = typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes;
    const hash = sha256Hex(data);
    this.blobs.set(hash, data);
    return { hash, size: data.byteLength };
  }

  async get(ref: string): Promise<Uint8Array> {
    const data = this.blobs.get(ref);
    if (!data) throw new Error(`blob not found: ${ref}`);
    return data;
  }

  async getText(ref: string): Promise<string> {
    return new TextDecoder().decode(await this.get(ref));
  }

  async has(ref: string): Promise<boolean> {
    return this.blobs.has(ref);
  }
}
