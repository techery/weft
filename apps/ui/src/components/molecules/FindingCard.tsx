import type { ReactNode } from "react";
import { MonoBadge } from "~/components/atoms/MonoBadge";
import type { Finding } from "~/domain/types";
import styles from "./FindingCard.module.css";

type Props = { finding: Finding; onOpenStep?: () => void };

/** One journaled note: what it said, and where it says the evidence is. */
export function FindingCard({ finding }: Props) {
  return (
    <div className={styles.card}>
      <div className={styles.head}>
        <span className={styles.id}>{finding.id}</span>
        <div className={styles.msg}>
          {noteBlocks(finding.msg).map((block) => (
            <p key={block.key}>{inlineCode(block.text)}</p>
          ))}
        </div>
        {finding.sev ? <span className={styles.sev}>{finding.sev}</span> : null}
      </div>
      {finding.loc ? <span className={styles.loc}>{finding.loc}</span> : null}
      {finding.chip ? (
        <div className={styles.foot}>
          <span className={styles.footLabel}>opened step</span>
          <span className={styles.step}>{finding.stepLabel}</span>
          <MonoBadge bg="var(--color-neutral-200)" fg="var(--color-neutral-800)">
            {finding.chip}
          </MonoBadge>
        </div>
      ) : null}
    </div>
  );
}

/** Preserve authored lines, and give long single-line agent prose readable sentence breaks. */
function noteBlocks(text: string): Array<{ key: string; text: string }> {
  const blocks = text
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean)
    .flatMap((line) =>
      line.length > 180
        ? line.split(/(?<=[.!?])\s+(?=[`"'“‘(]*[A-Z`])/).map((sentence) => sentence.trim())
        : [line],
    );
  let cursor = 0;
  return blocks.map((block) => {
    const start = Math.max(cursor, text.indexOf(block, cursor));
    cursor = start + block.length;
    return { key: `${start}:${block.length}`, text: block };
  });
}

/** Journal notes use lightweight Markdown backticks for code identifiers. */
function inlineCode(text: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  const pattern = /`([^`]+)`/g;
  let cursor = 0;
  for (const match of text.matchAll(pattern)) {
    const start = match.index;
    if (start > cursor) nodes.push(text.slice(cursor, start));
    nodes.push(<code key={`${start}-${match[1]}`}>{match[1]}</code>);
    cursor = start + match[0].length;
  }
  if (cursor < text.length) nodes.push(text.slice(cursor));
  return nodes;
}
