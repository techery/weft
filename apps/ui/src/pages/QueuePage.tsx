import { useAtomValue, useSetAtom } from "jotai";
import { useOpenRun } from "~/app/useOpenRun";
import { Button } from "~/components/atoms/Button";
import { EmptyNote } from "~/components/molecules/EmptyNote";
import { QueueCard } from "~/components/molecules/QueueCard";
import { QueueGroupHeader } from "~/components/molecules/QueueGroupHeader";
import { PageHeader } from "~/components/templates/PageHeader";
import { ScrollPage } from "~/components/templates/ScrollPage";
import { RUN_ORDER } from "~/domain/fixtures/runs";
import { WORKFLOWS } from "~/domain/fixtures/workflows";
import { queueGroups } from "~/domain/views";
import { concurrencyAtom, openLauncherForAtom, runsAtom } from "~/state/atoms";
import styles from "./QueuePage.module.css";

/** Everything that wants a human, then everything that is working. */
export function QueuePage() {
  const runs = useAtomValue(runsAtom);
  const concurrency = useAtomValue(concurrencyAtom);
  const openLauncherFor = useSetAtom(openLauncherForAtom);
  const openRun = useOpenRun();
  const { waiting, running } = queueGroups(runs, RUN_ORDER);

  return (
    <ScrollPage maxWidth={1180} gap={18}>
      <PageHeader
        title="Queue"
        summary={`${waiting.length} waiting on you · ${running.length} running`}
        aside={
          <span className={styles.quickStart}>
            <span className={styles.quickStartLabel}>quick start</span>
            {WORKFLOWS.slice(0, 4).map((w) => (
              <Button
                key={w.file}
                variant="secondary"
                size="smallWide"
                round
                onClick={() => openLauncherFor(w.file)}
              >
                {w.name}
              </Button>
            ))}
          </span>
        }
      />

      <div className={styles.group}>
        <QueueGroupHeader
          label={`Waiting on you · ${waiting.length}`}
          note="blocks the run until answered"
          color="var(--color-accent-700)"
        />
        {waiting.map((card) => (
          <QueueCard key={card.runId} card={card} onOpen={() => openRun(card.runId, "gate", "queue")} />
        ))}
        {waiting.length === 0 ? <EmptyNote>Nothing is waiting on you.</EmptyNote> : null}
      </div>

      <div className={styles.group}>
        <QueueGroupHeader
          label={`Running · ${running.length}`}
          note={`pool ${concurrency} agents`}
          color="var(--color-accent-2-700)"
        />
        {running.map((card) => (
          <QueueCard key={card.runId} card={card} onOpen={() => openRun(card.runId, "default", "queue")} />
        ))}
        {running.length === 0 ? <EmptyNote>No runs are working right now.</EmptyNote> : null}
      </div>
    </ScrollPage>
  );
}
