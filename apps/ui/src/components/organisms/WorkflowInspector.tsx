import { Button } from "~/components/atoms/Button";
import { Kicker } from "~/components/atoms/Kicker";
import type { HistoryBar } from "~/components/molecules/HistoryBars";
import { HistoryBars } from "~/components/molecules/HistoryBars";
import { PhaseRow } from "~/components/molecules/PhaseRow";
import { RecentRunRow } from "~/components/molecules/RecentRunRow";
import type { RunState, Workflow } from "~/domain/types";
import styles from "./WorkflowInspector.module.css";

type Props = {
  workflow: Workflow;
  /** The strip of past runs, oldest first. */
  history: HistoryBar[];
  /** Lifecycle of each recent run, so its dot says what it is doing now. */
  runStates: Record<string, RunState>;
  /** The daemon's message when the stats behind this panel could not be read. */
  statsError?: string;
  /** Stats still on the wire — an empty strip is not yet a workflow that has never run. */
  statsPending?: boolean;
  /** The daemon's message when the run the phases are read off could not be read. */
  phasesError?: string;
  /** That same run still on the wire. */
  phasesPending?: boolean;
  onRun: () => void;
  onOpenRun: (runId: string) => void;
};

/** The right-hand panel: what this workflow is, how it has been doing, its shape. */
export function WorkflowInspector({
  workflow,
  history,
  runStates,
  statsError,
  statsPending,
  phasesError,
  phasesPending,
  onRun,
  onOpenRun,
}: Props) {
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
        <Kicker>{history.length > 0 ? `Last ${history.length} runs` : "Last runs"}</Kicker>
        {statsError !== undefined || statsPending === true ? (
          <span className={styles.historyNote}>{statsError ?? "reading run history…"}</span>
        ) : (
          <>
            {history.length > 0 ? <HistoryBars bars={history} /> : null}
            <span className={styles.historyNote}>{workflow.historyNote}</span>
          </>
        )}
      </div>

      <div className={styles.recent}>
        <Kicker className={styles.kickerSpaced}>Recent runs</Kicker>
        {workflow.recent.map((recent) => (
          <RecentRunRow
            key={recent.id}
            recent={recent}
            state={runStates[recent.id] ?? "done"}
            onOpen={() => onOpenRun(recent.id)}
          />
        ))}
        {workflow.recent.length === 0 ? (
          <span className={styles.recentEmpty}>
            {statsPending === true
              ? "reading recent runs…"
              : statsError !== undefined
                ? "recent runs could not be read"
                : "no runs in the last 30 days"}
          </span>
        ) : null}
      </div>

      <div className={styles.labels}>
        <Kicker className={styles.kickerSpaced}>Labels in code</Kicker>
        {workflow.labels.map((label, index) => (
          <PhaseRow key={label.name + label.meta} index={index + 1} label={label} />
        ))}
        {workflow.labels.length === 0 ? (
          <span className={styles.recentEmpty}>
            {phasesPending === true
              ? "reading the newest run…"
              : phasesError !== undefined
                ? "the newest run could not be read"
                : "no runs yet — phases are read off the newest one"}
          </span>
        ) : null}
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
