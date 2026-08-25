import { useQuery } from "@tanstack/react-query";
import { api } from "~/api/client";
import { LiveCursor } from "~/components/atoms/LiveCursor";
import type { AgentTranscript } from "~/domain/types";
import styles from "./AgentTranscriptPane.module.css";

type Props = {
  transcript: AgentTranscript;
  running: boolean;
};

type TranscriptEvent = {
  key: string;
  kind: string;
  meta: string;
  text: string;
};

/** A single agent step's recorded coding session. The step body owns all scrolling. */
export function AgentTranscriptPane({ transcript, running }: Props) {
  const log = useQuery({
    queryKey: ["agent-transcript", transcript.transcriptRef],
    queryFn: () => api.blobText(transcript.transcriptRef),
    enabled: transcript.transcriptRef !== "",
    staleTime: Number.POSITIVE_INFINITY,
  });

  return (
    <section className={styles.pane} aria-label="Agent log">
      <div className={styles.head}>
        <span className={styles.title}>coding session</span>
        <span className={styles.note}>{running ? "recording" : "recorded transcript"}</span>
        <span className={styles.spacer} />
        {transcript.transcriptSize > 0 ? (
          <span className={styles.size}>{formatBytes(transcript.transcriptSize)}</span>
        ) : null}
        {transcript.sessionId ? (
          <span className={styles.session} title={transcript.sessionId}>
            session {transcript.sessionId}
          </span>
        ) : null}
      </div>

      <div className={styles.body} aria-live="polite">
        {transcript.transcriptRef === "" ? (
          <EmptyTranscript running={running} />
        ) : log.isPending ? (
          <span className={styles.empty}>reading recorded transcript…</span>
        ) : log.error ? (
          <span className={styles.error}>
            {log.error instanceof Error ? log.error.message : "The recorded transcript could not be read."}
          </span>
        ) : (
          <TranscriptEvents text={log.data ?? ""} />
        )}
        {running ? (
          <span className={styles.live}>
            <LiveCursor /> recording
          </span>
        ) : null}
      </div>
    </section>
  );
}

function EmptyTranscript({ running }: { running: boolean }) {
  return (
    <span className={styles.empty}>
      {running
        ? "This coding session is still running. Its transcript is journaled when the step completes."
        : "This step has no journaled transcript. Older runs and provider failures may only retain lifecycle events."}
    </span>
  );
}

function TranscriptEvents({ text }: { text: string }) {
  const events = parseTranscript(text);
  if (events.length === 0) return <span className={styles.empty}>The recorded transcript is empty.</span>;
  return (
    <ol className={styles.events} aria-label="Agent transcript">
      {events.map((event) => (
        <TranscriptEventRow key={event.key} event={event} />
      ))}
    </ol>
  );
}

function TranscriptEventRow({ event }: { event: TranscriptEvent }) {
  return (
    <li className={styles.event} data-kind={event.kind} data-status={statusOf(event.meta)}>
      <div className={styles.eventKey}>
        <span className={styles.kind}>{humanize(event.kind)}</span>
        {event.meta ? <span className={styles.eventMeta}>{event.meta}</span> : null}
      </div>
      <div className={styles.eventValue}>
        <EventContent event={event} />
      </div>
    </li>
  );
}

function EventContent({ event }: { event: TranscriptEvent }) {
  const payload = parseJson(event.text);
  if (payload !== undefined) return <PayloadValue value={payload} depth={0} />;
  if (event.kind === "exec" || event.kind === "mcp" || event.kind === "tool") {
    return <code className={styles.command}>{event.text}</code>;
  }
  if (event.kind === "files") {
    return (
      <span className={styles.fileActions}>
        {event.text.split(/,\s*/).map((file) => (
          <code key={file} className={styles.fileAction} title={file}>
            {compactFileAction(file)}
          </code>
        ))}
      </span>
    );
  }
  return <span className={styles.prose}>{event.text}</span>;
}

function PayloadValue({ value, depth }: { value: unknown; depth: number }) {
  if (Array.isArray(value)) {
    if (value.length === 0) return <span className={styles.nullValue}>none</span>;
    if (value.every(isScalar)) {
      return (
        <span className={styles.values}>
          {value.map((item) => (
            <code key={String(item)} className={styles.valueChip}>
              {String(item)}
            </code>
          ))}
        </span>
      );
    }
    return <code className={styles.command}>{JSON.stringify(value, null, 2)}</code>;
  }
  if (isRecord(value)) {
    if (depth >= 2) return <code className={styles.command}>{JSON.stringify(value, null, 2)}</code>;
    return (
      <dl className={styles.payload}>
        {Object.entries(value).map(([key, item]) => (
          <div className={styles.payloadField} key={key}>
            <dt className={styles.payloadKey}>{humanize(key)}</dt>
            <dd className={styles.payloadValue}>
              <PayloadValue value={item} depth={depth + 1} />
            </dd>
          </div>
        ))}
      </dl>
    );
  }
  if (value === null || value === "") return <span className={styles.nullValue}>none</span>;
  if (typeof value === "boolean") {
    return (
      <span className={styles.boolean} data-value={String(value)}>
        {String(value)}
      </span>
    );
  }
  return <span className={styles.prose}>{String(value)}</span>;
}

function parseTranscript(text: string): TranscriptEvent[] {
  const events: TranscriptEvent[] = [];
  let offset = 0;
  for (const line of text.split("\n")) {
    const match = /^([a-z][\w-]*)(?:\s*\(([^)]*)\))?\s*:(.*)$/i.exec(line);
    if (match) {
      events.push({
        key: `${offset}:${match[1]}`,
        kind: (match[1] ?? "log").toLowerCase(),
        meta: match[2]?.trim() ?? "",
        text: (match[3] ?? "").trimStart(),
      });
    } else {
      const previous = events.at(-1);
      if (previous) previous.text = `${previous.text}\n${line}`.trimEnd();
      else if (line.trim() !== "") events.push({ key: `${offset}:log`, kind: "log", meta: "", text: line });
    }
    offset += line.length + 1;
  }
  return events;
}

function parseJson(text: string): unknown | undefined {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return undefined;
  try {
    return JSON.parse(trimmed);
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isScalar(value: unknown): boolean {
  return value === null || typeof value !== "object";
}

function humanize(value: string): string {
  return value.replace(/[-_]+/g, " ").replace(/^./, (letter) => letter.toUpperCase());
}

function statusOf(meta: string): "ok" | "error" | undefined {
  if (/^(?:exit 0|completed|success)$/i.test(meta)) return "ok";
  if (/^(?:exit [1-9]\d*|failed|error)$/i.test(meta)) return "error";
  return undefined;
}

function compactFileAction(value: string): string {
  const sourceIndex = value.lastIndexOf("/src/");
  return sourceIndex === -1
    ? value
    : `${value.slice(0, value.indexOf(" ") + 1)}src/${value.slice(sourceIndex + 5)}`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1_000) return `${bytes} B`;
  if (bytes < 1_000_000) return `${(bytes / 1_000).toFixed(1)} kB`;
  return `${(bytes / 1_000_000).toFixed(1)} MB`;
}
