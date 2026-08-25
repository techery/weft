import { useNavigate } from "@tanstack/react-router";
import { useAtom, useAtomValue, useSetAtom } from "jotai";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useStartRun, useWorkflow, useWorkflows } from "~/api/queries";
import type { WorkflowRow } from "~/api/types";
import { Button } from "~/components/atoms/Button";
import { TextArea } from "~/components/atoms/TextArea";
import { EmptyNote } from "~/components/molecules/EmptyNote";
import { LauncherField } from "~/components/molecules/LauncherField";
import { LauncherMatchRow } from "~/components/molecules/LauncherMatchRow";
import { gateAnswer, schemaQuestions } from "~/domain/adapt";
import {
  closeLauncherAtom,
  launcherCursorAtom,
  launcherInputsAtom,
  launcherOpenAtom,
  launcherQueryAtom,
  launcherStepAtom,
  launcherWorkflowAtom,
  setLauncherInputAtom,
  toggleLauncherChipAtom,
} from "~/state/atoms";
import styles from "./Launcher.module.css";

/** Case-insensitive match on either the workflow's name or its filename. */
export function matchWorkflows(rows: WorkflowRow[], query: string): WorkflowRow[] {
  const q = query.toLowerCase();
  if (!q) return rows;
  return rows.filter((w) => w.name.toLowerCase().includes(q) || w.file.toLowerCase().includes(q));
}

/**
 * Where the JSON typed into the raw fallback is parked. It lives in the same draft record as
 * the fields so a trip back to step 1 does not lose it; the `$` keeps it clear of any
 * property a schema could declare.
 */
const RAW_KEY = "$raw";

export function Launcher() {
  const open = useAtomValue(launcherOpenAtom);
  const [step, setStep] = useAtom(launcherStepAtom);
  const [query, setQuery] = useAtom(launcherQueryAtom);
  const [cursor, setCursor] = useAtom(launcherCursorAtom);
  const [name, setName] = useAtom(launcherWorkflowAtom);
  const [drafts, setDrafts] = useAtom(launcherInputsAtom);
  const close = useSetAtom(closeLauncherAtom);
  const setInput = useSetAtom(setLauncherInputAtom);
  const toggleChip = useSetAtom(toggleLauncherChipAtom);
  const searchRef = useRef<HTMLInputElement>(null);
  const navigate = useNavigate();

  const workflows = useWorkflows();
  const detail = useWorkflow(name);
  const start = useStartRun();
  /** The daemon's refusal, or a bad JSON paste — whichever the last attempt produced. */
  const [failure, setFailure] = useState("");

  const rows = useMemo(() => workflows.data ?? [], [workflows.data]);
  const matches = useMemo(() => matchWorkflows(rows, query), [rows, query]);
  const selectedIndex = Math.min(cursor, Math.max(matches.length - 1, 0));

  // A workflow whose name is not set yet has nothing to configure, so the picker stands in.
  const picking = step === 1 || name === "";
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

  /** Step 2 is about one workflow, so a refusal of the last one must not follow it there. */
  const pick = useCallback(
    (workflow: string) => {
      setFailure("");
      setName(workflow);
      setStep(2);
    },
    [setName, setStep],
  );

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

  // The keyboard is the primary way through the launcher: arrows walk the list,
  // enter advances then starts, escape backs all the way out.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        close();
        return;
      }
      if (picking) {
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
          if (picked) pick(picked.name);
        }
        return;
      }
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        submit();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, picking, matches, selectedIndex, submit, close, setCursor, pick]);

  useEffect(() => {
    if (open && picking) searchRef.current?.focus();
  }, [open, picking]);

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
        {picking ? (
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
                {matches.length} of {rows.length} match
              </span>
            </div>
            <div className={styles.list}>
              {workflows.isPending ? (
                <div className={styles.listState}>
                  <span className={styles.state}>reading the registry…</span>
                </div>
              ) : null}
              {workflows.error ? (
                <div className={styles.listState}>
                  <span className={`${styles.state} ${styles.stateError}`}>{workflows.error.message}</span>
                </div>
              ) : null}
              {workflows.isSuccess && matches.length === 0 ? (
                <div className={styles.listState}>
                  <EmptyNote>
                    {rows.length === 0
                      ? "No workflows are registered in this repo yet."
                      : "Nothing matches that."}
                  </EmptyNote>
                </div>
              ) : null}
              {matches.map((w, index) => (
                <LauncherMatchRow
                  key={w.name}
                  workflow={w}
                  selected={selectedIndex === index}
                  onHover={() => setCursor(index)}
                  onPick={() => {
                    setCursor(index);
                    pick(w.name);
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
                  <span className={styles.schemaNote}>schema-driven</span>
                  <span className={styles.spacer} />
                  <span className={styles.schemaHint}>tab to move · ⏎ starts · step 2 of 2</span>
                </div>
                <div className={styles.schemaFields}>
                  {detail.isPending ? (
                    <span className={styles.schemaState}>reading the declaration…</span>
                  ) : null}
                  {detail.error ? (
                    <span className={`${styles.schemaState} ${styles.stateError}`}>
                      {detail.error.message}
                    </span>
                  ) : null}
                  {detail.data !== undefined && schema === null ? (
                    <div className={styles.rawInput}>
                      <span className={styles.state}>
                        weft could not turn this workflow's input declaration into a schema — pass the input
                        as JSON.
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
              <div className={styles.foot}>
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
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
