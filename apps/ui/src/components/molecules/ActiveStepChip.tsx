import type { ActiveStep } from "~/domain/types";
import styles from "./ActiveStepChip.module.css";

type Props = { step: ActiveStep; selected: boolean; onSelect: () => void };

/** One of the "active now" shortcuts above the step body. */
export function ActiveStepChip({ step, selected, onSelect }: Props) {
  return (
    <button
      type="button"
      className={selected ? `${styles.chip} ${styles.on}` : styles.chip}
      onClick={onSelect}
    >
      <span className={styles.dot} />
      <span className={styles.label}>{step.label}</span>
      <span className={styles.name}>{step.name}</span>
      <span className={styles.meta}>{step.meta}</span>
    </button>
  );
}
