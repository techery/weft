/**
 * Replay (C3, C4): resume re-executes the workflow code and serves completed steps
 * from the journal. Identity is `key` (explicit) or a content hash + occurrence.
 *
 *  - Fast path: same seq, same hash → serve.
 *  - Salvage: any unconsumed entry with the same hash → serve (+ replay.salvaged).
 *    Survives inserted/removed/reordered steps; rewording re-runs.
 *  - `--reuse key`: match by key alone, accepting deliberate staleness.
 *  - Live: everything else re-runs; orphaned entries stay for audit, never served.
 *
 * Cached completions are delivered in journaled completion order so continuations
 * and seq numbers reproduce; the first live dispatch breaks strict ordering (the
 * code has changed — determinism of the remainder is best-effort by design).
 */
import type { Usage } from "@weft/sdk";
import type { BlobRefJson, HumanRequestEvent, JournalRecord, StepKind } from "./events.ts";

export interface CompletedEntry {
  seq: number;
  hash: string;
  kind: StepKind;
  key?: string;
  output: unknown;
  usage?: Usage;
  sessionId?: string;
  transcriptRef?: BlobRefJson;
  patchRef?: string;
  attempts?: number;
  /** Journal index of the completing event = completion order. */
  order: number;
  consumed: boolean;
}

export interface HumanEntry {
  id: string;
  hash: string;
  seq: number;
  request: HumanRequestEvent;
  answer?: { answer: unknown; answeredBy: "human" | "policy" | "timeout"; order: number };
  consumed: boolean;
}

export interface ScheduledEntry {
  seq: number;
  hash: string;
  kind: StepKind;
  at: number;
  childRunId?: string;
  completed: boolean;
  consumed: boolean;
}

export interface SignalEntry {
  name: string;
  payload: unknown;
  order: number;
  consumed: boolean;
}

export type ReuseMode = "content" | "key";

export class ReplayIndex {
  readonly bySeq = new Map<number, CompletedEntry>();
  readonly byHash = new Map<string, CompletedEntry[]>();
  readonly byKey = new Map<string, CompletedEntry[]>();
  readonly humansByHash = new Map<string, HumanEntry[]>();
  readonly humansById = new Map<string, HumanEntry>();
  readonly scheduledByHash = new Map<string, ScheduledEntry[]>();
  readonly signalsByName = new Map<string, SignalEntry[]>();
  /** Total journaled usage, restored into the budget on resume. */
  totalUsage = { tokens: 0, usd: 0 };
  maxSeq = 0;
  maxHumanId = 0;
  maxJournalIndex = -1;
  entryCount = 0;

  static fromRecords(records: JournalRecord[]): ReplayIndex {
    const index = new ReplayIndex();
    const scheduledBySeq = new Map<number, ScheduledEntry & { key?: string }>();
    const signalNameBySeq = new Map<number, string>();
    const completedSignalNames: string[] = [];
    for (const rec of records) {
      index.maxJournalIndex = Math.max(index.maxJournalIndex, rec.i);
      const ev = rec.ev;
      switch (ev.type) {
        case "step.scheduled": {
          const entry: ScheduledEntry & { key?: string } = {
            seq: ev.seq,
            hash: ev.hash,
            kind: ev.kind,
            at: rec.at,
            completed: false,
            consumed: false,
            ...(ev.childRunId ? { childRunId: ev.childRunId } : {}),
            ...(ev.key ? { key: ev.key } : {}),
          };
          scheduledBySeq.set(ev.seq, entry);
          index.maxSeq = Math.max(index.maxSeq, ev.seq);
          const list = index.scheduledByHash.get(ev.hash) ?? [];
          list.push(entry);
          index.scheduledByHash.set(ev.hash, list);
          if (ev.kind === "signal") {
            const name = (ev.payload as { name?: string } | undefined)?.name;
            if (name !== undefined) signalNameBySeq.set(ev.seq, name);
          }
          break;
        }
        case "step.completed": {
          const sched = scheduledBySeq.get(ev.seq);
          if (!sched) break;
          sched.completed = true;
          if (sched.kind === "signal") {
            const name = signalNameBySeq.get(ev.seq);
            if (name !== undefined) completedSignalNames.push(name);
          }
          const entry: CompletedEntry = {
            seq: ev.seq,
            hash: sched.hash,
            kind: sched.kind,
            output: ev.output,
            order: rec.i,
            consumed: false,
            ...(sched.key !== undefined ? { key: sched.key } : {}),
            ...(ev.usage !== undefined ? { usage: ev.usage } : {}),
            ...(ev.sessionId !== undefined ? { sessionId: ev.sessionId } : {}),
            ...(ev.transcriptRef !== undefined ? { transcriptRef: ev.transcriptRef } : {}),
            ...(ev.patchRef !== undefined ? { patchRef: ev.patchRef } : {}),
            ...(ev.attempts !== undefined ? { attempts: ev.attempts } : {}),
          };
          index.bySeq.set(ev.seq, entry);
          const byHash = index.byHash.get(entry.hash) ?? [];
          byHash.push(entry);
          index.byHash.set(entry.hash, byHash);
          if (entry.key !== undefined) {
            const byKey = index.byKey.get(entry.key) ?? [];
            byKey.push(entry);
            index.byKey.set(entry.key, byKey);
          }
          if (ev.usage) {
            index.totalUsage.tokens += (ev.usage.input ?? 0) + (ev.usage.output ?? 0);
            index.totalUsage.usd += ev.usage.usd ?? 0;
          }
          index.entryCount++;
          break;
        }
        case "step.attempt": {
          // A retry record carries the FAILED previous attempt's spend — the
          // completion event never will, so restore it from here.
          if (ev.usage) {
            index.totalUsage.tokens += (ev.usage.input ?? 0) + (ev.usage.output ?? 0);
            index.totalUsage.usd += ev.usage.usd ?? 0;
          }
          break;
        }
        case "step.failed": {
          // A terminal failure's turns were charged live; the serialized error is
          // where that spend survives (attached by the repair loop).
          const usage = (ev.error.detail as { usage?: Usage } | undefined)?.usage;
          if (usage) {
            index.totalUsage.tokens += (usage.input ?? 0) + (usage.output ?? 0);
            index.totalUsage.usd += usage.usd ?? 0;
          }
          break;
        }
        case "human.requested": {
          const entry: HumanEntry = { id: ev.id, hash: ev.hash, seq: ev.seq, request: ev, consumed: false };
          const list = index.humansByHash.get(ev.hash) ?? [];
          list.push(entry);
          index.humansByHash.set(ev.hash, list);
          index.humansById.set(ev.id, entry);
          index.maxSeq = Math.max(index.maxSeq, ev.seq);
          const num = /^h(\d+)$/.exec(ev.id);
          if (num) index.maxHumanId = Math.max(index.maxHumanId, Number(num[1]));
          index.entryCount++;
          break;
        }
        case "human.answered": {
          const entry = index.humansById.get(ev.id);
          if (entry) entry.answer = { answer: ev.answer, answeredBy: ev.answeredBy, order: rec.i };
          break;
        }
        case "human.rejected": {
          // The owner refused this answer against the real schema: the request is open
          // again, and only a later replacement answer (if any) counts.
          const entry = index.humansById.get(ev.id);
          if (entry) delete entry.answer;
          break;
        }
        case "signal.received": {
          const list = index.signalsByName.get(ev.name) ?? [];
          list.push({ name: ev.name, payload: ev.payload, order: rec.i, consumed: false });
          index.signalsByName.set(ev.name, list);
          break;
        }
        default:
          break;
      }
    }
    // A completed signal step already consumed its buffered signal.received in the
    // original run; consume it here too so a later live wait cannot re-take it.
    for (const name of completedSignalNames) index.takeSignal(name);
    return index;
  }

  /** All journaled completion orders (completed steps + answered humans), ascending. */
  completionOrders(): number[] {
    const orders: number[] = [];
    for (const entry of this.bySeq.values()) orders.push(entry.order);
    for (const entry of this.humansById.values()) if (entry.answer) orders.push(entry.answer.order);
    return orders.sort((a, b) => a - b);
  }

  matchStep(
    seq: number,
    hash: string,
    kind: StepKind,
    key: string | undefined,
    reuse: ReuseMode,
  ): { entry: CompletedEntry; via: "seq" | "salvage" | "key" } | undefined {
    const fast = this.bySeq.get(seq);
    if (fast && !fast.consumed && fast.hash === hash && fast.kind === kind) {
      return { entry: fast, via: "seq" };
    }
    const byHash = this.byHash.get(hash);
    if (byHash) {
      const entry = byHash.find((e) => !e.consumed && e.kind === kind);
      if (entry) return { entry, via: entry.seq === seq ? "seq" : "salvage" };
    }
    if (reuse === "key" && key !== undefined) {
      const byKey = this.byKey.get(key);
      if (byKey) {
        const entry = byKey.find((e) => !e.consumed && e.kind === kind);
        if (entry) return { entry, via: "key" };
      }
    }
    return undefined;
  }

  matchHuman(hash: string): HumanEntry | undefined {
    return this.humansByHash.get(hash)?.find((e) => !e.consumed);
  }

  matchIncompleteScheduled(hash: string, kind: StepKind): ScheduledEntry | undefined {
    return this.scheduledByHash.get(hash)?.find((e) => !e.consumed && !e.completed && e.kind === kind);
  }

  takeSignal(name: string): SignalEntry | undefined {
    const entry = this.signalsByName.get(name)?.find((e) => !e.consumed);
    if (entry) entry.consumed = true;
    return entry;
  }
}

/**
 * Delivers cached completions in journaled order while replay is "pure" (no live
 * dispatch yet). A stall — an order the edited code never requests — is broken by a
 * quiescence watchdog rather than deadlocking; the first live dispatch flushes
 * everything (strict ordering is meaningless once new work interleaves).
 */
export class OrderedDelivery {
  private orders: number[];
  private cursor = 0;
  private parked = new Map<number, () => void>();
  private strict: boolean;
  private watchdog: NodeJS.Timeout | undefined;
  private lastProgress = 0;

  constructor(
    orders: number[],
    private readonly inflightLive: () => number,
  ) {
    this.orders = orders;
    this.strict = orders.length > 0;
  }

  async deliver(order: number): Promise<void> {
    if (!this.strict) return;
    const expected = this.expected();
    if (expected === undefined || order < expected) {
      // Past the schedule (or skipped over by the watchdog): deliver immediately.
      this.lastProgress++;
      return;
    }
    if (order === expected) {
      this.advancePast(order);
      return;
    }
    await new Promise<void>((resolve) => {
      this.parked.set(order, resolve);
      this.armWatchdog();
    });
  }

  /** A live step dispatched: ordering can no longer be reproduced — flush everything. */
  breakOrder(): void {
    if (!this.strict) return;
    this.strict = false;
    if (this.watchdog) clearTimeout(this.watchdog);
    const parked = [...this.parked.entries()].sort((a, b) => a[0] - b[0]);
    this.parked.clear();
    for (const [, resolve] of parked) resolve();
  }

  private expected(): number | undefined {
    return this.orders[this.cursor];
  }

  private advancePast(order: number): void {
    while (this.cursor < this.orders.length && this.orders[this.cursor]! <= order) this.cursor++;
    this.lastProgress++;
    this.flush();
  }

  private flush(): void {
    for (;;) {
      const expected = this.expected();
      if (expected === undefined) {
        for (const [, resolve] of [...this.parked.entries()].sort((a, b) => a[0] - b[0])) resolve();
        this.parked.clear();
        return;
      }
      // Stragglers below the expected order (skipped over by the watchdog) never
      // get their turn — release them immediately.
      for (const order of [...this.parked.keys()].sort((a, b) => a - b)) {
        if (order >= expected) break;
        const resolve = this.parked.get(order)!;
        this.parked.delete(order);
        this.lastProgress++;
        resolve();
      }
      const resolve = this.parked.get(expected);
      if (!resolve) return;
      this.parked.delete(expected);
      this.cursor++;
      this.lastProgress++;
      resolve();
    }
  }

  private quietChecks = 0;

  private armWatchdog(): void {
    if (this.watchdog || !this.strict) return;
    const seen = this.lastProgress;
    this.watchdog = setTimeout(() => {
      this.watchdog = undefined;
      if (!this.strict || this.parked.size === 0) return;
      if (this.lastProgress === seen && this.inflightLive() === 0) {
        // Two consecutive quiet checks with parked deliveries: the expected order
        // was edited away — skip forward rather than deadlock.
        this.quietChecks++;
        if (this.quietChecks >= 2) {
          this.quietChecks = 0;
          const smallest = Math.min(...this.parked.keys());
          while (this.cursor < this.orders.length && this.orders[this.cursor]! < smallest) this.cursor++;
          this.flush();
        }
      } else {
        this.quietChecks = 0;
      }
      if (this.parked.size > 0) this.armWatchdog();
    }, 50);
    // Deliberately NOT unref'd: while a delivery is parked this timer may be the
    // only handle keeping a one-shot resume process alive; unref'ing it lets Node
    // exit 0 with the run half-replayed. It re-arms only while parked deliveries
    // exist, so it never outlives the replay.
  }
}
