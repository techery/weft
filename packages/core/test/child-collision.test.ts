/**
 * A fresh child run id is eight random hex characters — it can land on an
 * EXISTING, unrelated run. Adopting that journal would replay a stranger's
 * input under the new child's definition and append terminal records into the
 * stranger's history. The engine must detect the collision and take a free id.
 */
import { defineWorkflow, z } from "@weft/sdk";
import { afterAll, describe, expect, test, vi } from "vitest";
import { cleanupRepos, tempDir, testEngine } from "./helpers.ts";

const mocked = vi.hoisted(() => ({ queue: [] as string[] }));

vi.mock("node:crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:crypto")>();
  return {
    ...actual,
    randomUUID: (() => mocked.queue.shift() ?? actual.randomUUID()) as typeof actual.randomUUID,
  };
});

afterAll(cleanupRepos);

describe("child run id collisions", () => {
  test("a colliding fresh id is regenerated, never adopting the stranger's journal", async () => {
    const t = testEngine();
    // A stranger's durable run already owns the id the generator will hand out.
    await t.journal.append("stolen00", [
      {
        type: "run.created",
        runId: "stolen00",
        workflow: { name: "other" },
        input: { secret: true },
        cwd: "/elsewhere",
        depth: 0,
      },
    ]);
    const strangerBefore = [];
    for await (const rec of t.journal.read("stolen00")) strangerBefore.push(rec);

    const child = defineWorkflow(
      { name: "innocent", description: "i", input: z.object({}), output: z.object({ ok: z.boolean() }) },
      async () => ({ ok: true }),
    );
    const parent = defineWorkflow(
      { name: "parent", description: "p", input: z.object({}), output: z.object({ ok: z.boolean() }) },
      async (ctx) => (await ctx.workflow(child, {})) as { ok: boolean },
    );
    // First shift feeds the child-id generator (the parent id is explicit).
    mocked.queue.push("stolen00-0000-4000-8000-000000000000", "fresh123-0000-4000-8000-000000000000");
    const h = await t.engine.start(parent, { runId: "par00001", input: {}, cwd: await tempDir() });
    expect(await h.result).toEqual({ ok: true });

    // The child ran under the REGENERATED id; the journaled step records it.
    expect(await t.journal.exists("fresh123")).toBe(true);
    const recs = [];
    for await (const rec of t.journal.read("par00001")) recs.push(rec);
    const completed = recs.find(
      (r) => r.ev.type === "step.completed" && (r.ev.output as { childRunId?: string })?.childRunId,
    );
    expect(
      completed?.ev.type === "step.completed"
        ? (completed.ev.output as { childRunId?: string }).childRunId
        : undefined,
    ).toBe("fresh123");
    // The stranger's journal is byte-for-byte untouched.
    const strangerAfter = [];
    for await (const rec of t.journal.read("stolen00")) strangerAfter.push(rec);
    expect(strangerAfter).toEqual(strangerBefore);
  });
});
