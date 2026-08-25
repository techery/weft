import { useSetAtom } from "jotai";
import type { ReactNode } from "react";
import { useEffect } from "react";
import { usePending } from "~/api/queries";
import { Launcher } from "~/components/organisms/Launcher";
import { StatusBar } from "~/components/organisms/StatusBar";
import { type NavKey, TopBar } from "~/components/organisms/TopBar";
import { openLauncherAtom } from "~/state/atoms";
import styles from "./AppShell.module.css";

type Props = {
  active: NavKey;
  children: ReactNode;
};

/** Chrome that never changes: top bar, status bar, and the ⌘K launcher. */
export function AppShell({ active, children }: Props) {
  const pending = usePending();
  const openLauncher = useSetAtom(openLauncherAtom);
  const waiting = pending.data?.pending.length ?? 0;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        openLauncher();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [openLauncher]);

  return (
    <div className={styles.shell}>
      <TopBar
        active={active}
        queueBadge={waiting > 0 ? String(waiting) : undefined}
        onOpenLauncher={openLauncher}
      />
      <div className={styles.main}>{children}</div>
      <StatusBar />
      <Launcher />
    </div>
  );
}
