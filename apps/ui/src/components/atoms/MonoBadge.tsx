import styles from "./MonoBadge.module.css";

type Props = {
  bg: string;
  fg: string;
  /** Squared 8px corners with uppercase tracking — artifact type badges. */
  boxy?: boolean;
  /** Shrinks and ellipsises instead of forcing its width — rail artifact chips. */
  truncating?: boolean;
  children: string;
};

/** A small mono label on a tinted ground: risk tiers, file types, artifact names. */
export function MonoBadge({ bg, fg, boxy, truncating, children }: Props) {
  const classes = [styles.badge, boxy ? styles.rounded : "", truncating ? styles.truncating : ""]
    .filter(Boolean)
    .join(" ");
  return (
    <span className={classes} style={{ background: bg, color: fg }}>
      {children}
    </span>
  );
}
