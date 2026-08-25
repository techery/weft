import { useNavigate, useParams, useSearch } from "@tanstack/react-router";
import { useCancelRun } from "~/api/queries";
import { useRunView } from "~/app/useRunView";
import { EmptyNote } from "~/components/molecules/EmptyNote";
import { ArtifactsTab } from "~/components/organisms/ArtifactsTab";
import { ChangesTab } from "~/components/organisms/ChangesTab";
import { FindingsTab } from "~/components/organisms/FindingsTab";
import { GatePane } from "~/components/organisms/GatePane";
import { JournalTab } from "~/components/organisms/JournalTab";
import { RunHeader } from "~/components/organisms/RunHeader";
import { RunRail } from "~/components/organisms/RunRail";
import { RunTabsBar } from "~/components/organisms/RunTabsBar";
import { StepPane } from "~/components/organisms/StepPane";
import { resolveArtifact, resolveFile, resolveStepId, runTabs } from "~/domain/views";
import styles from "./RunDetailPage.module.css";

/** One run: its steps, the question holding it, and everything it wrote. */
export function RunDetailPage() {
  const { runId } = useParams({ from: "/runs/$runId" });
  const search = useSearch({ from: "/runs/$runId" });
  const navigate = useNavigate();
  const cancel = useCancelRun();
  const { run, gateSchema, diffs, isPending, error, live } = useRunView(runId);

  const patch = (next: Partial<typeof search>) =>
    void navigate({
      to: "/runs/$runId",
      params: { runId },
      search: (prev) => ({ ...prev, ...next }),
      replace: true,
    });

  const back = () => void navigate(search.from === "runs" ? { to: "/runs", search: {} } : { to: "/queue" });

  if (isPending) return <div className={styles.missing}>loading run {runId}…</div>;
  if (error || run === undefined) {
    return (
      <div className={styles.missing}>
        <EmptyNote>{error?.message ?? `No run ${runId} in the journal.`}</EmptyNote>
      </div>
    );
  }

  // A gate is pending while the run's own state still says a question is outstanding —
  // the server decides that, not this page, so answering it simply stops being true.
  const pendingGate = run.gate !== null && run.state === "waiting";
  const tabs = runTabs(run, pendingGate);
  const tab = tabs.some((t) => t.key === search.tab) && search.tab ? search.tab : "steps";
  const stepId = resolveStepId(run, search.step, pendingGate);
  const step = run.steps[stepId];
  const artifact = resolveArtifact(run, search.artifact);
  const file = resolveFile(run, search.file);
  const showGate = tab === "steps" && pendingGate && run.gate !== null && stepId === run.gateStep;

  return (
    <div className={styles.screen}>
      <RunHeader
        run={run}
        backLabel={search.from === "runs" ? "← Runs" : "← Queue"}
        onBack={back}
        canCancel={run.state === "running" || run.state === "waiting"}
        cancelling={cancel.isPending}
        onCancel={() => cancel.mutate(runId)}
        onOpenWorkflow={() => void navigate({ to: "/workflows", search: { wf: run.wf } })}
      />

      <RunTabsBar tabs={tabs} active={tab} onSelect={(next) => patch({ tab: next })} />

      <div className={styles.body}>
        {tab === "steps" ? (
          <RunRail run={run} selectedStepId={stepId} onSelect={(id) => patch({ step: id })} />
        ) : null}

        {showGate && run.gate ? (
          <GatePane
            gate={run.gate}
            step={step ?? fallbackStep(run.gate.title)}
            schema={gateSchema}
            onAnswered={() => patch({ step: undefined })}
          />
        ) : null}

        {tab === "steps" && !showGate ? (
          step ? (
            <StepPane
              run={run}
              step={step}
              stepId={stepId}
              onSelectStep={(id) => patch({ step: id })}
              onGoToGate={() => patch({ tab: "steps", step: run.gateStep ?? undefined })}
            />
          ) : (
            <div className={styles.missing}>
              <EmptyNote>This run has not opened a step yet.</EmptyNote>
            </div>
          )
        ) : null}

        {tab === "findings" ? <FindingsTab run={run} /> : null}

        {tab === "artifacts" ? (
          <ArtifactsTab run={run} artifact={artifact} onSelect={(name) => patch({ artifact: name })} />
        ) : null}

        {tab === "changes" ? (
          <ChangesTab
            run={run}
            file={file}
            diff={file ? diffs[file.path] : undefined}
            onSelect={(path) => patch({ file: path })}
          />
        ) : null}

        {tab === "journal" ? <JournalTab run={run} live={live} /> : null}
      </div>
    </div>
  );
}

/** A gate whose step the projection has not caught up with yet still has to render. */
function fallbackStep(title: string) {
  return {
    title,
    pill: "waiting on you",
    pillKind: "human" as const,
    action: "Copy gate id",
    cells: [],
    input: [],
    outTitle: "answer",
    outNote: "",
    out: [],
    streaming: false,
    tools: [],
    toolsTitle: "",
    next: null,
  };
}
