/**
 * Shared plumbing for the patterns. Nothing here is exported from the package root:
 * it exists so every pattern spells routing overrides and key composition the same way.
 */
import type { Effort, ProviderId } from "@techery/weft-sdk";

/** Routing overrides every pattern forwards verbatim to the steps it spawns. */
export interface Routing {
  provider?: ProviderId;
  model?: string;
  effort?: Effort;
}

/** Only the routing keys that were actually supplied, so step defaults still win. */
export function routing(opts: Routing): Routing {
  return {
    ...(opts.provider !== undefined ? { provider: opts.provider } : {}),
    ...(opts.model !== undefined ? { model: opts.model } : {}),
    ...(opts.effort !== undefined ? { effort: opts.effort } : {}),
  };
}

/**
 * Compose a step key under an optional caller prefix. A prefix is what keeps two
 * uses of the same pattern in one workflow from claiming the same keys.
 */
export function prefixed(prefix: string | undefined, key: string): string {
  return prefix ? `${prefix}:${key}` : key;
}

/** Clamp a user-supplied count to a sane positive integer. */
export function positiveInt(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  const n = Math.trunc(value);
  return n >= 1 ? n : 1;
}

/** Pretty-print a value for an agent prompt: compact, stable, and readable. */
export function asPromptJson(value: unknown): string {
  return JSON.stringify(value ?? null, null, 2);
}
