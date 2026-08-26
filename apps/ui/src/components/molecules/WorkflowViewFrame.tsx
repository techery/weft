import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "~/api/client";
import type { UiPresentation } from "~/api/types";
import styles from "./WorkflowViewFrame.module.css";

type Props = {
  runId: string;
  presentation: UiPresentation;
  onCandidate?: (answer: unknown) => void;
};

type FrameStatus = "loading" | "ready" | "error" | "disabled";

const MAX_MESSAGE_BYTES = 64 * 1024;
const MIN_HEIGHT = 80;
const MAX_HEIGHT = 720;
const READY_TIMEOUT_MS = 5_000;

function jsonSize(value: unknown): number | undefined {
  try {
    const encoded = JSON.stringify(value);
    return encoded === undefined ? undefined : encoded.length;
  } catch {
    return undefined;
  }
}

/** Capability-minimal host for one journaled workflow presentation. */
export function WorkflowViewFrame({ runId, presentation, onCandidate }: Props) {
  const frame = useRef<HTMLIFrameElement>(null);
  const channel = useRef<MessageChannel | null>(null);
  const generation = useRef(0);
  const readyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastResize = useRef(0);
  const [status, setStatus] = useState<FrameStatus>("loading");
  const [height, setHeight] = useState(180);
  const [message, setMessage] = useState("");

  useEffect(() => {
    return () => {
      if (readyTimer.current) clearTimeout(readyTimer.current);
      channel.current?.port1.close();
      channel.current?.port2.close();
    };
  }, []);

  const initialize = useCallback(async () => {
    const target = frame.current?.contentWindow;
    if (!target || status === "disabled") return;
    try {
      const props =
        "inline" in presentation.props
          ? presentation.props.inline
          : await api.blobJson(presentation.props.ref.$blob);
      const bytes = jsonSize(props);
      if (bytes === undefined) throw new Error("presentation props must be JSON serializable");
      if (bytes > MAX_MESSAGE_BYTES * 8) throw new Error("presentation props are too large to render");
      const next = new MessageChannel();
      channel.current?.port1.close();
      channel.current?.port2.close();
      channel.current = next;
      const mounted = String(++generation.current);
      if (readyTimer.current) clearTimeout(readyTimer.current);
      readyTimer.current = setTimeout(() => {
        setStatus("error");
        setMessage("custom view did not become ready in time");
        next.port1.close();
      }, READY_TIMEOUT_MS);
      next.port1.onmessage = (event: MessageEvent<unknown>) => {
        const value = event.data;
        if (typeof value !== "object" || value === null) return;
        const data = value as Record<string, unknown>;
        if (data.presentationId !== presentation.id || data.generation !== mounted) return;
        const size = jsonSize(data);
        if (size === undefined || size > MAX_MESSAGE_BYTES) return;
        if (data.type === "ready") {
          if (readyTimer.current) clearTimeout(readyTimer.current);
          readyTimer.current = null;
          setStatus("ready");
        } else if (data.type === "resize" && typeof data.height === "number") {
          const now = performance.now();
          if (now - lastResize.current < 50) return;
          lastResize.current = now;
          setHeight(Math.max(MIN_HEIGHT, Math.min(MAX_HEIGHT, Math.ceil(data.height))));
        } else if (data.type === "candidate" && presentation.mode === "input") {
          if (jsonSize(data.answer) === undefined) return;
          onCandidate?.(data.answer);
        } else if (data.type === "error" && typeof data.message === "string") {
          if (readyTimer.current) clearTimeout(readyTimer.current);
          readyTimer.current = null;
          setStatus("error");
          setMessage(data.message.slice(0, 300));
        }
      };
      next.port1.start();
      target.postMessage(
        {
          type: "weft.ui.init",
          protocol: 1,
          presentationId: presentation.id,
          generation: mounted,
          props,
        },
        "*",
        [next.port2],
      );
    } catch (error) {
      if (readyTimer.current) clearTimeout(readyTimer.current);
      readyTimer.current = null;
      setStatus("error");
      setMessage(error instanceof Error ? error.message : String(error));
    }
  }, [onCandidate, presentation, status]);

  if (status === "disabled") {
    return (
      <div className={styles.fallback}>
        <span>Custom view disabled. The standard data view remains available.</span>
        <button type="button" onClick={() => setStatus("loading")}>
          Enable custom view
        </button>
      </div>
    );
  }

  return (
    <section className={styles.shell} aria-label={`Workflow-provided view: ${presentation.asset.id}`}>
      <div className={styles.header}>
        <span>Workflow-provided view</span>
        <span>
          {presentation.asset.id} · revision {presentation.asset.revision}
        </span>
        <button type="button" onClick={() => setStatus("disabled")}>
          Disable
        </button>
      </div>
      {status === "error" ? <div className={styles.error}>Custom view unavailable: {message}</div> : null}
      <iframe
        ref={frame}
        className={styles.frame}
        title={`Workflow view ${presentation.asset.id}`}
        src={api.presentationFrameUrl(runId, presentation.id)}
        sandbox="allow-scripts"
        referrerPolicy="no-referrer"
        style={{ height }}
        onLoad={() => void initialize()}
      />
      {status === "loading" ? <span className={styles.loading}>Loading custom view…</span> : null}
    </section>
  );
}
