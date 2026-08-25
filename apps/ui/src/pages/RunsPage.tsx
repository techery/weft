import { useNavigate, useSearch } from "@tanstack/react-router";
import { useAtomValue } from "jotai";
import { useOpenRun } from "~/app/useOpenRun";
import { PillButton } from "~/components/atoms/PillButton";
import { ListTable } from "~/components/molecules/ListTable";
import { RunTableRow } from "~/components/molecules/RunTableRow";
import { StartedBanner } from "~/components/molecules/StartedBanner";
import { PageHeader } from "~/components/templates/PageHeader";
import { ScrollPage } from "~/components/templates/ScrollPage";
import { RUN_FILTERS } from "~/domain/fixtures/runList";
import { passesRunFilter, runTableRows } from "~/domain/views";
import { runsAtom, startedRunAtom } from "~/state/atoms";
import styles from "./RunsPage.module.css";

/** The journal index for the last 30 days. */
export function RunsPage() {
  const runs = useAtomValue(runsAtom);
  const started = useAtomValue(startedRunAtom);
  const search = useSearch({ from: "/runs" });
  const filter = search.filter ?? "All";
  const navigate = useNavigate();
  const openRun = useOpenRun();

  const rows = runTableRows(runs);
  const visible = rows.filter((r) => passesRunFilter(r, filter));

  return (
    <ScrollPage maxWidth={1180} gap={16}>
      <PageHeader
        title="Runs"
        summary={`${rows.length} runs in the journal window · 30d`}
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

      {started ? <StartedBanner wf={started.wf} file={started.file} /> : null}

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
        {visible.map((row) => (
          <RunTableRow
            key={row.id}
            row={row}
            onOpen={() => openRun(row.id, row.state === "waiting" ? "gate" : "default", "runs")}
          />
        ))}
      </ListTable>

      <p className={styles.footnote}>
        Every run keeps its journal, artifacts and staged changes for 30 days — open one to read what
        happened, even after it finished.
      </p>
    </ScrollPage>
  );
}
