import { Link } from "@tanstack/react-router";
import { Button } from "~/components/atoms/Button";
import { StatusDot } from "~/components/atoms/StatusDot";
import { NavTab } from "~/components/molecules/NavTab";
import styles from "./TopBar.module.css";

export type NavKey = "queue" | "runs" | "workflows" | "settings";

type Props = {
  active: NavKey;
  queueBadge: string;
  onOpenLauncher: () => void;
};

export function TopBar({ active, queueBadge, onOpenLauncher }: Props) {
  return (
    <header className={styles.bar}>
      <div className={styles.brand}>
        <Link to="/queue" className={styles.brandLink}>
          <span className={styles.mark}>w</span>
          <span className={styles.word}>weft</span>
        </Link>
        <span className={styles.repo}>acme/treel</span>
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
      <span className={styles.daemon}>
        <StatusDot state="running" />
        daemon · localhost:4781
      </span>
    </header>
  );
}
