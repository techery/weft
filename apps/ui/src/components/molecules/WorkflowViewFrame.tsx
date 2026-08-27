import { UI_PROTOCOL_MAX_PROPS_BYTES } from "@techery/weft-sdk/ui";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { api } from "~/api/client";
import type { UiPresentation } from "~/api/types";
import styles from "./WorkflowViewFrame.module.css";

type Props = {
  runId: string;
  presentation: UiPresentation;
  onCandidate?: (answer: unknown) => void;
};

type FrameStatus = "loading" | "ready" | "error" | "disabled";

const MAX_FRAME_MESSAGE_BYTES = 64 * 1024;
const MIN_HEIGHT = 80;
const READY_TIMEOUT_MS = 5_000;

function jsonByteSize(value: unknown): number | undefined {
  try {
    const encoded = JSON.stringify(value);
    return encoded === undefined ? undefined : new TextEncoder().encode(encoded).byteLength;
  } catch {
    return undefined;
  }
}

/** Capability-minimal host for one journaled workflow presentation. */
export function WorkflowViewFrame({ runId, presentation, onCandidate }: Props) {
  const frame = useRef<HTMLIFrameElement>(null);
  const channel = useRef<MessageChannel | null>(null);
  const initialization = useRef(0);
  const generation = useRef(0);
  const readyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [status, setStatus] = useState<FrameStatus>("loading");
  const [height, setHeight] = useState(180);
  const [message, setMessage] = useState("");
  const identity = JSON.stringify([
    runId,
    presentation.id,
    presentation.asset.bundleRef.$blob,
    presentation.props.hash,
  ]);
  const activeIdentity = useRef(identity);

  useLayoutEffect(() => {
    if (activeIdentity.current === identity) return;
    activeIdentity.current = identity;
    initialization.current += 1;
    if (readyTimer.current) clearTimeout(readyTimer.current);
    readyTimer.current = null;
    channel.current?.port1.close();
    channel.current?.port2.close();
    channel.current = null;
    setStatus("loading");
    setMessage("");
    setHeight(180);
  }, [identity]);

  useEffect(() => {
    return () => {
      initialization.current += 1;
      if (readyTimer.current) clearTimeout(readyTimer.current);
      channel.current?.port1.close();
      channel.current?.port2.close();
    };
  }, []);

  const initialize = useCallback(async () => {
    const target = frame.current?.contentWindow;
    if (!target || status === "disabled") return;
    const attempt = ++initialization.current;
    const currentIdentity = identity;
    const isCurrent = () =>
      initialization.current === attempt &&
      activeIdentity.current === currentIdentity &&
      frame.current?.contentWindow === target;
    try {
      const props =
        "inline" in presentation.props
          ? presentation.props.inline
          : await api.blobJson(presentation.props.ref.$blob);
      if (!isCurrent()) return;
      const bytes = jsonByteSize(props);
      if (bytes === undefined) throw new Error("presentation props must be JSON serializable");
      if (bytes > UI_PROTOCOL_MAX_PROPS_BYTES) throw new Error("presentation props are too large to render");
      const next = new MessageChannel();
      channel.current?.port1.close();
      channel.current?.port2.close();
      channel.current = next;
      const mounted = String(++generation.current);
      if (readyTimer.current) clearTimeout(readyTimer.current);
      readyTimer.current = setTimeout(() => {
        if (!isCurrent()) return;
        setStatus("error");
        setMessage("custom view did not become ready in time");
        next.port1.close();
      }, READY_TIMEOUT_MS);
      next.port1.onmessage = (event: MessageEvent<unknown>) => {
        const value = event.data;
        if (typeof value !== "object" || value === null) return;
        const data = value as Record<string, unknown>;
        if (data.presentationId !== presentation.id || data.generation !== mounted) return;
        const size = jsonByteSize(data);
        if (size === undefined || size > MAX_FRAME_MESSAGE_BYTES) return;
        if (data.type === "ready") {
          if (readyTimer.current) clearTimeout(readyTimer.current);
          readyTimer.current = null;
          setStatus("ready");
        } else if (
          data.type === "resize" &&
          typeof data.height === "number" &&
          Number.isFinite(data.height)
        ) {
          // The gate pane owns scrolling, so the embedded view should occupy the height its
          // content requested instead of introducing a second clipped scrolling surface.
          // ResizeObserver already coalesces layout work; dropping a close-following update
          // here could preserve the pre-React height and clip the completed view.
          setHeight(Math.max(MIN_HEIGHT, Math.ceil(data.height)));
        } else if (data.type === "candidate" && presentation.mode === "input") {
          if (jsonByteSize(data.answer) === undefined) return;
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
      if (!isCurrent()) return;
      if (readyTimer.current) clearTimeout(readyTimer.current);
      readyTimer.current = null;
      setStatus("error");
      setMessage(error instanceof Error ? error.message : String(error));
    }
  }, [identity, onCandidate, presentation, status]);

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
