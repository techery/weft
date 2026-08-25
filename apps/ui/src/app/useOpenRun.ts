import { useNavigate } from "@tanstack/react-router";
import { useCallback } from "react";
import type { RunOrigin } from "~/domain/views";

/**
 * Open a run, remembering where from so its back button can say so.
 *
 * A caller holding a pending request passes that request's step, which lands straight on
 * the question; everything else lands on whichever step the run recorded first.
 */
export function useOpenRun(): (runId: string, opts: { from: RunOrigin; step?: string }) => void {
  const navigate = useNavigate();
  return useCallback(
    (runId, opts) => {
      void navigate({
        to: "/runs/$runId",
        params: { runId },
        search: { from: opts.from, tab: "steps", ...(opts.step ? { step: opts.step } : {}) },
      });
    },
    [navigate],
  );
}
