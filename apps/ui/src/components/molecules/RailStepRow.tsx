import { MonoBadge } from "~/components/atoms/MonoBadge";
import { StatusDot } from "~/components/atoms/StatusDot";
import type { RailStep } from "~/domain/types";
import styles from "./RailStepRow.module.css";

type Props = { step: RailStep; selected: boolean; onSelect: () => void };

const LOUD = new Set(["run", "fail", "waiting"]);

export function RailStepRow({ step, selected, onSelect }: Props) {
  const ground = selected
    ? styles.selected
    : step.state === "fail"
      ? styles.fail
      : step.state === "waiting"
        ? styles.waiting
        : step.state === "run"
          ? styles.run
          : "";
  const metaTone =
    step.state === "fail" ? styles.metaFail : step.state === "waiting" ? styles.metaWaiting : "";

  return (
    <button
      type="button"
      aria-current={selected ? "step" : undefined}
      className={[styles.row, ground].filter(Boolean).join(" ")}
      onClick={onSelect}
    >
      <StatusDot state={step.state} />
      <span className={styles.kind}>{step.kind}</span>
      <span className={[styles.label, LOUD.has(step.state) ? styles.emphasis : ""].filter(Boolean).join(" ")}>
        {step.label}
      </span>
      {step.artifact ? (
        <MonoBadge bg="var(--color-accent-2-200)" fg="var(--color-accent-2-800)" truncating>
          {step.artifact}
        </MonoBadge>
      ) : null}
      <span className={[styles.meta, metaTone].filter(Boolean).join(" ")}>{step.meta}</span>
    </button>
  );
}
