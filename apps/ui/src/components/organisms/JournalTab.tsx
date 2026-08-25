import { LiveCursor } from "~/components/atoms/LiveCursor";
import { JournalRow } from "~/components/molecules/JournalRow";
import type { Run } from "~/domain/types";
import styles from "./JournalTab.module.css";

type Props = { run: Run; live: boolean };

/**
 * The append-only journal, in the order it was written.
 *
 * Fed by the SSE stream rather than by a fold, because this is the one view of a run that
 * is not a projection — a record that arrives while you are looking at it belongs on the
 * end of the list, not folded into a status somewhere.
 */
export function JournalTab({ run, live }: Props) {
  return (
    <div className={styles.pane}>
      {run.journal.map((entry, index) => (
        // The journal is append-only; a line's position is its identity.
        // biome-ignore lint/suspicious/noArrayIndexKey: append-only, so position is identity
        <JournalRow key={`journal-${index}`} entry={entry} />
      ))}
      {live ? <LiveCursor /> : null}
    </div>
  );
}
