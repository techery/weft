import type { SelectHTMLAttributes } from "react";
import styles from "./Fields.module.css";

export function SelectField({ className, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      className={[styles.control, styles.select, className ?? ""].filter(Boolean).join(" ")}
      {...rest}
    />
  );
}
