/**
 * Durations: `"10m"`, `"2h"`, `"90s"`, `"250ms"`, or a plain number of milliseconds —
 * accepted everywhere the API takes a timeout or delay.
 */

export type Duration = number | `${number}${"ms" | "s" | "m" | "h" | "d"}`;

const UNIT_MS: Record<string, number> = {
  ms: 1,
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
};

/** Parse a Duration into milliseconds. Throws on malformed input. */
export function parseDuration(d: Duration): number {
  if (typeof d === "number") {
    if (!Number.isFinite(d) || d < 0) throw new TypeError(`invalid duration: ${d}`);
    return d;
  }
  const m = /^(\d+(?:\.\d+)?)(ms|s|m|h|d)$/.exec(d);
  if (!m)
    throw new TypeError(`invalid duration: "${d}" (expected e.g. "10m", "2h", "90s", or ms as a number)`);
  return Number(m[1]) * UNIT_MS[m[2]!]!;
}

/** Render milliseconds as a compact human string ("4m12s", "830ms"). */
export function formatDuration(ms: number): string {
  if (ms < 1_000) return `${Math.round(ms)}ms`;
  const s = Math.round(ms / 1_000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return s % 60 === 0 ? `${m}m` : `${m}m${s % 60}s`;
  const h = Math.floor(m / 60);
  return m % 60 === 0 ? `${h}h` : `${h}h${m % 60}m`;
}
