import type { StepInput } from "~/domain/types";
import styles from "./StepInputRow.module.css";

type Props = { input: StepInput; divided: boolean };

/** One field of a step's input record, rendered by the shape of its value. */
export function StepInputRow({ input, divided }: Props) {
  return (
    <div className={divided ? `${styles.row} ${styles.divided}` : styles.row}>
      <span className={styles.key}>{input.k}</span>
      <span className={styles.value}>
        {input.kind === "record" ? (
          <span className={styles.record}>
            <span className={styles.ref}>{input.ref}</span>
            <span className={styles.recordTitle}>{input.title}</span>
            <span className={styles.sub}>{input.sub}</span>
          </span>
        ) : null}
        {input.kind === "file" ? (
          <span className={styles.file}>
            <span className={styles.fileName}>{input.title}</span>
            <span className={styles.fileSub}>{input.sub}</span>
          </span>
        ) : null}
        {input.kind === "text" ? <span className={styles.text}>{input.title}</span> : null}
        {input.pills.length > 0 ? (
          <span className={styles.pills}>
            {input.pills.map((pill) => (
              <span key={pill} className={styles.pill}>
                {pill}
              </span>
            ))}
          </span>
        ) : null}
      </span>
    </div>
  );
}
