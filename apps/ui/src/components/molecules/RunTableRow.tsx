import { StatusDot } from "~/components/atoms/StatusDot";
import { RUN_STATE_LABEL } from "~/domain/fixtures/runList";
import type { RunState } from "~/domain/types";
import type { RunTableRow as Row } from "~/domain/views";
import styles from "./RunTableRow.module.css";

const STATE_TEXT: Record<RunState, string> = {
  waiting: "var(--color-accent-700)",
  running: "var(--color-accent-2-700)",
  done: "var(--color-neutral-600)",
  stopped: "var(--color-neutral-600)",
};

export function RunTableRow({ row, onOpen }: { row: Row; onOpen: () => void }) {
  return (
    <button type="button" className={styles.row} onClick={onOpen}>
      <span className={styles.identity}>
        <StatusDot state={row.state} />
        <span className={styles.id}>{row.id}</span>
        <span className={styles.wf}>{row.wf}</span>
      </span>
      <span className={styles.outcome}>{row.outcome}</span>
      <span className={styles.state} style={{ color: STATE_TEXT[row.state] }}>
        {RUN_STATE_LABEL[row.state]}
      </span>
      <span className={styles.started}>{row.started}</span>
      <span className={styles.dur}>{row.dur}</span>
      <span className={styles.cost}>{row.cost}</span>
    </button>
  );
}
