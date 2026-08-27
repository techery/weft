import type {
  ButtonHTMLAttributes,
  HTMLAttributes,
  InputHTMLAttributes,
  ReactNode,
  SelectHTMLAttributes,
  TextareaHTMLAttributes,
} from "react";

export type ButtonVariant = "primary" | "secondary" | "outline" | "ghost";
export type ButtonSize = "xSmall" | "xSmallWide" | "small" | "smallWide" | "medium" | "mediumWide" | "large";

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant: ButtonVariant;
  size: ButtonSize;
  round?: boolean;
};

export function Button({ variant, size, round, className, ...rest }: ButtonProps) {
  return (
    <button
      type="button"
      className={[
        "weft-button",
        `weft-button--${variant}`,
        `weft-button--${size}`,
        round ? "weft-button--round" : "",
        className ?? "",
      ]
        .filter(Boolean)
        .join(" ")}
      {...rest}
    />
  );
}

type ToolbarProps = HTMLAttributes<HTMLDivElement>;

/** A semantic action group with a stable height and vertically centered contents. */
export function Toolbar({ className, ...rest }: ToolbarProps) {
  return (
    <div role="toolbar" className={className ? `weft-toolbar ${className}` : "weft-toolbar"} {...rest} />
  );
}

export function CountBadge({ bg, fg, children }: { bg: string; fg: string; children: string }) {
  return (
    <span className="weft-count-badge" style={{ background: bg, color: fg }}>
      {children}
    </span>
  );
}

export type FactCellVariant = "step" | "queue" | "artifact";
type FactCellProps = {
  label: string;
  value: string;
  color?: string;
  minWidth?: number;
  variant?: FactCellVariant;
  first?: boolean;
};

export function FactCell({ label, value, color, minWidth, variant = "step", first }: FactCellProps) {
  const Tag = variant === "step" ? "li" : "span";
  return (
    <Tag
      className={["weft-fact", `weft-fact--${variant}`, first ? "weft-fact--first" : ""]
        .filter(Boolean)
        .join(" ")}
      style={minWidth ? { minWidth } : undefined}
    >
      <span className="weft-fact__key">{label}</span>
      <span className="weft-fact__value" style={color ? { color } : undefined}>
        {value}
      </span>
    </Tag>
  );
}

export function Hairline() {
  return <span className="weft-hairline" />;
}

export type KickerTone = "accent" | "inline";
export function Kicker({
  tone = "accent",
  large,
  className,
  children,
}: {
  tone?: KickerTone;
  large?: boolean;
  className?: string;
  children: ReactNode;
}) {
  return (
    <span
      className={[
        "weft-kicker",
        tone === "inline" ? "weft-kicker--inline" : "",
        large ? "weft-kicker--large" : "",
        className ?? "",
      ]
        .filter(Boolean)
        .join(" ")}
    >
      {children}
    </span>
  );
}

export function LiveCursor() {
  return (
    <span className="weft-live-cursor" aria-hidden="true">
      ▋
    </span>
  );
}

export function MonoBadge({
  bg,
  fg,
  boxy,
  truncating,
  children,
}: {
  bg: string;
  fg: string;
  boxy?: boolean;
  truncating?: boolean;
  children: string;
}) {
  return (
    <span
      className={[
        "weft-mono-badge",
        boxy ? "weft-mono-badge--boxy" : "",
        truncating ? "weft-mono-badge--truncating" : "",
      ]
        .filter(Boolean)
        .join(" ")}
      style={{ background: bg, color: fg }}
    >
      {children}
    </span>
  );
}

export function PillButton({
  on,
  onClick,
  children,
}: {
  on: boolean;
  onClick: () => void;
  children: string;
}) {
  return (
    <button
      type="button"
      aria-pressed={on}
      onClick={onClick}
      className={on ? "weft-pill-button weft-pill-button--on" : "weft-pill-button"}
    >
      {children}
    </button>
  );
}

export function RangeField(props: Omit<InputHTMLAttributes<HTMLInputElement>, "type">) {
  return <input type="range" className="weft-range" {...props} />;
}
export function ScreenTitle({ children }: { children: string }) {
  return <h1 className="weft-screen-title">{children}</h1>;
}

export function SelectField({ className, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      className={["weft-control", "weft-select", className ?? ""].filter(Boolean).join(" ")}
      {...rest}
    />
  );
}

export function TextArea({ className, ...rest }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <textarea
      className={["weft-control", "weft-textarea", className ?? ""].filter(Boolean).join(" ")}
      {...rest}
    />
  );
}

export function TextField({
  scale = "compact",
  className,
  ...rest
}: Omit<InputHTMLAttributes<HTMLInputElement>, "size"> & { scale?: "compact" | "settings" }) {
  return (
    <input
      type="text"
      className={["weft-control", scale === "settings" ? "weft-control--settings" : "", className ?? ""]
        .filter(Boolean)
        .join(" ")}
      {...rest}
    />
  );
}

export function Toggle({
  on,
  label,
  onToggle,
  className,
}: {
  on: boolean;
  label: string;
  onToggle: () => void;
  className?: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      onClick={onToggle}
      className={["weft-toggle", className ?? ""].filter(Boolean).join(" ")}
    >
      <span
        className="weft-toggle__track"
        style={{
          justifyContent: on ? "flex-end" : "flex-start",
          background: on ? "var(--color-accent)" : "var(--color-neutral-300)",
        }}
      >
        <span className="weft-toggle__knob" />
      </span>
      <span className="weft-toggle__label">{label}</span>
    </button>
  );
}
