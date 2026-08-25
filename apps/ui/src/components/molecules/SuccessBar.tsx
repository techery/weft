import { successBarColor } from "~/domain/palette";
import styles from "./SuccessBar.module.css";

export function SuccessBar({ ok, className }: { ok: number; className?: string }) {
  return (
    <span className={className ? `${styles.wrap} ${className}` : styles.wrap}>
      <span className={styles.track}>
        <span className={styles.fill} style={{ width: `${ok}%`, background: successBarColor(ok) }} />
      </span>
      <span className={styles.value}>{ok}%</span>
    </span>
  );
}
