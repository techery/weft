import { useAtomValue, useSetAtom } from "jotai";
import type { ReactNode } from "react";
import { useEffect } from "react";
import { Launcher } from "~/components/organisms/Launcher";
import { StatusBar } from "~/components/organisms/StatusBar";
import { type NavKey, TopBar } from "~/components/organisms/TopBar";
import { RUN_ORDER } from "~/domain/fixtures/runs";
import type { Workflow } from "~/domain/types";
import { queueGroups } from "~/domain/views";
import { budgetAtom, concurrencyAtom, openLauncherAtom, runsAtom } from "~/state/atoms";
import styles from "./AppShell.module.css";

type Props = {
  active: NavKey;
  onStartRun: (workflow: Workflow) => void;
  children: ReactNode;
};

/** Chrome that never changes: top bar, status bar, and the ⌘K launcher. */
export function AppShell({ active, onStartRun, children }: Props) {
  const runs = useAtomValue(runsAtom);
  const budget = useAtomValue(budgetAtom);
  const concurrency = useAtomValue(concurrencyAtom);
  const openLauncher = useSetAtom(openLauncherAtom);
  const waitingCount = queueGroups(runs, RUN_ORDER).waiting.length;

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
      <TopBar active={active} queueBadge={String(waitingCount)} onOpenLauncher={openLauncher} />
      <div className={styles.main}>{children}</div>
      <StatusBar concurrency={concurrency} budget={budget} />
      <Launcher onStart={onStartRun} />
    </div>
  );
}
