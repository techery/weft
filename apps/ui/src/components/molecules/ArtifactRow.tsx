import { MonoBadge } from "~/components/atoms/MonoBadge";
import { artifactBadgeColors } from "~/domain/palette";
import type { Artifact } from "~/domain/types";
import styles from "./ArtifactRow.module.css";

type Props = { artifact: Artifact; selected: boolean; onSelect: () => void };

export function ArtifactRow({ artifact, selected, onSelect }: Props) {
  const colors = artifactBadgeColors(artifact.type);
  return (
    <button
      type="button"
      aria-pressed={selected}
      className={selected ? `${styles.row} ${styles.on}` : styles.row}
      onClick={onSelect}
    >
      <MonoBadge bg={colors.bg} fg={colors.fg} boxy>
        {artifact.type}
      </MonoBadge>
      <span className={styles.body}>
        <span className={styles.name}>{artifact.name}</span>
        <span className={styles.origin}>
          from {artifact.step} · {artifact.ago}
        </span>
      </span>
      <span className={styles.size}>{artifact.size}</span>
    </button>
  );
}
