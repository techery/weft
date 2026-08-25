import { atom } from "jotai";
import { buildRuns } from "~/domain/fixtures/runs";
import { DEFAULT_LAUNCHER_INPUTS, WORKFLOWS } from "~/domain/fixtures/workflows";
import type {
  GateAnswers,
  GateAnswerValue,
  LauncherInputs,
  LauncherInputValue,
  PolicyMode,
  RiskTier,
  Run,
} from "~/domain/types";

/* ── Gate answers ─────────────────────────────────────────────────────────
   Draft answers live here from the moment the gate is rendered; `answered`
   and `denied` record whether you actually submitted them. The run fixtures
   read all three, so answering a gate moves the whole run. */

export const gateAnswersAtom = atom<GateAnswers>({
  "gate-5": { action: "open a PR", notify: ["#eng-alerts"], wait: true, note: "" },
  "gate-3": { scope: "publish now", announce: "#releases", note: "" },
  "gate-4": { variant: "variant A", shot: true, note: "" },
});

export const answeredRunsAtom = atom<Record<string, boolean>>({});
export const deniedRunsAtom = atom<Record<string, boolean>>({});

/** Every run, rebuilt whenever an answer changes. */
export const runsAtom = atom<Record<string, Run>>((get) =>
  buildRuns({
    answered: get(answeredRunsAtom),
    denied: get(deniedRunsAtom),
    ans: get(gateAnswersAtom),
  }),
);

/** Set one field of one gate's answer. */
export const setGateAnswerAtom = atom(
  null,
  (get, set, gateId: string, key: string, value: GateAnswerValue) => {
    const all = get(gateAnswersAtom);
    set(gateAnswersAtom, { ...all, [gateId]: { ...all[gateId], [key]: value } });
  },
);

/** Add or remove one label from a multi-select gate answer. */
export const toggleGateChipAtom = atom(null, (get, set, gateId: string, key: string, label: string) => {
  const all = get(gateAnswersAtom);
  const current = all[gateId]?.[key];
  const list = Array.isArray(current) ? current : [];
  const next = list.includes(label) ? list.filter((x) => x !== label) : [...list, label];
  set(gateAnswersAtom, { ...all, [gateId]: { ...all[gateId], [key]: next } });
});

/** Flip a boolean gate answer. */
export const toggleGateFlagAtom = atom(null, (get, set, gateId: string, key: string) => {
  const all = get(gateAnswersAtom);
  set(gateAnswersAtom, { ...all, [gateId]: { ...all[gateId], [key]: !all[gateId]?.[key] } });
});

export const submitGateAtom = atom(null, (get, set, runId: string) => {
  set(answeredRunsAtom, { ...get(answeredRunsAtom), [runId]: true });
});

export const denyGateAtom = atom(null, (get, set, runId: string) => {
  set(answeredRunsAtom, { ...get(answeredRunsAtom), [runId]: true });
  set(deniedRunsAtom, { ...get(deniedRunsAtom), [runId]: true });
});

/* ── Settings ───────────────────────────────────────────────────────────── */

export const policyAtom = atom<Record<RiskTier, PolicyMode>>({
  read: "auto",
  write: "ask",
  network: "ask",
  destructive: "ask",
});

export const setPolicyAtom = atom(null, (get, set, tier: RiskTier, mode: PolicyMode) => {
  set(policyAtom, { ...get(policyAtom), [tier]: mode });
});

export const budgetAtom = atom("$8.00");
export const concurrencyAtom = atom(8);

/* ── Launcher ───────────────────────────────────────────────────────────── */

export const launcherOpenAtom = atom(false);
/** 1 = pick a workflow, 2 = fill in its inputs. */
export const launcherStepAtom = atom<1 | 2>(1);
export const launcherQueryAtom = atom("");
export const launcherWorkflowAtom = atom(WORKFLOWS[0]?.file ?? "");
/** Index of the highlighted row in the step-1 list. */
export const launcherCursorAtom = atom(0);

export const launcherInputsAtom = atom<LauncherInputs>(
  JSON.parse(JSON.stringify(DEFAULT_LAUNCHER_INPUTS)) as LauncherInputs,
);

export const setLauncherInputAtom = atom(
  null,
  (get, set, file: string, key: string, value: LauncherInputValue) => {
    const all = get(launcherInputsAtom);
    set(launcherInputsAtom, { ...all, [file]: { ...all[file], [key]: value } });
  },
);

export const toggleLauncherChipAtom = atom(null, (get, set, file: string, key: string, label: string) => {
  const all = get(launcherInputsAtom);
  const current = all[file]?.[key];
  const list = Array.isArray(current) ? current : [];
  const next = list.includes(label) ? list.filter((x) => x !== label) : [...list, label];
  set(launcherInputsAtom, { ...all, [file]: { ...all[file], [key]: next } });
});

export const toggleLauncherFlagAtom = atom(null, (get, set, file: string, key: string) => {
  const all = get(launcherInputsAtom);
  set(launcherInputsAtom, { ...all, [file]: { ...all[file], [key]: !all[file]?.[key] } });
});

export const openLauncherAtom = atom(null, (_get, set) => {
  set(launcherOpenAtom, true);
  set(launcherStepAtom, 1);
  set(launcherQueryAtom, "");
  set(launcherCursorAtom, 0);
});

/** Skip the picker and go straight to a known workflow's inputs. */
export const openLauncherForAtom = atom(null, (_get, set, file: string) => {
  set(launcherOpenAtom, true);
  set(launcherWorkflowAtom, file);
  set(launcherStepAtom, 2);
});

export const closeLauncherAtom = atom(null, (_get, set) => {
  set(launcherOpenAtom, false);
});

/** The "queued just now" strip on the runs screen, after starting a fresh run. */
export const startedRunAtom = atom<{ wf: string; file: string } | null>(null);
