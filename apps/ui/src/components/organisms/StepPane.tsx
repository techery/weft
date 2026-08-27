import { useEffect, useId, useState } from "react";
import { api } from "~/api/client";
import type { UiPresentation } from "~/api/types";
import { Button } from "~/components/atoms/Button";
import { FactCell } from "~/components/atoms/FactCell";
import { Kicker } from "~/components/atoms/Kicker";
import { StatusPill } from "~/components/atoms/StatusPill";
import { ActiveStepChip } from "~/components/molecules/ActiveStepChip";
import { AgentTranscriptPane } from "~/components/molecules/AgentTranscriptPane";
import { NextStrip } from "~/components/molecules/NextStrip";
import { DataPane } from "~/components/molecules/OutputPane";
import { SectionHeading } from "~/components/molecules/SectionHeading";
import { ToolCallRow } from "~/components/molecules/ToolCallRow";
import { WorkflowViewFrame } from "~/components/molecules/WorkflowViewFrame";
import type { Run, StepDetail } from "~/domain/types";
import styles from "./StepPane.module.css";

type Props = {
  run: Run;
  step: StepDetail;
  stepId: string;
  onSelectStep: (stepId: string) => void;
  onGoToGate: () => void;
};

type StepView = "step" | "agent-log";

/** What one step was given, what it produced, and what followed from it. */
export function StepPane({ run, step, stepId, onSelectStep, onGoToGate }: Props) {
  const [selection, setSelection] = useState<{ stepId: string; view: StepView }>({
    stepId,
    view: "step",
  });
  const view = selection.stepId === stepId ? selection.view : "step";
  const stepTabId = useId();
  const logTabId = useId();
  const stepPanelId = useId();
  const logPanelId = useId();
  // `ctx.ui.render` completes with `null`, while the durable JSON that produced
  // its view lives in the presentation props.
  const presentationIsOutput = step.presentation !== undefined && step.outValue === null;

  return (
    <div className={styles.pane}>
      <div className={styles.body}>
        {run.active.length > 0 ? (
          <div className={styles.activeRow}>
            <Kicker tone="inline">active now</Kicker>
            {run.active.map((active) => (
              <ActiveStepChip
                key={active.stepId}
                step={active}
                selected={active.stepId === stepId}
                onSelect={() => onSelectStep(active.stepId)}
              />
            ))}
          </div>
        ) : null}

        <div className={styles.titleRow}>
          <h2 className={styles.title}>{step.title}</h2>
          <StatusPill kind={step.pillKind}>{step.pill}</StatusPill>
          <span className={styles.spacer} />
        </div>

        {step.agentTranscript ? (
          <div className={styles.viewTabs} role="tablist" aria-label="Step views">
            <button
              id={stepTabId}
              className={styles.viewTab}
              type="button"
              role="tab"
              aria-selected={view === "step"}
              aria-controls={stepPanelId}
              tabIndex={view === "step" ? 0 : -1}
              onClick={() => setSelection({ stepId, view: "step" })}
            >
              Step
            </button>
            <button
              id={logTabId}
              className={styles.viewTab}
              type="button"
              role="tab"
              aria-selected={view === "agent-log"}
              aria-controls={logPanelId}
              tabIndex={view === "agent-log" ? 0 : -1}
              onClick={() => setSelection({ stepId, view: "agent-log" })}
            >
              Agent log
            </button>
          </div>
        ) : null}

        {view === "step" ? (
          <div
            className={styles.view}
            {...(step.agentTranscript
              ? { id: stepPanelId, role: "tabpanel", "aria-labelledby": stepTabId }
              : {})}
          >
            <SectionHeading>
              <Kicker>Overview</Kicker>
            </SectionHeading>
            <ul className={styles.cells} aria-label="Step overview">
              {step.cells.map((cell) => (
                <FactCell
                  key={cell.k}
                  label={cell.k}
                  value={cell.v}
                  color={cell.color}
                  minWidth={cell.k === "kind" ? 96 : 104}
                />
              ))}
            </ul>

            {step.inputValue !== undefined ? (
              <div className={styles.block}>
                <SectionHeading>
                  <Kicker>Input</Kicker>
                </SectionHeading>
                <DataPane
                  title="step input"
                  note="as scheduled"
                  value={step.inputValue}
                  schema={step.inputSchema}
                  lines={[]}
                  streaming={false}
                />
              </div>
            ) : null}

            <SectionHeading>
              <Kicker>Output</Kicker>
            </SectionHeading>
            {step.presentation ? (
              <div className={styles.block}>
                <WorkflowViewFrame
                  key={step.presentation.id}
                  runId={run.id}
                  presentation={step.presentation}
                />
              </div>
            ) : null}
            {presentationIsOutput && step.presentation ? (
              <PresentationOutputPane
                key={step.presentation.props.hash}
                title={step.outTitle}
                presentation={step.presentation}
              />
            ) : (
              <DataPane
                title={step.outTitle}
                note={step.outNote}
                value={step.outValue}
                schema={step.outSchema}
                lines={step.out}
                streaming={step.streaming}
              />
            )}

            {step.tools.length > 0 ? (
              <div className={styles.tools}>
                <SectionHeading note="sandboxed · fs read-only, no network">
                  <Kicker>{step.toolsTitle}</Kicker>
                </SectionHeading>
                {step.tools.map((tool) => (
                  <ToolCallRow key={tool.cmd} tool={tool} />
                ))}
              </div>
            ) : null}

            {step.next ? (
              <NextStrip
                label={step.next.k}
                detail={step.next.v}
                onAnswerNow={step.next.goToGate ? onGoToGate : undefined}
              />
            ) : null}
          </div>
        ) : step.agentTranscript ? (
          <div id={logPanelId} className={styles.logView} role="tabpanel" aria-labelledby={logTabId}>
            <AgentTranscriptPane transcript={step.agentTranscript} running={step.streaming} />
          </div>
        ) : null}
      </div>

      <div className={styles.foot}>
        <span className={styles.footId}>weft explain {stepId}</span>
        <Button variant="secondary" size="mediumWide">
          {step.action}
        </Button>
      </div>
    </div>
  );
}

function PresentationOutputPane({ title, presentation }: { title: string; presentation: UiPresentation }) {
  const initialValue = "inline" in presentation.props ? presentation.props.inline : undefined;
  const propsRef = "ref" in presentation.props ? presentation.props.ref.$blob : "";
  const [value, setValue] = useState<unknown>(initialValue);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(initialValue === undefined);

  useEffect(() => {
    if (propsRef === "") return;
    let current = true;
    void api
      .blobJson(propsRef)
      .then((props) => {
        if (!current) return;
        setValue(props);
        setLoading(false);
      })
      .catch((cause: unknown) => {
        if (!current) return;
        setError(cause instanceof Error ? cause.message : String(cause));
        setLoading(false);
      });
    return () => {
      current = false;
    };
  }, [propsRef]);

  return (
    <DataPane
      title={title}
      note="rendered by workflow view"
      value={value}
      schema={null}
      lines={error ? [error] : loading ? ["Loading presentation JSON…"] : []}
      streaming={loading}
    />
  );
}
