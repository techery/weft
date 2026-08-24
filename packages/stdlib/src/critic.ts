/**
 * The completeness critic. One agent reads what a run produced and answers a single
 * question: what is missing? It is aimed at the gaps a run cannot see in its own
 * output — a modality never run, a claim never verified, a source never read.
 */
import type { Ctx } from "@weft/sdk";
import { z } from "@weft/sdk";
import { type Routing, routing } from "./internal.ts";

/** One gap: what is absent, and why its absence matters. */
export const GapSchema = z.object({
  what: z.string(),
  why: z.string(),
});
export type Gap = z.infer<typeof GapSchema>;

export const CompletenessGapsSchema = z.object({
  missing: z.array(GapSchema),
});
export type CompletenessGaps = z.infer<typeof CompletenessGapsSchema>;

export interface CompletenessCriticOptions extends Routing {
  /** The work under review: a report, a findings dump, a draft. */
  produced: string;
  /** What the run was asked to do, so the critic can measure output against intent. */
  instructions?: string;
  /** Step key; defaults to `completeness`. */
  key?: string;
}

function criticPrompt(produced: string, instructions: string | undefined): string {
  const brief = instructions
    ? `The work was asked to do this:\n${instructions}\n\n`
    : `No brief was recorded; infer the intent from the work itself.\n\n`;
  return (
    `You are a completeness critic. Do not review quality, style, or correctness — ` +
    `review only what is ABSENT.\n\n` +
    brief +
    `Here is what was produced:\n\n${produced}\n\n` +
    `List the gaps. Look specifically for: a modality or angle that was never run; a claim ` +
    `asserted but never verified; a source, file, or dataset referenced but never read; a ` +
    `question raised and left unanswered; a stated scope that the work quietly narrowed. ` +
    `For each gap give what is missing and why its absence matters. ` +
    `Return an empty list only if you genuinely cannot find a gap.`
  );
}

/**
 * Ask one agent what this run failed to cover.
 *
 * ```ts
 * const { missing } = await completenessCritic(ctx, {
 *   produced: report,
 *   instructions: "Audit every auth path for privilege escalation",
 * });
 * ```
 */
export async function completenessCritic(
  ctx: Ctx,
  opts: CompletenessCriticOptions,
): Promise<CompletenessGaps> {
  const gaps = await ctx.agent(criticPrompt(opts.produced, opts.instructions), {
    schema: CompletenessGapsSchema,
    key: opts.key ?? "completeness",
    label: "completeness",
    ...routing(opts),
  });
  ctx.log(`completenessCritic: ${gaps.missing.length} gap(s) reported`);
  return gaps;
}
