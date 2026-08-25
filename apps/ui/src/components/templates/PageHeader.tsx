import type { ReactNode } from "react";
import { ScreenTitle } from "~/components/atoms/ScreenTitle";
import styles from "./PageHeader.module.css";

type Props = {
  title: string;
  summary?: string;
  /** Right-aligned controls: filters, quick-start shortcuts, a path note. */
  aside?: ReactNode;
};

export function PageHeader({ title, summary, aside }: Props) {
  return (
    <div className={styles.header}>
      <ScreenTitle>{title}</ScreenTitle>
      {summary ? <span className={styles.summary}>{summary}</span> : null}
      <span className={styles.spacer} />
      {aside}
    </div>
  );
}
