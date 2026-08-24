/**
 * Adversarial verification. Every claim faces a panel of refuters whose only job is
 * to kill it; a claim that survives a hostile majority is worth reporting. The panel
 * is skeptical by construction: an uncertain refuter votes to refute, and a refuter
 * whose branch fails outright counts as a refute vote too — a claim never survives
 * because nobody managed to check it.
 */
import type { Ctx } from "@techery/weft-sdk";
import { z } from "@techery/weft-sdk";
import { positiveInt, type Routing, routing } from "./internal.ts";

/** Default panel size: three refuters, so two of them must agree to kill a claim. */
export const DEFAULT_REFUTERS = 3;

/** What one refuter returns. */
export const RefuterVerdictSchema = z.object({
  refuted: z.boolean(),
  reason: z.string(),
});
export type RefuterVerdict = z.infer<typeof RefuterVerdictSchema>;

/** A claim the panel killed, with every reason that was voted against it. */
export interface RefutedClaim<T> {
  claim: T;
  reasons: string[];
}

export interface AdversarialVerifyResult<T> {
  survived: T[];
  refuted: Array<RefutedClaim<T>>;
}

export interface AdversarialVerifyOptions<T> extends Routing {
  claims: T[];
  /** Renders a claim into the one sentence a refuter has to attack. */
  describe(claim: T): string;
  /** Panel size per claim (default 3). A claim dies at ceil(refuters / 2) refute votes. */
  refuters?: number;
  /** Step key for claim `claimIndex`, refuter `refuterIndex`; defaults to `refute:I:R`. */
  keyFor?(claimIndex: number, refuterIndex: number): string;
}

/** The shape `adversarialVerify` returns, for a workflow's `output:` schema. */
export function adversarialVerifyResultSchema<C extends z.ZodType>(claim: C) {
  return z.object({
    survived: z.array(claim),
    refuted: z.array(z.object({ claim, reasons: z.array(z.string()) })),
  });
}

function refutePrompt(claim: string, index: number, total: number): string {
  return (
    `You are refuter ${index + 1} of ${total} on an adversarial panel, working independently. ` +
    `Your job is to KILL the claim below, not to confirm it.\n\n` +
    `CLAIM: ${claim}\n\n` +
    `Hunt for a counterexample, a contradicting fact, a missing precondition, or a reasoning error. ` +
    `Set refuted=true when the claim is wrong, overstated, or you cannot independently confirm it. ` +
    `Default refuted=true if uncertain — only answer refuted=false when you checked and the claim clearly holds. ` +
    `Give the single strongest reason behind your verdict.`
  );
}

/**
 * Run a refuter panel over every claim and return the survivors alongside the kills.
 *
 * ```ts
 * const { survived } = await adversarialVerify(ctx, {
 *   claims: findings,
 *   describe: (f) => `${f.claim} (${f.file}:${f.line})`,
 *   refuters: 3,
 * });
 * ```
 */
export async function adversarialVerify<T>(
  ctx: Ctx,
  opts: AdversarialVerifyOptions<T>,
): Promise<AdversarialVerifyResult<T>> {
  const claims = opts.claims;
  if (claims.length === 0) return { survived: [], refuted: [] };

  const refuters = positiveInt(opts.refuters, DEFAULT_REFUTERS);
  // A STRICT majority: on an even panel a tie must not kill (1 of 2 refuting survives).
  const threshold = Math.floor(refuters / 2) + 1;
  const keyFor =
    opts.keyFor ?? ((claimIndex: number, refuterIndex: number) => `refute:${claimIndex}:${refuterIndex}`);
  const route = routing(opts);

  const tasks: Array<Promise<RefuterVerdict>> = [];
  for (const [i, claim] of claims.entries()) {
    const described = opts.describe(claim);
    for (let r = 0; r < refuters; r++) {
      tasks.push(
        ctx.agent(refutePrompt(described, r, refuters), {
          schema: RefuterVerdictSchema,
          key: keyFor(i, r),
          label: `refute:${i}#${r}`,
          ...route,
        }),
      );
    }
  }

  // Settled entries, not ctx.ok(): a branch that failed is a refute vote, not a drop.
  const settled = await ctx.parallel(tasks);

  const survived: T[] = [];
  const refuted: Array<RefutedClaim<T>> = [];
  for (const [i, claim] of claims.entries()) {
    const reasons: string[] = [];
    for (let r = 0; r < refuters; r++) {
      const vote = settled[i * refuters + r];
      if (vote === undefined) continue;
      if (!vote.ok) {
        reasons.push(`refuter ${r} failed (${vote.error.code}): ${vote.error.message}`);
      } else if (vote.value.refuted) {
        reasons.push(vote.value.reason);
      }
    }
    if (reasons.length >= threshold) refuted.push({ claim, reasons });
    else survived.push(claim);
  }

  ctx.log(
    `adversarialVerify: ${survived.length}/${claims.length} claims survived ` +
      `${refuters} refuters (threshold ${threshold})`,
  );
  return { survived, refuted };
}
