import { journalTagColor } from "~/domain/palette";
import type { JournalEntry } from "~/domain/types";
import styles from "./JournalRow.module.css";

export function JournalRow({ entry }: { entry: JournalEntry }) {
  return (
    <span className={styles.row}>
      <span className={styles.time}>{entry.time}</span>
      <span className={styles.tag} style={{ color: journalTagColor(entry.tag) }}>
        {entry.tag}
      </span>
      <span className={styles.text}>{entry.text}</span>
    </span>
  );
}
