import { DiffLineRow } from "~/components/molecules/DiffLineRow";
import { EmptyNote } from "~/components/molecules/EmptyNote";
import { TreeRow } from "~/components/molecules/TreeRow";
import type { FileChange, FileDiff, Run } from "~/domain/types";
import { fileTree, totalAdds, totalDels } from "~/domain/views";
import styles from "./ChangesTab.module.css";

type Props = {
  run: Run;
  file: FileChange | undefined;
  /** The selected file's hunks, split out of the patch the daemon served. */
  diff: FileDiff | undefined;
  onSelect: (path: string) => void;
};

/**
 * The patches a run captured, file by file.
 *
 * The counts come from the daemon (it parses the unified diff once, and its numbers are
 * what the file tree shows); the lines come from splitting that same patch text. Both read
 * the same source, so a tree that says +42 −7 cannot disagree with the hunks beside it.
 */
export function ChangesTab({ run, file, diff, onSelect }: Props) {
  if (run.files.length === 0) {
    return (
      <div className={styles.pane}>
        <div className={styles.diff}>
          <div className={styles.diffBody} />
        </div>
      </div>
    );
  }

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
            <span className={styles.rootName}>{run.id}</span>
            <span className={styles.spacer} />
            <span className={styles.rootCount}>{run.files.length}</span>
          </span>
          {tree.map((node) => (
            <TreeRow
              key={node.key}
              node={node}
              selected={node.isFile && node.path === file?.path}
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
          <span className={styles.path}>{file?.path ?? ""}</span>
          <span className={styles.fileAdds}>+{file?.adds ?? 0}</span>
          <span className={styles.fileDels}>−{file?.dels ?? 0}</span>
          <span className={styles.hunks}>unified</span>
        </div>
        <div className={styles.diffBody}>
          {diff === undefined ? null : (
            <>
              <span className={styles.hunkHead}>{diff.hunk}</span>
              {diff.lines.map((line, index) => (
                // Diff lines repeat freely; position identifies them.
                // biome-ignore lint/suspicious/noArrayIndexKey: diff lines repeat, position is identity
                <DiffLineRow key={`diff-${index}`} line={line} />
              ))}
            </>
          )}
        </div>
        <div className={styles.diffFoot}>
          <span className={styles.footNote}>{run.branchNote}</span>
          {!run.committed && run.files.length > 0 ? (
            <EmptyNote>Captured in a worktree — merging is the workflow's own decision.</EmptyNote>
          ) : null}
        </div>
      </div>
    </div>
  );
}
