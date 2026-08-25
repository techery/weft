import type { TextareaHTMLAttributes } from "react";
import styles from "./Fields.module.css";

export function TextArea({ className, ...rest }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <textarea
      className={[styles.control, styles.note, className ?? ""].filter(Boolean).join(" ")}
      {...rest}
    />
  );
}
