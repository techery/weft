import { LiveCursor } from "~/components/atoms/LiveCursor";
import { JournalRow } from "~/components/molecules/JournalRow";
import type { Run } from "~/domain/types";
import styles from "./JournalTab.module.css";

/** The append-only jsonl journal, rendered as it was written. */
export function JournalTab({ run }: { run: Run }) {
  const live = run.state === "running" || run.state === "waiting";
  return (
    <div className={styles.pane}>
      {run.journal.map((entry, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: the journal is append-only, so a line's position is its identity
        <JournalRow key={`journal-${index}`} entry={entry} />
      ))}
      {live ? <LiveCursor /> : null}
    </div>
  );
}
