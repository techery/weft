import { StatusDot } from "~/components/atoms/StatusDot";
import type { Workflow } from "~/domain/types";
import { ShapeStrip } from "./ShapeStrip";
import { SuccessBar } from "./SuccessBar";
import styles from "./WorkflowTableRow.module.css";

type Props = { workflow: Workflow; selected: boolean; onSelect: () => void };

export function WorkflowTableRow({ workflow, selected, onSelect }: Props) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      className={selected ? `${styles.row} ${styles.on}` : styles.row}
      onClick={onSelect}
    >
      <span className={styles.name}>
        <StatusDot state={workflow.state} />
        <span className={styles.nameText}>{workflow.name}</span>
      </span>
      <ShapeStrip shape={workflow.shape} className={styles.shape} />
      <span className={styles.last}>{workflow.lastLabel}</span>
      <SuccessBar ok={workflow.ok} className={styles.success} />
      <span className={styles.p50}>{workflow.p50}</span>
      <span className={styles.cost}>{workflow.cost}</span>
    </button>
  );
}
