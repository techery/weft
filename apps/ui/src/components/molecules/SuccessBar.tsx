import { successBarColor } from "~/domain/palette";
import styles from "./SuccessBar.module.css";

/** `null` is a workflow nothing has scored yet — an empty track, not a full one. */
export function SuccessBar({ ok, className }: { ok: number | null; className?: string }) {
  return (
    <span className={className ? `${styles.wrap} ${className}` : styles.wrap}>
      <span className={styles.track}>
        {ok === null ? null : (
          <span className={styles.fill} style={{ width: `${ok}%`, background: successBarColor(ok) }} />
        )}
      </span>
      <span className={styles.value}>{ok === null ? "—" : `${ok}%`}</span>
    </span>
  );
}
