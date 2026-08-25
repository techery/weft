import type { ReactNode } from "react";
import styles from "./ScrollPage.module.css";

type Props = {
  /** Content column width; the design uses 1180 for lists and 760 for settings. */
  maxWidth: number;
  gap: number;
  children: ReactNode;
};

/** A centred, scrolling screen — the queue, runs and settings layout. */
export function ScrollPage({ maxWidth, gap, children }: Props) {
  return (
    <div className={styles.scroll}>
      <div className={styles.inner} style={{ maxWidth, gap }}>
        {children}
      </div>
    </div>
  );
}
