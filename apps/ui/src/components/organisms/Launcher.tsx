import { useAtom, useAtomValue, useSetAtom } from "jotai";
import { useEffect, useMemo, useRef } from "react";
import { Button } from "~/components/atoms/Button";
import { Kicker } from "~/components/atoms/Kicker";
import { LauncherField } from "~/components/molecules/LauncherField";
import { LauncherMatchRow } from "~/components/molecules/LauncherMatchRow";
import { findWorkflow, WORKFLOWS } from "~/domain/fixtures/workflows";
import type { Workflow } from "~/domain/types";
import {
  budgetAtom,
  closeLauncherAtom,
  launcherCursorAtom,
  launcherInputsAtom,
  launcherOpenAtom,
  launcherQueryAtom,
  launcherStepAtom,
  launcherWorkflowAtom,
  policyAtom,
  setLauncherInputAtom,
  toggleLauncherChipAtom,
  toggleLauncherFlagAtom,
} from "~/state/atoms";
import styles from "./Launcher.module.css";

/** Case-insensitive match on either the workflow's name or its filename. */
export function matchWorkflows(query: string): Workflow[] {
  const q = query.toLowerCase();
  if (!q) return WORKFLOWS;
  return WORKFLOWS.filter((w) => w.name.toLowerCase().includes(q) || w.file.includes(q));
}

type Props = {
  /** Called with the chosen workflow once the inputs are submitted. */
  onStart: (workflow: Workflow) => void;
};

export function Launcher({ onStart }: Props) {
  const open = useAtomValue(launcherOpenAtom);
  const [step, setStep] = useAtom(launcherStepAtom);
  const [query, setQuery] = useAtom(launcherQueryAtom);
  const [cursor, setCursor] = useAtom(launcherCursorAtom);
  const [file, setFile] = useAtom(launcherWorkflowAtom);
  const inputs = useAtomValue(launcherInputsAtom);
  const budget = useAtomValue(budgetAtom);
  const policy = useAtomValue(policyAtom);
  const close = useSetAtom(closeLauncherAtom);
  const setInput = useSetAtom(setLauncherInputAtom);
  const toggleChip = useSetAtom(toggleLauncherChipAtom);
  const toggleFlag = useSetAtom(toggleLauncherFlagAtom);
  const searchRef = useRef<HTMLInputElement>(null);

  const matches = useMemo(() => matchWorkflows(query), [query]);
  const selectedIndex = Math.min(cursor, Math.max(matches.length - 1, 0));
  const workflow = findWorkflow(file) ?? WORKFLOWS[0];

  // The keyboard is the primary way through the launcher: arrows walk the list,
  // enter advances then starts, escape backs all the way out.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        close();
        return;
      }
      if (step === 1) {
        if (e.key === "ArrowDown") {
          e.preventDefault();
          setCursor((c) => Math.min(c + 1, matches.length - 1));
        }
        if (e.key === "ArrowUp") {
          e.preventDefault();
          setCursor((c) => Math.max(c - 1, 0));
        }
        if (e.key === "Enter") {
          e.preventDefault();
          const picked = matches[Math.min(selectedIndex, matches.length - 1)];
          if (picked) {
            setFile(picked.file);
            setStep(2);
          }
        }
        return;
      }
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        if (workflow) onStart(workflow);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, step, matches, selectedIndex, workflow, close, setCursor, setFile, setStep, onStart]);

  useEffect(() => {
    if (open && step === 1) searchRef.current?.focus();
  }, [open, step]);

  if (!open || !workflow) return null;

  const values = inputs[workflow.file] ?? {};

  return (
    <div className={styles.backdrop} data-testid="launcher-backdrop">
      {/* A real button rather than a click handler on the ground, so dismissing
          the launcher is reachable by keyboard as well as by escape. */}
      <button type="button" className={styles.scrim} aria-label="Close the launcher" onClick={close} />
      <div className={styles.panel} role="dialog" aria-modal="true" aria-label="Run a workflow">
        {step === 1 ? (
          <>
            <div className={styles.search}>
              <span className={styles.searchLabel}>run</span>
              <input
                ref={searchRef}
                className={styles.searchInput}
                value={query}
                placeholder="type to filter…"
                aria-label="Filter workflows"
                onChange={(e) => {
                  setQuery(e.target.value);
                  setCursor(0);
                }}
              />
              <span className={styles.matchCount}>
                {matches.length} of {WORKFLOWS.length} match
              </span>
            </div>
            <div className={styles.list}>
              {matches.map((w, index) => (
                <LauncherMatchRow
                  key={w.file}
                  workflow={w}
                  selected={selectedIndex === index}
                  onHover={() => setCursor(index)}
                  onPick={() => {
                    setFile(w.file);
                    setCursor(index);
                    setStep(2);
                  }}
                />
              ))}
            </div>
            <div className={styles.hints}>
              <span>↑↓ move</span>
              <span>⏎ select</span>
              <span>esc close</span>
              <span className={styles.spacer} />
              <span>step 1 of 2 · pick a workflow</span>
            </div>
          </>
        ) : (
          <>
            <div className={styles.head}>
              <Button
                variant="ghost"
                size="xSmall"
                aria-label="Back to workflow list"
                onClick={() => setStep(1)}
              >
                ←
              </Button>
              <span className={styles.headMain}>
                <span className={styles.headTitle}>
                  <span className={styles.headName}>{workflow.name}</span>
                  <span className={styles.headFile}>{workflow.file}</span>
                </span>
                <span className={styles.headShape}>{workflow.labels.map((l) => l.name).join(" → ")}</span>
              </span>
              <span className={styles.headMeta}>
                ~{workflow.p50} · ~{workflow.cost}
              </span>
            </div>
            <div className={styles.body}>
              <div className={styles.inputsHead}>
                <Kicker>Inputs</Kicker>
                <span className={styles.inputsHint}>tab to move · ⏎ starts · step 2 of 2</span>
              </div>
              {workflow.inputs.map((input) => (
                <LauncherField
                  key={input.key}
                  input={input}
                  value={values[input.key]}
                  onSet={(value) => setInput(workflow.file, input.key, value)}
                  onToggleChip={(label) => toggleChip(workflow.file, input.key, label)}
                  onToggleFlag={() => toggleFlag(workflow.file, input.key)}
                />
              ))}
              <div className={styles.foot}>
                <span className={styles.footNote}>
                  budget {budget} · gates: {policy.write} on write
                </span>
                <Button variant="primary" size="large" onClick={() => onStart(workflow)}>
                  Start run ⏎
                </Button>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
