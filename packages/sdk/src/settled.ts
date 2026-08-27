import type { StepError } from "./errors.ts";

/**
 * Per-branch outcome of fan-out. `ctx.parallel` and `pipeline.run()` return these in
 * input order; `ctx.successes()` is the one narrowing helper (it records what it drops).
 */
export type Settled<T> = { ok: true; value: T } | { ok: false; error: StepError };

export function okValues<T>(settled: ReadonlyArray<Settled<T>>): T[] {
  const out: T[] = [];
  for (const s of settled) if (s.ok) out.push(s.value);
  return out;
}

export function failures<T>(settled: ReadonlyArray<Settled<T>>): StepError[] {
  const out: StepError[] = [];
  for (const s of settled) if (!s.ok) out.push(s.error);
  return out;
}
