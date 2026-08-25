import {
  createRootRoute,
  createRoute,
  createRouter,
  type RouterHistory,
  redirect,
} from "@tanstack/react-router";
import { RUN_FILTERS, type RunFilter } from "~/domain/filters";
import { isRunTab, type RunOrigin, type RunTab } from "~/domain/views";
import { QueuePage } from "~/pages/QueuePage";
import { RunDetailPage } from "~/pages/RunDetailPage";
import { RunsPage } from "~/pages/RunsPage";
import { SettingsPage } from "~/pages/SettingsPage";
import { WorkflowsPage } from "~/pages/WorkflowsPage";
import { RootLayout } from "./RootLayout";

/* Search params carry the parts of the UI worth linking to: which filter, which
   workflow, which step of which run. Everything else stays in Jotai. */

/** Every field is optional so a link can set just the part it cares about. */
export type RunDetailSearch = {
  from?: RunOrigin;
  tab?: RunTab;
  step?: string;
  artifact?: string;
  file?: string;
};

const rootRoute = createRootRoute({ component: RootLayout });

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  beforeLoad: () => {
    throw redirect({ to: "/queue" });
  },
});

const queueRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/queue",
  component: QueuePage,
});

const runsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/runs",
  validateSearch: (search: Record<string, unknown>): { filter?: RunFilter } => ({
    filter: RUN_FILTERS.includes(search.filter as RunFilter) ? (search.filter as RunFilter) : undefined,
  }),
  component: RunsPage,
});

const runDetailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/runs/$runId",
  validateSearch: (search: Record<string, unknown>): RunDetailSearch => ({
    from: search.from === "runs" ? "runs" : undefined,
    tab: isRunTab(search.tab as string | undefined) ? (search.tab as RunTab) : undefined,
    step: typeof search.step === "string" ? search.step : undefined,
    artifact: typeof search.artifact === "string" ? search.artifact : undefined,
    file: typeof search.file === "string" ? search.file : undefined,
  }),
  component: RunDetailPage,
});

const workflowsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/workflows",
  validateSearch: (search: Record<string, unknown>): { wf?: string } => ({
    wf: typeof search.wf === "string" ? search.wf : undefined,
  }),
  component: WorkflowsPage,
});

const settingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/settings",
  component: SettingsPage,
});

export const routeTree = rootRoute.addChildren([
  indexRoute,
  queueRoute,
  runsRoute,
  runDetailRoute,
  workflowsRoute,
  settingsRoute,
]);

export function createAppRouter(history?: RouterHistory) {
  return createRouter({ routeTree, ...(history ? { history } : {}) });
}

export const router = createAppRouter();

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
