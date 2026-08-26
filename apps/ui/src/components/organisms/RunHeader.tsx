import { useEffect, useState } from "react";
import { Button } from "~/components/atoms/Button";
import { StatusPill } from "~/components/atoms/StatusPill";
import { formatElapsed } from "~/domain/journal";
import { runPillKind } from "~/domain/palette";
import type { Run } from "~/domain/types";
import styles from "./RunHeader.module.css";

type Props = {
  run: Run;
  backLabel: string;
  onBack: () => void;
  onOpenWorkflow: () => void;
  canCancel: boolean;
  cancelling: boolean;
  onCancel: () => void;
};

export function RunHeader({
  run,
  backLabel,
  onBack,
  onOpenWorkflow,
  canCancel,
  cancelling,
  onCancel,
}: Props) {
  const live = run.state === "running" || run.state === "waiting";
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!live) return;
    const tick = () => setNow(Date.now());
    tick();
    const timer = window.setInterval(tick, 1_000);
    return () => window.clearInterval(timer);
  }, [live]);

  const chrome = live
    ? (() => {
        const parts = run.chrome.split(" · ");
        parts[1] = formatElapsed(now - run.createdAt);
        return parts.join(" · ");
      })()
    : run.chrome;

  return (
    <div className={styles.header}>
      <div className={styles.row}>
        <Button variant="ghost" size="xSmall" onClick={onBack}>
          {backLabel}
        </Button>
        <h2 className={styles.title}>{run.wf}</h2>
        <span className={styles.id}>{run.id}</span>
        <StatusPill kind={runPillKind(run.state)}>{run.pill}</StatusPill>
        {run.file ? (
          <button type="button" className={styles.fileLink} onClick={onOpenWorkflow}>
            {run.file}
          </button>
        ) : null}
        <span className={styles.spacer} />
        <span className={styles.chrome}>{chrome}</span>
        {canCancel ? (
          <Button variant="secondary" size="smallWide" disabled={cancelling} onClick={onCancel}>
            {cancelling ? "Cancelling…" : "Cancel run"}
          </Button>
        ) : null}
      </div>
    </div>
  );
}
