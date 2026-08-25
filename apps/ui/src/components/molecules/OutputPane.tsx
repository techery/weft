import { useId, useState } from "react";
import type { JsonSchema } from "~/api/types";
import { LiveCursor } from "~/components/atoms/LiveCursor";
import styles from "./OutputPane.module.css";

type Props = {
  title: string;
  note: string;
  value: unknown;
  schema: JsonSchema | null;
  lines: string[];
  streaming: boolean;
};

type ViewMode = "structured" | "json";

/** A validated value, readable by default and still inspectable as exact formatted JSON. */
export function DataPane({ title, note, value, schema, lines, streaming }: Props) {
  const [mode, setMode] = useState<ViewMode>("structured");
  const structured = value !== undefined;
  const view: ViewMode = structured ? mode : "json";
  const json = jsonLines(value, lines);

  return (
    <section className={styles.pane} aria-label={title}>
      <div className={styles.head}>
        <span className={styles.title}>{title}</span>
        <span className={styles.note}>{note}</span>
        <span className={styles.spacer} />
        {structured ? (
          <fieldset className={styles.switcher} aria-label="Data view">
            <button
              className={styles.switchButton}
              type="button"
              aria-pressed={view === "structured"}
              onClick={() => setMode("structured")}
            >
              Structured
            </button>
            <button
              className={styles.switchButton}
              type="button"
              aria-pressed={view === "json"}
              onClick={() => setMode("json")}
            >
              JSON
            </button>
          </fieldset>
        ) : null}
      </div>

      {view === "structured" ? (
        <div className={styles.structured}>
          <StructuredValue value={value} schema={schema} depth={0} />
        </div>
      ) : (
        <div className={styles.json}>
          {json.map((line, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: formatted JSON is ordered and never reordered
            <span key={`out-${index}`} className={styles.line}>
              {line}
            </span>
          ))}
          {streaming ? <LiveCursor /> : null}
        </div>
      )}
    </section>
  );
}

function StructuredValue({
  value,
  schema,
  depth,
  name,
}: {
  value: unknown;
  schema: JsonSchema | null;
  depth: number;
  name?: string;
}) {
  const resolved = resolveSchema(schema, value);

  if (depth >= 8) return <span className={styles.scalar}>{compact(value)}</span>;

  if (Array.isArray(value)) {
    if (value.length === 0) return <span className={styles.empty}>No items</span>;
    return (
      <ol className={styles.array}>
        {value.map((item, index) => (
          <StructuredArrayItem
            // biome-ignore lint/suspicious/noArrayIndexKey: array position is part of the output value
            key={`item-${index}`}
            value={item}
            schema={resolved?.items ?? null}
            depth={depth}
            index={index}
            name={name}
          />
        ))}
      </ol>
    );
  }

  if (isRecord(value)) {
    const entries = orderedEntries(value, resolved);
    if (entries.length === 0) return <span className={styles.empty}>No fields</span>;
    return (
      <dl className={depth === 0 ? styles.fields : styles.nestedFields}>
        {entries.map(([key, item, itemSchema]) => (
          <StructuredField key={key} name={key} value={item} schema={itemSchema} depth={depth} />
        ))}
      </dl>
    );
  }

  if (value === null) return <span className={styles.nullValue}>null</span>;
  if (typeof value === "boolean") {
    return (
      <span className={styles.boolean} data-value={String(value)}>
        <span className={styles.booleanDot} />
        {String(value)}
      </span>
    );
  }
  if (isChoice(resolved, value)) return <span className={styles.choice}>{String(value)}</span>;
  return <span className={styles.scalar}>{String(value)}</span>;
}

function StructuredField({
  name,
  value,
  schema,
  depth,
}: {
  name: string;
  value: unknown;
  schema: JsonSchema | null;
  depth: number;
}) {
  const composite = isComposite(value);
  const [expanded, setExpanded] = useState(true);
  const contentId = useId();
  const label = schema?.title ?? humanize(name);
  const type = schemaType(schema);

  return (
    <div className={`${styles.field} ${composite ? styles.fieldComposite : ""}`}>
      <dt className={`${styles.fieldKey} ${composite ? styles.compositeKey : ""}`}>
        {composite ? (
          <button
            className={styles.collapseButton}
            type="button"
            aria-label={`${expanded ? "Collapse" : "Expand"} ${label}`}
            aria-expanded={expanded}
            aria-controls={contentId}
            onClick={() => setExpanded((current) => !current)}
          >
            <span className={styles.chevron} aria-hidden="true" />
            <span className={styles.fieldLabel}>{label}</span>
            {type ? <span className={styles.fieldType}>{type}</span> : null}
          </button>
        ) : (
          <>
            <span className={styles.fieldLabel}>{label}</span>
            {type ? <span className={styles.fieldType}>{type}</span> : null}
          </>
        )}
      </dt>
      {!composite || expanded ? (
        <dd
          id={composite ? contentId : undefined}
          className={`${styles.fieldValue} ${composite ? styles.compositeValue : ""}`}
        >
          <StructuredValue value={value} schema={schema} depth={depth + 1} name={name} />
          {schema?.description ? <span className={styles.description}>{schema.description}</span> : null}
        </dd>
      ) : null}
    </div>
  );
}

function StructuredArrayItem({
  value,
  schema,
  depth,
  index,
  name,
}: {
  value: unknown;
  schema: JsonSchema | null;
  depth: number;
  index: number;
  name?: string;
}) {
  const composite = isComposite(value);
  const [expanded, setExpanded] = useState(true);
  const contentId = useId();
  const label = `${schema?.title ?? singularize(name ?? "item")} ${index + 1}`;

  if (!composite) {
    return (
      <li className={styles.arrayItem}>
        <span className={styles.index}>{index + 1}</span>
        <div className={styles.arrayValue}>
          <StructuredValue value={value} schema={schema} depth={depth + 1} />
        </div>
      </li>
    );
  }

  return (
    <li className={styles.recordItem}>
      <button
        className={styles.recordHead}
        type="button"
        aria-label={`${expanded ? "Collapse" : "Expand"} ${label}`}
        aria-expanded={expanded}
        aria-controls={contentId}
        onClick={() => setExpanded((current) => !current)}
      >
        <span className={styles.chevron} aria-hidden="true" />
        <span className={styles.index} aria-hidden="true">
          {index + 1}
        </span>
        <span className={styles.recordLabel}>{label}</span>
      </button>
      {expanded ? (
        <div id={contentId} className={styles.recordValue}>
          <StructuredValue value={value} schema={schema} depth={depth + 1} />
        </div>
      ) : null}
    </li>
  );
}

function orderedEntries(
  value: Record<string, unknown>,
  schema: JsonSchema | null,
): Array<[string, unknown, JsonSchema | null]> {
  const properties = schema?.properties ?? {};
  const order = [...Object.keys(properties), ...Object.keys(value).filter((key) => !(key in properties))];
  return order.filter((key) => key in value).map((key) => [key, value[key], properties[key] ?? null]);
}

function resolveSchema(schema: JsonSchema | null, value: unknown): JsonSchema | null {
  if (!schema) return null;
  const variants = schema.oneOf ?? schema.anyOf;
  return variants?.find((variant) => schemaMatches(variant, value)) ?? variants?.[0] ?? schema;
}

function schemaMatches(schema: JsonSchema, value: unknown): boolean {
  if (schema.const !== undefined) return Object.is(schema.const, value);
  if (schema.enum !== undefined) return schema.enum.some((choice) => Object.is(choice, value));
  const types = Array.isArray(schema.type) ? schema.type : schema.type ? [schema.type] : [];
  if (types.length === 0) return true;
  if (value === null) return types.includes("null");
  if (Array.isArray(value)) return types.includes("array");
  if (typeof value === "number" && Number.isInteger(value) && types.includes("integer")) return true;
  return types.includes(typeof value);
}

function schemaType(schema: JsonSchema | null): string {
  if (!schema?.type) return "";
  return Array.isArray(schema.type) ? schema.type.filter((type) => type !== "null").join(" / ") : schema.type;
}

function isChoice(schema: JsonSchema | null, value: unknown): boolean {
  return schema?.const !== undefined || schema?.enum?.some((choice) => Object.is(choice, value)) === true;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isComposite(value: unknown): boolean {
  return isRecord(value) || Array.isArray(value);
}

function humanize(key: string): string {
  const words = key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .trim();
  return words === "" ? key : words.charAt(0).toUpperCase() + words.slice(1);
}

function singularize(value: string): string {
  const label = humanize(value);
  return label.endsWith("s") && label.length > 1 ? label.slice(0, -1) : label;
}

function compact(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

function jsonLines(value: unknown, fallback: string[]): string[] {
  if (value === undefined) return fallback;
  try {
    return (JSON.stringify(value, null, 2) ?? String(value)).split("\n");
  } catch {
    return fallback.length > 0 ? fallback : [String(value)];
  }
}
