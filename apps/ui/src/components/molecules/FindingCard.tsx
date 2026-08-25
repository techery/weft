import { Button } from "~/components/atoms/Button";
import { MonoBadge } from "~/components/atoms/MonoBadge";
import type { Finding } from "~/domain/types";
import styles from "./FindingCard.module.css";

type Props = { finding: Finding; onOpenStep: () => void };

/** A finding, plus the step the code opened to deal with it. */
export function FindingCard({ finding, onOpenStep }: Props) {
  return (
    <div className={finding.settled ? styles.card : `${styles.card} ${styles.open}`}>
      <div className={styles.head}>
        <span className={styles.id}>{finding.id}</span>
        <span className={styles.msg}>{finding.msg}</span>
        <span className={styles.sev}>{finding.sev}</span>
      </div>
      <span className={styles.loc}>{finding.loc}</span>
      <div className={styles.foot}>
        <span className={styles.footLabel}>opened step</span>
        <span className={styles.step}>{finding.stepLabel}</span>
        <MonoBadge
          bg={finding.settled ? "var(--color-neutral-200)" : "var(--color-accent-200)"}
          fg={finding.settled ? "var(--color-neutral-800)" : "var(--color-accent-800)"}
        >
          {finding.chip}
        </MonoBadge>
        <span className={styles.spacer} />
        <Button variant="secondary" size="xSmallWide" onClick={onOpenStep}>
          Open step
        </Button>
      </div>
    </div>
  );
}
