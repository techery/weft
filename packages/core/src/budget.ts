/**
 * Real accounting (C8): tokens and USD from provider usage, hard ceilings,
 * pool shared with children. A child budget charges its parent chain, so a
 * sub-allocation can never exceed what the parent has left.
 */
import { BudgetExceededError, type BudgetView, CancelledError, type Usage } from "@techery/weft-sdk";

export interface BudgetLimits {
  tokens?: number;
  usd?: number;
}

export class Budget {
  private limitTokens: number | undefined;
  private limitUsd: number | undefined;
  private tokens = 0;
  private usd = 0;
  private readonly parent: Budget | undefined;
  // In-flight provider calls and observed per-call cost, tracked at the ROOT so the
  // whole pool (children included) shares one view of concurrent exposure.
  private inflightCalls = 0;
  private chargedCalls = 0;
  // Callers parked in reserveCall, woken whenever the pool's view changes (a charge
  // lands, or a call releases). Held at the ROOT so one queue serves the whole tree.
  private readonly waiters = new Set<() => void>();

  constructor(limits: BudgetLimits = {}, parent?: Budget) {
    // A ceiling must be a finite, non-negative number: Infinity silently turns a
    // "hard ceiling" into no budget at all, and NaN lets the first paid probe
    // through before every later comparison misbehaves.
    for (const [name, value] of [
      ["tokens", limits.tokens],
      ["usd", limits.usd],
    ] as const) {
      if (value !== undefined && (!Number.isFinite(value) || value < 0)) {
        throw new TypeError(`budget ${name} must be a finite, non-negative number; got ${value}`);
      }
    }
    this.limitTokens = limits.tokens;
    this.limitUsd = limits.usd;
    this.parent = parent;
  }

  private root(): Budget {
    return this.parent ? this.parent.root() : this;
  }

  /** Sub-allocate: fraction of remaining, or absolute caps, always parent-linked. */
  child(opts: { fraction?: number; tokens?: number; usd?: number } = {}): Budget {
    const limits: BudgetLimits = {};
    if (opts.tokens !== undefined) limits.tokens = opts.tokens;
    if (opts.usd !== undefined) limits.usd = opts.usd;
    if (opts.fraction !== undefined) {
      const rt = this.remainingTokens();
      const ru = this.remainingUsd();
      if (rt !== null) limits.tokens = Math.floor(rt * opts.fraction);
      if (ru !== null) limits.usd = ru * opts.fraction;
    }
    return new Budget(limits, this);
  }

  charge(usage: Usage): void {
    // A malformed provider report (negative or non-finite tokens/usd) must never
    // CREDIT the pool: subtracting would reopen an exhausted hard ceiling.
    this.tokens += nonNegative(usage.input) + nonNegative(usage.output);
    this.usd += nonNegative(usage.usd);
    if (this.parent) this.parent.charge(usage);
    else this.chargedCalls++; // one cost sample per charged call, counted once at the root
    // The first charge is what turns an unpriced pool into a priced one: parked
    // callers must re-evaluate now, not when the call finally releases.
    this.root().wake();
  }

  /** Release every parked caller so each re-tests admission against the new figures. */
  private wake(): void {
    if (this.waiters.size === 0) return;
    const woken = [...this.waiters];
    this.waiters.clear();
    for (const resolve of woken) resolve();
  }

  /**
   * Restore journaled spend on resume without re-charging parents twice.
   * `samples` is the number of charged calls the spend came from: without it,
   * reserveCall would treat the first resumed call as an unpriced probe and then
   * divide ALL historical spend by the new sample count alone, refusing calls
   * the budget can actually afford.
   */
  restore(tokens: number, usd: number, samples = 0): void {
    this.tokens += tokens;
    this.usd += usd;
    if (this.parent) this.parent.restore(tokens, usd, samples);
    else this.chargedCalls += samples;
  }

  /**
   * Credit spend to THIS scope only — the ancestors already account for it.
   * Used when a capped child resumes: the parent chain restored the rolled-up
   * spend through the parent journal, but the fresh child Budget's own ledger
   * must still see it, or a 500-token cap that burned 300 has 500 again.
   */
  restoreLocal(tokens: number, usd: number): void {
    this.tokens += tokens;
    this.usd += usd;
  }

  spentTokens(): number {
    return this.tokens;
  }

  spentUsd(): number {
    return this.usd;
  }

  remainingTokens(): number | null {
    const own = this.limitTokens === undefined ? null : Math.max(0, this.limitTokens - this.tokens);
    const up = this.parent?.remainingTokens() ?? null;
    if (own === null) return up;
    if (up === null) return own;
    return Math.min(own, up);
  }

  remainingUsd(): number | null {
    const own = this.limitUsd === undefined ? null : Math.max(0, this.limitUsd - this.usd);
    const up = this.parent?.remainingUsd() ?? null;
    if (own === null) return up;
    if (up === null) return own;
    return Math.min(own, up);
  }

  exhausted(): boolean {
    return this.remainingTokens() === 0 || this.remainingUsd() === 0;
  }

  /** Called before dispatching a step; throws once the pool is dry. */
  checkBeforeStep(stepRef: { key?: string; kind?: string }): void {
    if (!this.exhausted()) return;
    const t = this.remainingTokens();
    const u = this.remainingUsd();
    const axis = t === 0 ? `${this.tokens} tokens spent` : `$${this.usd.toFixed(2)} spent`;
    throw new BudgetExceededError(
      `budget exhausted before step ${stepRef.key ?? stepRef.kind ?? "?"} (${axis}; remaining tokens=${t}, usd=${u})`,
      stepRef,
    );
  }

  /**
   * Admission test for one more concurrent provider call: `undefined` when it fits,
   * otherwise the reason it does not. `checkBeforeStep` alone lets N parallel calls all
   * pass against a nearly-dry pool (nothing has charged yet), overspending by
   * N × call-cost; this holds the ceiling across concurrency. Nobody declares a call's
   * cost up front, so the observed average per charged call stands in for it — and with
   * no history yet, calls probe ONE at a time to price the pool.
   */
  private admits(): string | undefined {
    const rt = this.remainingTokens();
    const ru = this.remainingUsd();
    if (rt === null && ru === null) return undefined; // unbounded on both axes
    const root = this.root();
    const samples = root.chargedCalls;
    if (samples === 0) {
      return root.inflightCalls > 0 ? "while an unpriced call is in flight" : undefined;
    }
    // The observed average stands in for the declared cost nobody provides: this call
    // plus everything in flight must fit in what is left.
    const fits = (remaining: number | null, spent: number): boolean =>
      remaining === null || remaining >= (root.inflightCalls + 1) * (spent / samples);
    return fits(rt, root.tokens) && fits(ru, root.usd) ? undefined : "at the observed per-call cost";
  }

  /**
   * Reserve one in-flight provider call, WAITING for a slot rather than refusing one.
   *
   * A ceiling is a scheduling constraint, not an error: refusing here turned every
   * cold-start fan-out into N−1 dropped lanes, because nothing has been priced yet and
   * the first call is always the only one that fits. Parking instead costs latency
   * until the first charge lands and then admits at the observed width, which is what
   * the ceiling was actually for.
   *
   * It still refuses — but only when waiting cannot help: the pool is exhausted, or
   * nothing is in flight to release and this one call already does not fit.
   *
   * Returns a release fn for the dispatch site's finally.
   */
  async reserveCall(stepRef: { key?: string; kind?: string }, signal?: AbortSignal): Promise<() => void> {
    const root = this.root();
    for (;;) {
      if (signal?.aborted) {
        throw new CancelledError("run cancelled while waiting for budget", stepRef);
      }
      this.checkBeforeStep(stepRef); // hard ceiling reached: waiting cannot help
      const why = this.admits();
      if (why === undefined) break;
      if (root.inflightCalls === 0) {
        // Nothing is in flight, so no release will ever change the answer: this single
        // call genuinely does not fit in what is left.
        throw new BudgetExceededError(
          `budget cannot cover step ${stepRef.key ?? stepRef.kind ?? "?"} ${why} ` +
            `(0 in flight; remaining tokens=${this.remainingTokens()}, usd=${this.remainingUsd()})`,
          stepRef,
        );
      }
      await root.parkUntilChange(signal);
    }
    root.inflightCalls++;
    let released = false;
    return () => {
      if (!released) {
        released = true;
        root.inflightCalls--;
        root.wake();
      }
    };
  }

  /** Park until a charge lands or a call releases; an abort rejects the wait. */
  private parkUntilChange(signal: AbortSignal | undefined): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const onWake = (): void => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      };
      const onAbort = (): void => {
        this.waiters.delete(onWake);
        reject(new CancelledError("run cancelled while waiting for budget", {}));
      };
      this.waiters.add(onWake);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  view(): BudgetView {
    return {
      spent: { tokens: this.tokens, usd: this.usd },
      remaining: { tokens: this.remainingTokens(), usd: this.remainingUsd() },
    };
  }
}

/** Usage components come from PROVIDERS: only finite positive numbers count. */
function nonNegative(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}
