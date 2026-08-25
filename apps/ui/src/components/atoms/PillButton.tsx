import styles from "./PillButton.module.css";

type Props = {
  on: boolean;
  onClick: () => void;
  children: string;
};

export function PillButton({ on, onClick, children }: Props) {
  return (
    <button
      type="button"
      aria-pressed={on}
      onClick={onClick}
      className={on ? `${styles.pill} ${styles.on}` : styles.pill}
    >
      {children}
    </button>
  );
}
