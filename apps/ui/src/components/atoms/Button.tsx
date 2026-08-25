import type { ButtonHTMLAttributes } from "react";
import styles from "./Button.module.css";

export type ButtonVariant = "primary" | "secondary" | "ghost";

export type ButtonSize = "xSmall" | "xSmallWide" | "small" | "smallWide" | "medium" | "mediumWide" | "large";

type Props = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant: ButtonVariant;
  size: ButtonSize;
  /** Pill radius instead of the default 8px corner. */
  round?: boolean;
};

export function Button({ variant, size, round, className, ...rest }: Props) {
  const classes = [styles.btn, styles[variant], styles[size], round ? styles.round : "", className ?? ""]
    .filter(Boolean)
    .join(" ");
  return <button type="button" className={classes} {...rest} />;
}
