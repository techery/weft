import { StatusDot } from "~/components/atoms/StatusDot";
import type { RecentRunRef, RunState } from "~/domain/types";
import styles from "./RecentRunRow.module.css";

type Props = { recent: RecentRunRef; state: RunState; onOpen: () => void };

export function RecentRunRow({ recent, state, onOpen }: Props) {
  return (
    <button type="button" className={styles.row} onClick={onOpen}>
      <StatusDot state={state} size={6} />
      <span className={styles.id}>{recent.id}</span>
      <span className={styles.outcome}>{recent.outcome}</span>
      <span className={styles.ago}>{recent.ago}</span>
    </button>
  );
}
