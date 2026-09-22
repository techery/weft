import {
  type JournalRecord,
  persistedDefOf,
  reduceState,
  resumeOptions,
  retainedDefOf,
  StepError,
  type Weft,
} from "@techery/weft-host";

/** Earliest unresolved sleep or human timeout. Reading a deadline never performs the operation behind it. */
export function nextDeadline(records: JournalRecord[]): number | undefined {
  const state = reduceState(records);
  if (state.resumeBlocked) return undefined;
  const deadlines = state.humans
    .filter((human) => human.status === "pending" && human.deadline !== undefined)
    .map((human) => human.deadline!);
  const sleeping = new Map<number, { hash: string; at: number }>();
  for (const { ev, at } of records) {
    if (ev.type === "step.scheduled") {
      const previous = sleeping.get(ev.seq);
      sleeping.delete(ev.seq);
      if (ev.kind === "sleep" || ev.kind === "signal") {
        const ms = ev.kind === "sleep" ? (ev.payload as { ms?: unknown } | undefined)?.ms : ev.timeoutMs;
        if (typeof ms === "number" && Number.isFinite(ms) && ms >= 0)
          sleeping.set(ev.seq, {
            hash: ev.hash,
            at: Math.min((ev.originAt ?? at) + ms, previous?.hash === ev.hash ? previous.at : Infinity),
          });
      }
    } else if (ev.type === "step.completed" || ev.type === "step.failed") {
      sleeping.delete(ev.seq);
    }
  }
  deadlines.push(...[...sleeping.values()].map((wait) => wait.at));
  return deadlines.length ? Math.min(...deadlines) : undefined;
}

export interface DeadlineScheduler {
  /** Also used for deterministic startup scans in hosts and tests. */
  scan(): Promise<void>;
  close(): Promise<void>;
}

/** The daemon owns the periodic timer; the engine's durable run lease owns each resumed workflow. */
export function startDeadlineScheduler(
  weft: Weft,
  options: { intervalMs?: number; now?: () => number } = {},
): DeadlineScheduler {
  const now = options.now ?? Date.now;
  const interval = options.intervalMs ?? 1_000;
  if (!Number.isFinite(interval) || interval < 1)
    throw new TypeError("deadline scheduler interval must be positive");
  const cache = new Map<string, { version: number; deadline?: number; records: number; blocked?: boolean }>();
  let closed = false;
  let running: Promise<void> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const scan = (): Promise<void> => {
    if (closed) return Promise.resolve();
    if (running) return running;
    running = (async () => {
      const summaries = await weft.engine.list();
      // Sleep steps preserve the compatible `executing` status while waiting. An
      // inactive executing run is eligible only when its journal has a due wait.
      const suspended = summaries.filter(
        (run) =>
          (run.status === "waiting_for_human" ||
            run.status === "waiting_for_signal" ||
            run.status === "executing") &&
          !weft.engine.isActive(run.runId),
      );
      for (let index = 0; index < suspended.length && !closed; index += 4) {
        await Promise.all(
          suspended.slice(index, index + 4).map(async (summary) => {
            if (closed || weft.engine.isActive(summary.runId)) return;
            let cached = cache.get(summary.runId);
            if (!cached || cached.version !== summary.updatedAt) {
              const records: JournalRecord[] = [];
              for await (const record of weft.engine.journal.read(summary.runId)) records.push(record);
              cached = {
                version: summary.updatedAt,
                deadline: nextDeadline(records),
                records: records.length,
              };
              cache.set(summary.runId, cached);
            }
            if (closed || cached.blocked || cached.deadline === undefined || cached.deadline > now()) return;
            try {
              // A child's deadline wakes its root. Resuming the child independently
              // could write an ancestor-owned workspace without that owner's lease.
              let rootId = summary.runId;
              let childId: string | undefined;
              const ancestors = new Set([rootId]);
              for (;;) {
                const state = await weft.engine.state(rootId);
                // An edit-tolerant resume can leave an older child waiting after its
                // parent finishes or replaces that workflow step. Its deadline does
                // not authorize reopening the finished run or restoring the old path.
                if (
                  state.status === "complete" ||
                  state.status === "failed" ||
                  state.status === "cancelled" ||
                  state.resumeBlocked ||
                  weft.engine.isActive(rootId)
                )
                  return;
                if (childId !== undefined) {
                  const childStep = state.steps.findLast((step) => step.childRunId === childId);
                  if (
                    childStep?.status !== "running" ||
                    state.steps.findLast((step) => step.seq === childStep.seq) !== childStep
                  )
                    return;
                }
                const parent = state.parentRunId;
                if (!parent) break;
                if (ancestors.has(parent) || ancestors.size > 64)
                  throw new Error("Invalid workflow ancestor chain");
                ancestors.add(parent);
                childId = rootId;
                rootId = parent;
              }
              if (weft.engine.isActive(rootId)) return;
              const persisted = (await retainedDefOf(weft, rootId)) ?? (await persistedDefOf(weft, rootId));
              if (closed) return;
              const handle = await weft.engine.resume(rootId, {
                ...resumeOptions(persisted),
                mode: "strict",
                nonterminalOnly: true,
              });
              void handle.result.catch(() => undefined);
              cache.delete(summary.runId);
            } catch (error) {
              // The root may finish in another process after the ancestor checks.
              // The lease-protected resume guard treats that as an obsolete wakeup.
              if (
                error instanceof StepError &&
                error.code === "invalid_input" &&
                typeof error.detail === "object" &&
                error.detail !== null &&
                "reason" in error.detail &&
                error.detail.reason === "run_terminal"
              )
                return;
              // Another daemon can win the lease after this scan; that is successful ownership, not a blocked run.
              if (
                /already.*(running|claimed|owned)|claim.*held|another.*(process|owner)/i.test(String(error))
              )
                return;
              cached.blocked = true;
              if (!closed && weft.engine.journal.appendIf) {
                await weft.engine.journal.appendIf(summary.runId, cached.records, [
                  { type: "resume.blocked", source: "deadline-scheduler", reason: String(error) },
                ]);
              }
            }
          }),
        );
      }
      const live = new Set(suspended.map((summary) => summary.runId));
      for (const key of cache.keys()) if (!live.has(key)) cache.delete(key);
    })().finally(() => {
      running = undefined;
    });
    return running;
  };
  const tick = async (): Promise<void> => {
    try {
      await scan();
    } catch {
      /* A read failure is retried next tick; no run is guessed absent. */
    }
    if (!closed) {
      timer = setTimeout(() => void tick(), interval);
      timer.unref?.();
    }
  };
  void tick();
  return {
    scan,
    async close() {
      closed = true;
      if (timer) clearTimeout(timer);
      await running?.catch(() => undefined);
      cache.clear();
    },
  };
}
