import type { ReactNode } from "react";
import styles from "./Kicker.module.css";

export type KickerTone = "accent" | "inline";

type Props = {
  tone?: KickerTone;
  /** Wider 11px eyebrow used by the queue's group headers. */
  large?: boolean;
  className?: string;
  children: ReactNode;
};

export function Kicker({ tone = "accent", large, className, children }: Props) {
  const classes = [
    styles.kicker,
    tone === "inline" ? styles.inline : "",
    large ? styles.tight : "",
    className ?? "",
  ]
    .filter(Boolean)
    .join(" ");
  return <span className={classes}>{children}</span>;
}
