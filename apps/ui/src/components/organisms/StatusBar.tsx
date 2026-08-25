import { useMeta } from "~/api/queries";
import { statusBarFacts } from "~/domain/adapt";
import styles from "./StatusBar.module.css";

export function StatusBar() {
  const meta = useMeta();
  const facts = statusBarFacts(meta.data);

  return (
    <footer className={styles.bar}>
      {/* "ok" is a claim about the daemon, so it waits until /api/meta has made it. */}
      <span className={meta.isSuccess ? styles.ok : undefined}>
        ● daemon {meta.isSuccess ? "ok" : meta.isError ? "error" : "…"}
      </span>
      {meta.error ? (
        // Every other fact on this row comes from meta, so a failed meta has nothing to
        // put there and the daemon's own message is what belongs in the space.
        <span title={meta.error.message}>{meta.error.message}</span>
      ) : (
        <>
          <span>pool {facts.pool}</span>
          <span>default {facts.budget}</span>
          <span>journal .weft/runs/ · append-only jsonl</span>
        </>
      )}
      <span className={styles.spacer} />
      <span>{facts.version}</span>
    </footer>
  );
}
