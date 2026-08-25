import { Hairline } from "~/components/atoms/Hairline";
import { Kicker } from "~/components/atoms/Kicker";
import styles from "./QueueGroupHeader.module.css";

type Props = { label: string; note: string; color: string };

export function QueueGroupHeader({ label, note, color }: Props) {
  return (
    <div className={styles.row}>
      <Kicker large>
        <span style={{ color }}>{label}</span>
      </Kicker>
      <Hairline />
      <span className={styles.note}>{note}</span>
    </div>
  );
}
