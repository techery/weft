import { Outlet, useNavigate, useRouterState } from "@tanstack/react-router";
import { useSetAtom } from "jotai";
import { useCallback } from "react";
import type { NavKey } from "~/components/organisms/TopBar";
import { AppShell } from "~/components/templates/AppShell";
import { DEFAULT_STEP, WORKFLOW_TO_RUN } from "~/domain/fixtures/runs";
import type { Workflow } from "~/domain/types";
import { closeLauncherAtom, launcherStepAtom, startedRunAtom } from "~/state/atoms";

function navKeyFor(pathname: string): NavKey {
  if (pathname.startsWith("/runs")) return "runs";
  if (pathname.startsWith("/workflows")) return "workflows";
  if (pathname.startsWith("/settings")) return "settings";
  return "queue";
}

export function RootLayout() {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const navigate = useNavigate();
  const closeLauncher = useSetAtom(closeLauncherAtom);
  const setLauncherStep = useSetAtom(launcherStepAtom);
  const setStarted = useSetAtom(startedRunAtom);

  /**
   * Starting a workflow that already has a live run opens that run; anything
   * else is queued, and the runs screen says so until the daemon picks it up.
   */
  const startRun = useCallback(
    (workflow: Workflow) => {
      closeLauncher();
      setLauncherStep(1);
      const runId = WORKFLOW_TO_RUN[workflow.file];
      if (runId) {
        void navigate({
          to: "/runs/$runId",
          params: { runId },
          search: { from: "runs", tab: "steps", step: DEFAULT_STEP[runId] },
        });
        return;
      }
      setStarted({ wf: workflow.name, file: workflow.file });
      void navigate({ to: "/runs", search: { filter: "All" } });
    },
    [closeLauncher, navigate, setLauncherStep, setStarted],
  );

  return (
    <AppShell active={navKeyFor(pathname)} onStartRun={startRun}>
      <Outlet />
    </AppShell>
  );
}
