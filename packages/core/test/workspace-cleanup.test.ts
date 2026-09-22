import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { cleanupOwnedWorkspace } from "@techery/weft-core";
import { defineCheck, defineOperation, defineWorkflow, z } from "@techery/weft-sdk";
import { execa } from "execa";
import { afterAll, expect, test } from "vitest";
import { cleanupRepos, tempRepo, testEngine } from "./helpers.ts";

afterAll(cleanupRepos);
const config = { approvalPolicy: { tiers: { low: "auto", medium: "auto", high: "auto" } } } as const;
const meta = {
  name: "cleanup-attention",
  description: "Cleanup distinguishes follow-up from unresolved recovery",
  input: z.object({}),
  output: z.object({}),
  workspace: { branch: "weft/cleanup-attention" },
};
const failedCheck = defineCheck({ name: "tests", policy: "required", run: () => false });
const feedback = defineOperation({
  name: "feedback",
  revision: "1",
  binding: "github.pr-feedback",
  risk: "low",
  input: z.object({ head: z.string() }),
  output: z.object({ head: z.string(), status: z.enum(["pending", "failed", "unknown"]) }),
});

test.each(["root", "descendant"] as const)(
  "cleanup permits a clean terminal workspace after %s verification failure",
  async (scope) => {
    const child = defineWorkflow({ ...meta, name: "failed-review", workspace: undefined }, async (ctx) => {
      await ctx.check(failedCheck, { key: "verify" });
      return {};
    });
    const workflow = defineWorkflow(meta, async (ctx) => {
      if (scope === "root") await ctx.check(failedCheck, { key: "verify" });
      else
        await expect(ctx.workflow(child, {}, { key: "review" })).rejects.toMatchObject({
          code: "check_failed",
        });
      return {};
    });
    const root = await tempRepo();
    const t = testEngine({ config });
    const run = await t.engine.start(workflow, { cwd: root, input: {} });
    if (scope === "root") await expect(run.result).rejects.toMatchObject({ code: "check_failed" });
    else await run.result;
    const state = await t.engine.state(run.runId);
    const failed = scope === "root" ? state : await t.engine.state(state.children[0]!.childRunId);
    expect(failed.operations).toEqual([]);
    expect(failed.attention?.map(({ kind }) => kind)).toEqual(["verification"]);
    const path = state.workspace!.path;
    expect(await cleanupOwnedWorkspace(t.journal, run.runId)).toEqual({
      path,
      branch: meta.workspace.branch,
    });
    await expect(readFile(join(path, "README.md"))).rejects.toMatchObject({ code: "ENOENT" });
    expect((await execa("git", ["show", `${meta.workspace.branch}:README.md`], { cwd: root })).stdout).toBe(
      "hello",
    );
  },
);

test.each(["pending", "failed", "unknown"] as const)(
  "cleanup permits a completed workspace with recorded %s PR feedback",
  async (status) => {
    const t = testEngine({
      config,
      operations: {
        "github.pr-feedback": {
          risk: "low",
          execute: async (input) => ({ ...(input as { head: string }), status }),
          reconcile: async () => ({ status: "not_applied" }),
        },
      },
    });
    const workflow = defineWorkflow(meta, async (ctx) => {
      const candidate = await ctx.workspace!.snapshot({ key: "candidate" });
      await ctx.operation(feedback, { head: candidate.head }, { key: "feedback" });
      return {};
    });
    const run = await t.engine.start(workflow, { cwd: await tempRepo(), input: {} });
    await run.result;
    const state = await t.engine.state(run.runId);
    expect(state.operations?.map(({ status }) => status)).toEqual(["complete"]);
    expect(state.attention?.map(({ kind }) => kind)).toEqual(["delivery"]);
    await cleanupOwnedWorkspace(t.journal, run.runId);
    expect((await t.engine.state(run.runId)).workspace?.retained).toBe(false);
  },
);

test("cleanup still refuses an uncertain feedback operation", async () => {
  const t = testEngine({
    config,
    operations: {
      "github.pr-feedback": {
        risk: "low",
        execute: async () => {
          throw new Error("response lost");
        },
        reconcile: async () => ({ status: "unknown", detail: "outcome unavailable" }),
      },
    },
  });
  const workflow = defineWorkflow(meta, async (ctx) => {
    const candidate = await ctx.workspace!.snapshot({ key: "candidate" });
    await ctx.operation(feedback, { head: candidate.head }, { key: "feedback" });
    return {};
  });
  const run = await t.engine.start(workflow, { cwd: await tempRepo(), input: {} });
  await expect(run.result).rejects.toMatchObject({ code: "recovery_required" });
  await expect(cleanupOwnedWorkspace(t.journal, run.runId)).rejects.toMatchObject({
    code: "recovery_required",
  });
  expect((await t.engine.state(run.runId)).workspace?.retained).toBe(true);
});

test("cleanup still authenticates ownership after an ordinary verification failure", async () => {
  const t = testEngine({ config });
  const workflow = defineWorkflow(meta, async (ctx) => {
    await ctx.check(failedCheck, { key: "verify" });
    return {};
  });
  const run = await t.engine.start(workflow, { cwd: await tempRepo(), input: {} });
  await expect(run.result).rejects.toMatchObject({ code: "check_failed" });
  const path = (await t.engine.state(run.runId)).workspace!.path;
  const gitDir = (await execa("git", ["rev-parse", "--absolute-git-dir"], { cwd: path })).stdout;
  await writeFile(join(gitDir, "weft-owner.json"), "{}");
  await expect(cleanupOwnedWorkspace(t.journal, run.runId)).rejects.toMatchObject({
    code: "recovery_required",
  });
  expect(await readFile(join(path, "README.md"), "utf8")).toBe("hello\n");
});
