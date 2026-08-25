import { Link } from "@tanstack/react-router";
import { useMeta } from "~/api/queries";
import { Button } from "~/components/atoms/Button";
import { StatusDot } from "~/components/atoms/StatusDot";
import { NavTab } from "~/components/molecules/NavTab";
import type { RunState } from "~/domain/types";
import styles from "./TopBar.module.css";

export type NavKey = "queue" | "runs" | "workflows" | "settings";

type Props = {
  active: NavKey;
  /** Absent when nothing is waiting, or before the queue has answered. */
  queueBadge?: string;
  onOpenLauncher: () => void;
};

export function TopBar({ active, queueBadge, onOpenLauncher }: Props) {
  const meta = useMeta();
  // Grey until /api/meta answers once: a green dot before anything replied would be
  // claiming a reachability the page has not established yet.
  const dot: RunState = meta.isSuccess ? "running" : meta.isError ? "failed" : "done";

  return (
    <header className={styles.bar}>
      <div className={styles.brand}>
        <Link to="/queue" className={styles.brandLink}>
          <span className={styles.mark}>w</span>
          <span className={styles.word}>weft</span>
        </Link>
        {meta.data ? <span className={styles.repo}>{meta.data.repo.name}</span> : null}
      </div>
      <nav className={styles.nav}>
        <NavTab to="/queue" label="Queue" badge={queueBadge} active={active === "queue"} />
        <NavTab to="/runs" label="Runs" active={active === "runs"} />
        <NavTab to="/workflows" label="Workflows" active={active === "workflows"} />
        <NavTab to="/settings" label="Settings" active={active === "settings"} />
      </nav>
      <span className={styles.spacer} />
      <Button variant="primary" size="mediumWide" onClick={onOpenLauncher}>
        Run a workflow ⌘K
      </Button>
      <span className={styles.daemon} title={meta.error?.message}>
        <StatusDot state={dot} />
        {/* This page is served by the daemon it talks to, so its own origin is the address. */}
        daemon · {window.location.host}
      </span>
    </header>
  );
}
