import type { GateOption } from "~/domain/types";
import styles from "./OptionCard.module.css";

type Props = {
  /** Radio group name — the gate question this option answers. */
  name: string;
  option: GateOption;
  selected: boolean;
  onPick: () => void;
};

/** A radio-style choice card in a gate — the primary answer control. */
export function OptionCard({ name, option, selected, onPick }: Props) {
  return (
    <label className={selected ? `${styles.card} ${styles.on}` : styles.card}>
      <input
        type="radio"
        className={styles.input}
        name={name}
        value={option.label}
        checked={selected}
        onChange={onPick}
      />
      <span className={styles.head}>
        <span className={selected ? `${styles.dot} ${styles.dotOn}` : styles.dot} />
        <span className={styles.label}>{option.label}</span>
        <span className={styles.spacer} />
        {option.meta ? <span className={styles.meta}>{option.meta}</span> : null}
      </span>
      <span className={styles.desc}>{option.desc}</span>
    </label>
  );
}
