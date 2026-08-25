import { FindingCard } from "~/components/molecules/FindingCard";
import { SectionHeading } from "~/components/molecules/SectionHeading";
import type { Run } from "~/domain/types";
import styles from "./FindingsTab.module.css";

type Props = { run: Run; onOpenStep: (stepId: string) => void };

export function FindingsTab({ run, onOpenStep }: Props) {
  return (
    <div className={styles.pane}>
      <SectionHeading note="each finding opened one step — the code decided how many and when">
        <h2 className={styles.title}>Findings</h2>
      </SectionHeading>
      {run.findings.map((finding) => (
        <FindingCard key={finding.id} finding={finding} onOpenStep={() => onOpenStep(finding.stepId)} />
      ))}
    </div>
  );
}
