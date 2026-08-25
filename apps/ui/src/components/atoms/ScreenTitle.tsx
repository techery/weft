import styles from "./ScreenTitle.module.css";

export function ScreenTitle({ children }: { children: string }) {
  return <h1 className={styles.title}>{children}</h1>;
}
