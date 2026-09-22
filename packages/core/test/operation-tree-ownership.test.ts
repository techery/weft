import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { OperationBindings } from "@techery/weft-core";
import { defineOperation, defineWorkflow, z } from "@techery/weft-sdk";
import { afterAll, expect, test } from "vitest";
import { cleanupRepos, reopen, tempRepo, testEngine } from "./helpers.ts";

afterAll(cleanupRepos);
const config = {
  approvalPolicy: { tiers: { low: "auto", medium: "auto", high: "auto", irreversible: "auto" } },
} as const;

test.each(["child", "grandchild"])("a draining %s keeps its ancestor workspace claimed", async (depth) => {
  let release!: () => void;
  const pending = new Promise<void>((done) => {
    release = done;
  });
  let workspace = "";
  const operation = defineOperation({
    name: "write-late",
    binding: "write-late",
    revision: "1",
    risk: "low",
    input: z.object({}),
    output: z.string(),
  });
  const operations: OperationBindings = {
    "write-late": {
      risk: "low",
      execute: async (_input, context) => {
        workspace = context.cwd;
        await pending; // Simulate a host adapter which ignores cancellation.
        await writeFile(join(workspace, "README.md"), "old child finished");
        return "done";
      },
      reconcile: async () => ({ status: "not_applied" }),
    },
  };
  const meta = {
    description: "A timed-out external write",
    input: z.object({}),
    output: z.string(),
  };
  const child = defineWorkflow(
    { ...meta, name: "child" },
    async (ctx) => (await ctx.operation(operation, {}, { key: "write", timeout: "10ms" })).value,
  );
  const middle = defineWorkflow({ ...meta, name: "middle" }, (ctx) =>
    ctx.workflow(child, {}, { key: "child" }),
  );
  const parent = defineWorkflow(
    {
      ...meta,
      name: "parent",
      workspace: { branch: "weft/operation-tree" },
    },
    (ctx) => ctx.workflow(depth === "grandchild" ? middle : child, {}, { key: "descendant" }),
  );
  let resumedBodies = 0;
  const edited = defineWorkflow(
    { ...meta, name: "parent", workspace: { branch: "weft/operation-tree" } },
    async (ctx) => {
      resumedBodies++;
      await ctx.exec(
        process.execPath,
        ["-e", "require('fs').writeFileSync('README.md','resumed parent finished')"],
        { key: "write" },
      );
      return "resumed";
    },
  );
  const first = testEngine({ config, operations });
  const next = reopen(first, { config, operations });
  try {
    const run = await first.engine.start(parent, { input: {}, cwd: await tempRepo() });
    await expect(run.result).rejects.toMatchObject({ code: "recovery_required" });
    await expect(first.engine.resume(run.runId, { def: edited })).rejects.toMatchObject({
      code: "recovery_required",
    });
    await expect(next.engine.resume(run.runId, { def: edited })).rejects.toThrow(/active in another process/);
    expect(resumedBodies).toBe(0);
    expect(await readFile(join(workspace, "README.md"), "utf8")).toBe("hello\n");

    release();
    // The lease releases after the real adapter settles, independently of its timed-out step.
    await expect
      .poll(async () => {
        const claim = await first.journal.acquireRun(run.runId);
        if (!claim) return false;
        await claim.release();
        return true;
      })
      .toBe(true);
    const resumed = await next.engine.resume(run.runId, { def: edited });
    expect(await resumed.result).toBe("resumed");
    expect(resumedBodies).toBe(1);
    expect(await readFile(join(workspace, "README.md"), "utf8")).toBe("resumed parent finished");
  } finally {
    release();
    await first.engine.shutdown();
    await next.engine.shutdown();
  }
});
