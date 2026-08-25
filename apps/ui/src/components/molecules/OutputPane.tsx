import { LiveCursor } from "~/components/atoms/LiveCursor";
import styles from "./OutputPane.module.css";

type Props = { title: string; note: string; lines: string[]; streaming: boolean };

/** The dark pane holding whatever the step returned. */
export function OutputPane({ title, note, lines, streaming }: Props) {
  return (
    <div className={styles.pane}>
      <span className={styles.head}>
        <span className={styles.title}>{title}</span>
        <span className={styles.spacer} />
        <span className={styles.note}>{note}</span>
      </span>
      {lines.map((line, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: step output is an ordered transcript, never reordered
        <span key={`out-${index}`} className={styles.line}>
          {line}
        </span>
      ))}
      {streaming ? <LiveCursor /> : null}
    </div>
  );
}
