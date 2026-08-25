import { KIND_BG, KIND_FG } from "~/domain/palette";
import type { ShapeCell } from "~/domain/types";
import styles from "./ShapeStrip.module.css";

/** T · A · H · ∥ — the run's shape at a glance. */
export function ShapeStrip({ shape, className }: { shape: ShapeCell[]; className?: string }) {
  return (
    <span className={className ? `${styles.strip} ${className}` : styles.strip}>
      {shape.map((cell, index) => (
        <span
          // biome-ignore lint/suspicious/noArrayIndexKey: a shape repeats glyphs, so only position identifies a cell
          key={`${cell.kind}-${cell.glyph}-${index}`}
          className={styles.cell}
          style={{ background: KIND_BG[cell.kind], color: KIND_FG[cell.kind] }}
        >
          {cell.glyph}
        </span>
      ))}
    </span>
  );
}
