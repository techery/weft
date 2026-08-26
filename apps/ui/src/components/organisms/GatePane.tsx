import { useAtomValue, useSetAtom } from "jotai";
import { useMemo, useState } from "react";
import { api } from "~/api/client";
import { useAnswerGate } from "~/api/queries";
import type { JsonSchema } from "~/api/types";
import { Button } from "~/components/atoms/Button";
import { Kicker } from "~/components/atoms/Kicker";
import { MonoBadge } from "~/components/atoms/MonoBadge";
import { StatusPill } from "~/components/atoms/StatusPill";
import { GateQuestionRow } from "~/components/molecules/GateQuestionRow";
import { SectionHeading } from "~/components/molecules/SectionHeading";
import { WorkflowViewFrame } from "~/components/molecules/WorkflowViewFrame";
import { gateAnswer, VERDICT_FIELD } from "~/domain/adapt";
import type { Gate, StepDetail } from "~/domain/types";
import { clearGateDraftAtom, gateDraftAtom, setGateFieldAtom, toggleGateChipAtom } from "~/state/atoms";
import styles from "./GatePane.module.css";

type Props = {
  gate: Gate;
  step: StepDetail;
  schema: JsonSchema | null;
  onAnswered: () => void;
};

/**
 * The form that unblocks a run.
 *
 * Its controls are derived from the schema the workflow declared for the answer, never
 * from the field names — so a workflow that asks for something this UI has never seen still
 * gets a usable form, and one that asks for an enum gets pills rather than a text box.
 *
 * Deny is only offered where denial is a meaningful answer. `ctx.human.approve` declares
 * `{ approved, note }`, so refusing is `approved: false`; an `ask` has no such axis, and a
 * button that submitted an arbitrary "no" into its schema would be inventing a reply.
 */
export function GatePane({ gate, step, schema, onAnswered }: Props) {
  const drafts = useAtomValue(gateDraftAtom);
  const setField = useSetAtom(setGateFieldAtom);
  const toggleChip = useSetAtom(toggleGateChipAtom);
  const clearDraft = useSetAtom(clearGateDraftAtom);
  const answer = useAnswerGate();
  const [staged, setStaged] = useState<{ gateId: string; value: unknown }>();
  const candidate = staged?.gateId === gate.id ? staged.value : undefined;

  const values = useMemo(() => drafts[gate.id] ?? {}, [drafts, gate.id]);
  const runId = gate.runId ?? "";

  const submit = (override?: Record<string, unknown>, exact?: unknown) => {
    answer.mutate(
      {
        runId,
        requestId: gate.id,
        answer: exact === undefined ? gateAnswer(schema, { ...values, ...override }) : exact,
      },
      {
        onSuccess: () => {
          clearDraft(gate.id);
          onAnswered();
        },
      },
    );
  };

  // Previewing the approving answer: it is the one the primary button sends, and a
  // preview that omitted the verdict would show something the run never receives.
  const payload = JSON.stringify(
    candidate === undefined
      ? gateAnswer(schema, gate.deniable ? { ...values, [VERDICT_FIELD]: true } : values)
      : candidate,
  );

  return (
    <div className={styles.pane}>
      <div className={styles.body}>
        <div className={styles.titleRow}>
          <h2 className={styles.title}>{step.title}</h2>
          <StatusPill kind={step.pillKind}>{step.pill}</StatusPill>
          <span className={styles.spacer} />
          <span className={styles.stepId}>{gate.id}</span>
        </div>

        <div className={styles.ask}>
          <div className={styles.askMeta}>
            <span className={styles.event}>human.requested · {gate.id}</span>
            {gate.risk ? (
              <MonoBadge bg="var(--color-accent-200)" fg="var(--color-accent-800)">
                {`risk: ${gate.risk}`}
              </MonoBadge>
            ) : null}
            <span className={styles.blocks}>{gate.blocks}</span>
          </div>
          <h3 className={styles.gateTitle}>{gate.title}</h3>
          {gate.detail ? <span className={styles.detail}>{gate.detail}</span> : null}
          {gate.artifactRef ? (
            <a
              className={styles.artifactLink}
              href={api.blobUrl(gate.artifactRef.ref, "text")}
              target="_blank"
              rel="noreferrer"
            >
              Open attached report · {gate.artifactRef.size.toLocaleString()} bytes
            </a>
          ) : null}
        </div>

        <div className={styles.answersHead}>
          <SectionHeading note="journaled verbatim · passed back to the waiting step" noteNowrap>
            <Kicker>Answers</Kicker>
          </SectionHeading>
        </div>

        {gate.ui ? (
          <div className={styles.questions}>
            <WorkflowViewFrame
              key={gate.ui.id}
              runId={runId}
              presentation={gate.ui}
              onCandidate={(value) => setStaged({ gateId: gate.id, value })}
            />
            {candidate !== undefined ? (
              <span className={styles.detail}>
                Candidate staged by the custom view. Review the payload below, then submit from Weft.
              </span>
            ) : null}
          </div>
        ) : null}

        <div className={styles.questions}>
          {gate.questions.map((question) => (
            <GateQuestionRow
              key={question.key}
              question={question}
              value={values[question.key] as never}
              onSet={(value) => {
                setStaged(undefined);
                setField(gate.id, question.key, value);
              }}
              onToggleChip={(label) => {
                setStaged(undefined);
                toggleChip(gate.id, question.key, label);
              }}
              onToggleFlag={() => {
                setStaged(undefined);
                setField(gate.id, question.key, values[question.key] !== true);
              }}
            />
          ))}
          {gate.questions.length === 0 ? (
            <span className={styles.detail}>
              This question declares no fields — answering it just releases the run.
            </span>
          ) : null}
        </div>

        {answer.isError ? <span className={styles.detail}>{(answer.error as Error).message}</span> : null}
      </div>

      <div className={styles.foot}>
        <span className={styles.payload}>
          <span className={styles.payloadLabel}>payload → waiting step</span>
          <span className={styles.payloadValue}>{payload}</span>
        </span>
        {gate.deniable ? (
          <Button
            variant="secondary"
            size="mediumWide"
            disabled={answer.isPending}
            onClick={() => submit({ approved: false })}
          >
            {gate.denyLabel}
          </Button>
        ) : null}
        <Button
          variant="primary"
          size="large"
          disabled={answer.isPending}
          onClick={() =>
            candidate === undefined
              ? submit(gate.deniable ? { approved: true } : undefined)
              : submit(undefined, candidate)
          }
        >
          {answer.isPending ? "Answering…" : candidate === undefined ? gate.submitLabel : "Submit and resume"}
        </Button>
      </div>
    </div>
  );
}
