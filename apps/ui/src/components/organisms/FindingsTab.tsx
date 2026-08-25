import { FindingCard } from "~/components/molecules/FindingCard";
import { SectionHeading } from "~/components/molecules/SectionHeading";
import type { Run } from "~/domain/types";
import styles from "./FindingsTab.module.css";

type Props = { run: Run };

/**
 * A run's journaled notes.
 *
 * `ctx.note` records a kind, some text and optional evidence — no severity scale and no
 * link to a step. So a note names itself and the card's footer is omitted rather than
 * pointing at a step nothing actually chose.
 */
export function FindingsTab({ run }: Props) {
  return (
    <div className={styles.pane}>
      <SectionHeading note="journaled by the run as it went">
        <h2 className={styles.title}>Notes</h2>
      </SectionHeading>
      {run.findings.map((finding) => (
        <FindingCard key={finding.id} finding={finding} />
      ))}
    </div>
  );
}
