import type { RunState, Weft } from "@techery/weft-host";
import type { Hono } from "hono";
import { fail } from "../http.ts";
import { stateOf } from "../state.ts";

export interface AttentionEntry {
  runId: string;
  workflow: string;
  attention: NonNullable<RunState["attention"]>[number];
}

/** Includes terminal runs: an unknown remote operation still needs attention after its run fails. */
export function registerAttentionRoutes(app: Hono, weft: Weft): void {
  app.get("/api/attention", async (c) => {
    try {
      const summaries = await weft.engine.list();
      const attention: AttentionEntry[] = [];
      const unreadable: Array<{ runId: string; error: string }> = [];
      for (let index = 0; index < summaries.length; index += 8) {
        const batch = summaries.slice(index, index + 8);
        const results = await Promise.allSettled(batch.map((run) => stateOf(weft, run.runId)));
        for (let i = 0; i < results.length; i++) {
          const result = results[i]!;
          if (result.status === "rejected") {
            unreadable.push({ runId: batch[i]!.runId, error: String(result.reason) });
          } else {
            const state = result.value;
            for (const item of state.attention ?? [])
              attention.push({ runId: state.runId, workflow: state.workflow, attention: item });
          }
        }
      }
      attention.sort((a, b) => a.attention.updatedAt - b.attention.updatedAt);
      return c.json({ attention, unreadable });
    } catch (error) {
      return fail(c, error);
    }
  });
}
