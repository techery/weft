import type { ReactNode } from "react";
import styles from "./ListTable.module.css";

/** The bordered card the runs and workflows lists both live in. */
export function ListTable({ head, children }: { head: ReactNode; children: ReactNode }) {
  return (
    <div className={styles.table}>
      <div className={styles.head}>{head}</div>
      {children}
    </div>
  );
}
