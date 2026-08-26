import type { WorkflowRow } from "~/api/types";
import { ArrowRightIcon } from "~/components/atoms/Icons";
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
      <span className={styles.identity}>
        <span className={styles.name}>{workflow.name}</span>
        <span className={styles.file}>{workflow.file}</span>
      </span>
      {/* The registry listing carries no timing or spend — those are per-run facts, and a
          workflow's own description is what it does have to say for itself here. */}
      <span className={styles.meta}>{workflow.description}</span>
      <ArrowRightIcon className={styles.arrow} aria-hidden="true" weight="fill" size={14} />
    </button>
  );
}
