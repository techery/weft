/**
 * A run's journal as it is written.
 *
 * The daemon streams every record over SSE, and an `EventSource` reconnect carries its
 * cursor as `Last-Event-ID` — so a dropped connection resumes rather than replaying the
 * whole journal into the page. That is the daemon's contract; this is just the subscriber.
 *
 * Two things the UI gets only from here: completion-only transcript references that may be
 * absent from an older projection, and a signal to refetch folded state. A step that
 * finishes appends a record; that record is the cue, so live views need no polling.
 */
import type { JournalRecord } from "./types";

export interface JournalStream {
  close(): void;
}

/**
 * Subscribe to `runId`'s journal. `onRecord` fires per record in order; `onError` fires
 * when the stream drops (the browser retries on its own afterwards).
 */
export function streamJournal(
  runId: string,
  onRecord: (record: JournalRecord) => void,
  onError?: (event: Event) => void,
): JournalStream {
  const source = new EventSource(`/api/runs/${encodeURIComponent(runId)}/events`);
  source.onmessage = (event) => {
    try {
      onRecord(JSON.parse(event.data) as JournalRecord);
    } catch {
      // A malformed frame is not worth tearing the stream down for: the next record is
      // still coming, and the fold behind this is authoritative anyway.
    }
  };
  if (onError) source.onerror = onError;
  return {
    close: () => source.close(),
  };
}
