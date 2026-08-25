import styles from "./StatusBar.module.css";

type Props = { concurrency: number; budget: string };

export function StatusBar({ concurrency, budget }: Props) {
  return (
    <footer className={styles.bar}>
      <span className={styles.ok}>● daemon ok</span>
      <span>pool {concurrency} agents</span>
      <span>default budget {budget}</span>
      <span>journal .weft/runs/ · append-only jsonl</span>
      <span className={styles.spacer} />
      <span>weft v0.9.0</span>
    </footer>
  );
}
