import styles from "./ProviderRow.module.css";

type Props = { id: string; model: string; status: string };

export function ProviderRow({ id, model, status }: Props) {
  return (
    <div className={styles.row}>
      <span className={styles.id}>{id}</span>
      <span className={styles.model}>{model}</span>
      <span className={styles.status}>{status}</span>
    </div>
  );
}
