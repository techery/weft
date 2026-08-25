import type { ReactNode } from "react";
import { Hairline } from "~/components/atoms/Hairline";
import styles from "./SectionHeading.module.css";

type Props = {
  /** Usually a Kicker, occasionally an h2. */
  children: ReactNode;
  /** Right-hand mono aside. */
  note?: string;
  noteNowrap?: boolean;
};

/** Label, rule, optional aside — the divider used above every content block. */
export function SectionHeading({ children, note, noteNowrap }: Props) {
  return (
    <div className={styles.row}>
      {children}
      <Hairline />
      {note ? (
        <span className={noteNowrap ? `${styles.note} ${styles.nowrap}` : styles.note}>{note}</span>
      ) : null}
    </div>
  );
}
