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
import type { Usage } from "@techery/weft-sdk";
import type {
  BlobRefJson,
  HumanRequestEvent,
  HumanReviewFileEdit,
  JournalRecord,
  StepKind,
} from "./events.ts";

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
  /** The child run this step's SCHEDULED record named (workflow steps). */
  childRunId?: string;
  /** Journal index of the completing event = completion order. */
  order: number;
  consumed: boolean;
  /** False after a settlement failure, so a later successful replay can repair projections. */
  settled: boolean;
}

export interface HumanEntry {
  id: string;
  hash: string;
  seq: number;
  key?: string;
  request: HumanRequestEvent;
  answer?: {
    answer: unknown;
    answeredBy: "human" | "policy" | "timeout";
    order: number;
    reviewEdit?: HumanReviewFileEdit;
  };
  consumed: boolean;
  superseded: boolean;
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
  readonly humansByKey = new Map<string, HumanEntry[]>();
  readonly scheduledByHash = new Map<string, ScheduledEntry[]>();
  readonly signalsByName = new Map<string, SignalEntry[]>();
  /**
   * Total journaled usage, restored into the budget on resume. `samples` counts
   * the charged calls it came from, so reserveCall's observed-average gate keeps
   * an honest denominator after a resume.
   */
  totalUsage = { tokens: 0, usd: 0, samples: 0 };
  /**
   * baseTree of every journaled patch.merged. A resultTree found in here was
   * CONSUMED by a later journaled merge — that later patch may edit the very
   * lines the earlier one introduced, so a failed reverse-apply of the earlier
   * patch does not mean its integration is gone.
   */
  readonly mergedBaseTrees = new Set<string>();
  maxSeq = 0;
  maxHumanId = 0;
  maxJournalIndex = -1;
  entryCount = 0;

  static fromRecords(records: JournalRecord[]): ReplayIndex {
    const index = new ReplayIndex();
    const scheduledBySeq = new Map<number, ScheduledEntry & { key?: string }>();
    const latestScheduledOrderBySeq = new Map<number, number>();
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
          latestScheduledOrderBySeq.set(ev.seq, rec.i);
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
            settled: false,
            ...(sched.key !== undefined ? { key: sched.key } : {}),
            ...(sched.childRunId !== undefined ? { childRunId: sched.childRunId } : {}),
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
            // A child-workflow roll-up aggregates the child's WHOLE spend: count
            // its real calls, or the restored per-call average balloons.
            index.totalUsage.samples += ev.usage.samples ?? 1;
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
            index.totalUsage.samples += ev.usage.samples ?? 1;
          }
          break;
        }
        case "step.failed": {
          const completed = index.bySeq.get(ev.seq);
          // A settlement failure must retain the exact completed output: replaying it
          // retries the journaled side effects without paying the provider again. Old
          // journals predate `phase`; a completion newer than the latest schedule is
          // the unambiguous completed -> failed settlement sequence.
          const settlementFailure =
            ev.phase === "settle" ||
            (ev.phase === undefined &&
              completed !== undefined &&
              completed.order > (latestScheduledOrderBySeq.get(ev.seq) ?? -1));
          if (completed && settlementFailure) {
            completed.settled = false;
          } else if (completed) {
            index.bySeq.delete(ev.seq);
            index.byHash.set(
              completed.hash,
              (index.byHash.get(completed.hash) ?? []).filter((entry) => entry !== completed),
            );
            if (completed.key !== undefined) {
              index.byKey.set(
                completed.key,
                (index.byKey.get(completed.key) ?? []).filter((entry) => entry !== completed),
              );
            }
            index.entryCount--;
          }
          // A terminal failure's turns were charged live; the serialized error is
          // where that spend survives (attached by the repair loop).
          const usage = (ev.error.detail as { usage?: Usage } | undefined)?.usage;
          if (usage) {
            index.totalUsage.tokens += (usage.input ?? 0) + (usage.output ?? 0);
            index.totalUsage.usd += usage.usd ?? 0;
            index.totalUsage.samples += usage.samples ?? 1;
          }
          break;
        }
        case "step.settled": {
          const completed = index.bySeq.get(ev.seq);
          if (completed) completed.settled = true;
          break;
        }
        case "human.requested": {
          const entry: HumanEntry = {
            id: ev.id,
            hash: ev.hash,
            seq: ev.seq,
            request: ev,
            consumed: false,
            superseded: false,
            ...(ev.key !== undefined ? { key: ev.key } : {}),
          };
          const list = index.humansByHash.get(ev.hash) ?? [];
          list.push(entry);
          index.humansByHash.set(ev.hash, list);
          index.humansById.set(ev.id, entry);
          if (ev.key !== undefined) {
            const keyed = index.humansByKey.get(ev.key) ?? [];
            keyed.push(entry);
            index.humansByKey.set(ev.key, keyed);
          }
          index.maxSeq = Math.max(index.maxSeq, ev.seq);
          const num = /^h(\d+)$/.exec(ev.id);
          if (num) index.maxHumanId = Math.max(index.maxHumanId, Number(num[1]));
          index.entryCount++;
          break;
        }
        case "human.superseded": {
          const entry = index.humansById.get(ev.id);
          if (entry) entry.superseded = true;
          break;
        }
        case "human.answered": {
          // FIRST standing answer wins: two processes racing past the answered-guard
          // can both append, and the owner delivered the first — replay must agree.
          // A rejection clears the slot, so a post-rejection replacement still fills.
          const entry = index.humansById.get(ev.id);
          if (entry && entry.answer === undefined) {
            entry.answer = {
              answer: ev.answer,
              answeredBy: ev.answeredBy,
              order: rec.i,
              ...(ev.reviewEdit !== undefined ? { reviewEdit: ev.reviewEdit } : {}),
            };
          }
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
        case "signal.rejected": {
          // The refused delivery was consumed even though its step failed:
          // processed in journal order, this marks exactly the payload the
          // failed step took, so a corrected one appended later is next in line.
          index.takeSignal(ev.name);
          break;
        }
        case "patch.merged": {
          index.mergedBaseTrees.add(ev.baseTree);
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
    /**
     * True when the workflow script is byte-identical to the one that produced this
     * journal. Step positions only mean something under that condition.
     */
    positionsTrusted = true,
  ): { entry: CompletedEntry; via: "seq" | "salvage" | "key"; ambiguous?: true } | undefined {
    const sameKind = (this.byHash.get(hash) ?? []).filter((e) => e.kind === kind);
    /**
     * A KEYLESS step is identified by its content alone, so two call sites sharing a
     * prompt and schema are indistinguishable here — and an agent step reads the
     * repository, so "same prompt" never means "same world". Two ways that bites:
     *
     *  - Off-position (salvage): the match is picked by journal order, so a later call
     *    site can consume an earlier one's answer.
     *  - On-position, but the SCRIPT CHANGED: deleting the first of two identical probes
     *    slides the second into seq 1, where the fast path hands it the deleted probe's
     *    answer. That is the case that reads as correct and is not.
     *
     * Either way the caller re-runs instead of guessing: a re-run costs a call, a wrong
     * entry costs the truth. An explicit `key` disambiguates and keeps full salvage.
     */
    const ambiguousKeyless = key === undefined && sameKind.length > 1;

    const fast = this.bySeq.get(seq);
    if (fast && !fast.consumed && fast.hash === hash && fast.kind === kind) {
      return ambiguousKeyless && !positionsTrusted
        ? { entry: fast, via: "seq", ambiguous: true }
        : { entry: fast, via: "seq" };
    }
    {
      const entry = sameKind.find((e) => !e.consumed);
      if (entry) {
        if (entry.seq === seq && !(ambiguousKeyless && !positionsTrusted)) {
          return { entry, via: "seq" };
        }
        if (ambiguousKeyless) return { entry, via: "salvage", ambiguous: true };
        return { entry, via: "salvage" };
      }
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

  /**
   * Keyless human requests with the same question and schema are indistinguishable by
   * content alone. Position is the only discriminator they have, and a position only
   * means something while the script is unchanged. When it is not, handing over an
   * arbitrary entry lets a SURVIVING gate consume the answer a DELETED sibling received,
   * replaying a recorded denial as an approval with nothing in the journal to say so.
   *
   * So this mirrors {@link matchStep}: serve on position when positions are trusted, and
   * otherwise report the ambiguity rather than guess. The caller re-opens the request —
   * re-asking costs a wait, guessing costs the truth, and for a human decision that is
   * the side that cannot be wrong.
   */
  matchHuman(
    hash: string,
    seq?: number,
    positionsTrusted = true,
    key?: string,
  ): { entry: HumanEntry; ambiguous?: true } | undefined {
    const sameHash = (this.humansByHash.get(hash) ?? []).filter((entry) => !entry.superseded);
    const ambiguousKeyless = key === undefined && sameHash.length > 1;

    if (seq !== undefined) {
      const onPosition = sameHash.find((e) => !e.consumed && e.seq === seq);
      if (onPosition) {
        return ambiguousKeyless && !positionsTrusted
          ? { entry: onPosition, ambiguous: true }
          : { entry: onPosition };
      }
    }
    const entry = sameHash.find((e) => !e.consumed);
    if (!entry) return undefined;
    return ambiguousKeyless ? { entry, ambiguous: true } : { entry };
  }

  /** An older unanswered request at this call site whose semantics changed. */
  pendingHumanByKey(key: string): HumanEntry | undefined {
    return this.humansByKey
      .get(key)
      ?.find((entry) => !entry.consumed && !entry.superseded && entry.answer === undefined);
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

/** Consecutive drained event-loop turns with no progress that count as a stall. */
const QUIET_TURNS = 3;

/**
 * Delivers cached completions in journaled order while replay is "pure" (no live
 * dispatch yet). A stall — an order the edited code never requests — is broken by a
 * quiescence watchdog rather than deadlocking; the first live dispatch flushes
 * everything (strict ordering is meaningless once new work interleaves).
 *
 * The stall test counts drained event-loop TURNS, not milliseconds. A wall-clock timer
 * made the decision depend on how fast the machine was: the same journal replayed on a
 * slower box could skip forward at a different point, assign different seq numbers, and
 * change what the NEXT resume's fast path matched — replay was not a pure function of
 * the journal. A turn count is machine-independent, and `busy()` (live dispatches plus
 * replay-path I/O still in flight) keeps a turn from counting as quiet while any
 * continuation is still on its way.
 */
export class OrderedDelivery {
  private orders: number[];
  private cursor = 0;
  private parked = new Map<number, () => void>();
  private strict: boolean;
  private watchdog: NodeJS.Immediate | NodeJS.Timeout | undefined;
  private lastProgress = 0;

  constructor(
    orders: number[],
    /** Live dispatches plus replay-path I/O in flight; zero means nothing is coming. */
    private readonly busy: () => number,
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
    if (this.watchdog) this.clearWatchdog();
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

  private quietTurns = 0;

  /** The handle is an Immediate or a Timeout depending on which arm ran; clear either. */
  private clearWatchdog(): void {
    const handle = this.watchdog;
    this.watchdog = undefined;
    if (handle === undefined) return;
    if (typeof (handle as NodeJS.Immediate).hasRef === "function" && !("refresh" in handle)) {
      clearImmediate(handle as NodeJS.Immediate);
    } else {
      clearTimeout(handle as NodeJS.Timeout);
    }
  }

  private armWatchdog(): void {
    if (this.watchdog || !this.strict) return;
    const seen = this.lastProgress;
    const check = (): void => {
      this.watchdog = undefined;
      if (!this.strict || this.parked.size === 0) return;
      if (this.lastProgress === seen && this.busy() === 0) {
        // A drained turn with parked deliveries and nothing in flight: no continuation
        // can arrive to claim the expected order. After QUIET_TURNS of that, the order
        // was edited away — skip forward rather than deadlock.
        this.quietTurns++;
        if (this.quietTurns >= QUIET_TURNS) {
          this.quietTurns = 0;
          const smallest = Math.min(...this.parked.keys());
          while (this.cursor < this.orders.length && this.orders[this.cursor]! < smallest) this.cursor++;
          this.flush();
        }
      } else {
        this.quietTurns = 0;
      }
      if (this.parked.size > 0) this.armWatchdog();
    };
    // A drained turn is the unit while nothing is in flight. When something IS in
    // flight the turn cannot be quiet anyway, so fall back to a coarse timer rather
    // than spinning setImmediate hot for the length of a provider call.
    this.watchdog = this.busy() === 0 ? setImmediate(check) : setTimeout(check, 50);
    // Deliberately NOT unref'd: while a delivery is parked this handle may be the
    // only thing keeping a one-shot resume process alive; unref'ing it lets Node
    // exit 0 with the run half-replayed. It re-arms only while parked deliveries
    // exist, so it never outlives the replay.
  }
}
