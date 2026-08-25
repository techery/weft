import { useNavigate, useSearch } from "@tanstack/react-router";
import { useAtomValue, useSetAtom } from "jotai";
import { useOpenRun } from "~/app/useOpenRun";
import { ListTable } from "~/components/molecules/ListTable";
import { WorkflowTableRow } from "~/components/molecules/WorkflowTableRow";
import { WorkflowInspector } from "~/components/organisms/WorkflowInspector";
import { PageHeader } from "~/components/templates/PageHeader";
import { findWorkflow, WORKFLOWS } from "~/domain/fixtures/workflows";
import { openLauncherForAtom, runsAtom } from "~/state/atoms";
import styles from "./WorkflowsPage.module.css";

/** Every workflow file in the project, with the selected one inspected. */
export function WorkflowsPage() {
  const runs = useAtomValue(runsAtom);
  const openLauncherFor = useSetAtom(openLauncherForAtom);
  const { wf } = useSearch({ from: "/workflows" });
  const navigate = useNavigate();
  const openRun = useOpenRun();
  // Dependency audit is the design's default selection.
  const selected = findWorkflow(wf ?? "deps-audit.ts") ?? WORKFLOWS[0];

  if (!selected) return null;

  return (
    <div className={styles.screen}>
      <div className={styles.list}>
        <PageHeader
          title="Workflows"
          aside={<span className={styles.path}>.weft/workflows/ · 342 runs · 30d</span>}
        />
        <ListTable
          head={
            <>
              <span className={styles.headWorkflow}>Workflow</span>
              <span className={styles.headShape}>Shape</span>
              <span className={styles.headLast}>Last</span>
              <span className={styles.headSuccess}>Success</span>
              <span className={styles.headP50}>p50</span>
              <span className={styles.headCost}>Cost</span>
            </>
          }
        >
          {WORKFLOWS.map((workflow) => (
            <WorkflowTableRow
              key={workflow.file}
              workflow={workflow}
              selected={workflow.file === selected.file}
              onSelect={() => void navigate({ to: "/workflows", search: { wf: workflow.file } })}
            />
          ))}
        </ListTable>
        <p className={styles.legend}>
          Shape: <span className={styles.mono}>T</span> task · <span className={styles.mono}>A</span> agent ·{" "}
          <span className={styles.mono}>H</span> human gate · <span className={styles.mono}>∥</span> parallel.
        </p>
      </div>

      <WorkflowInspector
        workflow={selected}
        runs={runs}
        onRun={() => openLauncherFor(selected.file)}
        onOpenRun={(runId) => openRun(runId, runs[runId]?.state === "waiting" ? "gate" : "default", "runs")}
      />
    </div>
  );
}
