import styles from "./FactCell.module.css";

export type FactCellVariant = "step" | "queue" | "artifact";

type Props = {
  label: string;
  value: string;
  /** Overrides the value colour — step cells highlight exits and links. */
  color?: string;
  /** Minimum width in px; step cells narrow the `kind` column. */
  minWidth?: number;
  variant?: FactCellVariant;
  first?: boolean;
};

export function FactCell({ label, value, color, minWidth, variant = "step", first }: Props) {
  const Tag = variant === "step" ? "li" : "span";
  const classes = [
    styles.cell,
    variant === "step" ? styles.step : "",
    variant === "queue" ? `${styles.fixed} ${styles.small}` : "",
    variant === "artifact" ? styles.wide : "",
    first ? styles.first : "",
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <Tag className={classes} style={minWidth ? { minWidth } : undefined}>
      <span className={styles.key}>{label}</span>
      <span className={styles.value} style={color ? { color } : undefined}>
        {value}
      </span>
    </Tag>
  );
}
