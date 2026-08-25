import type { JsonSchema } from "~/api/types";
import { PillButton } from "~/components/atoms/PillButton";
import { SelectField } from "~/components/atoms/SelectField";
import { TextArea } from "~/components/atoms/TextArea";
import { TextField } from "~/components/atoms/TextField";
import { Toggle } from "~/components/atoms/Toggle";
import type { GateQuestion } from "~/domain/types";
import styles from "./LauncherField.module.css";
import { OptionCard } from "./OptionCard";

type Props = {
  question: GateQuestion;
  schema: JsonSchema | null;
  value: unknown;
  onSet: (value: unknown) => void;
  onToggleChip: (label: string) => void;
};

/**
 * One declared input of a workflow, rendered by the control its schema asks for — the same
 * vocabulary a gate's questions use, because both are a JSON Schema turned into a form.
 */
export function LauncherField({ question, schema, value, onSet, onToggleChip }: Props) {
  const chosen: unknown[] = Array.isArray(value) ? value : [];
  const meta = [schemaType(schema), question.required ? "required" : "optional"].filter(Boolean);

  return (
    <div className={styles.row}>
      <div className={styles.key}>
        <span className={styles.keyLabel}>{question.label}</span>
        <span className={styles.keyMeta}>{meta.join(" · ")}</span>
      </div>
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

        {question.kind === "text" ? (
          <TextField
            className={styles.textField}
            type={schema?.type === "number" || schema?.type === "integer" ? "number" : "text"}
            aria-label={question.label}
            value={typeof value === "string" || typeof value === "number" ? value : ""}
            placeholder={question.required ? "Required" : "Optional"}
            min={schema?.minimum}
            max={schema?.maximum}
            onChange={(e) => onSet(e.target.value)}
          />
        ) : null}

        {question.kind === "list" ? (
          <TextArea
            className={styles.textArea}
            rows={3}
            aria-label={question.label}
            value={Array.isArray(value) ? value.join("\n") : typeof value === "string" ? value : ""}
            placeholder="One item per line"
            onChange={(e) => onSet(e.target.value)}
          />
        ) : null}

        {question.kind === "note" ? (
          <TextArea
            className={styles.textArea}
            rows={2}
            aria-label={question.label}
            value={typeof value === "string" ? value : ""}
            placeholder={question.required ? "Required" : "Optional"}
            onChange={(e) => onSet(e.target.value)}
          />
        ) : null}
        {schema?.description ? <span className={styles.description}>{schema.description}</span> : null}
      </div>
    </div>
  );
}

function schemaType(schema: JsonSchema | null): string {
  if (!schema?.type) return "value";
  return Array.isArray(schema.type) ? schema.type.filter((type) => type !== "null").join(" / ") : schema.type;
}
