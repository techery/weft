import type { WorkflowLabel } from "~/domain/types";
import styles from "./PhaseRow.module.css";

/** One `phase()` label as it appears in the workflow file, numbered in order. */
export function PhaseRow({ index, label }: { index: number; label: WorkflowLabel }) {
  const gated = label.meta.includes("human");
  return (
    <span className={styles.row}>
      <span
        className={styles.num}
        style={{
          background: gated ? "var(--color-accent-200)" : "var(--color-neutral-200)",
          color: gated ? "var(--color-accent-800)" : "var(--color-neutral-800)",
        }}
      >
        {index}
      </span>
      <span className={styles.name}>{label.name}</span>
      <span className={styles.meta}>{label.meta}</span>
    </span>
  );
}
