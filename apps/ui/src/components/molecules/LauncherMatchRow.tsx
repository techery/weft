import { StatusDot } from "~/components/atoms/StatusDot";
import type { Workflow } from "~/domain/types";
import styles from "./LauncherMatchRow.module.css";

type Props = {
  workflow: Workflow;
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
      <StatusDot state={workflow.state} />
      <span className={styles.name}>{workflow.name}</span>
      <span className={styles.file}>{workflow.file}</span>
      <span className={styles.spacer} />
      <span className={styles.meta}>
        ~{workflow.p50} · ~{workflow.cost}
      </span>
      <span className={styles.arrow}>→</span>
    </button>
  );
}
