import { useQuery } from "@tanstack/react-query";
import { api } from "~/api/client";
import { Button } from "~/components/atoms/Button";
import { FactCell } from "~/components/atoms/FactCell";
import { ArtifactRow } from "~/components/molecules/ArtifactRow";
import { EmptyNote } from "~/components/molecules/EmptyNote";
import type { Artifact, Run } from "~/domain/types";
import styles from "./ArtifactsTab.module.css";

type Props = {
  run: Run;
  artifact: Artifact | undefined;
  onSelect: (name: string) => void;
};

/**
 * Everything the run wrote, with the selected one rendered in place.
 *
 * The inventory carries refs, not bytes — a blob is content-addressed and can be large, so
 * it is fetched only for the file actually being looked at, and cached forever afterwards
 * because its hash IS its identity.
 */
export function ArtifactsTab({ run, artifact, onSelect }: Props) {
  const body = useQuery({
    queryKey: ["blob", artifact?.ref ?? ""],
    queryFn: () => api.blobText(artifact?.ref ?? ""),
    enabled: artifact?.available,
    staleTime: Number.POSITIVE_INFINITY,
  });

  if (run.artifacts.length === 0) {
    return (
      <div className={styles.pane}>
        <div className={styles.body}>
          <div className={styles.content}>
            <EmptyNote>This run has not written any artifacts.</EmptyNote>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className={styles.pane}>
      <div className={styles.list}>
        <span className={styles.listTitle}>Artifacts · {run.artifacts.length}</span>
        {run.artifacts.map((entry) => (
          <ArtifactRow
            key={entry.name}
            artifact={entry}
            selected={entry.name === artifact?.name}
            onSelect={() => onSelect(entry.name)}
          />
        ))}
      </div>

      {artifact ? (
        <div className={styles.viewer}>
          <div className={styles.head}>
            <span className={styles.identity}>
              <span className={styles.name}>{artifact.name}</span>
              <span className={styles.path}>{artifact.ref.slice(0, 16)}…</span>
            </span>
            <Button
              variant="secondary"
              size="small"
              disabled={!artifact.available}
              onClick={() => window.open(api.blobUrl(artifact.ref, "text"), "_blank")}
            >
              Raw
            </Button>
          </div>

          <div className={styles.body}>
            <div className={styles.content}>
              {!artifact.available ? (
                <EmptyNote>The journal still names this blob, but the store no longer holds it.</EmptyNote>
              ) : body.isPending ? (
                <span className={styles.para}>loading…</span>
              ) : body.isError ? (
                <EmptyNote>{(body.error as Error).message}</EmptyNote>
              ) : (
                <span className={styles.code}>
                  {(body.data ?? "").split("\n").map((line, index) => (
                    // A file's own line order is its identity.
                    // biome-ignore lint/suspicious/noArrayIndexKey: file line order is identity
                    <span key={`line-${index}`} className={styles.codeLine}>
                      {line}
                    </span>
                  ))}
                </span>
              )}
            </div>
          </div>

          <div className={styles.foot}>
            {[
              { k: "produced by", v: artifact.step || "—" },
              { k: "type", v: artifact.type },
              ...(artifact.size ? [{ k: "size", v: artifact.size }] : []),
              ...(artifact.ago ? [{ k: "journaled", v: artifact.ago }] : []),
            ].map((entry, index) => (
              <FactCell
                key={entry.k}
                variant="artifact"
                first={index === 0}
                label={entry.k}
                value={entry.v}
              />
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}
