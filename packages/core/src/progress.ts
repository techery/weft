import type { ProviderProgress } from "@techery/weft-sdk";
import type { RunControl } from "./provider.ts";
import type { RunRuntime, StepIO } from "./runtime.ts";

/** Status is observational: at most 100 unique consecutive updates and 512 characters per provider turn. */
export async function withProviderProgress<T>(
  rt: RunRuntime,
  io: StepIO,
  run: (control: RunControl) => Promise<T>,
): Promise<T> {
  let open = true;
  let count = 0;
  let previous = "";
  const onProgress = (progress: ProviderProgress): void => {
    if (
      !open ||
      io.signal.aborted ||
      count >= 100 ||
      !progress ||
      !["working", "tool", "finalizing", "repairing"].includes(progress.stage) ||
      typeof progress.message !== "string"
    )
      return;
    const message = progress.message.trim().slice(0, 512);
    if (!message) return;
    const identity = `${progress.stage}:${message}`;
    if (identity === previous) return;
    previous = identity;
    count++;
    void rt
      .append([{ type: "step.progress", seq: io.seq, progress: { stage: progress.stage, message } }])
      .catch(() => undefined);
  };
  try {
    return await run({ signal: io.signal, onProgress });
  } finally {
    open = false;
  }
}
