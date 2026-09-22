import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { cleanupOwnedWorkspace, type OperationBindings, type OperationContext } from "@techery/weft-core";
import {
  type Ctx,
  defineCheck,
  defineDelivery,
  defineOperation,
  defineWorkflow,
  type VerificationProof,
  type WorkspaceCandidate,
  z,
} from "@techery/weft-sdk";
import { afterAll, describe, expect, test } from "vitest";
import { cleanupRepos, reopen, tempDir, tempRepo, testEngine } from "./helpers.ts";

afterAll(cleanupRepos);
const config = {
  approvalPolicy: { tiers: { low: "auto", medium: "auto", high: "auto", irreversible: "auto" } },
} as const;
const operation = defineOperation({
  name: "publish",
  revision: "1",
  binding: "publish",
  input: z.object({ value: z.number() }),
  output: z.object({ id: z.string() }),
  risk: "low",
});
const delivery = defineDelivery({
  name: "publish",
  revision: "1",
  binding: "publish",
  input: z.object({ value: z.number() }),
  output: z.object({ id: z.string() }),
  risk: "low",
});
const passing = defineCheck({ name: "tests", revision: "1", policy: "required", run: () => true });
function bindings(
  execute: (input: unknown, context: OperationContext) => Promise<unknown> = async () => ({
    id: "external-1",
  }),
): OperationBindings {
  return { publish: { risk: "low", execute, reconcile: async () => ({ status: "not_applied" }) } };
}
const meta = {
  name: "owned",
  description: "owned candidate",
  input: z.object({}),
  output: z.object({ id: z.string() }),
  workspace: { branch: "weft/test" },
};
async function commit(ctx: Ctx, text: string, key: string) {
  await ctx.exec("node", ["-e", "require('node:fs').writeFileSync('README.md',process.argv[1])", text], {
    key: `${key}:write`,
  });
  await ctx.git.add({ paths: ["README.md"], key: `${key}:add` });
  await ctx.git.commit({ message: key, key: `${key}:commit` });
}

describe("fresh checks and diagnostic repair", () => {
  test("unrevisioned reusable callbacks re-execute on resume", async () => {
    let pass = true;
    let calls = 0;
    const check = defineCheck({
      name: "closure",
      run: () => {
        calls++;
        return pass;
      },
    });
    const def = defineWorkflow(
      { ...meta, workspace: undefined, output: z.object({ status: z.string() }) },
      async (ctx) => ({ status: (await ctx.check(check, { key: "check" })).status }),
    );
    const first = testEngine();
    const handle = await first.engine.start(def, { input: {}, cwd: await tempDir() });
    expect(await handle.result).toEqual({ status: "pass" });
    pass = false;
    const next = reopen(first);
    expect(await (await next.engine.resume(handle.runId, { def })).result).toEqual({ status: "fail" });
    expect(calls).toBe(2);
  });

  test("diagnostic required failures can be repaired; completion policy remains fail-closed", async () => {
    const check = defineCheck({ name: "tests", policy: "required", input: z.boolean(), run: (pass) => pass });
    const def = defineWorkflow({ ...meta, workspace: undefined }, async (ctx) => {
      expect((await ctx.check(check, false, { key: "initial", purpose: "diagnostic" })).status).toBe("fail");
      expect((await ctx.check(check, true, { key: "final" })).status).toBe("pass");
      return { id: "fixed" };
    });
    const t = testEngine();
    expect(await (await t.engine.start(def, { input: {}, cwd: await tempDir() })).result).toEqual({
      id: "fixed",
    });
  });

  test("waivers preserve failed verdict, enforce expiry, and cannot satisfy required checks", async () => {
    const optional = defineCheck({ name: "optional", run: () => false });
    const def = defineWorkflow({ ...meta, workspace: undefined }, async (ctx) => {
      await expect(
        ctx.check(optional, { key: "expired", waive: { reason: "temporary", expiresAt: "2000-01-01" } }),
      ).rejects.toMatchObject({ code: "invalid_input" });
      await expect(
        ctx.check(passing, { key: "required", waive: { reason: "temporary" } }),
      ).rejects.toMatchObject({ code: "invalid_input" });
      expect(
        await ctx.check(optional, {
          key: "waived",
          waive: { reason: "tracked exception", expiresAt: "2100-01-01" },
        }),
      ).toMatchObject({ status: "fail", disposition: "waived" });
      return { id: "ok" };
    });
    const t = testEngine();
    await (await t.engine.start(def, { input: {}, cwd: await tempDir() })).result;
  });
});

describe("owned candidate delivery", () => {
  test("retains isolated commits, runs preparation, and re-verifies before serving a receipt", async () => {
    const root = await tempRepo({ "README.md": "original\n", ".gitignore": ".prepared\n" });
    let path = "";
    let checks = 0;
    let dispatches = 0;
    const check = defineCheck({
      name: "tests",
      revision: "1",
      policy: "required",
      run: () => {
        checks++;
        return true;
      },
    });
    const def = defineWorkflow(
      {
        ...meta,
        workspace: {
          ...meta.workspace,
          prepare: [["node", "-e", "require('node:fs').writeFileSync('.prepared','ready')"]],
        },
      },
      async (ctx) => {
        path = ctx.workspace!.path;
        expect(ctx.workspace!.branch).toBe("weft/test");
        expect(await readFile(join(path, ".prepared"), "utf8")).toBe("ready");
        await commit(ctx, "changed\n", "change");
        const candidate = await ctx.workspace!.snapshot({ key: "candidate" });
        await ctx.workspace!.assertCurrent(candidate);
        const verified = await ctx.verify(candidate, [check], { key: "verify" });
        expect(verified.passed).toBe(true);
        return (
          await ctx.delivery(
            delivery,
            { value: 1 },
            { key: "delivery", candidate, proofs: [verified.proof!] },
          )
        ).value;
      },
    );
    const ops = bindings(async () => {
      dispatches++;
      return { id: "pr-1" };
    });
    const first = testEngine({ config, operations: ops });
    const handle = await first.engine.start(def, { input: {}, cwd: root });
    expect(await handle.result).toEqual({ id: "pr-1" });
    expect(path).not.toBe(root);
    expect(await readFile(join(root, "README.md"), "utf8")).toBe("original\n");
    const retained = path;
    const next = reopen(first, { config, operations: ops });
    expect(await (await next.engine.resume(handle.runId, { def })).result).toEqual({ id: "pr-1" });
    expect(path).toBe(retained);
    expect(checks).toBe(2);
    expect(dispatches).toBe(1);
    const state = await next.engine.state(handle.runId);
    expect(state.workspace?.path).toBe(retained);
  });

  test("repair loop can reject an initial candidate and deliver a newly committed one", async () => {
    const root = await tempRepo();
    let healthy = false;
    const check = defineCheck({ name: "tests", policy: "required", run: () => healthy });
    const def = defineWorkflow(meta, async (ctx) => {
      const before = await ctx.workspace!.snapshot({ key: "before" });
      const initial = await ctx.verify(before, [check], { key: "initial" });
      expect(initial.passed).toBe(false);
      expect(initial.proof).toBeUndefined();
      await commit(ctx, "fixed\n", "fix");
      healthy = true;
      const after = await ctx.workspace!.snapshot({ key: "after" });
      expect(after.id).not.toBe(before.id);
      expect(after.generation).toBeGreaterThan(before.generation);
      const final = await ctx.verify(after, [check], { key: "final" });
      return (
        await ctx.delivery(
          delivery,
          { value: 1 },
          { key: "delivery", candidate: after, proofs: [final.proof!] },
        )
      ).value;
    });
    const t = testEngine({ config, operations: bindings() });
    expect(await (await t.engine.start(def, { input: {}, cwd: root })).result).toEqual({ id: "external-1" });
  });

  test("copies of candidates/proofs and altered proof check names grant no authority", async () => {
    let dispatches = 0;
    const def = defineWorkflow(meta, async (ctx) => {
      const candidate = await ctx.workspace!.snapshot({ key: "candidate" });
      await expect(
        ctx.verify({ ...candidate } as WorkspaceCandidate, [passing], { key: "copy" }),
      ).rejects.toMatchObject({ code: "stale_candidate" });
      const verified = await ctx.verify(candidate, [passing], { key: "verify" });
      expect(Object.isFrozen(verified.proof!.checks)).toBe(true);
      await expect(
        ctx.delivery(
          delivery,
          { value: 1 },
          { key: "copy-proof", candidate, proofs: [{ ...verified.proof! } as VerificationProof] },
        ),
      ).rejects.toMatchObject({ code: "check_failed" });
      await commit(ctx, "later\n", "later");
      await expect(
        ctx.delivery(delivery, { value: 1 }, { key: "stale", candidate, proofs: [verified.proof!] }),
      ).rejects.toMatchObject({ code: "stale_candidate" });
      return { id: "safe" };
    });
    const t = testEngine({
      config,
      operations: bindings(async () => {
        dispatches++;
        return { id: "bad" };
      }),
    });
    expect(await (await t.engine.start(def, { input: {}, cwd: await tempRepo() })).result).toEqual({
      id: "safe",
    });
    expect(dispatches).toBe(0);
  });

  test("code changed while awaiting human approval is not delivered", async () => {
    let workspace = "";
    let dispatches = 0;
    const def = defineWorkflow(meta, async (ctx) => {
      workspace = ctx.workspace!.path;
      const candidate = await ctx.workspace!.snapshot({ key: "candidate" });
      const proof = (await ctx.verify(candidate, [passing], { key: "verify" })).proof!;
      return (
        await ctx.delivery(
          delivery,
          { value: 1 },
          { key: "deliver", candidate, proofs: [proof], approval: { question: "Publish this commit?" } },
        )
      ).value;
    });
    const t = testEngine({
      config,
      operations: bindings(async () => {
        dispatches++;
        return { id: "bad" };
      }),
    });
    const handle = await t.engine.start(def, { input: {}, cwd: await tempRepo() });
    const outcome = await handle.outcome();
    if (outcome.status !== "waiting_for_human") throw new Error(`expected approval, got ${outcome.status}`);
    await writeFile(join(workspace, "README.md"), "new unreviewed code\n");
    await t.engine.answer(handle.runId, outcome.pending[0]!.id, { approved: true });
    await expect(handle.result).rejects.toMatchObject({ code: "stale_candidate" });
    expect(dispatches).toBe(0);
  });

  test("a check that changes the candidate is refused and cannot mint a proof", async () => {
    const changing = defineCheck({
      name: "mutator",
      command: ["node", "-e", "require('node:fs').writeFileSync('README.md','unverified')"],
    });
    const def = defineWorkflow(meta, async (ctx) => {
      const candidate = await ctx.workspace!.snapshot({ key: "candidate" });
      await ctx.verify(candidate, [changing], { key: "verify" });
      return { id: "bad" };
    });
    const t = testEngine({ config });
    await expect(
      (await t.engine.start(def, { input: {}, cwd: await tempRepo() })).result,
    ).rejects.toMatchObject({ code: "stale_candidate" });
  });

  test("ignored declared environment inputs invalidate a candidate", async () => {
    const def = defineWorkflow(
      { ...meta, workspace: { ...meta.workspace, fingerprintFiles: [".environment"] } },
      async (ctx) => {
        await writeFile(join(ctx.workspace!.path, ".environment"), "toolchain-v1");
        const candidate = await ctx.workspace!.snapshot({ key: "candidate" });
        const proof = (await ctx.verify(candidate, [passing], { key: "verify" })).proof!;
        await writeFile(join(ctx.workspace!.path, ".environment"), "toolchain-v2");
        await expect(
          ctx.delivery(delivery, { value: 1 }, { key: "deliver", candidate, proofs: [proof] }),
        ).rejects.toMatchObject({ code: "stale_candidate" });
        return { id: "safe" };
      },
    );
    const t = testEngine({ config, operations: bindings() });
    expect(
      await (
        await t.engine.start(def, { input: {}, cwd: await tempRepo({ ".gitignore": ".environment\n" }) })
      ).result,
    ).toEqual({ id: "safe" });
  });

  test("cleanup is explicit, refuses unknown data, and retains commits on the branch", async () => {
    let path = "";
    const def = defineWorkflow(meta, async (ctx) => {
      path = ctx.workspace!.path;
      await commit(ctx, "retained\n", "change");
      return { id: "done" };
    });
    const t = testEngine({ config });
    const root = await tempRepo();
    const handle = await t.engine.start(def, { input: {}, cwd: root });
    await handle.result;
    await writeFile(join(path, "untracked.txt"), "preserve me");
    await expect(cleanupOwnedWorkspace(t.journal, handle.runId)).rejects.toMatchObject({ code: "conflict" });
    const { unlink } = await import("node:fs/promises");
    await unlink(join(path, "untracked.txt"));
    expect(await cleanupOwnedWorkspace(t.journal, handle.runId)).toEqual({ path, branch: "weft/test" });
    await expect(readFile(join(path, "README.md"))).rejects.toMatchObject({ code: "ENOENT" });
    const { execa } = await import("execa");
    expect((await execa("git", ["show", "weft/test:README.md"], { cwd: root })).stdout).toBe("retained");
    expect((await t.engine.state(handle.runId)).workspace?.retained).toBe(false);
    expect(await cleanupOwnedWorkspace(t.journal, handle.runId)).toEqual({ path, branch: "weft/test" });
  });

  test("parallel write agents share one owned workspace but never overlap", async () => {
    let active = 0;
    let maximum = 0;
    const t = testEngine({ config });
    t.builder.on({ key: "writers/*/write" }, async () => {
      active++;
      maximum = Math.max(maximum, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active--;
      return { id: "done" };
    });
    const def = defineWorkflow(meta, async (ctx) => {
      await ctx.parallel.all(
        ["a", "b"],
        (item, lane) =>
          lane.agent(`write ${item}`, {
            key: "write",
            schema: z.object({ id: z.string() }),
            write: { paths: ["README.md"] },
          }),
        { key: "writers", keyOf: (item) => item, concurrency: 2 },
      );
      return { id: "done" };
    });
    await (await t.engine.start(def, { input: {}, cwd: await tempRepo() })).result;
    expect(maximum).toBe(1);
  });
});

describe("reconcilable host operations", () => {
  test.each(["applied", "not_applied", "unknown"] as const)(
    "interrupted dispatch reconciles %s without unsafe duplicate dispatch",
    async (status) => {
      let dispatches = 0;
      let observations = 0;
      const ops: OperationBindings = {
        publish: {
          risk: "low",
          execute: async () => {
            dispatches++;
            if (dispatches === 1) throw new Error("connection lost after dispatch");
            return { id: "retried" };
          },
          reconcile: async () => {
            observations++;
            return status === "applied"
              ? { status, output: { id: "found" } }
              : status === "unknown"
                ? { status, detail: "cannot determine remote state", resources: ["external:request"] }
                : { status };
          },
        },
      };
      const def = defineWorkflow(
        { ...meta, workspace: undefined },
        async (ctx) => (await ctx.operation(operation, { value: 1 }, { key: "publish" })).value,
      );
      const first = testEngine({ config, operations: ops });
      const handle = await first.engine.start(def, { input: {}, cwd: await tempDir() });
      await expect(handle.result).rejects.toMatchObject({ code: "recovery_required" });
      const next = reopen(first, { config, operations: ops });
      const resumed = await next.engine.resume(handle.runId, { def });
      if (status === "unknown")
        await expect(resumed.result).rejects.toMatchObject({ code: "recovery_required" });
      else expect(await resumed.result).toEqual({ id: status === "applied" ? "found" : "retried" });
      expect(observations).toBe(1);
      expect(dispatches).toBe(status === "not_applied" ? 2 : 1);
      expect((await next.engine.state(handle.runId)).attention?.length ?? 0).toBe(
        status === "unknown" ? 1 : 0,
      );
    },
  );

  test("receipts replay without dispatch, preserving output transforms exactly once", async () => {
    let dispatches = 0;
    const transformed = defineOperation({
      ...operation,
      output: z.object({ id: z.string().transform((id) => `${id}!`) }),
    });
    const def = defineWorkflow(
      { ...meta, workspace: undefined },
      async (ctx) => (await ctx.operation(transformed, { value: 1 }, { key: "publish" })).value,
    );
    const ops = bindings(async () => {
      dispatches++;
      return { id: "one" };
    });
    const first = testEngine({ config, operations: ops });
    const handle = await first.engine.start(def, { input: {}, cwd: await tempDir() });
    expect(await handle.result).toEqual({ id: "one!" });
    const next = reopen(first, { config, operations: ops });
    expect(await (await next.engine.resume(handle.runId, { def })).result).toEqual({ id: "one!" });
    expect(dispatches).toBe(1);
  });

  test("request identities cannot be reused for different inputs on resume", async () => {
    let value = 1;
    const def = defineWorkflow(
      { ...meta, workspace: undefined },
      async (ctx) => (await ctx.operation(operation, { value }, { key: "publish" })).value,
    );
    const first = testEngine({ config, operations: bindings() });
    const handle = await first.engine.start(def, { input: {}, cwd: await tempDir() });
    await handle.result;
    value = 2;
    const next = reopen(first, { config, operations: bindings() });
    await expect((await next.engine.resume(handle.runId, { def })).result).rejects.toMatchObject({
      code: "invalid_input",
    });
  });

  test("missing bindings and generic access to delivery-only bindings fail before dispatch", async () => {
    const ops = { publish: { ...bindings().publish!, delivery: true, requiredChecks: ["tests"] } };
    const def = defineWorkflow(
      { ...meta, workspace: undefined },
      async (ctx) => (await ctx.operation(operation, { value: 1 }, { key: "publish" })).value,
    );
    const missing = testEngine({ config });
    await expect(
      (await missing.engine.start(def, { input: {}, cwd: await tempDir() })).result,
    ).rejects.toMatchObject({ code: "invalid_input" });
    const wrong = testEngine({ config, operations: ops });
    await expect(
      (await wrong.engine.start(def, { input: {}, cwd: await tempDir() })).result,
    ).rejects.toMatchObject({ code: "check_failed" });
  });

  test("host timeout leaves a recoverable intent instead of repeating a hung effect", async () => {
    const def = defineWorkflow(
      { ...meta, workspace: undefined },
      async (ctx) =>
        (await ctx.operation(operation, { value: 1 }, { key: "publish", timeout: "10ms" })).value,
    );
    const t = testEngine({ config, operations: bindings(async () => new Promise(() => {})) });
    const handle = await t.engine.start(def, { input: {}, cwd: await tempDir() });
    await expect(handle.result).rejects.toMatchObject({ code: "recovery_required" });
    expect((await t.engine.state(handle.runId)).attention?.length).toBe(1);
  });
});
