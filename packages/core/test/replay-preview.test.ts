import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { JournalRecord } from "@techery/weft-core";
import { defineOperation, defineWorkflow, z } from "@techery/weft-sdk";
import { afterAll, expect, test } from "vitest";
import { cleanupRepos, reopen, tempDir, tempRepo, testEngine } from "./helpers.ts";

afterAll(cleanupRepos);
async function records(t: ReturnType<typeof testEngine>, id: string): Promise<JournalRecord[]> {
  const rows: JournalRecord[] = [];
  for await (const record of t.journal.read(id)) rows.push(record);
  return rows;
}

test("dry preview uses the same changed-bundle positional guard as edit-tolerant resume", async () => {
  let count = 2;
  const def = defineWorkflow(
    { name: "preview", description: "preview", input: z.object({}), output: z.array(z.string()) },
    async (ctx) => {
      const values: string[] = [];
      for (let index = 0; index < count; index++)
        values.push((await ctx.agent("same question", { schema: z.object({ tag: z.string() }) })).tag);
      return values;
    },
  );
  const first = testEngine();
  first.builder.on({}, { tag: "before" });
  const run = await first.engine.start(def, { input: {}, cwd: await tempDir(), defHash: "bundle-v1" });
  await run.result;
  count = 1; // delegated helper change: the body text itself stays identical.
  const second = reopen(first);
  second.builder.on({}, { tag: "after" });
  const preview = await second.engine.replayDry(run.runId, { def, defHash: "bundle-v2" });
  expect(preview).toMatchObject({ hits: 0, completed: false, diverged: [{ kind: "agent", seq: 1 }] });
  expect(second.builder.calls).toHaveLength(0);
  expect(
    await (await second.engine.resume(run.runId, { def, defHash: "bundle-v2", mode: "edit-tolerant" }))
      .result,
  ).toEqual(["after"]);
  expect(second.builder.calls).toHaveLength(1);
});

test.each(["confirmed", "unknown"])(
  "owned-workspace preview cannot execute or reconcile a %s operation",
  async (outcome) => {
    const cwd = await tempRepo();
    const operation = defineOperation({
      name: "write",
      revision: "1",
      binding: "write",
      input: z.object({}),
      output: z.string(),
      risk: "low",
    });
    let dispatches = 0;
    let reconciliations = 0;
    const t = testEngine({
      config: { approvalPolicy: { tiers: { low: "auto" } } },
      operations: {
        write: {
          risk: "low",
          execute: async (_input, context) => {
            dispatches++;
            await writeFile(join(context.cwd, "README.md"), "original operation\n");
            if (outcome === "unknown") throw new Error("acknowledgment lost");
            return "confirmed";
          },
          reconcile: async () => {
            reconciliations++;
            return { status: "not_applied" };
          },
        },
      },
    });
    const make = (key: string) =>
      defineWorkflow(
        {
          name: "owned-preview",
          description: "preview",
          input: z.object({}),
          output: z.string(),
          workspace: { branch: "weft/preview" },
        },
        async (ctx) => (await ctx.operation(operation, {}, { key })).value,
      );
    const def = make("write");
    const run = await t.engine.start(def, { input: {}, cwd });
    await run.result.catch(() => undefined);
    const workspace = (await t.engine.state(run.runId)).workspace!;
    const before = await records(t, run.runId);
    for (const previewDef of [def, make("new-write")]) {
      const preview = await t.engine.replayDry(run.runId, { def: previewDef });
      expect(preview.completed).toBe(false);
      expect(preview.diverged[0]?.kind).toBe("sideeffect");
    }
    expect(dispatches).toBe(1);
    expect(reconciliations).toBe(0);
    expect(await records(t, run.runId)).toEqual(before);
    expect(await readFile(join(workspace.path, "README.md"), "utf8")).toBe("original operation\n");
    expect(await readFile(join(cwd, "README.md"), "utf8")).toBe("hello\n");
  },
);
