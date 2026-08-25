import { STATUS_COLOR } from "~/domain/palette";
import type { RunState, StepState, WorkflowState } from "~/domain/types";
import styles from "./StatusDot.module.css";

type Props = {
  state: RunState | StepState | WorkflowState;
  /** Diameter in px — 7 everywhere except the two 6px lists. */
  size?: number;
  pulse?: boolean;
};

export function StatusDot({ state, size = 7, pulse }: Props) {
  return (
    <span
      className={pulse ? `${styles.dot} ${styles.pulse}` : styles.dot}
      style={{ width: size, height: size, background: STATUS_COLOR[state] }}
    />
  );
}
