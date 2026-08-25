import { RailStepRow } from "~/components/molecules/RailStepRow";
import type { Run } from "~/domain/types";
import styles from "./RunRail.module.css";

type Props = { run: Run; selectedStepId: string; onSelect: (stepId: string) => void };

/** One linear list of steps, grouped by the label the workflow gave them. */
export function RunRail({ run, selectedStepId, onSelect }: Props) {
  return (
    <nav className={styles.rail} aria-label="Run steps">
      <span className={styles.title}>{run.railTitle}</span>
      {run.rail.map((group, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: label names repeat across a run, so only position identifies a group
        <div key={`${group.name}-${index}`} className={styles.group}>
          <span className={styles.groupHead}>
            <span className={styles.groupName}>{group.name}</span>
            <span className={styles.groupMeta}>{group.meta}</span>
          </span>
          {group.steps.map((step) => (
            <RailStepRow
              key={step.id}
              step={step}
              selected={step.id === selectedStepId}
              onSelect={() => onSelect(step.id)}
            />
          ))}
        </div>
      ))}
      <span className={styles.note}>
        One linear list, appended as steps start. Several steps can be active at once under different labels.
      </span>
    </nav>
  );
}
