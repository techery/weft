/**
 * Query keys and the hooks over them.
 *
 * Keys are listed in one place because invalidation is the interesting part: answering a
 * gate changes the run, the queue and the runs list at once, and a screen that refetched
 * only what it could see would leave the nav badge stale.
 */

import type { UseQueryResult } from "@tanstack/react-query";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "./client";
import type {
  ArtifactEntry,
  ConfigResponse,
  Meta,
  PatchResponse,
  PendingResponse,
  RunDetail,
  RunRow,
  WorkflowDetail,
  WorkflowIssue,
  WorkflowRow,
  WorkflowStats,
  WorkflowTask,
} from "./types";

export const keys = {
  meta: ["meta"] as const,
  runs: (spend: boolean) => ["runs", { spend }] as const,
  run: (runId: string) => ["run", runId] as const,
  pending: ["pending"] as const,
  workflows: ["workflows"] as const,
  workflow: (name: string) => ["workflow", name] as const,
  workflowStats: (name: string) => ["workflow-stats", name] as const,
  workflowTasks: (name: string) => ["workflow-tasks", name] as const,
  artifacts: (runId: string) => ["artifacts", runId] as const,
  patch: (runId: string) => ["patch", runId] as const,
  config: ["config"] as const,
};

/** The daemon's own identity changes only when it restarts. */
export function useMeta(): UseQueryResult<Meta> {
  return useQuery({ queryKey: keys.meta, queryFn: api.meta, staleTime: Number.POSITIVE_INFINITY });
}

/**
 * Lists poll. A run started from a terminal, or a step finishing in a run this page is not
 * watching, has no other way to reach the screen — and the interval is what makes the
 * queue feel like a queue rather than a snapshot.
 */
const LIST_POLL_MS = 4_000;

export function useRuns(opts: { spend?: boolean } = {}): UseQueryResult<RunRow[]> {
  const spend = opts.spend === true;
  return useQuery({
    queryKey: keys.runs(spend),
    queryFn: () => api.runs({ spend }),
    refetchInterval: LIST_POLL_MS,
  });
}

export function usePending(): UseQueryResult<PendingResponse> {
  return useQuery({ queryKey: keys.pending, queryFn: api.pending, refetchInterval: LIST_POLL_MS });
}

export function useRun(runId: string): UseQueryResult<RunDetail> {
  return useQuery({
    queryKey: keys.run(runId),
    queryFn: () => api.run(runId, { detail: true }),
    // The journal stream invalidates this, so it does not poll on its own.
    enabled: runId !== "",
  });
}

export function useWorkflows(): UseQueryResult<WorkflowRow[]> {
  // Listing re-bundles every workflow file, so it is worth holding onto.
  return useQuery({ queryKey: keys.workflows, queryFn: api.workflows, staleTime: 30_000 });
}

export function useWorkflowIssues(): UseQueryResult<WorkflowIssue[]> {
  return useQuery({ queryKey: [...keys.workflows, "issues"], queryFn: api.workflowIssues, staleTime: 30_000 });
}

export function useWorkflow(name: string): UseQueryResult<WorkflowDetail> {
  return useQuery({
    queryKey: keys.workflow(name),
    queryFn: () => api.workflow(name),
    enabled: name !== "",
    staleTime: 30_000,
  });
}

export function useWorkflowStats(name: string): UseQueryResult<WorkflowStats> {
  return useQuery({
    queryKey: keys.workflowStats(name),
    queryFn: () => api.workflowStats(name),
    enabled: name !== "",
    staleTime: 10_000,
  });
}

export function useWorkflowTasks(name: string): UseQueryResult<WorkflowTask[]> {
  return useQuery({
    queryKey: keys.workflowTasks(name),
    queryFn: () => api.workflowTasks(name),
    enabled: name !== "",
    // Agents update tasks out of band through the CLI, so polling is the invalidation path.
    refetchInterval: 30_000,
    refetchIntervalInBackground: false,
  });
}

export function useArtifacts(runId: string): UseQueryResult<ArtifactEntry[]> {
  return useQuery({
    queryKey: keys.artifacts(runId),
    queryFn: () => api.artifacts(runId),
    enabled: runId !== "",
  });
}

export function usePatch(runId: string): UseQueryResult<PatchResponse> {
  return useQuery({ queryKey: keys.patch(runId), queryFn: () => api.patch(runId), enabled: runId !== "" });
}

export function useConfig(): UseQueryResult<ConfigResponse> {
  return useQuery({ queryKey: keys.config, queryFn: api.config });
}

/** Everything a run-changing action has to refresh: the run, both lists, and the queue. */
function useRunInvalidation(): (runId: string) => Promise<void> {
  const client = useQueryClient();
  return async (runId: string) => {
    await Promise.all([
      client.invalidateQueries({ queryKey: keys.run(runId) }),
      client.invalidateQueries({ queryKey: ["runs"] }),
      client.invalidateQueries({ queryKey: keys.pending }),
      client.invalidateQueries({ queryKey: keys.artifacts(runId) }),
      client.invalidateQueries({ queryKey: keys.patch(runId) }),
    ]);
  };
}

export function useAnswerGate() {
  const invalidate = useRunInvalidation();
  return useMutation({
    mutationFn: (vars: { runId: string; requestId: string; answer: unknown }) =>
      api.answer(vars.runId, vars.requestId, vars.answer),
    onSuccess: (_data, vars) => invalidate(vars.runId),
  });
}

export function useCancelRun() {
  const invalidate = useRunInvalidation();
  return useMutation({
    mutationFn: (runId: string) => api.cancel(runId),
    onSuccess: (_data, runId) => invalidate(runId),
  });
}

export function useStartRun() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: api.start,
    onSuccess: async (data) => {
      await Promise.all([
        client.invalidateQueries({ queryKey: ["runs"] }),
        client.invalidateQueries({ queryKey: keys.pending }),
        client.invalidateQueries({ queryKey: keys.workflowStats(data.workflow) }),
      ]);
    },
  });
}

export function useSaveConfig() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: api.saveConfig,
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: keys.config });
      // The engine resolved its config at startup, so `effective` will not move until the
      // daemon restarts — but the file half of the response has to be right immediately.
      await client.invalidateQueries({ queryKey: keys.meta });
    },
  });
}
