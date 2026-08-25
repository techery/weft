import { Button } from "~/components/atoms/Button";
import { DiffLineRow } from "~/components/molecules/DiffLineRow";
import { TreeRow } from "~/components/molecules/TreeRow";
import { FILE_DIFFS } from "~/domain/fixtures/runList";
import type { FileChange, Run } from "~/domain/types";
import { fileTree, totalAdds, totalDels } from "~/domain/views";
import styles from "./ChangesTab.module.css";

type Props = {
  run: Run;
  file: FileChange;
  onSelect: (path: string) => void;
  onGoToGate: () => void;
};

/** The staged working tree for this run, file by file. */
export function ChangesTab({ run, file, onSelect, onGoToGate }: Props) {
  const diff = FILE_DIFFS[file.path] ?? { hunk: "", lines: [] };
  const tree = fileTree(run.files);

  return (
    <div className={styles.pane}>
      <div className={styles.tree}>
        <div className={styles.treeHead}>
          <span className={styles.treeTitle}>Changes</span>
          <span className={styles.spacer} />
          <span className={styles.adds}>+{totalAdds(run.files)}</span>
          <span className={styles.dels}>−{totalDels(run.files)}</span>
        </div>
        <div className={styles.treeBody}>
          <span className={styles.root}>
            <span className={styles.twisty}>▾</span>
            <span className={styles.rootName}>weft/{run.id}</span>
            <span className={styles.spacer} />
            <span className={styles.rootCount}>{run.files.length}</span>
          </span>
          {tree.map((node) => (
            <TreeRow
              key={node.key}
              node={node}
              selected={node.isFile && node.path === file.path}
              onSelect={() => onSelect(node.path)}
            />
          ))}
        </div>
        <div className={styles.treeFoot}>
          <span className={styles.note}>{run.changesNote}</span>
          <span className={styles.branch}>{run.branchNote}</span>
        </div>
      </div>

      <div className={styles.diff}>
        <div className={styles.diffHead}>
          <span className={styles.path}>{file.path}</span>
          <span className={styles.fileAdds}>+{file.adds}</span>
          <span className={styles.fileDels}>−{file.dels}</span>
          <span className={styles.hunks}>unified · 1 hunk</span>
        </div>
        <div className={styles.diffBody}>
          <span className={styles.hunkHead}>{diff.hunk}</span>
          {diff.lines.map((line, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: diff lines repeat freely, so only position identifies them
            <DiffLineRow key={`diff-${index}`} line={line} />
          ))}
        </div>
        <div className={styles.diffFoot}>
          <span className={styles.footNote}>{run.branchNote}</span>
          <Button variant="ghost" size="medium">
            Open in editor
          </Button>
          {!run.committed ? (
            <Button variant="secondary" size="mediumWide">
              Request changes
            </Button>
          ) : null}
          {!run.committed ? (
            <Button variant="primary" size="large" onClick={onGoToGate}>
              Go to commit gate
            </Button>
          ) : null}
        </div>
      </div>
    </div>
  );
}
