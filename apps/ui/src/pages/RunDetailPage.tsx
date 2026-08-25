import { useNavigate, useParams, useSearch } from "@tanstack/react-router";
import { useAtomValue } from "jotai";
import { ArtifactsTab } from "~/components/organisms/ArtifactsTab";
import { ChangesTab } from "~/components/organisms/ChangesTab";
import { FindingsTab } from "~/components/organisms/FindingsTab";
import { GatePane } from "~/components/organisms/GatePane";
import { JournalTab } from "~/components/organisms/JournalTab";
import { RunHeader } from "~/components/organisms/RunHeader";
import { RunRail } from "~/components/organisms/RunRail";
import { RunTabsBar } from "~/components/organisms/RunTabsBar";
import { StepPane } from "~/components/organisms/StepPane";
import { hasPendingGate, resolveArtifact, resolveFile, resolveStepId, runTabs } from "~/domain/views";
import { answeredRunsAtom, runsAtom } from "~/state/atoms";
import styles from "./RunDetailPage.module.css";

const DEFAULT_ARTIFACT = "report.md";
const DEFAULT_FILE = "src/net/fetchWithRetry.ts";

/** One run: its steps, findings, artifacts, staged changes and journal. */
export function RunDetailPage() {
  const { runId } = useParams({ from: "/runs/$runId" });
  const search = useSearch({ from: "/runs/$runId" });
  const navigate = useNavigate();
  const runs = useAtomValue(runsAtom);
  const answered = useAtomValue(answeredRunsAtom);
  const run = runs[runId];

  if (!run) {
    return <div className={styles.missing}>No run {runId} in the journal window.</div>;
  }

  const patch = (next: Partial<typeof search>) =>
    void navigate({
      to: "/runs/$runId",
      params: { runId },
      search: (prev) => ({ ...prev, ...next }),
      replace: true,
    });

  const pendingGate = hasPendingGate(run, answered);
  const tabs = runTabs(run, pendingGate);
  const tab = tabs.some((t) => t.key === search.tab) && search.tab ? search.tab : "steps";
  const stepId = resolveStepId(run, search.step, pendingGate);
  const step = run.steps[stepId];
  // The design opens the audit run on its newest artifact and first changed
  // file; every other run falls back to its own first entry.
  const artifact = resolveArtifact(run, search.artifact ?? DEFAULT_ARTIFACT);
  const file = resolveFile(run, search.file ?? DEFAULT_FILE);
  const showGate = tab === "steps" && pendingGate && stepId === run.gateStep && !!run.gate;

  const goToGate = () => patch({ tab: "steps", step: run.gateStep ?? undefined });

  return (
    <div className={styles.screen}>
      <RunHeader
        run={run}
        backLabel={search.from === "runs" ? "← Runs" : "← Queue"}
        onBack={() =>
          void navigate(
            search.from === "runs" ? { to: "/runs", search: { filter: "All" } } : { to: "/queue" },
          )
        }
        onOpenWorkflow={() => void navigate({ to: "/workflows", search: { wf: run.file } })}
      />

      <RunTabsBar tabs={tabs} active={tab} onSelect={(next) => patch({ tab: next })} />

      <div className={styles.body}>
        {tab === "steps" ? (
          <RunRail run={run} selectedStepId={stepId} onSelect={(id) => patch({ step: id })} />
        ) : null}

        {showGate && run.gate && step ? (
          <GatePane runId={run.id} gate={run.gate} step={step} stepId={stepId} />
        ) : null}

        {tab === "steps" && !showGate && step ? (
          <StepPane
            run={run}
            step={step}
            stepId={stepId}
            onSelectStep={(id) => patch({ step: id })}
            onGoToGate={goToGate}
          />
        ) : null}

        {tab === "findings" ? (
          <FindingsTab run={run} onOpenStep={(id) => patch({ tab: "steps", step: id })} />
        ) : null}

        {tab === "artifacts" && artifact ? (
          <ArtifactsTab run={run} artifact={artifact} onSelect={(name) => patch({ artifact: name })} />
        ) : null}

        {tab === "changes" && file ? (
          <ChangesTab
            run={run}
            file={file}
            onSelect={(path) => patch({ file: path })}
            onGoToGate={goToGate}
          />
        ) : null}

        {tab === "journal" ? <JournalTab run={run} /> : null}
      </div>
    </div>
  );
}
