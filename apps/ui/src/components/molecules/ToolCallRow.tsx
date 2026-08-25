import type { ToolCall } from "~/domain/types";
import styles from "./ToolCallRow.module.css";

export function ToolCallRow({ tool }: { tool: ToolCall }) {
  return (
    <span className={tool.running ? `${styles.row} ${styles.running}` : styles.row}>
      <span className={styles.tag}>tool</span>
      <span className={styles.cmd}>{tool.cmd}</span>
      <span className={tool.running ? `${styles.meta} ${styles.metaRunning}` : styles.meta}>{tool.meta}</span>
    </span>
  );
}
