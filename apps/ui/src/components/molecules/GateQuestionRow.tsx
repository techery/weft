import { PillButton } from "~/components/atoms/PillButton";
import { SelectField } from "~/components/atoms/SelectField";
import { TextArea } from "~/components/atoms/TextArea";
import { TextField } from "~/components/atoms/TextField";
import { Toggle } from "~/components/atoms/Toggle";
import type { GateAnswerValue, GateQuestion } from "~/domain/types";
import styles from "./GateQuestionRow.module.css";
import { OptionCard } from "./OptionCard";

type Props = {
  question: GateQuestion;
  value: GateAnswerValue | undefined;
  onSet: (value: GateAnswerValue) => void;
  onToggleChip: (label: string) => void;
  onToggleFlag: () => void;
};

/** One question of a human gate, rendered by the control the workflow asked for. */
export function GateQuestionRow({ question, value, onSet, onToggleChip, onToggleFlag }: Props) {
  const chosen = Array.isArray(value) ? value : [];

  return (
    <div className={styles.row}>
      <span className={styles.key}>
        {question.label}
        {question.required ? <span className={styles.req}> *</span> : null}
      </span>
      <div className={styles.control}>
        {question.kind === "cards" ? (
          <span className={styles.cards}>
            {question.options.map((option) => (
              <OptionCard
                key={option.label}
                name={question.key}
                option={option}
                selected={value === option.label}
                onPick={() => onSet(option.label)}
              />
            ))}
          </span>
        ) : null}

        {question.kind === "chips" || question.kind === "choice" ? (
          <span className={styles.chips}>
            {question.options.map((option) => {
              const on = question.kind === "chips" ? chosen.includes(option.label) : value === option.label;
              return (
                <PillButton
                  key={option.label}
                  on={on}
                  onClick={() =>
                    question.kind === "chips" ? onToggleChip(option.label) : onSet(option.label)
                  }
                >
                  {question.kind === "chips" && on ? `✓ ${option.label}` : option.label}
                </PillButton>
              );
            })}
          </span>
        ) : null}

        {question.kind === "select" ? (
          <SelectField
            aria-label={question.label}
            value={typeof value === "string" ? value : ""}
            onChange={(e) => onSet(e.target.value)}
          >
            {question.options.map((option) => (
              <option key={option.label} value={option.label}>
                {option.label}
              </option>
            ))}
          </SelectField>
        ) : null}

        {question.kind === "toggle" ? (
          // The caption is the field's own state, not a guess at what the flag means: the
          // schema gives a name and a type, never a pair of prose alternatives.
          <Toggle on={value === true} label={value === true ? "yes" : "no"} onToggle={onToggleFlag} />
        ) : null}

        {question.kind === "text" ? (
          <TextField
            aria-label={question.label}
            value={typeof value === "string" ? value : ""}
            placeholder={question.required ? "required" : "optional"}
            onChange={(e) => onSet(e.target.value)}
          />
        ) : null}

        {question.kind === "list" ? (
          <TextArea
            rows={3}
            aria-label={question.label}
            value={Array.isArray(value) ? value.join("\n") : typeof value === "string" ? value : ""}
            placeholder="one item per line"
            onChange={(e) => onSet(e.target.value)}
          />
        ) : null}

        {question.kind === "note" ? (
          <TextArea
            rows={2}
            aria-label={question.label}
            value={typeof value === "string" ? value : ""}
            placeholder={question.required ? "required" : "optional — journaled verbatim"}
            onChange={(e) => onSet(e.target.value)}
          />
        ) : null}
      </div>
    </div>
  );
}
