import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Ctx, PatchRef } from "@techery/weft-sdk";
import { defineProcedure, defineWorkflow, z } from "@techery/weft-sdk";
import { afterAll, expect, test } from "vitest";
import { cleanupRepos, reopen, tempDir, tempRepo, testEngine } from "./helpers.ts";

afterAll(cleanupRepos);
const meta = {
  name: "scoped-writes",
  description: "Scoped writers retain independent patch and task provenance",
  input: z.object({}),
  output: z.array(z.string()),
};
const patchSchema = z.object({ ref: z.string(), key: z.string(), files: z.array(z.string()) });
async function write(ctx: Pick<Ctx, "agent">, name: string): Promise<PatchRef> {
  const result = await ctx.agent.detailed(`Write ${name}`, {
    key: "edit",
    schema: z.object({ ok: z.boolean() }),
    write: { paths: [`${name}.txt`] },
  });
  return result.patch!;
}
const writer = defineProcedure({
  name: "writer",
  revision: "1",
  input: z.string(),
  output: patchSchema,
  requires: ["agent"],
  run: write,
});

function workflow(integrateAll: boolean, throughProcedure: boolean) {
  return defineWorkflow(meta, async (ctx) => {
    const patches = await ctx.parallel.all(
      ["a", "b"],
      (name, lane) =>
        throughProcedure ? lane.procedure(writer, name, { key: "writer" }) : write(lane, name),
      { key: "lanes", keyOf: (name) => name, concurrency: 2 },
    );
    await ctx.integrate(integrateAll ? patches : patches.slice(0, 1));
    return patches.map(({ key }) => key);
  });
}
function fixtures(t: ReturnType<typeof testEngine>, throughProcedure: boolean) {
  for (const name of ["a", "b"])
    t.builder.on(
      { key: `lanes/${name}/${throughProcedure ? "writer/" : ""}edit` },
      { ok: true },
      { writes: { [`${name}.txt`]: name.toUpperCase() } },
    );
}

test.each([false, true])(
  "one integrated scoped patch cannot hide another (procedure=%s)",
  async (throughProcedure) => {
    const t = testEngine();
    fixtures(t, throughProcedure);
    const cwd = await tempRepo();
    const run = await t.engine.start(workflow(false, throughProcedure), { cwd, input: {} });
    await expect(run.result).rejects.toMatchObject({
      code: "unintegrated_patches",
      message: expect.stringContaining(`lanes/b/${throughProcedure ? "writer/" : ""}edit`),
    });
    expect(await readFile(join(cwd, "a.txt"), "utf8")).toBe("A");
    await expect(readFile(join(cwd, "b.txt"))).rejects.toMatchObject({ code: "ENOENT" });
  },
);

test.each([false, true])(
  "scoped patches integrate independently and replay after restart (procedure=%s)",
  async (throughProcedure) => {
    const t = testEngine();
    fixtures(t, throughProcedure);
    const cwd = await tempRepo();
    const def = workflow(true, throughProcedure);
    const run = await t.engine.start(def, { cwd, input: {} });
    const keys = ["a", "b"].map((name) => `lanes/${name}/${throughProcedure ? "writer/" : ""}edit`);
    expect(await run.result).toEqual(keys);
    const resumed = reopen(t);
    expect(await (await resumed.engine.resume(run.runId, { def })).result).toEqual(keys);
    expect(resumed.builder.calls).toHaveLength(0);
    expect(await readFile(join(cwd, "a.txt"), "utf8")).toBe("A");
    expect(await readFile(join(cwd, "b.txt"), "utf8")).toBe("B");
    const captured: string[] = [];
    for await (const { ev } of resumed.journal.read(run.runId))
      if (ev.type === "patch.captured") captured.push(ev.key);
    expect(captured.sort()).toEqual(keys);
  },
);

test("scope violations identify each lane's writer", async () => {
  const t = testEngine();
  t.builder.on({ key: "lanes/*/edit" }, { ok: true }, { writes: { "unexpected.txt": "outside scope" } });
  const def = defineWorkflow(meta, async (ctx) => {
    const patches = await ctx.parallel.all(["a", "b"], (name, lane) => write(lane, name), {
      key: "lanes",
      keyOf: (name) => name,
    });
    await ctx.discard(patches);
    return patches.map(({ key }) => key);
  });
  const run = await t.engine.start(def, { cwd: await tempRepo(), input: {} });
  await run.result;
  const violations: string[] = [];
  for await (const { ev } of t.journal.read(run.runId))
    if (ev.type === "scope.violation") violations.push(ev.key);
  expect(violations.sort()).toEqual(["lanes/a/edit", "lanes/b/edit"]);
});

test("agent and workflow task provenance retain the owning lane", async () => {
  const observed: string[] = [];
  const applied: string[] = [];
  const t = testEngine({
    taskTracker: {
      snapshot: async (context) => {
        observed.push(context.step);
        return { total: 0, tasks: [] };
      },
      schema: async () => null,
      applyBatch: async (context) => {
        applied.push(context.step);
      },
    },
  });
  t.builder.on({ key: "lanes/*/inspect" }, { ok: true });
  const def = defineWorkflow({ ...meta, id: "scoped-writes", tasks: {} }, async (ctx) =>
    ctx.parallel.all(
      ["a", "b"],
      async (name, lane) => {
        await lane.tasks.observe({}, { key: "observe" });
        await lane.agent("Inspect tasks", { key: "inspect", schema: z.object({ ok: z.boolean() }) });
        await lane.tasks.upsert({
          key: "record",
          dedupeKey: name,
          set: { title: name, description: "finding" },
        });
        return name;
      },
      { key: "lanes", keyOf: (name) => name },
    ),
  );
  const run = await t.engine.start(def, { cwd: await tempDir(), input: {} });
  expect(await run.result).toEqual(["a", "b"]);
  expect(observed.sort()).toEqual([
    "lanes/a/inspect",
    "lanes/a/observe",
    "lanes/b/inspect",
    "lanes/b/observe",
  ]);
  expect(applied.sort()).toEqual(["lanes/a/record", "lanes/b/record"]);
});
