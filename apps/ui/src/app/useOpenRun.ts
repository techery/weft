import { useNavigate } from "@tanstack/react-router";
import { useAtomValue } from "jotai";
import { useCallback } from "react";
import { DEFAULT_STEP } from "~/domain/fixtures/runs";
import type { RunOrigin } from "~/domain/views";
import { runsAtom } from "~/state/atoms";

export type OpenRunMode = "gate" | "default";

/**
 * Opening a run from the queue lands on its pending gate; opening it from the
 * runs table lands on whichever step reads best for that run. Both remember
 * where you came from so the back button can say so.
 */
export function useOpenRun() {
  const navigate = useNavigate();
  const runs = useAtomValue(runsAtom);

  return useCallback(
    (runId: string, mode: OpenRunMode, from: RunOrigin) => {
      const run = runs[runId];
      const fallback = DEFAULT_STEP[runId] ?? "";
      const step = mode === "gate" ? (run?.gateStep ?? fallback) : fallback;
      void navigate({ to: "/runs/$runId", params: { runId }, search: { from, tab: "steps", step } });
    },
    [navigate, runs],
  );
}
