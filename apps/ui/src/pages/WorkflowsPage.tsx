import { useNavigate, useSearch } from "@tanstack/react-router";
import { useSetAtom } from "jotai";
import {
  useRun,
  useWorkflow,
  useWorkflowIssues,
  useWorkflowStats,
  useWorkflows,
  useWorkflowTasks,
} from "~/api/queries";
import type { RunDetail, RunStatus, WorkflowRow } from "~/api/types";
import { useOpenRun } from "~/app/useOpenRun";
import { EmptyNote } from "~/components/molecules/EmptyNote";
import type { HistoryBar } from "~/components/molecules/HistoryBars";
import { WorkflowTableRow } from "~/components/molecules/WorkflowTableRow";
import { WorkflowInspector } from "~/components/organisms/WorkflowInspector";
import { PageHeader } from "~/components/templates/PageHeader";
import { adaptWorkflow, runState } from "~/domain/adapt";
import type { RunState } from "~/domain/types";
import { openLauncherForAtom } from "~/state/atoms";
import styles from "./WorkflowsPage.module.css";

/** A run that is still going has no outcome to paint and no duration to scale a bar by. */
const SETTLED = new Set<RunStatus>(["complete", "failed", "cancelled"]);

/** Every workflow the registry knows, with the selected one inspected. */
export function WorkflowsPage() {
  const openLauncherFor = useSetAtom(openLauncherForAtom);
  const { wf } = useSearch({ from: "/workflows" });
  const navigate = useNavigate();
  const openRun = useOpenRun();

  const workflows = useWorkflows();
  const workflowIssues = useWorkflowIssues();
  const rows = workflows.data ?? [];
  // `wf` can name a workflow the registry no longer carries; the first row always exists.
  const selectedRow = rows.find((row) => row.name === wf) ?? rows[0];
  const name = selectedRow?.name ?? "";

  const detail = useWorkflow(name);
  const stats = useWorkflowStats(name);
  const tasks = useWorkflowTasks(name);
  // Nothing declares a workflow's shape, so it is read off its newest run — one query for
  // the inspected workflow only, never for the table.
  const shapeRunId = stats.data?.recent[0]?.runId ?? "";
  const shapeSource = useRun(shapeRunId);

  const selected = selectedRow
    ? adaptWorkflow(selectedRow, { stats: stats.data, detail: detail.data, shapeSource: shapeSource.data })
    : null;

  const recent = stats.data?.recent ?? [];
  // Newest-first from the API; the strip reads oldest-first, like `history` in the adapter.
  const history: HistoryBar[] = recent
    .filter((run) => SETTLED.has(run.status))
    .reverse()
    .map((run) => ({ ok: run.status === "complete", ms: Math.max(0, run.updatedAt - run.createdAt) }));
  const runStates: Record<string, RunState> = {};
  for (const run of recent) runStates[run.runId] = runState(run.status);

  // A disabled `useRun("")` stays pending forever, so a workflow with no runs at all must
  // not read as one whose newest run is still on the wire.
  const phasesPending = stats.isPending || (shapeRunId !== "" && shapeSource.isPending);
  // The phases are read off the newest run, which only the stats can name: a stats failure
  // leaves them unknown, not absent.
  const phasesError = shapeSource.error?.message ?? stats.error?.message;

  return (
    <div className={styles.screen}>
      <div className={styles.list}>
        <PageHeader
          title="Workflows"
          aside={
            <span className={styles.path}>
              .weft/workflows/{rows.length > 0 ? ` · ${rows.length} in the registry` : ""}
            </span>
          }
        />
        {workflows.isPending ? <p className={styles.legend}>Reading the registry…</p> : null}
        {workflows.error ? <EmptyNote>{workflows.error.message}</EmptyNote> : null}
        {!workflows.isPending && !workflows.error && rows.length === 0 ? (
          <EmptyNote>No workflows here yet — add a file to .weft/workflows/.</EmptyNote>
        ) : null}
        {rows.length > 0 ? (
          <div className={styles.cards}>
            {rows.map((row) => (
              <RegistryRow
                key={row.name}
                row={row}
                selected={row.name === selectedRow?.name}
                // Only the inspected workflow's newest run is read, so it is the only row
                // that can carry a shape — every other one would cost a run read.
                shapeSource={row.name === selectedRow?.name ? shapeSource.data : undefined}
                onSelect={() => void navigate({ to: "/workflows", search: { wf: row.name } })}
                onRun={() => openLauncherFor(row.name)}
              />
            ))}
          </div>
        ) : null}
        {workflowIssues.data && workflowIssues.data.length > 0 ? (
          <section className={styles.issues} aria-labelledby="broken-workflows-heading">
            <div className={styles.issuesHeader}>
              <h2 id="broken-workflows-heading">Broken workflows</h2>
              <span className={styles.issuesCount}>{workflowIssues.data.length}</span>
            </div>
            {workflowIssues.data.map((issue) => (
              <article key={issue.file} className={styles.issue}>
                <div className={styles.issueFile}>
                  <span className={styles.issueMarker} aria-hidden="true">
                    !
                  </span>
                  <span>{issue.file}</span>
                </div>
                <p className={styles.issueError}>{issue.error.split("\n", 1)[0]}</p>
                {issue.diagnostics.length > 0 ? (
                  <ul className={styles.diagnostics}>
                    {issue.diagnostics.map((diagnostic) => (
                      <li
                        key={`${diagnostic.file}:${diagnostic.line}:${diagnostic.column}:${diagnostic.rule}`}
                      >
                        <span className={styles.diagnosticLocation}>
                          {diagnostic.file}:{diagnostic.line}:{diagnostic.column}
                        </span>{" "}
                        <span className={styles.diagnosticRule}>{diagnostic.rule}</span>
                        <span> {diagnostic.message}</span>
                        {diagnostic.fixIt ? (
                          <span className={styles.diagnosticFix}>Fix: {diagnostic.fixIt}</span>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                ) : null}
              </article>
            ))}
          </section>
        ) : null}
      </div>

      {selected ? (
        <WorkflowInspector
          workflow={selected}
          history={history}
          runStates={runStates}
          statsPending={stats.isPending}
          statsError={stats.error?.message}
          phasesPending={phasesPending}
          phasesError={phasesError}
          tasks={tasks.data ?? []}
          tasksPending={tasks.isPending}
          tasksError={tasks.error?.message}
          onRun={() => openLauncherFor(selected.name)}
          onOpenRun={(runId) => openRun(runId, { from: "runs" })}
        />
      ) : null}
    </div>
  );
}

/**
 * One row's numbers are its own query. That is a request per workflow, which a registry of
 * a handful of files can afford — and the row draws from the listing until they arrive,
 * rather than holding the whole table back.
 */
function RegistryRow({
  row,
  selected,
  shapeSource,
  onSelect,
  onRun,
}: {
  row: WorkflowRow;
  selected: boolean;
  /** This workflow's newest run, when the page already holds it — the only source of a shape. */
  shapeSource?: RunDetail;
  onSelect: () => void;
  onRun: () => void;
}) {
  const stats = useWorkflowStats(row.name);
  return (
    <WorkflowTableRow
      workflow={adaptWorkflow(row, { stats: stats.data, shapeSource })}
      selected={selected}
      onSelect={onSelect}
      onRun={onRun}
    />
  );
}
