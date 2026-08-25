import { useNavigate, useSearch } from "@tanstack/react-router";
import { usePending, useRuns } from "~/api/queries";
import type { PendingRequest } from "~/api/types";
import { useOpenRun } from "~/app/useOpenRun";
import { PillButton } from "~/components/atoms/PillButton";
import { ListTable } from "~/components/molecules/ListTable";
import { RunTableRow } from "~/components/molecules/RunTableRow";
import { PageHeader } from "~/components/templates/PageHeader";
import { ScrollPage } from "~/components/templates/ScrollPage";
import { adaptRunRows, gateStepId } from "~/domain/adapt";
import { passesFilter, RUN_FILTERS } from "~/domain/filters";
import styles from "./RunsPage.module.css";

/** The journal index for the last 30 days. */
export function RunsPage() {
  const search = useSearch({ from: "/runs" });
  const filter = search.filter ?? "All";
  const navigate = useNavigate();
  const openRun = useOpenRun();
  const runs = useRuns({ spend: true });
  const pending = usePending();

  const pendingByRun = new Map<string, PendingRequest>();
  // Keyed by the run that OWNS the question, which is the run this table has a row for —
  // a child's question belongs to the child's row, not its root's. The queue arrives
  // oldest-first, so the first one kept per run is the one that stopped it.
  for (const request of pending.data?.pending ?? []) {
    if (!pendingByRun.has(request.runId)) pendingByRun.set(request.runId, request);
  }

  const rows = adaptRunRows(runs.data ?? [], pendingByRun);
  const visible = rows.filter((row) => passesFilter(row.state, filter));
  const settled = !runs.isPending && runs.error === null;
  // The queue is where a waiting row's question comes from, so a failed queue read has to
  // be said out loud: without it those rows quietly report a step count instead.
  const failure = runs.error ?? pending.error;

  const open = (runId: string) => {
    const request = pendingByRun.get(runId);
    // A run that is waiting opens on its gate, the same landing the queue gives it.
    openRun(runId, { from: "runs", ...(request ? { step: gateStepId(request.id) } : {}) });
  };

  return (
    <ScrollPage maxWidth={1180} gap={16}>
      <PageHeader
        title="Runs"
        summary={
          settled ? `${rows.length} run${rows.length === 1 ? "" : "s"} in the journal window` : undefined
        }
        aside={
          <span className={styles.filters}>
            {RUN_FILTERS.map((f) => (
              <PillButton
                key={f}
                on={filter === f}
                onClick={() => void navigate({ to: "/runs", search: { filter: f } })}
              >
                {f}
              </PillButton>
            ))}
          </span>
        }
      />

      <ListTable
        head={
          <>
            <span className={styles.headRun}>Run</span>
            <span className={styles.headWhere}>Where it stands</span>
            <span className={styles.headState}>State</span>
            <span className={styles.headStarted}>Started</span>
            <span className={styles.headElapsed}>Elapsed</span>
            <span className={styles.headCost}>Cost</span>
          </>
        }
      >
        {runs.isPending ? <p className={styles.note}>Reading the journal…</p> : null}
        {failure ? <p className={styles.error}>{failure.message}</p> : null}
        {visible.map((row) => (
          <RunTableRow key={row.id} row={row} onOpen={() => open(row.id)} />
        ))}
        {settled && visible.length === 0 ? (
          <p className={styles.note}>
            {rows.length === 0 ? "No runs in the journal window." : "No runs in this filter."}
          </p>
        ) : null}
      </ListTable>

      <p className={styles.footnote}>
        Every run keeps its journal, artifacts and staged changes for 30 days — open one to read what
        happened, even after it finished.
      </p>
    </ScrollPage>
  );
}
