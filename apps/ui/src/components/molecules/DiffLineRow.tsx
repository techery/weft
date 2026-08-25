import type { DiffLine } from "~/domain/types";
import styles from "./DiffLineRow.module.css";

export function DiffLineRow({ line }: { line: DiffLine }) {
  const ground = line.sign === "+" ? styles.added : line.sign === "-" ? styles.removed : "";
  const text = line.sign === "+" ? styles.textAdded : line.sign === "-" ? styles.textRemoved : "";
  return (
    <span className={[styles.row, ground].filter(Boolean).join(" ")}>
      <span className={`${styles.gutter} ${styles.old}`}>{line.ln || "·"}</span>
      <span className={`${styles.gutter} ${styles.new}`}>{line.rn || "·"}</span>
      <span className={[styles.text, text].filter(Boolean).join(" ")}>{line.text}</span>
    </span>
  );
}
