import { Button } from "~/components/atoms/Button";
import { StatusPill } from "~/components/atoms/StatusPill";
import { runPillKind } from "~/domain/palette";
import type { Run } from "~/domain/types";
import styles from "./RunHeader.module.css";

type Props = {
  run: Run;
  backLabel: string;
  onBack: () => void;
  onOpenWorkflow: () => void;
};

export function RunHeader({ run, backLabel, onBack, onOpenWorkflow }: Props) {
  const canCancel = run.state === "running" || run.state === "waiting";
  return (
    <div className={styles.header}>
      <div className={styles.row}>
        <Button variant="ghost" size="xSmall" onClick={onBack}>
          {backLabel}
        </Button>
        <h2 className={styles.title}>{run.wf}</h2>
        <span className={styles.id}>{run.id}</span>
        <StatusPill kind={runPillKind(run.state)}>{run.pill}</StatusPill>
        <button type="button" className={styles.fileLink} onClick={onOpenWorkflow}>
          {run.file}
        </button>
        <span className={styles.spacer} />
        <span className={styles.chrome}>{run.chrome}</span>
        {canCancel ? (
          <Button variant="secondary" size="smallWide">
            Cancel run
          </Button>
        ) : null}
      </div>
    </div>
  );
}
