import styles from "./LiveCursor.module.css";

/**
 * The blinking block that marks output still arriving. Decorative: that a step
 * is streaming is already stated by its status pill and its output title.
 */
export function LiveCursor() {
  return (
    <span className={styles.cursor} aria-hidden="true">
      ▋
    </span>
  );
}
