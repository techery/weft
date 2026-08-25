import { PILL_BG, PILL_FG } from "~/domain/palette";
import type { PillKind } from "~/domain/types";
import styles from "./StatusPill.module.css";

/** The uppercase status pill beside a run title or a step title. */
export function StatusPill({ kind, children }: { kind: PillKind; children: string }) {
  return (
    <span className={styles.pill} style={{ background: PILL_BG[kind], color: PILL_FG[kind] }}>
      {children}
    </span>
  );
}
