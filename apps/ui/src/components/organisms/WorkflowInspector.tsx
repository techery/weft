import { useState } from "react";
import type { WorkflowTask } from "~/api/types";
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
  tasks: WorkflowTask[];
  tasksPending?: boolean;
  tasksError?: string;
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
  tasks,
  tasksPending,
  tasksError,
  onRun,
  onOpenRun,
}: Props) {
  const [taskWindow, setTaskWindow] = useState({ workflow: workflow.name, count: 50 });
  const visibleTaskCount = taskWindow.workflow === workflow.name ? taskWindow.count : 50;
  const visibleTasks = tasks.slice(0, visibleTaskCount);
  return (
    <aside className={styles.panel} aria-labelledby="workflow-inspector-title">
      <div className={styles.identity}>
        <h2 id="workflow-inspector-title" className={styles.name}>
          {workflow.name}
        </h2>
        <span className={styles.desc}>{workflow.desc}</span>
        <span className={styles.path}>{workflow.file}</span>
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
        <Kicker className={styles.kickerSpaced}>Latest run shape</Kicker>
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

      <section className={styles.tasks} aria-labelledby="workflow-tasks-heading">
        <h3 id="workflow-tasks-heading" className={styles.taskHeading}>
          Tasks · {tasks.length}
        </h3>
        {visibleTasks.map((task) => (
          <article key={task.id} className={styles.task} data-status={task.status}>
            <div className={styles.taskHead}>
              <span className={styles.taskStatus}>{task.status.replace("_", " ")}</span>
              <span className={styles.taskPriority}>{task.priority}</span>
              <span className={styles.taskId}>{task.id}</span>
            </div>
            <h3 className={styles.taskTitle}>{task.title}</h3>
            <p className={styles.taskDescription}>{task.description}</p>
            {task.dedupeKey ? <span className={styles.taskMeta}>Identity {task.dedupeKey}</span> : null}
            {task.tags.length > 0 ? (
              <div className={styles.taskTags}>
                {task.tags.map((tag) => (
                  <span key={tag}>#{tag}</span>
                ))}
              </div>
            ) : null}
            {task.acceptanceCriteria.length > 0 ? (
              <ul className={styles.criteria}>
                {task.acceptanceCriteria.map((criterion) => (
                  <li
                    key={criterion.id}
                    data-met={criterion.met}
                    aria-label={`${criterion.text}: ${criterion.met ? "met" : "not met"}`}
                  >
                    <span aria-hidden="true">{criterion.met ? "✓" : "○"}</span>
                    {criterion.text}
                  </li>
                ))}
              </ul>
            ) : null}
            {task.dependencies.length > 0 ? (
              <span className={styles.taskMeta}>Depends on {task.dependencies.join(", ")}</span>
            ) : null}
            {task.relatedFiles.length > 0 ? (
              <span className={styles.taskMeta}>Files {task.relatedFiles.join(", ")}</span>
            ) : null}
            {task.notes.length > 0 ? <TaskNotes task={task} /> : null}
            {hasExtensions(task.extensions) ? (
              <pre className={styles.extensions}>{JSON.stringify(task.extensions, null, 2)}</pre>
            ) : null}
            <span className={styles.taskAudit}>
              Updated {new Date(task.updatedAt).toLocaleString()} by {task.updatedBy} · revision{" "}
              {task.revision} · schema v{task.extensionSchemaVersion}
            </span>
          </article>
        ))}
        {visibleTasks.length < tasks.length ? (
          <Button
            variant="secondary"
            size="mediumWide"
            onClick={() => setTaskWindow({ workflow: workflow.name, count: visibleTaskCount + 50 })}
          >
            Show 50 more · {tasks.length - visibleTasks.length} remaining
          </Button>
        ) : null}
        {tasks.length === 0 ? (
          <span className={styles.recentEmpty}>
            {tasksPending === true
              ? "reading workflow tasks…"
              : tasksError !== undefined
                ? "workflow tasks could not be read"
                : "no tasks — agents can create them with the bound weft CLI"}
          </span>
        ) : null}
        {tasksError !== undefined ? <span className={styles.taskError}>{tasksError}</span> : null}
      </section>

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

function TaskNotes({ task }: { task: WorkflowTask }) {
  const [open, setOpen] = useState(false);
  return (
    <details className={styles.taskNotes} onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary>
        {task.notes.length === 1 ? "1 note" : `${task.notes.length} notes`} · latest by{" "}
        {task.notes.at(-1)?.actor}
      </summary>
      {open ? (
        <ol>
          {task.notes.map((note) => (
            <li key={`${note.at}-${note.actor}-${note.text}`}>
              <time dateTime={new Date(note.at).toISOString()}>{new Date(note.at).toLocaleString()}</time>{" "}
              <strong>{note.actor}</strong>: {note.text}
            </li>
          ))}
        </ol>
      ) : null}
    </details>
  );
}

function hasExtensions(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return value !== undefined && value !== null;
  return Object.keys(value).length > 0;
}
