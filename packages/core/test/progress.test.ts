import type { JournalEvent } from "@techery/weft-core";
import type { ProviderProgress } from "@techery/weft-sdk";
import { expect, test } from "vitest";
import { withProviderProgress } from "../src/progress.ts";
import type { RunRuntime, StepIO } from "../src/runtime.ts";

test("provider status is bounded, deduplicated and ignores updates after cancellation or completion", async () => {
  const events: JournalEvent[] = [];
  const rt = {
    append: async (batch: JournalEvent[]) => {
      events.push(...batch);
      return [];
    },
  } as unknown as RunRuntime;
  const abort = new AbortController();
  const io = { seq: 7, signal: abort.signal } as StepIO;
  let emit: ((progress: ProviderProgress) => void) | undefined;
  const result = await withProviderProgress(rt, io, async (control) => {
    emit = control.onProgress;
    emit?.({ stage: "working", message: "Reading files" });
    emit?.({ stage: "working", message: "Reading files" });
    emit?.({ stage: "tool", message: "x".repeat(10_000) });
    for (let index = 0; index < 120; index++) emit?.({ stage: "tool", message: `Tool ${index}` });
    return "result";
  });
  emit?.({ stage: "finalizing", message: "Late completion" });
  expect(result).toBe("result");
  expect(events).toHaveLength(100);
  expect(events[1]).toMatchObject({ type: "step.progress", seq: 7, progress: { message: "x".repeat(512) } });
  abort.abort();
  await withProviderProgress(rt, io, async (control) =>
    control.onProgress?.({ stage: "working", message: "Cancelled turn" }),
  );
  expect(events).toHaveLength(100);
});
