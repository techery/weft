import { Button } from "~/components/atoms/Button";
import { FactCell } from "~/components/atoms/FactCell";
import { MonoBadge } from "~/components/atoms/MonoBadge";
import { StatusDot } from "~/components/atoms/StatusDot";
import type { QueueCard as QueueCardModel } from "~/domain/views";
import styles from "./QueueCard.module.css";

type Props = { card: QueueCardModel; onOpen: () => void };

/** One waiting-or-running run, with the ask up front and the facts beneath. */
export function QueueCard({ card, onOpen }: Props) {
  return (
    <div className={card.needsYou ? `${styles.card} ${styles.needsYou}` : styles.card}>
      <div className={styles.top}>
        <span className={styles.identity}>
          <span className={styles.name}>
            <StatusDot state={card.needsYou ? "waiting" : "running"} />
            {card.wf}
          </span>
          <span className={styles.sub}>{card.sub}</span>
        </span>
        <span className={styles.body}>
          <span className={styles.ask}>
            {card.ask}
            {card.risk ? (
              <MonoBadge bg="var(--color-accent-200)" fg="var(--color-accent-800)">
                {`risk: ${card.risk}`}
              </MonoBadge>
            ) : null}
          </span>
          <span className={styles.detail}>{card.detail}</span>
        </span>
        <Button variant={card.needsYou ? "primary" : "secondary"} size="mediumWide" onClick={onOpen}>
          {card.action}
        </Button>
      </div>
      <div className={styles.facts}>
        {card.facts.map((fact, index) => (
          <FactCell key={fact.k} variant="queue" first={index === 0} label={fact.k} value={fact.v} />
        ))}
      </div>
    </div>
  );
}
