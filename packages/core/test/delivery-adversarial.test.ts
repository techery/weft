import { readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { cleanupOwnedWorkspace, type OperationBindings, type ReconciledOperation } from "@techery/weft-core";
import {
  type CheckDefinition,
  defineCheck,
  defineDelivery,
  defineOperation,
  defineWorkflow,
  z,
} from "@techery/weft-sdk";
import { execa } from "execa";
import { afterAll, describe, expect, test } from "vitest";
import { cleanupRepos, reopen, tempDir, tempRepo, testEngine } from "./helpers.ts";

afterAll(cleanupRepos);
const config = {
  approvalPolicy: { tiers: { low: "auto", medium: "auto", high: "auto", irreversible: "auto" } },
} as const;
const meta = {
  name: "adversarial-owned-workspace",
  description: "Exercises the owned-workspace authority boundary",
  input: z.object({}),
  output: z.object({ id: z.string() }),
  workspace: { branch: "weft/adversarial" },
};
const operation = defineOperation({
  name: "publish",
  binding: "publish",
  revision: "1",
  risk: "low",
  input: z.object({}),
  output: z.object({ id: z.string() }),
});
const delivery = defineDelivery({ ...operation });
const check = defineCheck({ name: "tests", revision: "1", policy: "required", run: () => true });
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("adversarial delivery ownership", () => {
  test("resume refuses a worktree whose run lock was removed before entering the body", async () => {
    const cwd = await tempRepo();
    let workspace = "";
    let entered = 0;
    const def = defineWorkflow(meta, async (ctx) => {
      entered++;
      workspace = ctx.workspace!.path;
      return { id: "done" };
    });
    const first = testEngine({ config });
    const handle = await first.engine.start(def, { cwd, input: {} });
    await handle.result;
    await execa("git", ["worktree", "unlock", workspace], { cwd });
    const next = reopen(first, { config });
    await expect((await next.engine.resume(handle.runId, { def })).result).rejects.toMatchObject({
      code: "recovery_required",
    });
    expect(entered).toBe(1);
  });

  test("delivery reauthenticates the owner marker after candidate verification", async () => {
    let dispatched = 0;
    const def = defineWorkflow(meta, async (ctx) => {
      const candidate = await ctx.workspace!.snapshot({ key: "candidate" });
      const verified = await ctx.verify(candidate, [check], { key: "verify" });
      const gitDir = (await execa("git", ["rev-parse", "--absolute-git-dir"], { cwd: ctx.workspace!.path }))
        .stdout;
      await unlink(join(gitDir, "weft-owner.json"));
      return (
        await ctx.delivery(
          delivery,
          {},
          {
            key: "publish",
            candidate,
            proofs: [verified.proof!],
          },
        )
      ).value;
    });
    const t = testEngine({
      config,
      operations: {
        publish: {
          risk: "low",
          delivery: true,
          execute: async () => {
            dispatched++;
            return { id: "unsafe" };
          },
          reconcile: async () => ({ status: "not_applied" }),
        },
      },
    });
    await expect(
      (await t.engine.start(def, { cwd: await tempRepo(), input: {} })).result,
    ).rejects.toBeTruthy();
    expect(dispatched).toBe(0);
  });

  test("mutating the caller's check list cannot relabel executed proof as an unexecuted check", async () => {
    const checks: CheckDefinition<void>[] = [];
    const notRun = defineCheck({
      name: "independent-review",
      run: () => {
        throw new Error("must not run");
      },
    });
    checks.push(
      defineCheck({
        name: "tests",
        run: () => {
          checks[0] = notRun;
          return true;
        },
      }),
    );
    let dispatched = 0;
    const def = defineWorkflow(meta, async (ctx) => {
      const candidate = await ctx.workspace!.snapshot({ key: "candidate" });
      const verified = await ctx.verify(candidate, checks, { key: "verify" });
      expect(verified.proof!.checks).toEqual(["tests"]);
      await expect(
        ctx.delivery(delivery, {}, { key: "publish", candidate, proofs: [verified.proof!] }),
      ).rejects.toMatchObject({ code: "check_failed" });
      return { id: "safe" };
    });
    const t = testEngine({
      config,
      operations: {
        publish: {
          risk: "low",
          delivery: true,
          requiredChecks: ["independent-review"],
          execute: async () => {
            dispatched++;
            return { id: "unsafe" };
          },
          reconcile: async () => ({ status: "not_applied" }),
        },
      },
    });
    await (await t.engine.start(def, { cwd: await tempRepo(), input: {} })).result;
    expect(dispatched).toBe(0);
  });

  test("prototype-named failed checks cannot disappear from completeness or mint proof", async () => {
    const failed = defineCheck({ name: "__proto__", policy: "required", run: () => false });
    const def = defineWorkflow(meta, async (ctx) => {
      const candidate = await ctx.workspace!.snapshot({ key: "candidate" });
      const verified = await ctx.verify(candidate, [failed], { key: "verify" });
      expect(verified.passed).toBe(false);
      expect(verified.proof).toBeUndefined();
      expect(Object.keys(verified.results)).toEqual(["__proto__"]);
      expect(Object.getOwnPropertyDescriptor(verified.results, "__proto__")?.value.status).toBe("fail");
      return { id: "safe" };
    });
    const t = testEngine({ config });
    await (await t.engine.start(def, { cwd: await tempRepo(), input: {} })).result;
  });

  test("a child sharing an owned workspace cannot be resumed independently of its parent", async () => {
    let entered = 0;
    const child = defineWorkflow({ ...meta, name: "shared-child", workspace: undefined }, async (ctx) => {
      entered++;
      await ctx.exec(
        "node",
        ["-e", "require('node:fs').writeFileSync('README.md',process.argv[1])", `child:${entered}`],
        { key: "write" },
      );
      return { id: "child" };
    });
    const parent = defineWorkflow(meta, async (ctx) => {
      await ctx.workflow(child, {}, { key: "child" });
      await ctx.human.approve({ key: "pause", action: "Finish parent?" });
      return { id: "parent" };
    });
    const first = testEngine({ config });
    const handle = await first.engine.start(parent, { cwd: await tempRepo(), input: {} });
    const outcome = await handle.outcome();
    if (outcome.status !== "waiting_for_human") throw new Error(`Expected pause, got ${outcome.status}`);
    try {
      const state = await first.engine.state(handle.runId);
      const childId = state.children[0]!.childRunId;
      const next = reopen(first, { config });
      await expect(
        next.engine.resume(childId, { def: child }).then((resumed) => resumed.result),
      ).rejects.toMatchObject({ code: "recovery_required" });
      expect(entered).toBe(1);
    } finally {
      await first.engine.answer(handle.runId, outcome.pending[0]!.id, { approved: true });
      await handle.result;
    }
  });

  test("child-local fanout serializes inherited workspace mutations without granting workspace ownership", async () => {
    let active = 0;
    let maximum = 0;
    let workspace = "";
    const child = defineWorkflow({ ...meta, name: "serial-child", workspace: undefined }, async (ctx) => {
      expect(ctx.workspace).toBeUndefined();
      await ctx.parallel.all(["a", "b"], (_, lane) => lane.operation(operation, {}, { key: "mutate" }), {
        key: "mutations",
        keyOf: (item) => item,
        concurrency: 2,
      });
      return { id: "child" };
    });
    const parent = defineWorkflow(meta, async (ctx) => {
      workspace = ctx.workspace!.path;
      return ctx.workflow(child, {}, { key: "child" });
    });
    const t = testEngine({
      config,
      operations: {
        publish: {
          risk: "low",
          execute: async (_, context) => {
            expect(context.cwd).toBe(workspace);
            active++;
            maximum = Math.max(maximum, active);
            await new Promise((done) => setTimeout(done, 10));
            active--;
            return { id: "mutated" };
          },
          reconcile: async () => ({ status: "not_applied" }),
        },
      },
    });
    await (await t.engine.start(parent, { cwd: await tempRepo(), input: {} })).result;
    expect(maximum).toBe(1);
  });

  test.each(["child", "operation", "scoped-agent"] as const)(
    "%s work cannot overlap an owned delivery",
    async (kind) => {
      const dispatchStarted = deferred();
      const releaseDispatch = deferred();
      let publishing = false;
      let overlapped = false;
      let workspace = "";
      const child = defineWorkflow({ ...meta, name: "owned-child", workspace: undefined }, async (ctx) => {
        overlapped ||= publishing;
        const result = await ctx.exec("node", ["-e", "process.stdout.write(process.cwd())"], { key: "cwd" });
        expect(result.stdout).toBe(workspace);
        return { id: "child" };
      });
      const local = defineOperation({ ...operation, name: "local", binding: "local" });
      const ops: OperationBindings = {
        publish: {
          risk: "low",
          delivery: true,
          execute: async () => {
            publishing = true;
            dispatchStarted.resolve();
            await releaseDispatch.promise;
            publishing = false;
            return { id: "published" };
          },
          reconcile: async () => ({ status: "not_applied" }),
        },
        local: {
          risk: "low",
          execute: async (_, context) => {
            overlapped ||= publishing;
            await writeFile(join(context.cwd, "README.md"), "late local mutation\n");
            return { id: "local" };
          },
          reconcile: async () => ({ status: "not_applied" }),
        },
      };
      const def = defineWorkflow(meta, async (ctx) => {
        workspace = ctx.workspace!.path;
        const candidate = await ctx.workspace!.snapshot({ key: "candidate" });
        const proof = (await ctx.verify(candidate, [check], { key: "verify" })).proof!;
        const published = ctx.delivery(delivery, {}, { key: "publish", candidate, proofs: [proof] });
        await dispatchStarted.promise;
        const concurrent =
          kind === "child"
            ? ctx.workflow(child, {}, { key: "child" })
            : kind === "operation"
              ? ctx.operation(local, {}, { key: "local" })
              : ctx
                  .scope({ agent: { write: { paths: ["README.md"] } } })
                  .agent("write in the owned workspace", {
                    schema: z.object({ id: z.string() }),
                    key: "scoped-agent",
                  });
        // Give the contender a chance to acquire authority while dispatch is in flight.
        // Always release it: a correct lock waits until publication has completed.
        setTimeout(releaseDispatch.resolve, 75);
        await Promise.all([published, concurrent]);
        return { id: "done" };
      });
      const t = testEngine({ config, operations: ops });
      t.builder.on({ key: "scoped-agent" }, () => {
        overlapped ||= publishing;
        return { id: "scoped-agent" };
      });
      await (await t.engine.start(def, { cwd: await tempRepo(), input: {} })).result;
      expect(overlapped).toBe(false);
    },
  );
});

describe("adversarial operation recovery", () => {
  test.each([null, { status: "unexpected" }])(
    "malformed reconciliation %j cannot authorize a retry",
    async (observed) => {
      let dispatches = 0;
      const ops: OperationBindings = {
        publish: {
          risk: "low",
          execute: async () => {
            dispatches++;
            if (dispatches === 1) throw new Error("lost acknowledgment");
            return { id: "duplicated" };
          },
          // Trusted adapters are still runtime inputs; a buggy adapter must fail closed.
          reconcile: async () => observed as unknown as ReconciledOperation,
        },
      };
      const def = defineWorkflow(
        { ...meta, workspace: undefined },
        async (ctx) => (await ctx.operation(operation, {}, { key: "publish" })).value,
      );
      const first = testEngine({ config, operations: ops });
      const handle = await first.engine.start(def, { cwd: await tempDir(), input: {} });
      await expect(handle.result).rejects.toMatchObject({ code: "recovery_required" });
      const next = reopen(first, { config, operations: ops });
      await expect((await next.engine.resume(handle.runId, { def })).result).rejects.toMatchObject({
        code: "recovery_required",
      });
      expect(dispatches).toBe(1);
    },
  );

  test("a timed-out noncooperative dispatch cannot race a second owner", async () => {
    const release = deferred();
    let dispatches = 0;
    const ops: OperationBindings = {
      publish: {
        risk: "low",
        execute: async () => {
          dispatches++;
          if (dispatches === 1) await release.promise;
          return { id: "applied" };
        },
        reconcile: async () => ({ status: "not_applied" }),
      },
    };
    const def = defineWorkflow(
      { ...meta, workspace: undefined },
      async (ctx) => (await ctx.operation(operation, {}, { key: "publish", timeout: "10ms" })).value,
    );
    const first = testEngine({ config, operations: ops });
    try {
      const handle = await first.engine.start(def, { cwd: await tempDir(), input: {} });
      await expect(handle.result).rejects.toMatchObject({ code: "recovery_required" });
      const next = reopen(first, { config, operations: ops });
      await expect(
        next.engine.resume(handle.runId, { def }).then((resumed) => resumed.result),
      ).rejects.toBeTruthy();
      expect(dispatches).toBe(1);
    } finally {
      release.resolve();
    }
  });

  test("cancellation keeps uncertain intent and late host success cannot append a receipt", async () => {
    const started = deferred();
    const release = deferred();
    const ops: OperationBindings = {
      publish: {
        risk: "low",
        execute: async () => {
          started.resolve();
          await release.promise;
          return { id: "late" };
        },
        reconcile: async () => ({ status: "unknown", detail: "still awaiting external outcome" }),
      },
    };
    const def = defineWorkflow(
      { ...meta, workspace: undefined },
      async (ctx) => (await ctx.operation(operation, {}, { key: "publish" })).value,
    );
    const t = testEngine({ config, operations: ops });
    const handle = await t.engine.start(def, { cwd: await tempDir(), input: {} });
    handle.result.catch(() => undefined);
    await started.promise;
    try {
      await t.engine.cancel(handle.runId);
      await expect(handle.result).rejects.toBeTruthy();
    } finally {
      release.resolve();
    }
    await new Promise((done) => setImmediate(done));
    const state = await t.engine.state(handle.runId);
    expect(state.status).toBe("cancelled");
    expect(state.attention).toHaveLength(1);
    const events = [];
    for await (const record of t.journal.read(handle.runId)) events.push(record.ev.type);
    expect(events).toContain("operation.intent");
    expect(events).not.toContain("operation.receipt");
  });
});

describe("owned-workspace descendant cleanup guards", () => {
  test.each(["active", "uncertain", "nonterminal", "unrelated", "settled"] as const)(
    "%s descendant must be accounted for before deleting the root worktree",
    async (scenario) => {
      const cwd = await tempRepo();
      const leaf = defineWorkflow({ ...meta, name: "cleanup-leaf", workspace: undefined }, async (ctx) => {
        if (scenario === "uncertain") await ctx.operation(operation, {}, { key: "uncertain" });
        return { id: "leaf" };
      });
      const child = defineWorkflow({ ...meta, name: "cleanup-child", workspace: undefined }, async (ctx) =>
        ctx.workflow(leaf, {}, { key: "leaf" }),
      );
      const root = defineWorkflow(meta, async (ctx) => {
        await ctx.exec("node", ["-e", "require('node:fs').writeFileSync('README.md','retained commit\\n')"], {
          key: "write",
        });
        await ctx.git.add({ paths: ["README.md"], key: "stage" });
        await ctx.git.commit({ message: "retained owned change", key: "commit" });
        // A workflow may handle a child failure without resolving its uncertain remote effect.
        await ctx.workflow(child, {}, { key: "child" }).catch(() => undefined);
        return { id: "terminal-root" };
      });
      const t = testEngine({
        config,
        operations: {
          publish: {
            risk: "low",
            execute: async () => {
              throw new Error("acknowledgment lost after possible remote application");
            },
            reconcile: async () => ({ status: "unknown", detail: "remote outcome is unresolved" }),
          },
        },
      });
      const handle = await t.engine.start(root, { cwd, input: {} });
      await handle.result;
      const state = await t.engine.state(handle.runId);
      expect(state.status).toBe("complete");
      expect(state.attention ?? []).toHaveLength(0);
      const workspace = state.workspace!;
      const childId = state.children[0]!.childRunId;
      const leafId = (await t.engine.state(childId)).children[0]!.childRunId;
      const activeLease = scenario === "active" ? await t.journal.acquireRun(leafId) : undefined;
      if (scenario === "active") expect(activeLease).toBeDefined();
      if (scenario === "nonterminal") {
        // Model a process dying after marking the descendant executing but before terminal append.
        await t.journal.append(leafId, [{ type: "run.status", status: "executing" }]);
      }
      if (scenario === "unrelated") {
        const unrelated = await t.engine.start(leaf, { cwd: await tempDir(), input: {} });
        await unrelated.result;
        for await (const record of t.journal.read(childId)) {
          if (record.ev.type === "step.scheduled" && record.ev.childRunId) {
            // A corrupt pointer must not adopt a real journal whose parent is somebody else.
            await t.journal.append(childId, [{ ...record.ev, childRunId: unrelated.runId }]);
            break;
          }
        }
      }
      try {
        if (scenario !== "settled") {
          await expect(cleanupOwnedWorkspace(t.journal, handle.runId)).rejects.toMatchObject({
            code: scenario === "active" ? "conflict" : "recovery_required",
          });
          expect(await readFile(join(workspace.path, "README.md"), "utf8")).toBe("retained commit\n");
          expect((await t.engine.state(handle.runId)).workspace?.retained).toBe(true);
          // A failed cleanup must release every claim it acquired before finding the blocker.
          for (const id of [handle.runId, childId]) {
            const released = await t.journal.acquireRun(id);
            expect(released).toBeDefined();
            await released?.release();
          }
        }
      } finally {
        await activeLease?.release();
      }
      if (scenario === "settled" || scenario === "active") {
        expect(await cleanupOwnedWorkspace(t.journal, handle.runId)).toEqual({
          path: workspace.path,
          branch: meta.workspace.branch,
        });
        await expect(readFile(join(workspace.path, "README.md"))).rejects.toMatchObject({ code: "ENOENT" });
        expect((await execa("git", ["show", `${meta.workspace.branch}:README.md`], { cwd })).stdout).toBe(
          "retained commit",
        );
        expect((await t.engine.state(handle.runId)).workspace?.retained).toBe(false);
      }
    },
  );
});
