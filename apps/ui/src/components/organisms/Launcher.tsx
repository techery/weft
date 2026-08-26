import { useNavigate } from "@tanstack/react-router";
import { useAtom, useAtomValue, useSetAtom } from "jotai";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useStartRun, useWorkflow } from "~/api/queries";
import { Button } from "~/components/atoms/Button";
import { TextArea } from "~/components/atoms/TextArea";
import { Toolbar } from "~/components/atoms/Toolbar";
import { EmptyNote } from "~/components/molecules/EmptyNote";
import { LauncherField } from "~/components/molecules/LauncherField";
import { gateAnswer, schemaQuestions } from "~/domain/adapt";
import {
  closeLauncherAtom,
  launcherInputsAtom,
  launcherOpenAtom,
  launcherWorkflowAtom,
  setLauncherInputAtom,
  toggleLauncherChipAtom,
} from "~/state/atoms";
import styles from "./Launcher.module.css";

/**
 * Where the JSON typed into the raw fallback is parked. It lives in the same draft record as
 * the fields; the `$` keeps it clear of any property a schema could declare.
 */
const RAW_KEY = "$raw";

export function Launcher() {
  const open = useAtomValue(launcherOpenAtom);
  const name = useAtomValue(launcherWorkflowAtom);
  const [drafts, setDrafts] = useAtom(launcherInputsAtom);
  const close = useSetAtom(closeLauncherAtom);
  const setInput = useSetAtom(setLauncherInputAtom);
  const toggleChip = useSetAtom(toggleLauncherChipAtom);
  const navigate = useNavigate();

  const detail = useWorkflow(name);
  const start = useStartRun();
  /** The daemon's refusal, or a bad JSON paste — whichever the last attempt produced. */
  const [failure, setFailure] = useState("");

  const schema = detail.data?.input ?? null;
  const questions = useMemo(() => schemaQuestions(schema), [schema]);
  const values = drafts[name] ?? {};

  // Seed the form from the schema's own defaults, once per workflow: a value the declaration
  // already supplies should not have to be retyped, and it must be sent unless it is changed.
  useEffect(() => {
    const properties = schema?.properties;
    if (name === "" || properties === undefined) return;
    setDrafts((all) => {
      const current = all[name] ?? {};
      const seeded: Record<string, unknown> = {};
      for (const [key, property] of Object.entries(properties)) {
        if (property.default !== undefined && current[key] === undefined) seeded[key] = property.default;
      }
      if (Object.keys(seeded).length === 0) return all;
      return { ...all, [name]: { ...current, ...seeded } };
    });
  }, [name, schema, setDrafts]);

  const submit = useCallback(() => {
    // The declaration decides what is sent, so ⏎ before it arrives has to wait — the button
    // is disabled for the same reason, and the keyboard is the other way in here.
    if (name === "" || start.isPending || detail.data === undefined) return;
    let input: unknown;
    if (schema === null) {
      const text = typeof values[RAW_KEY] === "string" ? values[RAW_KEY] : "";
      try {
        input = text.trim() === "" ? {} : JSON.parse(text);
      } catch (err) {
        setFailure(`that is not valid JSON — ${err instanceof Error ? err.message : String(err)}`);
        return;
      }
    } else {
      input = gateAnswer(schema, values);
    }
    setFailure("");
    start.mutate(
      { workflow: name, input },
      {
        // The message names the field the workflow does not take, so it is the whole answer.
        onError: (err) => setFailure(err.message),
        onSuccess: (data) => {
          close();
          void navigate({
            to: "/runs/$runId",
            params: { runId: data.runId },
            search: { from: "runs", tab: "steps" },
          });
        },
      },
    );
  }, [close, detail.data, name, navigate, schema, start, values]);

  // The workflow was selected before opening this dialog; escape closes the input form.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        close();
        return;
      }
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        submit();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, submit, close]);

  // A refusal from an earlier attempt says nothing about this one.
  useEffect(() => {
    if (open) setFailure("");
  }, [open]);

  if (!open) return null;

  const defaults = detail.data?.defaults;
  const route = defaults?.provider ? `${defaults.provider}${defaults.model ? `/${defaults.model}` : ""}` : "";

  return (
    <div className={styles.backdrop} data-testid="launcher-backdrop">
      {/* A real button rather than a click handler on the ground, so dismissing
          the launcher is reachable by keyboard as well as by escape. */}
      <button type="button" className={styles.scrim} aria-label="Close the launcher" onClick={close} />
      <div className={styles.panel} role="dialog" aria-modal="true" aria-label="Run a workflow">
        <div className={styles.head}>
          <span className={styles.headMain}>
            <span className={styles.headTitle}>
              <span className={styles.headName}>{name}</span>
              <span className={styles.headFile}>{detail.data?.file ?? ""}</span>
            </span>
            <span className={styles.headShape}>{detail.data?.description ?? ""}</span>
          </span>
          <span className={styles.headMeta}>{route}</span>
        </div>
        <div className={styles.body}>
          <section className={styles.schemaPane} aria-label="Workflow input">
            <div className={styles.schemaHead}>
              <span className={styles.schemaTitle}>workflow input</span>
              <span className={styles.spacer} />
              <span className={styles.schemaHint}>tab to move · ⏎ starts</span>
            </div>
            <div className={styles.schemaFields}>
              {detail.isPending ? <span className={styles.schemaState}>reading the declaration…</span> : null}
              {detail.error ? (
                <span className={`${styles.schemaState} ${styles.stateError}`}>{detail.error.message}</span>
              ) : null}
              {detail.data !== undefined && schema === null ? (
                <div className={styles.rawInput}>
                  <span className={styles.state}>
                    weft could not turn this workflow's input declaration into a schema — pass the input as
                    JSON.
                  </span>
                  <TextArea
                    className={styles.rawTextArea}
                    rows={5}
                    aria-label="Input as JSON"
                    placeholder={'{ "who": "world" }'}
                    value={typeof values[RAW_KEY] === "string" ? values[RAW_KEY] : ""}
                    onChange={(e) => setInput(name, RAW_KEY, e.target.value)}
                  />
                </div>
              ) : null}
              {detail.data !== undefined && schema !== null && questions.length === 0 ? (
                <div className={styles.schemaState}>
                  <EmptyNote>This workflow declares no inputs.</EmptyNote>
                </div>
              ) : null}
              {questions.map((question) => (
                <LauncherField
                  key={question.key}
                  question={question}
                  schema={schema?.properties?.[question.key] ?? null}
                  value={values[question.key]}
                  onSet={(value) => setInput(name, question.key, value)}
                  onToggleChip={(label) => toggleChip(name, question.key, label)}
                />
              ))}
            </div>
          </section>
          <Toolbar className={styles.foot} aria-label="Run actions">
            <span className={failure ? `${styles.footNote} ${styles.footError}` : styles.footNote}>
              {failure || (start.isPending ? "starting…" : "")}
            </span>
            <Button
              variant="primary"
              size="large"
              disabled={detail.data === undefined || start.isPending}
              onClick={submit}
            >
              Start run ⏎
            </Button>
          </Toolbar>
        </div>
      </div>
    </div>
  );
}
