import type { InputHTMLAttributes } from "react";
import styles from "./Fields.module.css";

export function RangeField(props: Omit<InputHTMLAttributes<HTMLInputElement>, "type">) {
  return <input type="range" className={styles.range} {...props} />;
}
