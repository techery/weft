import type { ReactNode } from "react";
import { Kicker } from "~/components/atoms/Kicker";
import styles from "./SettingsCard.module.css";

type Props = { title: string; gap: number; children: ReactNode };

export function SettingsCard({ title, gap, children }: Props) {
  return (
    <section className={styles.card} style={{ gap }}>
      <Kicker>{title}</Kicker>
      {children}
    </section>
  );
}
