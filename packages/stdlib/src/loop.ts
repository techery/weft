/**
 * Run rounds until they come up dry. The caller owns what a round does; this owns
 * the bookkeeping — dedupe against everything ever seen, count consecutive rounds
 * that added nothing, and stop on the dry streak or the round ceiling, never on
 * "the last round felt quiet".
 */
import type { Ctx } from "@techery/weft-sdk";
import { positiveInt } from "./internal.ts";

/** Consecutive empty rounds that end the loop. */
export const DEFAULT_DRY_ROUNDS = 2;
/** Hard ceiling on rounds, dry or not. */
export const DEFAULT_MAX_ROUNDS = 10;

export interface LoopUntilDryOptions<T> {
  /** Runs one round; receives the 1-based round number. May return repeats. */
  find(round: number): Promise<T[]>;
  /** Identity of an item, compared against every item accumulated so far. */
  keyOf(item: T): string;
  /** Consecutive rounds adding nothing new that end the loop (default 2). */
  dryRounds?: number;
  /** Ceiling on rounds regardless of yield (default 10). */
  maxRounds?: number;
}

/**
 * Accumulate unique items across rounds until the well runs dry.
 *
 * ```ts
 * const all = await loopUntilDry(ctx, {
 *   find: (round) => ctx.agent(`Sweep ${round}: find call sites we missed`, { … }),
 *   keyOf: (site) => `${site.file}:${site.line}`,
 * });
 * ```
 */
export async function loopUntilDry<T>(ctx: Ctx, opts: LoopUntilDryOptions<T>): Promise<T[]> {
  // Finite-positive like every other stdlib count: NaN would run ZERO rounds and
  // Infinity would remove the hard ceiling on paid rounds entirely.
  const dryRounds = positiveInt(opts.dryRounds, DEFAULT_DRY_ROUNDS);
  const maxRounds = positiveInt(opts.maxRounds, DEFAULT_MAX_ROUNDS);

  const seen = new Set<string>();
  const collected: T[] = [];
  let dryStreak = 0;
  let round = 0;

  while (round < maxRounds) {
    round++;
    const found = await opts.find(round);
    let added = 0;
    for (const item of found) {
      const key = opts.keyOf(item);
      if (seen.has(key)) continue;
      seen.add(key);
      collected.push(item);
      added++;
    }
    ctx.log(
      `loopUntilDry: round ${round} returned ${found.length}, ${added} new ` +
        `(${collected.length} unique so far)`,
    );
    if (added === 0) {
      dryStreak++;
      if (dryStreak >= dryRounds) {
        ctx.log(`loopUntilDry: ${dryStreak} dry round(s) in a row — stopping after ${round} round(s)`);
        return collected;
      }
    } else {
      dryStreak = 0;
    }
  }

  ctx.log(`loopUntilDry: hit the ceiling of ${maxRounds} round(s) with ${collected.length} unique item(s)`);
  return collected;
}
