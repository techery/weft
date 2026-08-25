import { Link } from "@tanstack/react-router";
import { CountBadge } from "~/components/atoms/CountBadge";
import styles from "./NavTab.module.css";

type Props = {
  to: string;
  label: string;
  badge?: string;
  active: boolean;
};

export function NavTab({ to, label, badge, active }: Props) {
  return (
    <Link to={to} className={active ? `${styles.tab} ${styles.on}` : styles.tab}>
      {label}
      {badge ? (
        <CountBadge
          bg={active ? "var(--color-accent)" : "var(--color-neutral-200)"}
          fg={active ? "var(--color-surface)" : "var(--color-neutral-600)"}
        >
          {badge}
        </CountBadge>
      ) : null}
    </Link>
  );
}
