import { MonoBadge } from "~/components/atoms/MonoBadge";
import type { Finding } from "~/domain/types";
import styles from "./FindingCard.module.css";

type Props = { finding: Finding; onOpenStep?: () => void };

/** One journaled note: what it said, and where it says the evidence is. */
export function FindingCard({ finding }: Props) {
  return (
    <div className={styles.card}>
      <div className={styles.head}>
        <span className={styles.id}>{finding.id}</span>
        <span className={styles.msg}>{finding.msg}</span>
        {finding.sev ? <span className={styles.sev}>{finding.sev}</span> : null}
      </div>
      {finding.loc ? <span className={styles.loc}>{finding.loc}</span> : null}
      {finding.chip ? (
        <div className={styles.foot}>
          <span className={styles.footLabel}>opened step</span>
          <span className={styles.step}>{finding.stepLabel}</span>
          <MonoBadge bg="var(--color-neutral-200)" fg="var(--color-neutral-800)">
            {finding.chip}
          </MonoBadge>
        </div>
      ) : null}
    </div>
  );
}
