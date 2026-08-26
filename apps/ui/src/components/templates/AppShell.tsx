import type { ReactNode } from "react";
import { usePending } from "~/api/queries";
import { Launcher } from "~/components/organisms/Launcher";
import { type NavKey, TopBar } from "~/components/organisms/TopBar";
import styles from "./AppShell.module.css";

type Props = {
  active: NavKey;
  hideHeader?: boolean;
  children: ReactNode;
};

/** Chrome that never changes: top bar and the selected workflow's input dialog. */
export function AppShell({ active, hideHeader = false, children }: Props) {
  const pending = usePending();
  const waiting = pending.data?.pending.length ?? 0;

  return (
    <div className={styles.shell}>
      {hideHeader ? null : <TopBar active={active} queueBadge={waiting > 0 ? String(waiting) : undefined} />}
      <div className={styles.main}>{children}</div>
      <Launcher />
    </div>
  );
}
