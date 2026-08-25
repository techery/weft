import { Button } from "~/components/atoms/Button";
import styles from "./NextStrip.module.css";

type Props = {
  label: string;
  detail: string;
  /** Shown only when this step is the gate that is holding the run. */
  onAnswerNow?: () => void;
};

/** The dashed strip explaining what weft did, or is about to do, next. */
export function NextStrip({ label, detail, onAnswerNow }: Props) {
  return (
    <div className={styles.strip}>
      <span className={styles.key}>{label}</span>
      <span className={styles.value}>{detail}</span>
      {onAnswerNow ? (
        <Button variant="primary" size="smallWide" onClick={onAnswerNow}>
          Answer now
        </Button>
      ) : null}
    </div>
  );
}
