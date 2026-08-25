import { CountBadge } from "~/components/atoms/CountBadge";
import type { RunTab, RunTabDef } from "~/domain/views";
import styles from "./RunTabsBar.module.css";

type Props = { tabs: RunTabDef[]; active: RunTab; onSelect: (tab: RunTab) => void };

export function RunTabsBar({ tabs, active, onSelect }: Props) {
  return (
    <div className={styles.bar} role="tablist">
      {tabs.map((tab) => {
        const on = tab.key === active;
        const showBadge = tab.badge !== "";
        return (
          <button
            key={tab.key}
            type="button"
            role="tab"
            aria-selected={on}
            className={on ? `${styles.tab} ${styles.on}` : styles.tab}
            onClick={() => onSelect(tab.key)}
          >
            {tab.label}
            {showBadge ? (
              <CountBadge
                bg={
                  tab.key === "steps"
                    ? "var(--color-accent)"
                    : on
                      ? "var(--color-accent-200)"
                      : "var(--color-neutral-200)"
                }
                fg={
                  tab.key === "steps"
                    ? "var(--color-surface)"
                    : on
                      ? "var(--color-accent-800)"
                      : "var(--color-neutral-600)"
                }
              >
                {tab.badge}
              </CountBadge>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}
