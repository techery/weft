import styles from "./EmptyNote.module.css";

export function EmptyNote({ children }: { children: string }) {
  return <span className={styles.note}>{children}</span>;
}
