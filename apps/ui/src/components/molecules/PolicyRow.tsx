import type { PolicyMode, RiskTier } from "~/domain/types";
import styles from "./PolicyRow.module.css";

type Props = {
  tier: RiskTier;
  ops: string;
  mode: PolicyMode;
  onSet: (mode: PolicyMode) => void;
};

const MODES: PolicyMode[] = ["auto", "ask"];

export function PolicyRow({ tier, ops, mode, onSet }: Props) {
  return (
    <div className={styles.row}>
      <span className={styles.tier}>{tier}</span>
      <span className={styles.ops}>{ops}</span>
      <span className={styles.modes}>
        {MODES.map((option) => (
          <button
            key={option}
            type="button"
            aria-pressed={mode === option}
            className={mode === option ? `${styles.mode} ${styles.on}` : styles.mode}
            onClick={() => onSet(option)}
          >
            {option}
          </button>
        ))}
      </span>
    </div>
  );
}
