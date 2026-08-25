import { Button } from "~/components/atoms/Button";
import { FactCell } from "~/components/atoms/FactCell";
import { Kicker } from "~/components/atoms/Kicker";
import { StatusPill } from "~/components/atoms/StatusPill";
import { ActiveStepChip } from "~/components/molecules/ActiveStepChip";
import { NextStrip } from "~/components/molecules/NextStrip";
import { OutputPane } from "~/components/molecules/OutputPane";
import { SectionHeading } from "~/components/molecules/SectionHeading";
import { StepInputRow } from "~/components/molecules/StepInputRow";
import { ToolCallRow } from "~/components/molecules/ToolCallRow";
import type { Run, StepDetail } from "~/domain/types";
import styles from "./StepPane.module.css";

type Props = {
  run: Run;
  step: StepDetail;
  stepId: string;
  onSelectStep: (stepId: string) => void;
  onGoToGate: () => void;
};

/** What one step was given, what it produced, and what followed from it. */
export function StepPane({ run, step, stepId, onSelectStep, onGoToGate }: Props) {
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

        <SectionHeading>
          <Kicker>Overview</Kicker>
        </SectionHeading>
        <div className={styles.cells}>
          {step.cells.map((cell) => (
            <FactCell
              key={cell.k}
              label={cell.k}
              value={cell.v}
              color={cell.color}
              minWidth={cell.k === "kind" ? 96 : 104}
            />
          ))}
        </div>

        {step.input.length > 0 ? (
          <div className={styles.block}>
            <SectionHeading note="as the step was scheduled">
              <Kicker>Input</Kicker>
            </SectionHeading>
            <div className={styles.inputBox}>
              {step.input.map((input, index) => (
                <StepInputRow key={input.k} input={input} divided={index > 0} />
              ))}
            </div>
          </div>
        ) : null}

        <SectionHeading>
          <Kicker>Output</Kicker>
        </SectionHeading>
        <OutputPane title={step.outTitle} note={step.outNote} lines={step.out} streaming={step.streaming} />

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

      <div className={styles.foot}>
        <span className={styles.footId}>weft explain {stepId}</span>
        <Button variant="secondary" size="mediumWide">
          {step.action}
        </Button>
      </div>
    </div>
  );
}
