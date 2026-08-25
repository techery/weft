import type { TreeNode } from "~/domain/views";
import styles from "./TreeRow.module.css";

type Props = { node: TreeNode; selected: boolean; onSelect: () => void };

/** One line of the changed-files tree; directories are inert. */
export function TreeRow({ node, selected, onSelect }: Props) {
  const classes = [styles.row, node.isFile ? "" : styles.dir, selected ? styles.on : ""]
    .filter(Boolean)
    .join(" ");
  return (
    <button
      type="button"
      className={classes}
      style={{ paddingLeft: 10 + node.depth * 13 }}
      onClick={node.isFile ? onSelect : undefined}
      disabled={!node.isFile}
    >
      <span className={styles.twisty}>{node.isFile ? "" : "▾"}</span>
      {node.isFile ? (
        <span className={styles.icon} style={{ color: node.extColor }}>
          {node.ext}
        </span>
      ) : null}
      <span
        className={[styles.name, node.isFile ? "" : styles.dirName, selected ? styles.selectedName : ""]
          .filter(Boolean)
          .join(" ")}
      >
        {node.name}
      </span>
      {node.isFile ? (
        <span className={selected ? `${styles.stat} ${styles.statOn}` : styles.stat}>{node.stat}</span>
      ) : null}
    </button>
  );
}
