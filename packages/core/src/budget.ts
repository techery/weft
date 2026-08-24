/**
 * Real accounting (C8): tokens and USD from provider usage, hard ceilings,
 * pool shared with children. A child budget charges its parent chain, so a
 * sub-allocation can never exceed what the parent has left.
 */
import { BudgetExceededError, type BudgetView, type Usage } from "@weft/sdk";

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
    this.tokens += (usage.input ?? 0) + (usage.output ?? 0);
    this.usd += usage.usd ?? 0;
    if (this.parent) this.parent.charge(usage);
    else this.chargedCalls++; // one cost sample per charged call, counted once at the root
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
   * Reserve one in-flight provider call. `checkBeforeStep` alone lets N parallel calls
   * all pass against a nearly-dry pool (nothing has charged yet), overspending by
   * N × call-cost; this gate holds the ceiling across concurrency. Nobody declares a
   * call's cost up front, so the observed average per charged call stands in for it —
   * and with no history yet, calls probe ONE at a time. Returns a release fn for the
   * dispatch site's finally.
   */
  reserveCall(stepRef: { key?: string; kind?: string }): () => void {
    this.checkBeforeStep(stepRef);
    const root = this.root();
    const rt = this.remainingTokens();
    const ru = this.remainingUsd();
    if (rt !== null || ru !== null) {
      const samples = root.chargedCalls;
      const refuse = (why: string): never => {
        throw new BudgetExceededError(
          `budget cannot cover step ${stepRef.key ?? stepRef.kind ?? "?"} ${why} ` +
            `(${root.inflightCalls} in flight; remaining tokens=${rt}, usd=${ru})`,
          stepRef,
        );
      };
      if (samples === 0) {
        // No cost observed yet: calls probe ONE at a time so a parallel fan-out
        // cannot multiply an unknown cost past the ceiling.
        if (root.inflightCalls > 0) refuse("while an unpriced call is in flight");
      } else {
        // The observed average stands in for the declared cost nobody provides:
        // this call plus everything in flight must fit in what is left.
        const fits = (remaining: number | null, spent: number): boolean =>
          remaining === null || remaining >= (root.inflightCalls + 1) * (spent / samples);
        if (!fits(rt, root.tokens) || !fits(ru, root.usd)) refuse("at the observed per-call cost");
      }
    }
    root.inflightCalls++;
    let released = false;
    return () => {
      if (!released) {
        released = true;
        root.inflightCalls--;
      }
    };
  }

  view(): BudgetView {
    return {
      spent: { tokens: this.tokens, usd: this.usd },
      remaining: { tokens: this.remainingTokens(), usd: this.remainingUsd() },
    };
  }
}
