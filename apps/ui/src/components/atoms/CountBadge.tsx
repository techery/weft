import styles from "./CountBadge.module.css";

/** The small count that rides along in nav items and run tabs. */
export function CountBadge({ bg, fg, children }: { bg: string; fg: string; children: string }) {
  return (
    <span className={styles.badge} style={{ background: bg, color: fg }}>
      {children}
    </span>
  );
}
