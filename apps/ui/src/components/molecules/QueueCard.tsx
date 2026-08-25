import { Button } from "~/components/atoms/Button";
import { FactCell } from "~/components/atoms/FactCell";
import { MonoBadge } from "~/components/atoms/MonoBadge";
import { StatusDot } from "~/components/atoms/StatusDot";
import type { Labelled } from "~/domain/types";
import styles from "./QueueCard.module.css";

/**
 * One card's worth of copy. The queue builds this from two different sources — a pending
 * request and a running run's row — so the shape is what they have in common, and anything
 * neither can supply arrives as "" or as a missing fact.
 */
export type QueueCardModel = {
  /** True when the run is blocked on a human answer. */
  needsYou: boolean;
  wf: string;
  sub: string;
  ask: string;
  detail: string;
  /** Risk tier of the pending gate, or "" when the request declared none. */
  risk: string;
  action: string;
  facts: Labelled[];
};

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
          {card.detail ? <span className={styles.detail}>{card.detail}</span> : null}
        </span>
        <Button variant={card.needsYou ? "primary" : "secondary"} size="mediumWide" onClick={onOpen}>
          {card.action}
        </Button>
      </div>
      {card.facts.length > 0 ? (
        <div className={styles.facts}>
          {card.facts.map((fact, index) => (
            <FactCell key={fact.k} variant="queue" first={index === 0} label={fact.k} value={fact.v} />
          ))}
        </div>
      ) : null}
    </div>
  );
}
