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
        <span className={styles.chrome}>{run.chrome}</span>
        {canCancel ? (
          <Button variant="secondary" size="smallWide" disabled={cancelling} onClick={onCancel}>
            {cancelling ? "Cancelling…" : "Cancel run"}
          </Button>
        ) : null}
      </div>
    </div>
  );
}
