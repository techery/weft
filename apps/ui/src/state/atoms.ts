/**
 * Client state — and only client state.
 *
 * Everything the daemon owns (runs, workflows, config, what is waiting on a person) lives
 * in TanStack Query, because it is somebody else's data and it changes without this page's
 * involvement. What is left here is genuinely local: which step of the launcher is open,
 * what has been typed into a form but not yet submitted. None of it survives a reload, and
 * none of it should.
 */
import { atom } from "jotai";

/* ── Launcher ───────────────────────────────────────────────────────────── */

export const launcherOpenAtom = atom(false);
/** 1 = pick a workflow, 2 = fill in its declared inputs. */
export const launcherStepAtom = atom<1 | 2>(1);
export const launcherQueryAtom = atom("");
/** Registry name of the workflow being configured. */
export const launcherWorkflowAtom = atom("");
/** Index of the highlighted row in the step-1 list. */
export const launcherCursorAtom = atom(0);

/** Draft inputs, per workflow name — kept while the launcher is open. */
export const launcherInputsAtom = atom<Record<string, Record<string, unknown>>>({});

export const setLauncherInputAtom = atom(null, (get, set, workflow: string, key: string, value: unknown) => {
  const all = get(launcherInputsAtom);
  set(launcherInputsAtom, { ...all, [workflow]: { ...all[workflow], [key]: value } });
});

export const toggleLauncherChipAtom = atom(null, (get, set, workflow: string, key: string, label: string) => {
  const all = get(launcherInputsAtom);
  const current = all[workflow]?.[key];
  const list = Array.isArray(current) ? (current as string[]) : [];
  const next = list.includes(label) ? list.filter((x) => x !== label) : [...list, label];
  set(launcherInputsAtom, { ...all, [workflow]: { ...all[workflow], [key]: next } });
});

export const openLauncherAtom = atom(null, (_get, set) => {
  set(launcherOpenAtom, true);
  set(launcherStepAtom, 1);
  set(launcherQueryAtom, "");
  set(launcherCursorAtom, 0);
});

/** Skip the picker and go straight to a known workflow's inputs. */
export const openLauncherForAtom = atom(null, (_get, set, workflow: string) => {
  set(launcherOpenAtom, true);
  set(launcherWorkflowAtom, workflow);
  set(launcherStepAtom, 2);
});

export const closeLauncherAtom = atom(null, (_get, set) => {
  set(launcherOpenAtom, false);
});

/* ── Gate answers ───────────────────────────────────────────────────────── */

/**
 * What has been filled into a gate's form but not yet submitted, per request id. Keyed by
 * request rather than by run: a run can hold more than one question, and answering one
 * must not disturb what was typed into another.
 */
export const gateDraftAtom = atom<Record<string, Record<string, unknown>>>({});

export const setGateFieldAtom = atom(null, (get, set, requestId: string, key: string, value: unknown) => {
  const all = get(gateDraftAtom);
  set(gateDraftAtom, { ...all, [requestId]: { ...all[requestId], [key]: value } });
});

export const toggleGateChipAtom = atom(null, (get, set, requestId: string, key: string, label: string) => {
  const all = get(gateDraftAtom);
  const current = all[requestId]?.[key];
  const list = Array.isArray(current) ? (current as string[]) : [];
  const next = list.includes(label) ? list.filter((x) => x !== label) : [...list, label];
  set(gateDraftAtom, { ...all, [requestId]: { ...all[requestId], [key]: next } });
});

/** Forget a draft once its question has been answered, so a re-ask starts clean. */
export const clearGateDraftAtom = atom(null, (get, set, requestId: string) => {
  const { [requestId]: _gone, ...rest } = get(gateDraftAtom);
  set(gateDraftAtom, rest);
});
