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

  constructor(limits: BudgetLimits = {}, parent?: Budget) {
    this.limitTokens = limits.tokens;
    this.limitUsd = limits.usd;
    this.parent = parent;
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
    this.parent?.charge(usage);
  }

  /** Restore journaled spend on resume without re-charging parents twice. */
  restore(tokens: number, usd: number): void {
    this.tokens += tokens;
    this.usd += usd;
    this.parent?.restore(tokens, usd);
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

  view(): BudgetView {
    return {
      spent: { tokens: this.tokens, usd: this.usd },
      remaining: { tokens: this.remainingTokens(), usd: this.remainingUsd() },
    };
  }
}
