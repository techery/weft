import type { WorkflowRow } from "~/api/types";
import styles from "./LauncherMatchRow.module.css";

type Props = {
  workflow: WorkflowRow;
  selected: boolean;
  onPick: () => void;
  onHover: () => void;
};

export function LauncherMatchRow({ workflow, selected, onPick, onHover }: Props) {
  return (
    <button
      type="button"
      className={selected ? `${styles.row} ${styles.on}` : styles.row}
      onClick={onPick}
      onMouseEnter={onHover}
      onFocus={onHover}
    >
      <span className={styles.name}>{workflow.name}</span>
      <span className={styles.file}>{workflow.file}</span>
      <span className={styles.spacer} />
      {/* The registry listing carries no timing or spend — those are per-run facts, and a
          workflow's own description is what it does have to say for itself here. */}
      <span className={styles.meta}>{workflow.description}</span>
      <span className={styles.arrow}>→</span>
    </button>
  );
}
