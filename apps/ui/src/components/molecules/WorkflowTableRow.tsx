import { Button } from "~/components/atoms/Button";
import { StatusDot } from "~/components/atoms/StatusDot";
import type { Workflow } from "~/domain/types";
import { SuccessBar } from "./SuccessBar";
import styles from "./WorkflowTableRow.module.css";

type Props = { workflow: Workflow; selected: boolean; onSelect: () => void; onRun: () => void };

export function WorkflowTableRow({ workflow, selected, onSelect, onRun }: Props) {
  return (
    <article className={selected ? `${styles.row} ${styles.on}` : styles.row}>
      <div className={styles.top}>
        <button type="button" aria-pressed={selected} className={styles.select} onClick={onSelect}>
          <span className={styles.identity}>
            <span className={styles.name}>
              <StatusDot state={workflow.state} />
              <span className={styles.nameText}>{workflow.name}</span>
            </span>
            <span className={styles.file}>{workflow.file}</span>
          </span>
          <span className={styles.description}>{workflow.desc}</span>
          <span className={styles.metrics}>
            <span className={styles.metric}>
              <span className={styles.metricKey}>last</span>
              <span className={styles.metricValue}>{workflow.lastLabel || "—"}</span>
            </span>
            <span className={`${styles.metric} ${styles.successMetric}`}>
              <span className={styles.metricKey}>success</span>
              <SuccessBar ok={workflow.ok} />
            </span>
            <span className={styles.metric}>
              <span className={styles.metricKey}>p50</span>
              <span className={styles.metricValue}>{workflow.p50}</span>
            </span>
            <span className={styles.metric}>
              <span className={styles.metricKey}>cost</span>
              <span className={styles.metricValue}>{workflow.cost}</span>
            </span>
          </span>
        </button>
        <span className={styles.action}>
          <Button variant="primary" size="mediumWide" onClick={onRun}>
            Run…
          </Button>
        </span>
      </div>
    </article>
  );
}
