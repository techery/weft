import { StatusDot } from "~/components/atoms/StatusDot";
import styles from "./StartedBanner.module.css";

/** Shown on the runs screen right after a workflow with no live run is started. */
export function StartedBanner({ wf, file }: { wf: string; file: string }) {
  return (
    <div className={styles.banner}>
      <StatusDot state="waiting" pulse />
      <span className={styles.name}>{wf}</span>
      <span className={styles.file}>{file}</span>
      <span className={styles.spacer} />
      <span className={styles.note}>queued just now · the daemon opens step 1 in a moment</span>
    </div>
  );
}
