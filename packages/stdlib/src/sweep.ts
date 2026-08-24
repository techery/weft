/**
 * Look at one subject through several lenses at once. Each mode is an independent
 * agent with its own key, so a lens that fails costs only that lens: the failure is
 * dropped through ctx.ok (which records it) and named in the run log.
 */
import type { AnySchema, Ctx, InferOut } from "@techery/weft-sdk";
import { z } from "@techery/weft-sdk";
import { prefixed, type Routing, routing } from "./internal.ts";

/** One lens: a name for the key and the report, and the brief the agent gets. */
export interface SweepMode {
  name: string;
  prompt: string;
}

export const SweepModeSchema = z.object({
  name: z.string(),
  prompt: z.string(),
});

export interface SweepOutcome<T> {
  mode: string;
  result: T;
}

export interface MultiModalSweepOptions<S extends AnySchema> extends Routing {
  subject: string;
  modes: SweepMode[];
  schema: S;
  /** Namespaces the `sweep:NAME` keys when a workflow sweeps more than once. */
  keyPrefix?: string;
}

/** The shape `multiModalSweep` returns, for a workflow's `output:` schema. */
export function sweepResultSchema<R extends z.ZodType>(result: R) {
  return z.array(z.object({ mode: z.string(), result }));
}

function sweepPrompt(subject: string, mode: SweepMode, others: string[]): string {
  const rest = others.length > 0 ? others.join(", ") : "none";
  return (
    `Examine one subject through exactly one lens.\n\n` +
    `SUBJECT: ${subject}\n\n` +
    `LENS (${mode.name}): ${mode.prompt}\n\n` +
    `Stay inside this lens. Other agents are covering the remaining lenses (${rest}), so ` +
    `breadth here buys nothing and depth buys everything.`
  );
}

/**
 * Fan one subject out across modes and return what came back, in mode order.
 *
 * ```ts
 * const views = await multiModalSweep(ctx, {
 *   subject: "the checkout flow",
 *   modes: [
 *     { name: "security", prompt: "Where can a hostile client force a bad state?" },
 *     { name: "perf", prompt: "Where does latency come from under load?" },
 *   ],
 *   schema: Observations,
 * });
 * ```
 */
export async function multiModalSweep<S extends AnySchema>(
  ctx: Ctx,
  opts: MultiModalSweepOptions<S>,
): Promise<Array<SweepOutcome<InferOut<S>>>> {
  const modes = opts.modes;
  if (modes.length === 0) return [];
  const prefix = opts.keyPrefix;
  const route = routing(opts);
  const names = modes.map((m) => m.name);

  const settled = await ctx.parallel(
    modes.map(async (mode, i): Promise<SweepOutcome<InferOut<S>>> => {
      const others = names.filter((_n, j) => j !== i);
      const result = await ctx.agent(sweepPrompt(opts.subject, mode, others), {
        schema: opts.schema,
        key: prefixed(prefix, `sweep:${mode.name}`),
        label: `sweep:${mode.name}`,
        ...route,
      });
      return { mode: mode.name, result };
    }),
  );

  const dropped = modes.filter((_mode, i) => settled[i]?.ok !== true).map((mode) => mode.name);
  const kept = ctx.ok(settled);
  if (dropped.length > 0) {
    ctx.log(`multiModalSweep: dropped ${dropped.length}/${modes.length} mode(s): ${dropped.join(", ")}`);
  }
  return kept;
}
