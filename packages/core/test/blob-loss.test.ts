/**
 * A step's output can be offloaded to a blob. If that blob is gone, the answer is
 * unreadable — which is a cache MISS, not a dead run: re-running the step produces it
 * again. It used to throw, so a run whose only problem was one absent file became
 * permanently unresumable.
 */
import { MemoryBlobStore } from "@techery/weft-core";
import { mock } from "@techery/weft-provider-mock";
import { defineWorkflow, z } from "@techery/weft-sdk";
import { afterAll, describe, expect, test } from "vitest";
import { cleanupRepos, reopen, tempDir, testEngine } from "./helpers.ts";

afterAll(cleanupRepos);

const Big = z.object({ text: z.string() });
const Out = z.object({ text: z.string() });

describe("a journaled output whose blob is gone", () => {
  test("re-runs the step instead of failing the run", async () => {
    let calls = 0;
    const def = defineWorkflow(
      { name: "big", description: "big", input: z.object({}), output: Out },
      async (ctx) => {
        const r = await ctx.agent("produce something large", { schema: Big, key: "produce" });
        await ctx.human.approve({ action: "ship?" });
        return { text: r.text };
      },
    );

    const builder = () =>
      mock().on({ key: "produce" }, () => {
        calls++;
        return { text: "x".repeat(4096) };
      });

    // Force the output into a blob.
    const config = { limits: { blobThresholdBytes: 1 } };
    const t1 = testEngine({ builder: builder(), config });
    const cwd = await tempDir();
    const h1 = await t1.engine.start(def, { input: {}, cwd });
    const o1 = await h1.outcome();
    if (o1.status !== "waiting_for_human") throw new Error(`expected suspension, got ${o1.status}`);
    await t1.engine.answer(h1.runId, o1.pending[0]!.id, { approved: true });
    await h1.result;
    expect(calls).toBe(1);

    // The blob store loses the file — a partial restore, a pruned cache. A fresh
    // store stands in for one whose blobs did not survive.
    const t2 = reopen(t1, { builder: builder(), config, blobs: new MemoryBlobStore() });
    const h2 = await t2.engine.resume(h1.runId, { def });
    const o2 = await h2.outcome();
    if (o2.status === "waiting_for_human") {
      await t2.engine.answer(h1.runId, o2.pending[0]!.id, { approved: true });
    }
    const out = (await h2.result) as { text: string };

    expect(out.text).toHaveLength(4096);
    expect(calls).toBe(2); // re-ran rather than failing
  });
});
