import { HISTORY_BAR_HEIGHTS } from "~/domain/fixtures/workflows";
import styles from "./HistoryBars.module.css";

/** Last 14 runs — a full bar for a success, a stub in red for a failure. */
export function HistoryBars({ history }: { history: number[] }) {
  return (
    <span className={styles.bars}>
      {history.map((value, index) => (
        <span
          // biome-ignore lint/suspicious/noArrayIndexKey: bar N is always the Nth-oldest run
          key={`bar-${index}`}
          className={styles.bar}
          style={{
            background: value ? "var(--color-accent-2-300)" : "var(--color-danger)",
            height: value ? `${HISTORY_BAR_HEIGHTS[index] ?? 60}%` : "30%",
          }}
        />
      ))}
    </span>
  );
}
