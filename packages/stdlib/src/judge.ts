/**
 * Judge panel. One attempt per angle, then a judge per attempt — every judge scores
 * every attempt and names one best. The winner is the attempt with the most best-votes,
 * ties broken by mean score, so a single generous judge cannot carry a weak attempt.
 */
import type { AnySchema, Ctx, InferOut } from "@techery/weft-sdk";
import { StepError, z } from "@techery/weft-sdk";
import { asPromptJson, prefixed, type Routing, routing } from "./internal.ts";

/** What one judge returns: a score per attempt, the index it ranks best, and why. */
export const JudgeVerdictSchema = z.object({
  scores: z.array(z.number()),
  best: z.number().int(),
  rationale: z.string(),
});
export type JudgeVerdict = z.infer<typeof JudgeVerdictSchema>;

/**
 * The judge schema pinned to an exact attempt count — what `judgePanel` actually
 * sends, so a judge that returns the wrong number of scores gets repaired.
 */
export function judgeVerdictSchema(attempts: number) {
  const last = Math.max(0, attempts - 1);
  return z.object({
    scores: z.array(z.number().min(0).max(10)).length(attempts),
    best: z.number().int().min(0).max(last),
    rationale: z.string(),
  });
}

export interface JudgePanelResult<T> {
  winner: T;
  attempts: T[];
  /** Mean score per attempt, index-aligned with `attempts`. */
  scores: number[];
}

export interface JudgePanelOptions<S extends AnySchema> extends Routing {
  task: string;
  /** One attempt is produced per angle; the angle is the attempt's brief. */
  angles: string[];
  attemptSchema: S;
  /** Namespaces the `attempt:I` and `judge:I` keys when a workflow judges more than once. */
  keyPrefix?: string;
}

/** The shape `judgePanel` returns, for a workflow's `output:` schema. */
export function judgePanelResultSchema<A extends z.ZodType>(attempt: A) {
  return z.object({
    winner: attempt,
    attempts: z.array(attempt),
    scores: z.array(z.number()),
  });
}

function attemptPrompt(task: string, angle: string, index: number, total: number): string {
  return (
    `TASK: ${task}\n\n` +
    `You are attempt ${index + 1} of ${total}, and your assigned angle is the whole of your brief.\n` +
    `ANGLE: ${angle}\n\n` +
    `Commit to this angle rather than hedging toward the others — a panel of judges will ` +
    `compare your attempt against the rival angles, and a distinctive answer scores better ` +
    `than a compromise. Answer the task in full.`
  );
}

function judgePrompt(task: string, attempts: unknown[], index: number, total: number): string {
  const rendered = attempts.map((a, i) => `--- ATTEMPT ${i} ---\n${asPromptJson(a)}`).join("\n\n");
  return (
    `You are judge ${index + 1} of ${total} on an independent panel. Judge on the merits; ` +
    `you cannot see the other judges and must not try to guess them.\n\n` +
    `TASK: ${task}\n\n` +
    `${attempts.length} attempts were produced:\n\n${rendered}\n\n` +
    `Score every attempt from 0 (useless) to 10 (could not be bettered), returning exactly ` +
    `${attempts.length} scores in attempt order. Then name the index of the single best attempt ` +
    `and give the rationale that decided it.`
  );
}

/**
 * Produce one attempt per angle, judge them all, and return the winner.
 *
 * ```ts
 * const { winner, scores } = await judgePanel(ctx, {
 *   task: "Design the cache invalidation strategy",
 *   angles: ["favor simplicity", "favor throughput", "favor correctness under partition"],
 *   attemptSchema: Design,
 * });
 * ```
 */
export async function judgePanel<S extends AnySchema>(
  ctx: Ctx,
  opts: JudgePanelOptions<S>,
): Promise<JudgePanelResult<InferOut<S>>> {
  type Attempt = InferOut<S>;
  const angles = opts.angles;
  if (angles.length === 0) {
    throw new StepError("invalid_input", "judgePanel: at least one angle is required");
  }
  const prefix = opts.keyPrefix;
  const route = routing(opts);

  const attemptSettled = await ctx.parallel(
    angles.map((angle, i) =>
      ctx.agent(attemptPrompt(opts.task, angle, i, angles.length), {
        schema: opts.attemptSchema,
        key: prefixed(prefix, `attempt:${i}`),
        label: `attempt:${i}`,
        ...route,
      }),
    ),
  );
  const attempts: Attempt[] = ctx.successes(attemptSettled);
  if (attempts.length === 0) {
    throw new StepError("internal", `judgePanel: all ${angles.length} attempts failed; nothing to judge`);
  }

  const total = attempts.length;
  const verdictSchema = judgeVerdictSchema(total);
  const judgeSettled = await ctx.parallel(
    attempts.map((_attempt, i) =>
      ctx.agent(judgePrompt(opts.task, attempts, i, total), {
        schema: verdictSchema,
        key: prefixed(prefix, `judge:${i}`),
        label: `judge:${i}`,
        ...route,
      }),
    ),
  );
  const verdicts = ctx.successes(judgeSettled);

  const totals: number[] = new Array<number>(total).fill(0);
  const counts: number[] = new Array<number>(total).fill(0);
  const bestVotes: number[] = new Array<number>(total).fill(0);
  for (const verdict of verdicts) {
    for (const [i, score] of verdict.scores.entries()) {
      if (i >= total || !Number.isFinite(score)) continue;
      totals[i] = (totals[i] ?? 0) + score;
      counts[i] = (counts[i] ?? 0) + 1;
    }
    const best = verdict.best;
    if (Number.isInteger(best) && best >= 0 && best < total) bestVotes[best] = (bestVotes[best] ?? 0) + 1;
  }
  const scores = totals.map((sum, i) => {
    const n = counts[i] ?? 0;
    return n === 0 ? 0 : sum / n;
  });

  let winnerIndex = 0;
  for (let i = 1; i < total; i++) {
    const votes = bestVotes[i] ?? 0;
    const leading = bestVotes[winnerIndex] ?? 0;
    if (votes > leading) winnerIndex = i;
    else if (votes === leading && (scores[i] ?? 0) > (scores[winnerIndex] ?? 0)) winnerIndex = i;
  }
  const winner = attempts[winnerIndex];
  if (winner === undefined) {
    throw new StepError("internal", "judgePanel: winner index fell outside the attempt list");
  }

  if (verdicts.length === 0) {
    ctx.log(`judgePanel: every judge failed; falling back to attempt ${winnerIndex}`);
  } else {
    ctx.log(
      `judgePanel: attempt ${winnerIndex} won with ${bestVotes[winnerIndex] ?? 0}/${verdicts.length} ` +
        `best-votes (mean ${(scores[winnerIndex] ?? 0).toFixed(2)})`,
    );
  }
  return { winner, attempts, scores };
}
