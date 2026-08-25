import styles from "./Toggle.module.css";

type Props = {
  on: boolean;
  label: string;
  onToggle: () => void;
  /** Extra top padding, matching the launcher's flag rows. */
  className?: string;
};

export function Toggle({ on, label, onToggle, className }: Props) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      onClick={onToggle}
      className={className ? `${styles.button} ${className}` : styles.button}
    >
      <span
        className={styles.track}
        style={{
          justifyContent: on ? "flex-end" : "flex-start",
          background: on ? "var(--color-accent)" : "var(--color-neutral-300)",
        }}
      >
        <span className={styles.knob} />
      </span>
      <span className={styles.label}>{label}</span>
    </button>
  );
}
