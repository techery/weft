import { Button } from "~/components/atoms/Button";
import { Kicker } from "~/components/atoms/Kicker";
import { HistoryBars } from "~/components/molecules/HistoryBars";
import { PhaseRow } from "~/components/molecules/PhaseRow";
import { RecentRunRow } from "~/components/molecules/RecentRunRow";
import type { Run, Workflow } from "~/domain/types";
import styles from "./WorkflowInspector.module.css";

type Props = {
  workflow: Workflow;
  runs: Record<string, Run>;
  onRun: () => void;
  onOpenRun: (runId: string) => void;
};

/** The right-hand panel: what this workflow is, how it has been doing, its shape. */
export function WorkflowInspector({ workflow, runs, onRun, onOpenRun }: Props) {
  return (
    <aside className={styles.panel}>
      <div className={styles.identity}>
        <span className={styles.path}>.weft/workflows/{workflow.file}</span>
        <h2 className={styles.name}>{workflow.name}</h2>
        <span className={styles.desc}>{workflow.desc}</span>
      </div>

      <div className={styles.actions}>
        <Button variant="primary" size="mediumWide" onClick={onRun}>
          Run…
        </Button>
      </div>

      <div className={styles.block}>
        <Kicker>Last 14 runs</Kicker>
        <HistoryBars history={workflow.history} />
        <span className={styles.historyNote}>{workflow.historyNote}</span>
      </div>

      <div className={styles.recent}>
        <Kicker className={styles.kickerSpaced}>Recent runs</Kicker>
        {workflow.recent.map((recent) => (
          <RecentRunRow
            key={recent.id}
            recent={recent}
            state={runs[recent.id]?.state ?? "done"}
            onOpen={() => onOpenRun(recent.id)}
          />
        ))}
        {workflow.recent.length === 0 ? (
          <span className={styles.recentEmpty}>no runs in the last 30 days</span>
        ) : null}
      </div>

      <div className={styles.labels}>
        <Kicker className={styles.kickerSpaced}>Labels in code</Kicker>
        {workflow.labels.map((label, index) => (
          <PhaseRow key={label.name + label.meta} index={index + 1} label={label} />
        ))}
      </div>

      <div className={styles.facts}>
        {workflow.facts.map((fact) => (
          <span key={fact.k} className={styles.fact}>
            <span className={styles.factKey}>{fact.k}</span>
            <span>{fact.v}</span>
          </span>
        ))}
      </div>
    </aside>
  );
}
