/**
 * One run, assembled.
 *
 * A run's screen reads from four places — the folded state, the queue's pending requests,
 * the artifact inventory, the captured patches — plus the journal, which arrives as a
 * stream rather than a fetch. This hook is where those meet, so no component has to know
 * that the tabs it renders come from different requests that land at different times.
 *
 * The stream does double duty. It is the Journal tab's content, and it is the signal to
 * refetch the fold: a step that finishes appends a record, and that record is the cue. So
 * an open run updates itself without polling, and a finished one costs nothing.
 */
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { streamJournal } from "~/api/events";
import { keys, useArtifacts, usePatch, usePending, useRun, useWorkflows } from "~/api/queries";
import type { JournalRecord, JsonSchema } from "~/api/types";
import { adaptArtifacts, adaptRun } from "~/domain/adapt";
import { splitDiff } from "~/domain/diff";
import { journalEntries } from "~/domain/journal";
import type { FileChange, FileDiff, Run } from "~/domain/types";

export interface RunView {
  run: Run | undefined;
  /** The schema of the answer the blocking question expects. */
  gateSchema: JsonSchema | null;
  diffs: Record<string, FileDiff>;
  isPending: boolean;
  error: Error | null;
  live: boolean;
}

/** Records arriving faster than this are coalesced into one refetch. */
const REFETCH_DEBOUNCE_MS = 250;

export function useRunView(runId: string): RunView {
  const client = useQueryClient();
  const detail = useRun(runId);
  const pending = usePending();
  const artifacts = useArtifacts(runId);
  const patch = usePatch(runId);
  const workflows = useWorkflows();
  const [records, setRecords] = useState<JournalRecord[]>([]);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const status = detail.data?.status;
  const live = status !== undefined && status !== "complete" && status !== "failed" && status !== "cancelled";

  useEffect(() => {
    if (runId === "") return;
    setRecords([]);
    const stream = streamJournal(runId, (record) => {
      // Ordered and de-duplicated by index: a reconnect resumes from Last-Event-ID, but a
      // proxy replaying one frame must not double a line in the journal view.
      setRecords((current) => {
        if (current.some((seen) => seen.i === record.i)) return current;
        return [...current, record].sort((a, b) => a.i - b.i);
      });
      if (timer.current !== undefined) clearTimeout(timer.current);
      timer.current = setTimeout(() => {
        void client.invalidateQueries({ queryKey: keys.run(runId) });
        void client.invalidateQueries({ queryKey: keys.artifacts(runId) });
        void client.invalidateQueries({ queryKey: keys.patch(runId) });
      }, REFETCH_DEBOUNCE_MS);
    });
    return () => {
      stream.close();
      if (timer.current !== undefined) clearTimeout(timer.current);
    };
  }, [runId, client]);

  if (detail.data === undefined) {
    return {
      run: undefined,
      gateSchema: null,
      diffs: {},
      isPending: detail.isPending,
      error: (detail.error as Error | null) ?? null,
      live: false,
    };
  }

  // The request blocking THIS run, which is not always the root's — a child suspended on a
  // person is the run that must be answered.
  const request = pending.data?.pending.find((entry) => entry.runId === runId);
  // A run captures one patch per write step, and several of them routinely touch the same
  // file — five agents all editing App.tsx is the normal shape of a parallel build. The
  // changes view is about FILES, so each one is listed once with its totals across every
  // patch, and its hunks are concatenated in capture order rather than one patch silently
  // replacing another's.
  const totals = new Map<string, FileChange>();
  const diffs: Record<string, FileDiff> = {};
  for (const entry of patch.data?.patches ?? []) {
    for (const stat of entry.stats) {
      const seen = totals.get(stat.path);
      if (seen) {
        seen.adds += stat.adds;
        seen.dels += stat.dels;
      } else {
        totals.set(stat.path, { path: stat.path, adds: stat.adds, dels: stat.dels });
      }
    }
    if (entry.diff === undefined) continue;
    for (const [path, fileDiff] of Object.entries(splitDiff(entry.diff))) {
      const seen = diffs[path];
      if (seen === undefined) {
        diffs[path] = fileDiff;
        continue;
      }
      // The later patch's own header becomes a line, so the join stays readable as one
      // scroll rather than pretending the hunks were contiguous.
      seen.lines.push(
        { ln: "", rn: "", text: "", sign: "" },
        { ln: "", rn: "", text: fileDiff.hunk, sign: "" },
      );
      seen.lines.push(...fileDiff.lines);
    }
  }
  const files: FileChange[] = [...totals.values()];

  const run = adaptRun(detail.data, {
    journal: journalEntries(records),
    files,
    artifacts: adaptArtifacts(artifacts.data ?? []),
    ...(request ? { pending: request } : {}),
    ...(fileOf(workflows.data, detail.data.workflow) ?? {}),
  });

  return {
    run,
    gateSchema: (request?.schema as JsonSchema | undefined) ?? gateSchemaOf(detail.data, run.gate?.id),
    diffs,
    isPending: false,
    error: null,
    live,
  };
}

function fileOf(
  workflows: Array<{ name: string; file: string }> | undefined,
  workflow: string,
): { file: string } | undefined {
  const hit = workflows?.find((entry) => entry.name === workflow);
  return hit ? { file: hit.file } : undefined;
}

/** The schema a run's own projection recorded, for a question the queue no longer lists. */
function gateSchemaOf(
  detail: { humans: Array<{ id: string; schema: unknown }> },
  gateId: string | undefined,
): JsonSchema | null {
  if (gateId === undefined) return null;
  const human = detail.humans.find((entry) => entry.id === gateId);
  return (human?.schema as JsonSchema | undefined) ?? null;
}
