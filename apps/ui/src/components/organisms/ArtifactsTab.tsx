import { Button } from "~/components/atoms/Button";
import { FactCell } from "~/components/atoms/FactCell";
import { ArtifactRow } from "~/components/molecules/ArtifactRow";
import type { Artifact, Run } from "~/domain/types";
import styles from "./ArtifactsTab.module.css";

type Props = {
  run: Run;
  artifact: Artifact;
  onSelect: (name: string) => void;
};

/** Everything the run wrote, with the selected file rendered in place. */
export function ArtifactsTab({ run, artifact, onSelect }: Props) {
  const view = artifact.view;
  const meta = [
    { k: "produced by", v: artifact.step },
    { k: "type", v: artifact.type },
    { k: "size", v: artifact.size },
    { k: "journaled", v: artifact.ago },
  ];

  return (
    <div className={styles.pane}>
      <div className={styles.list}>
        <span className={styles.listTitle}>Artifacts · {run.artifacts.length}</span>
        {run.artifacts.map((entry) => (
          <ArtifactRow
            key={entry.name}
            artifact={entry}
            selected={entry.name === artifact.name}
            onSelect={() => onSelect(entry.name)}
          />
        ))}
      </div>

      <div className={styles.viewer}>
        <div className={styles.head}>
          <span className={styles.identity}>
            <span className={styles.name}>{artifact.name}</span>
            <span className={styles.path}>
              .weft/runs/{run.id}/artifacts/{artifact.name}
            </span>
          </span>
          <Button variant="ghost" size="small">
            Raw
          </Button>
          <Button variant="secondary" size="small">
            Diff vs previous
          </Button>
          <Button variant="primary" size="smallWide">
            Download
          </Button>
        </div>

        <div className={styles.body}>
          <div className={styles.content}>
            <h2 className={styles.title}>{view.kind === "md" ? view.title : artifact.name}</h2>
            {view.kind === "md"
              ? view.paras.map((para) => (
                  <span key={para} className={styles.para}>
                    {para}
                  </span>
                ))
              : null}
            {view.kind === "code" ? (
              <span className={styles.code}>
                {view.lines.map((line, index) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: an artifact's line order is fixed once it is written
                  <span key={`line-${index}`} className={styles.codeLine}>
                    {line}
                  </span>
                ))}
              </span>
            ) : null}
            {view.kind === "md" && view.rows.length > 0 ? (
              <span className={styles.rows}>
                {view.rows.map((row) => (
                  <span key={row.k} className={styles.row}>
                    <span className={styles.rowKey}>{row.k}</span>
                    <span className={styles.rowText}>{row.t}</span>
                    <span className={styles.rowValue}>{row.v}</span>
                  </span>
                ))}
              </span>
            ) : null}
          </div>
        </div>

        <div className={styles.foot}>
          {meta.map((entry, index) => (
            <FactCell key={entry.k} variant="artifact" first={index === 0} label={entry.k} value={entry.v} />
          ))}
        </div>
      </div>
    </div>
  );
}
