import { useAtomValue, useSetAtom } from "jotai";
import { Button } from "~/components/atoms/Button";
import { Kicker } from "~/components/atoms/Kicker";
import { MonoBadge } from "~/components/atoms/MonoBadge";
import { StatusPill } from "~/components/atoms/StatusPill";
import { GateQuestionRow } from "~/components/molecules/GateQuestionRow";
import { SectionHeading } from "~/components/molecules/SectionHeading";
import type { Gate, StepDetail } from "~/domain/types";
import { gatePayload } from "~/domain/views";
import {
  denyGateAtom,
  gateAnswersAtom,
  setGateAnswerAtom,
  submitGateAtom,
  toggleGateChipAtom,
  toggleGateFlagAtom,
} from "~/state/atoms";
import styles from "./GatePane.module.css";

type Props = { runId: string; gate: Gate; step: StepDetail; stepId: string };

/** The answer form for a pending human gate — this is what blocks the run. */
export function GatePane({ runId, gate, step, stepId }: Props) {
  const answers = useAtomValue(gateAnswersAtom);
  const setAnswer = useSetAtom(setGateAnswerAtom);
  const toggleChip = useSetAtom(toggleGateChipAtom);
  const toggleFlag = useSetAtom(toggleGateFlagAtom);
  const submit = useSetAtom(submitGateAtom);
  const deny = useSetAtom(denyGateAtom);
  const values = answers[gate.id] ?? {};

  return (
    <div className={styles.pane}>
      <div className={styles.body}>
        <div className={styles.titleRow}>
          <h2 className={styles.title}>{step.title}</h2>
          <StatusPill kind={step.pillKind}>{step.pill}</StatusPill>
          <span className={styles.spacer} />
          <span className={styles.stepId}>weft explain {stepId}</span>
        </div>

        <div className={styles.ask}>
          <div className={styles.askMeta}>
            <span className={styles.event}>human.requested · {gate.id}</span>
            <MonoBadge bg="var(--color-accent-200)" fg="var(--color-accent-800)">
              {`risk: ${gate.risk}`}
            </MonoBadge>
            <span className={styles.blocks}>{gate.blocks}</span>
          </div>
          <h3 className={styles.gateTitle}>{gate.title}</h3>
          <span className={styles.detail}>{gate.detail}</span>
        </div>

        <div className={styles.answersHead}>
          <SectionHeading note="journaled verbatim · passed to the next step" noteNowrap>
            <Kicker>Answers</Kicker>
          </SectionHeading>
        </div>

        <div className={styles.questions}>
          {gate.questions.map((question) => (
            <GateQuestionRow
              key={question.key}
              question={question}
              value={values[question.key]}
              onSet={(value) => setAnswer(gate.id, question.key, value)}
              onToggleChip={(label) => toggleChip(gate.id, question.key, label)}
              onToggleFlag={() => toggleFlag(gate.id, question.key)}
            />
          ))}
        </div>
      </div>

      <div className={styles.foot}>
        <span className={styles.payload}>
          <span className={styles.payloadLabel}>payload → next step</span>
          <span className={styles.payloadValue}>{gatePayload(gate, answers)}</span>
        </span>
        <Button variant="secondary" size="mediumWide" onClick={() => deny(runId)}>
          {gate.denyLabel}
        </Button>
        <Button variant="primary" size="large" onClick={() => submit(runId)}>
          {gate.submitLabel}
        </Button>
      </div>
    </div>
  );
}
