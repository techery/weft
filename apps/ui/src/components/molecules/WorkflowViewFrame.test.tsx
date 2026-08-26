import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { api } from "~/api/client";
import type { UiPresentation } from "~/api/types";
import { WorkflowViewFrame } from "./WorkflowViewFrame";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function presentation(blob: string, hash: string): UiPresentation {
  return {
    id: "u1",
    asset: {
      id: "summary",
      revision: "1",
      bundleRef: { $blob: "a".repeat(64), size: 128 },
      protocol: 1,
    },
    props: { ref: { $blob: blob, size: 32 }, hash },
    mode: "display",
  };
}

describe("WorkflowViewFrame", () => {
  it("does not post stale blob props after the run identity changes", async () => {
    const oldProps = deferred<unknown>();
    const nextProps = deferred<unknown>();
    vi.spyOn(api, "blobJson").mockImplementation((ref) =>
      ref === "old" ? oldProps.promise : nextProps.promise,
    );
    const posted: unknown[] = [];
    const { rerender } = render(
      <WorkflowViewFrame runId="old-run" presentation={presentation("old", "old-hash")} />,
    );
    const oldFrame = screen.getByTitle<HTMLIFrameElement>("Workflow view summary");
    if (!oldFrame.contentWindow) throw new Error("test iframe has no contentWindow");
    oldFrame.contentWindow.postMessage = ((message: unknown) => posted.push(message)) as typeof postMessage;
    fireEvent.load(oldFrame);

    rerender(<WorkflowViewFrame runId="next-run" presentation={presentation("next", "next-hash")} />);
    const nextFrame = screen.getByTitle<HTMLIFrameElement>("Workflow view summary");
    if (!nextFrame.contentWindow) throw new Error("test iframe has no contentWindow");
    nextFrame.contentWindow.postMessage = ((message: unknown) => posted.push(message)) as typeof postMessage;
    fireEvent.load(nextFrame);

    await act(async () => nextProps.resolve({ run: "next" }));
    await waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0]).toMatchObject({ props: { run: "next" } });

    await act(async () => oldProps.resolve({ run: "old" }));
    await waitFor(() => expect(posted).toHaveLength(1));
  });
});
