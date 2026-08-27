import { StatusDot } from "~/components/atoms/StatusDot";
import type { RunTableEntry } from "~/domain/adapt";
import { RUN_STATE_LABEL } from "~/domain/filters";
import type { RunState } from "~/domain/types";
import styles from "./RunTableRow.module.css";

const STATE_TEXT: Record<RunState, string> = {
  waiting: "var(--color-accent-700)",
  running: "var(--color-accent-2-700)",
  done: "var(--color-neutral-600)",
  failed: "var(--color-danger)",
  stopped: "var(--color-neutral-600)",
};

export function RunTableRow({ row, onOpen }: { row: RunTableEntry; onOpen: () => void }) {
  return (
    <button type="button" className={styles.row} onClick={onOpen}>
      <span className={styles.identity}>
        <StatusDot state={row.state} />
        <span className={styles.id}>{row.id}</span>
        <span className={styles.wf}>{row.wf}</span>
      </span>
      <span className={styles.outcome} data-label="Where it stands">
        {row.outcome}
      </span>
      <span className={styles.state} data-label="State" style={{ color: STATE_TEXT[row.state] }}>
        {RUN_STATE_LABEL[row.state]}
      </span>
      <span className={styles.started} data-label="Started">
        {row.started}
      </span>
      <span className={styles.dur} data-label="Elapsed">
        {row.dur}
      </span>
      <span className={styles.cost} data-label="Cost">
        {row.cost || "—"}
      </span>
    </button>
  );
}
