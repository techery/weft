import { PillButton } from "~/components/atoms/PillButton";
import { SelectField } from "~/components/atoms/SelectField";
import { TextArea } from "~/components/atoms/TextArea";
import { Toggle } from "~/components/atoms/Toggle";
import type { GateQuestion } from "~/domain/types";
import styles from "./LauncherField.module.css";
import { OptionCard } from "./OptionCard";

type Props = {
  question: GateQuestion;
  value: unknown;
  onSet: (value: unknown) => void;
  onToggleChip: (label: string) => void;
};

/**
 * One declared input of a workflow, rendered by the control its schema asks for — the same
 * vocabulary a gate's questions use, because both are a JSON Schema turned into a form.
 */
export function LauncherField({ question, value, onSet, onToggleChip }: Props) {
  const chosen: unknown[] = Array.isArray(value) ? value : [];

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

        {question.kind === "choice" ? (
          <span className={styles.seg}>
            {question.options.map((option) => (
              <PillButton key={option.label} on={value === option.label} onClick={() => onSet(option.label)}>
                {option.label}
              </PillButton>
            ))}
          </span>
        ) : null}

        {question.kind === "chips" ? (
          <span className={styles.chips}>
            {question.options.map((option) => {
              const on = chosen.includes(option.label);
              return (
                <PillButton key={option.label} on={on} onClick={() => onToggleChip(option.label)}>
                  {on ? `✓ ${option.label}` : option.label}
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
          <Toggle
            on={value === true}
            label={value === true ? "on" : "off"}
            onToggle={() => onSet(value !== true)}
            className={styles.flag}
          />
        ) : null}

        {question.kind === "note" ? (
          <TextArea
            rows={2}
            aria-label={question.label}
            value={typeof value === "string" ? value : ""}
            onChange={(e) => onSet(e.target.value)}
          />
        ) : null}
      </div>
    </div>
  );
}
