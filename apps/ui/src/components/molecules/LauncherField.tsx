import { PillButton } from "~/components/atoms/PillButton";
import { TextField } from "~/components/atoms/TextField";
import { Toggle } from "~/components/atoms/Toggle";
import type { LauncherInputValue, WorkflowInput } from "~/domain/types";
import styles from "./LauncherField.module.css";

type Props = {
  input: WorkflowInput;
  value: LauncherInputValue | undefined;
  onSet: (value: LauncherInputValue) => void;
  onToggleChip: (label: string) => void;
  onToggleFlag: () => void;
};

/** One row of the launcher's input form — the shape depends on the input kind. */
export function LauncherField({ input, value, onSet, onToggleChip, onToggleFlag }: Props) {
  const chips = Array.isArray(value) ? value : [];
  const flagOn = value === true;
  const flagLabel = (flagOn ? input.options[0] : input.options[1]) ?? "";

  return (
    <div className={styles.row}>
      <span className={styles.key}>
        {input.label}
        {input.required ? <span className={styles.req}> *</span> : null}
      </span>
      <div className={styles.control}>
        {input.kind === "text" ? (
          <TextField
            aria-label={input.label}
            value={typeof value === "string" ? value : ""}
            onChange={(e) => onSet(e.target.value)}
          />
        ) : null}

        {input.kind === "seg" ? (
          <span className={styles.seg}>
            {input.options.map((option) => (
              <PillButton key={option} on={value === option} onClick={() => onSet(option)}>
                {option}
              </PillButton>
            ))}
          </span>
        ) : null}

        {input.kind === "chips" ? (
          <span className={styles.chips}>
            {input.options.map((option) => (
              <PillButton key={option} on={chips.includes(option)} onClick={() => onToggleChip(option)}>
                {chips.includes(option) ? `✓ ${option}` : option}
              </PillButton>
            ))}
          </span>
        ) : null}

        {input.kind === "file" ? (
          <span className={styles.file}>
            <span className={styles.fileValue}>{typeof value === "string" ? value : ""}</span>
            <span className={styles.fileHint}>drop or ⌘O</span>
          </span>
        ) : null}

        {input.kind === "flag" ? (
          <Toggle on={flagOn} label={flagLabel} onToggle={onToggleFlag} className={styles.flag} />
        ) : null}
      </div>
    </div>
  );
}
