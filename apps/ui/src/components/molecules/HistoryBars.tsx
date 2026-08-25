import styles from "./HistoryBars.module.css";

/** One past run in the strip: how it ended, and how long it took. */
export type HistoryBar = { ok: boolean; ms: number };

/** Below this a quick run would read as a failure stub rather than as a success. */
const FLOOR = 40;

/** Recent runs oldest-first — a full bar for a success, a stub in red for a failure. */
export function HistoryBars({ bars }: { bars: HistoryBar[] }) {
  // A failure keeps its fixed stub, so a long one must not flatten every success beside it.
  const longest = Math.max(1, ...bars.filter((bar) => bar.ok).map((bar) => bar.ms));
  return (
    <span className={styles.bars}>
      {bars.map((bar, index) => (
        <span
          // biome-ignore lint/suspicious/noArrayIndexKey: bar N is always the Nth-oldest run
          key={`bar-${index}`}
          className={styles.bar}
          style={{
            background: bar.ok ? "var(--color-accent-2-300)" : "var(--color-danger)",
            height: bar.ok ? `${Math.round(FLOOR + (100 - FLOOR) * Math.min(1, bar.ms / longest))}%` : "30%",
          }}
        />
      ))}
    </span>
  );
}
