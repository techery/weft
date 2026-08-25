import type { InputHTMLAttributes } from "react";
import styles from "./Fields.module.css";

type Props = Omit<InputHTMLAttributes<HTMLInputElement>, "size"> & {
  /** Settings uses a slightly taller field than the launcher does. */
  scale?: "compact" | "settings";
};

export function TextField({ scale = "compact", className, ...rest }: Props) {
  const classes = [styles.control, scale === "settings" ? styles.settings : "", className ?? ""]
    .filter(Boolean)
    .join(" ");
  return <input type="text" className={classes} {...rest} />;
}
