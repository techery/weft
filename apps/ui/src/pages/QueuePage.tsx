import type { UseQueryResult } from "@tanstack/react-query";
import { useSetAtom } from "jotai";
import { useMeta, usePending, useRuns, useWorkflows } from "~/api/queries";
import type { PendingRequest, RunRow } from "~/api/types";
import { useOpenRun } from "~/app/useOpenRun";
import { Button } from "~/components/atoms/Button";
import { StatusDot } from "~/components/atoms/StatusDot";
import { EmptyNote } from "~/components/molecules/EmptyNote";
import { QueueCard, type QueueCardModel } from "~/components/molecules/QueueCard";
import { QueueGroupHeader } from "~/components/molecules/QueueGroupHeader";
import { PageHeader } from "~/components/templates/PageHeader";
import { ScrollPage } from "~/components/templates/ScrollPage";
import { ago, duration, gateStepId, money, runState } from "~/domain/adapt";
import { openLauncherForAtom } from "~/state/atoms";
import styles from "./QueuePage.module.css";

/** Everything that wants a human, then everything that is working. */
export function QueuePage() {
  const pending = usePending();
  const runs = useRuns({ spend: true });
  const workflows = useWorkflows();
  const meta = useMeta();
  const openLauncherFor = useSetAtom(openLauncherForAtom);
  const openRun = useOpenRun();

  const requests = pending.data?.pending ?? [];
  const unreadable = pending.data?.unreadable ?? [];
  const rows = runs.data ?? [];
  const running = rows.filter((row) => runState(row.status) === "running");
  // A request carries no spend of its own; the runs list is where a run's cost is.
  const spendByRun = new Map(rows.map((row) => [row.runId, row.spend?.usd]));

  // The question belongs to the run that ASKED it, which is where the answer is posted —
  // a gate raised inside a child does not open on the root.
  const openGate = (request: PendingRequest) => {
    openRun(request.runId, { from: "queue", step: gateStepId(request.id) });
  };

  const counted = pending.data !== undefined && runs.data !== undefined;

  return (
    <ScrollPage maxWidth={1180} gap={18}>
      <PageHeader
        title="Queue"
        summary={counted ? `${requests.length} waiting on you · ${running.length} running` : ""}
        aside={
          <span className={styles.quickStart}>
            <span className={styles.quickStartLabel}>quick start</span>
            {(workflows.data ?? []).slice(0, 4).map((w) => (
              <Button
                key={w.name}
                variant="secondary"
                size="smallWide"
                round
                onClick={() => openLauncherFor(w.name)}
              >
                {w.name}
              </Button>
            ))}
          </span>
        }
      />

      {unreadable.length > 0 ? (
        <div className={styles.warning}>
          <StatusDot state="fail" />
          <span>{`${unreadable.length} run${unreadable.length === 1 ? "" : "s"} could not be read — a question may be waiting inside`}</span>
          <span className={styles.warningRuns}>
            {unreadable.map((entry) => `${entry.runId}: ${entry.error}`).join(" · ")}
          </span>
        </div>
      ) : null}

      <div className={styles.group}>
        <QueueGroupHeader
          label={`Waiting on you · ${requests.length}`}
          note="blocks the run until answered"
          color="var(--color-accent-700)"
        />
        {requests.map((request) => (
          // A request id is only unique within its own run — every run's first question is
          // `h1` — so the run has to be part of the key across a list of every run's.
          <QueueCard
            key={`${request.runId}:${request.id}`}
            card={waitingCard(request, spendByRun.get(request.runId))}
            onOpen={() => openGate(request)}
          />
        ))}
        <GroupState query={pending} count={requests.length} empty="Nothing is waiting on you." />
      </div>

      <div className={styles.group}>
        <QueueGroupHeader
          label={`Running · ${running.length}`}
          note={meta.data ? `pool ${meta.data.limits.concurrency} agents` : ""}
          color="var(--color-accent-2-700)"
        />
        {running.map((row) => (
          <QueueCard
            key={row.runId}
            card={runningCard(row)}
            onOpen={() => openRun(row.runId, { from: "queue" })}
          />
        ))}
        <GroupState query={runs} count={running.length} empty="No runs are working right now." />
      </div>
    </ScrollPage>
  );
}

/** What a group shows instead of cards: the daemon's own message beats a generic failure. */
function GroupState({
  query,
  count,
  empty,
}: {
  query: UseQueryResult<unknown>;
  count: number;
  empty: string;
}) {
  if (query.error) return <div className={styles.warning}>{query.error.message}</div>;
  if (query.isPending) return <span className={styles.loading}>loading…</span>;
  if (count === 0) return <EmptyNote>{empty}</EmptyNote>;
  return null;
}

function waitingCard(request: PendingRequest, usd: number | undefined): QueueCardModel {
  return {
    needsYou: true,
    wf: request.workflow,
    sub: `${request.runId} · waiting · ${ago(request.createdAt)}`,
    ask: request.question,
    detail: request.detail ?? "",
    risk: request.risk ?? "",
    action: "Answer →",
    facts: [
      // A question asked inside a child run holds the root run too, and the root is what
      // the person started — so that is what this is blocking.
      { k: "blocks", v: request.rootWorkflow },
      { k: "waiting", v: ago(request.createdAt) },
      ...(usd === undefined ? [] : [{ k: "spent", v: money(usd) }]),
    ],
  };
}

function runningCard(row: RunRow): QueueCardModel {
  const active = row.running ?? 0;
  const steps = `${active} step${active === 1 ? "" : "s"}`;
  const elapsed = duration(row.createdAt, undefined);
  return {
    needsYou: false,
    wf: row.workflow || "—",
    sub: `${row.runId} · running · ${elapsed}`,
    ask: `${steps} active`,
    detail: "",
    risk: "",
    action: "Open",
    facts: [
      { k: "active", v: steps },
      { k: "elapsed", v: elapsed },
      ...(row.spend ? [{ k: "spent", v: money(row.spend.usd) }] : []),
    ],
  };
}
