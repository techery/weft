import { existsSync } from "node:fs";
import { readFile, symlink } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import {
  type AgentProvider,
  Budget,
  Engine,
  type JournalEvent,
  type JournalRecord,
  MemoryBlobStore,
  MemoryJournalStore,
  ProviderRegistry,
  ReplayIndex,
  reduceState,
} from "@weft/core";
import { mock } from "@weft/provider-mock";
import { defineWorkflow, z } from "@weft/sdk";
import { execa } from "execa";
import { afterAll, describe, expect, test, vi } from "vitest";
import { cleanupRepos, reopen, tempDir, tempRepo, testEngine } from "./helpers.ts";

afterAll(cleanupRepos);

async function records(journal: { read(runId: string): AsyncIterable<JournalRecord> }, runId: string) {
  const out: JournalRecord[] = [];
  for await (const rec of journal.read(runId)) out.push(rec);
  return out;
}

describe("review regressions: replay & durability", () => {
  test("a resumed sleep anchors to its ORIGINAL schedule time, not the resume time", async () => {
    const def = defineWorkflow(
      { name: "sleepy", description: "s", input: z.object({}), output: z.object({ ok: z.boolean() }) },
      async (ctx) => {
        await ctx.sleep(600);
        return { ok: true };
      },
    );
    const t1 = testEngine();
    const cwd = await tempDir();
    const h1 = await t1.engine.start(def, { input: {}, cwd });
    await new Promise((r) => setTimeout(r, 250));
    await t1.engine.cancel(h1.runId); // abandon mid-sleep; the run stays resumable

    const t2 = reopen(t1);
    const h2 = await t2.engine.resume(h1.runId, { def });
    expect(await h2.result).toEqual({ ok: true });
    const recs = await records(t2.journal, h1.runId);
    const firstScheduled = recs.find((r) => r.ev.type === "step.scheduled" && r.ev.kind === "sleep");
    const fired = recs.find((r) => r.ev.type === "timer.fired")?.ev;
    if (!firstScheduled || fired?.type !== "timer.fired") throw new Error("missing sleep events");
    // deadline = ORIGINAL scheduledAt + 600, exactly — never resumeAt + 600
    expect(fired.deadline).toBe(firstScheduled.at + 600);
  });

  test("a replayed signal step consumes its payload: the next wait never sees it", async () => {
    const def = defineWorkflow(
      {
        name: "sig2",
        description: "s",
        input: z.object({}),
        output: z.object({ a: z.number(), b: z.number() }),
      },
      async (ctx) => {
        const first = await ctx.signal("go", z.object({ n: z.number() }));
        const second = await ctx.signal("go", z.object({ n: z.number() }));
        return { a: first.n, b: second.n };
      },
    );
    const t1 = testEngine();
    const cwd = await tempDir();
    const h1 = await t1.engine.start(def, { input: {}, cwd });
    await h1.outcome(); // waiting on first signal
    await t1.engine.signal(h1.runId, "go", { n: 1 });
    await new Promise((r) => setTimeout(r, 100)); // first step completes; now waiting on second
    await t1.engine.cancel(h1.runId);

    const t2 = reopen(t1);
    const h2 = await t2.engine.resume(h1.runId, { def });
    const outcome = await h2.outcome();
    // the stale {n:1} must NOT satisfy the second wait
    expect(outcome.status).toBe("waiting_for_signal");
    await t2.engine.signal(h1.runId, "go", { n: 2 });
    expect(await h2.result).toEqual({ a: 1, b: 2 });
  });

  test("the budget ceiling survives resume", async () => {
    const def = defineWorkflow(
      { name: "budgeted", description: "b", input: z.object({}), output: z.object({}) },
      async (ctx) => {
        await ctx.agent("one", { schema: z.object({ ok: z.boolean() }), key: "s1" });
        await ctx.human.approve({ action: "continue?" });
        await ctx.agent("two", { schema: z.object({ ok: z.boolean() }), key: "s2" });
        return {};
      },
    );
    const t1 = testEngine();
    t1.builder.on({ key: "*" }, { ok: true }, { usage: { input: 800, output: 300 } });
    const cwd = await tempDir();
    const h1 = await t1.engine.start(def, { input: {}, cwd, budget: { tokens: 1000 } });
    const o1 = await h1.outcome();
    if (o1.status !== "waiting_for_human") throw new Error("expected suspension");
    await t1.engine.answer(h1.runId, o1.pending[0]!.id, { approved: true });
    await h1.result.catch(() => undefined);

    // Even if the first process died right after the answer, a fresh engine must
    // still enforce the journaled ceiling: s1 spent 1100 of 1000.
    const t2 = reopen(t1);
    t2.builder.on({ key: "*" }, { ok: true }, { usage: { input: 800, output: 300 } });
    const h2 = await t2.engine.resume(h1.runId, { def });
    await expect(h2.result).rejects.toMatchObject({ code: "budget_exceeded" });
  });

  test("cancel of a run waiting on a gate ends cancelled — never complete", async () => {
    const def = defineWorkflow(
      { name: "gated", description: "g", input: z.object({}), output: z.object({ ok: z.boolean() }) },
      async (ctx) => {
        const go = await ctx.gate({ action: "git.push origin/main", risk: "high" });
        return { ok: go.approved };
      },
    );
    const t = testEngine();
    const handle = await t.engine.start(def, { input: {}, cwd: await tempDir() });
    await handle.outcome();
    await t.engine.cancel(handle.runId);
    await expect(handle.result).rejects.toMatchObject({ code: "cancelled" });
    const recs = await records(t.journal, handle.runId);
    expect(recs.some((r) => r.ev.type === "run.cancelled")).toBe(true);
    expect(recs.some((r) => r.ev.type === "run.completed")).toBe(false);
  });

  test("cancel of a run blocked in ctx.signal resolves promptly", async () => {
    const def = defineWorkflow(
      { name: "sigwait", description: "s", input: z.object({}), output: z.object({}) },
      async (ctx) => {
        await ctx.signal("never", z.object({}));
        return {};
      },
    );
    const t = testEngine();
    const handle = await t.engine.start(def, { input: {}, cwd: await tempDir() });
    await handle.outcome();
    const started = Date.now();
    await t.engine.cancel(handle.runId);
    expect(Date.now() - started).toBeLessThan(1_000);
    await expect(handle.result).rejects.toMatchObject({ code: "cancelled" });
  });

  test("resume after a terminal failure re-executes instead of returning the old failure", async () => {
    const def = defineWorkflow(
      { name: "flaky2", description: "f", input: z.object({}), output: z.object({ ok: z.boolean() }) },
      async (ctx) => {
        const r = await ctx.agent("do", { schema: z.object({ ok: z.boolean() }), key: "only", repair: 0 });
        return { ok: r.ok };
      },
    );
    const t = testEngine();
    t.builder.on({ key: "only" }, { wrong: 1 }, { times: 1 });
    t.builder.on({ key: "only" }, { ok: true });
    const cwd = await tempDir();
    const h1 = await t.engine.start(def, { input: {}, cwd });
    await expect(h1.result).rejects.toMatchObject({ code: "schema_repair_exhausted" });
    // the SAME engine instance must replay (the active map is cleared at terminal)
    const h2 = await t.engine.resume(h1.runId, { def });
    expect(await h2.result).toEqual({ ok: true });
  });

  test("integrate replay serves already-merged patches without phantom conflicts", async () => {
    const FixResult = z.object({ summary: z.string() });
    const def = defineWorkflow(
      {
        name: "twofix",
        description: "t",
        input: z.object({}),
        output: z.object({ merged: z.array(z.string()) }),
      },
      async (ctx) => {
        const fixes = ctx.ok(
          await ctx.parallel([
            ctx.agent.detailed("a", { schema: FixResult, key: "fix:1", write: { paths: ["a.txt"] } }),
            ctx.agent.detailed("b", { schema: FixResult, key: "fix:2", write: { paths: ["b.txt"] } }),
          ]),
        );
        fixes.sort((x, y) => (x.patch!.key < y.patch!.key ? -1 : 1));
        const ledger = await ctx.integrate(fixes);
        await ctx.human.approve({ action: "publish?" });
        return { merged: ledger.merged };
      },
    );
    const t1 = testEngine();
    t1.builder.on({ key: "fix:1" }, { summary: "a" }, { writes: { "a.txt": "one\n" } });
    t1.builder.on({ key: "fix:2" }, { summary: "b" }, { writes: { "b.txt": "two\n" } });
    const cwd = await tempRepo({ "a.txt": "base\n", "b.txt": "base\n" });
    const h1 = await t1.engine.start(def, { input: {}, cwd });
    const o1 = await h1.outcome();
    if (o1.status !== "waiting_for_human") throw new Error(`expected gate, got ${o1.status}`);
    // answer out of process, resume in a fresh engine with NO fixtures
    const t2 = reopen(t1);
    await t2.engine.answer(h1.runId, o1.pending[0]!.id, { approved: true });
    const t3 = reopen(t1);
    const h2 = await t3.engine.resume(h1.runId, { def });
    const out = (await h2.result) as { merged: string[] };
    expect(out.merged).toEqual(["fix:1", "fix:2"]);
    expect(t3.builder.calls).toHaveLength(0);
    const pending = await t3.engine.pending(h1.runId);
    expect(pending).toHaveLength(0);
  });

  test("a journal-served exec step never re-resolves its secret", async () => {
    process.env.WEFT_REGRESSION_SECRET = "s3cret!";
    const def = defineWorkflow(
      { name: "sec", description: "s", input: z.object({}), output: z.object({ len: z.number() }) },
      async (ctx) => {
        const r = await ctx.exec("node", ["-e", "console.log((process.env.T ?? '').length)"], {
          env: { T: ctx.secret("WEFT_REGRESSION_SECRET") },
        });
        await ctx.human.approve({ action: "continue?" });
        return { len: Number(r.stdout.trim()) };
      },
    );
    const t1 = testEngine();
    const cwd = await tempDir();
    const h1 = await t1.engine.start(def, { input: {}, cwd });
    const o1 = await h1.outcome();
    if (o1.status !== "waiting_for_human") throw new Error("expected suspension");
    await t1.engine.answer(h1.runId, o1.pending[0]!.id, { approved: true });
    await h1.result;

    delete process.env.WEFT_REGRESSION_SECRET; // the secret is GONE
    const t2 = reopen(t1);
    const h2 = await t2.engine.resume(h1.runId, { def });
    expect(await h2.result).toEqual({ len: 7 }); // served from the journal, env untouched
  });
});

describe("review regressions: semantics", () => {
  test("human.ask with an enum schema is answerable ({ value } on the wire, unwrapped in code)", async () => {
    const def = defineWorkflow(
      { name: "enumask", description: "e", input: z.object({}), output: z.object({ module: z.string() }) },
      async (ctx) => {
        const module = await ctx.human.ask({ question: "Which module?", schema: z.enum(["auth", "api"]) });
        return { module };
      },
    );
    const t = testEngine();
    const handle = await t.engine.start(def, { input: {}, cwd: await tempDir() });
    const outcome = await handle.outcome();
    if (outcome.status !== "waiting_for_human") throw new Error("expected ask");
    const id = outcome.pending[0]!.id;
    // a bare string fails the (wrapped) journaled schema…
    await expect(t.engine.answer(handle.runId, id, "auth")).rejects.toMatchObject({ code: "invalid_answer" });
    // …and a bad enum value fails the real schema even when wrapped
    await expect(t.engine.answer(handle.runId, id, { value: "billing" })).rejects.toMatchObject({
      code: "invalid_answer",
    });
    await t.engine.answer(handle.runId, id, { value: "auth" });
    expect(await handle.result).toEqual({ module: "auth" });
  });

  test("workflow defaults route provider AND model together", async () => {
    const def = defineWorkflow(
      {
        name: "codexish",
        description: "c",
        input: z.object({}),
        output: z.object({}),
        defaults: { provider: "codex", model: "gpt-5-codex-max", effort: "low" },
      },
      async (ctx) => {
        await ctx.agent("go", { schema: z.object({ ok: z.boolean() }), key: "a" });
        return {};
      },
    );
    const t = testEngine();
    t.builder.on({ key: "a" }, { ok: true });
    const handle = await t.engine.start(def, { input: {}, cwd: await tempDir() });
    await handle.result;
    expect(t.builder.calls[0]).toMatchObject({ model: "gpt-5-codex-max", effort: "low" });
    const recs = await records(t.journal, handle.runId);
    const route = recs.find((r) => r.ev.type === "step.scheduled" && r.ev.kind === "agent");
    expect(route?.ev.type === "step.scheduled" ? route.ev.route : undefined).toMatchObject({
      provider: "codex",
      model: "gpt-5-codex-max",
    });
  });

  test("a step timeout aborts the in-flight provider call and retries get a fresh signal", async () => {
    const def = defineWorkflow(
      { name: "slowpoke", description: "s", input: z.object({}), output: z.object({ ok: z.boolean() }) },
      async (ctx) => {
        const r = await ctx.agent("slow", {
          schema: z.object({ ok: z.boolean() }),
          key: "slow",
          timeout: 150,
          retry: { attempts: 1, backoff: 10 },
        });
        return { ok: r.ok };
      },
    );
    const t = testEngine();
    let responded = 0;
    t.builder.on(
      { key: "slow" },
      () => {
        responded++;
        return { ok: true };
      },
      { delayMs: 30_000, times: 1 },
    );
    t.builder.on({ key: "slow" }, () => {
      responded++;
      return { ok: true };
    });
    const started = Date.now();
    const handle = await t.engine.start(def, { input: {}, cwd: await tempDir() });
    // attempt 1's 30s delay is torn down by the engine-side abort (timeout + 1s
    // grace); attempt 2 gets a FRESH signal and succeeds promptly.
    expect(await handle.result).toEqual({ ok: true });
    expect(responded).toBe(1); // the aborted attempt never reached its responder
    expect(Date.now() - started).toBeLessThan(5_000);
    const recs = await records(t.journal, handle.runId);
    expect(recs.some((r) => r.ev.type === "step.attempt" && r.ev.detail?.startsWith("retry after"))).toBe(
      true,
    );
  });

  test("the global limiter caps un-capped bash fan-out", async () => {
    const t = testEngine({ config: { limits: { concurrency: 2 } } });
    const cwd = await tempDir();
    const def = defineWorkflow(
      { name: "fan", description: "f", input: z.object({}), output: z.object({ n: z.number() }) },
      async (ctx) => {
        const settled = await ctx.parallel(
          Array.from({ length: 6 }, (_, i) => ctx.bash(`sleep 0.15 && echo ${i}`, { key: `b${i}` })),
        );
        return { n: ctx.ok(settled).length };
      },
    );
    const started = Date.now();
    const handle = await t.engine.start(def, { input: {}, cwd });
    expect(await handle.result).toEqual({ n: 6 });
    // 6 × 150ms at concurrency 2 needs ≥ 3 waves; unbounded would finish in ~1 wave
    expect(Date.now() - started).toBeGreaterThan(400);
  });
});

describe("codex review findings (PR #1)", () => {
  test("a later write agent's worktree sees patches an earlier integrate left uncommitted", async () => {
    const FixResult = z.object({ summary: z.string() });
    const t = testEngine();
    t.builder.on(
      { key: "fix:first" },
      { summary: "v2" },
      { writes: { "config.ts": "export const version = 2;\n" } },
    );
    // the second agent READS the file from its worktree and derives its edit from it
    t.builder.on({ key: "fix:second" }, async (req) => {
      const { readFile: rf, writeFile: wf } = await import("node:fs/promises");
      const { join: j } = await import("node:path");
      const seen = await rf(j(req.cwd, "config.ts"), "utf8");
      await wf(j(req.cwd, "notes.md"), `saw: ${seen.trim()}\n`);
      return { summary: `built on: ${seen.trim()}` };
    });
    const cwd = await tempRepo({ "config.ts": "export const version = 1;\n" });
    const def = defineWorkflow(
      { name: "rounds", description: "r", input: z.object({}), output: z.object({ second: z.string() }) },
      async (ctx) => {
        const first = await ctx.agent.detailed("bump", {
          schema: FixResult,
          key: "fix:first",
          write: { paths: ["config.ts"] },
        });
        await ctx.integrate([first]);
        // the tree now holds version 2, UNCOMMITTED — round two must build on it
        const second = await ctx.agent.detailed("annotate", {
          schema: FixResult,
          key: "fix:second",
          write: { paths: ["notes.md"] },
        });
        await ctx.integrate([second]);
        return { second: second.value.summary };
      },
    );
    const handle = await t.engine.start(def, { input: {}, cwd });
    expect(await handle.result).toEqual({ second: "built on: export const version = 2;" });
    const { readFile: rf } = await import("node:fs/promises");
    const { join: j } = await import("node:path");
    expect(await rf(j(cwd, "notes.md"), "utf8")).toBe("saw: export const version = 2;\n");
  });

  test("conflict rollback restores an untracked file instead of deleting it", async () => {
    const FixResult = z.object({ summary: z.string() });
    const t = testEngine();
    t.builder.on(
      { key: "fix:notes" },
      { summary: "rewrote notes" },
      { writes: { "NOTES.md": "the agent's notes\n" } },
    );
    const cwd = await tempRepo({ "code.ts": "x\n" });
    // the user's own UNTRACKED file, present before the run
    const { writeFile: wf, readFile: rf } = await import("node:fs/promises");
    const { join: j } = await import("node:path");
    await wf(j(cwd, "NOTES.md"), "v1 user notes\n");
    const def = defineWorkflow(
      { name: "collide", description: "c", input: z.object({}), output: z.object({ failed: z.boolean() }) },
      async (ctx) => {
        const fix = await ctx.agent.detailed("rewrite notes", {
          schema: FixResult,
          key: "fix:notes",
          write: { paths: ["NOTES.md"] },
        });
        // the integration tree moves on AFTER capture: the patch's context (v1) no
        // longer matches, so integrate must conflict and roll back to THIS state
        await ctx.bash("printf 'v2 user notes\\n' > NOTES.md");
        try {
          await ctx.integrate([fix], { onConflict: "fail" });
          return { failed: false };
        } catch (err) {
          if ((err as { code?: string }).code === "conflict") {
            await ctx.discard([fix]);
            return { failed: true };
          }
          throw err;
        }
      },
    );
    const handle = await t.engine.start(def, { input: {}, cwd });
    expect(await handle.result).toEqual({ failed: true });
    // the untracked file survived the rollback at its pre-integrate content —
    // the old stash-create snapshot could not represent it and DELETED it here
    expect(await rf(j(cwd, "NOTES.md"), "utf8")).toBe("v2 user notes\n");
  });

  test("a signal sent before the waiter registers is buffered, not lost", async () => {
    const t = testEngine();
    const def = defineWorkflow(
      { name: "early-signal", description: "e", input: z.object({}), output: z.object({ sha: z.string() }) },
      async (ctx) => {
        await ctx.sleep(300); // busy in an earlier step while the webhook arrives
        const payload = await ctx.signal("ci-done", z.object({ sha: z.string() }));
        return { sha: payload.sha };
      },
    );
    const handle = await t.engine.start(def, { input: {}, cwd: await tempDir() });
    await new Promise((r) => setTimeout(r, 60)); // mid-sleep: no waiter registered yet
    await t.engine.signal(handle.runId, "ci-done", { sha: "abc123" });
    expect(await handle.result).toEqual({ sha: "abc123" });
  });
});

describe("codex review findings, round 2 (PR #1)", () => {
  test("schema-repair turns all count against the budget, success and failure alike", async () => {
    const t = testEngine();
    let flakyCalls = 0;
    t.builder.on({ key: "flaky" }, () => (++flakyCalls === 1 ? { wrong: true } : { ok: true }), {
      usage: { input: 100, output: 50 },
    });
    t.builder.on({ key: "hopeless" }, { never: "valid" }, { usage: { input: 100, output: 50 } });
    const def = defineWorkflow(
      { name: "spendy", description: "s", input: z.object({}), output: z.object({ spent: z.number() }) },
      async (ctx) => {
        await ctx.agent("flaky", { schema: z.object({ ok: z.boolean() }), key: "flaky" }); // 1 turn + 1 repair
        try {
          await ctx.agent("hopeless", { schema: z.object({ ok: z.boolean() }), key: "hopeless" }); // 3 turns, all invalid
        } catch (err) {
          if ((err as { code?: string }).code !== "schema_repair_exhausted") throw err;
        }
        return { spent: ctx.budget.spent.tokens };
      },
    );
    const handle = await t.engine.start(def, { input: {}, cwd: await tempDir() });
    // 2 turns for flaky + 3 turns for hopeless (initial + 2 repairs), 150 tokens each
    expect(await handle.result).toEqual({ spent: 750 });
    const recs = await records(t.journal, handle.runId);
    const completed = recs.find((r) => r.ev.type === "step.completed" && r.ev.seq === 1)?.ev;
    if (completed?.type !== "step.completed") throw new Error("missing completion");
    expect(completed.usage).toMatchObject({ input: 200, output: 100 }); // both turns journaled
  });

  test("an answer appended by another engine reaches the run this engine is holding", async () => {
    const def = defineWorkflow(
      { name: "held", description: "h", input: z.object({}), output: z.object({ ok: z.boolean() }) },
      async (ctx) => {
        const go = await ctx.human.approve({ action: "proceed?" });
        return { ok: go.approved };
      },
    );
    const t1 = testEngine();
    const h1 = await t1.engine.start(def, { input: {}, cwd: await tempDir() });
    const o1 = await h1.outcome();
    if (o1.status !== "waiting_for_human") throw new Error("expected suspension");
    // a SECOND engine (another process) answers — no resume call anywhere
    const t2 = reopen(t1);
    await t2.engine.answer(h1.runId, o1.pending[0]!.id, { approved: true });
    // the owning engine's journal tailer delivers it to the suspended wait
    expect(await h1.result).toEqual({ ok: true });
    // ...and folds the externally appended record into the active projection, so the
    // terminal snapshot shows the request answered, never still pending.
    const snap = await t1.journal.readSnapshot(h1.runId);
    const humans = (snap?.state as { humans?: Array<{ status: string }> } | undefined)?.humans;
    expect(humans?.[0]?.status).toBe("answered");
  });

  test("a cancel appended by another engine aborts the run this engine is holding", async () => {
    const def = defineWorkflow(
      { name: "heldcancel", description: "h", input: z.object({}), output: z.object({}) },
      async (ctx) => {
        await ctx.gate({ action: "git.push origin/main", risk: "high" });
        return {};
      },
    );
    const t1 = testEngine();
    const h1 = await t1.engine.start(def, { input: {}, cwd: await tempDir() });
    await h1.outcome();
    const t2 = reopen(t1);
    await t2.engine.cancel(h1.runId); // inactive in t2: appends run.cancelled only
    await expect(h1.result).rejects.toMatchObject({ code: "cancelled" });
    const state = await t1.engine.state(h1.runId);
    expect(state.status).toBe("cancelled");
    expect(state.output).toBeUndefined(); // never records complete
  });
});

describe("codex review findings, round 3 (PR #1)", () => {
  test("run.created reaches active-run projections for fresh starts and children", async () => {
    const child = defineWorkflow(
      { name: "child-state", description: "c", input: z.object({}), output: z.object({ ok: z.boolean() }) },
      async (ctx) => {
        await ctx.human.approve({ action: "child gate" });
        return { ok: true };
      },
    );
    const def = defineWorkflow(
      {
        name: "parent-state",
        description: "p",
        input: z.object({ tag: z.string() }),
        output: z.object({ ok: z.boolean() }),
      },
      async (ctx, input) => {
        await ctx.human.approve({ action: "parent gate" });
        const r = (await ctx.workflow(child, {})) as { ok: boolean };
        return { ok: r.ok && input.tag === "t" };
      },
    );
    const t = testEngine();
    const h = await t.engine.start(def, { input: { tag: "t" }, cwd: await tempDir() });
    const o1 = await h.outcome();
    if (o1.status !== "waiting_for_human") throw new Error("expected suspension");

    // The run was started, not resumed: state() reduces the in-memory records,
    // which must include the seeded run.created or the run has no identity.
    const parentState = await t.engine.state(h.runId);
    expect(parentState).toMatchObject({ runId: h.runId, workflow: "parent-state", input: { tag: "t" } });
    expect(parentState.createdAt).toBeGreaterThan(0);

    await t.engine.answer(h.runId, o1.pending[0]!.id, { approved: true });
    // The child gets its own journal; find it once it suspends on its gate.
    let childId: string | undefined;
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      const runs = await t.journal.list();
      childId = runs.find((r) => r.parentRunId === h.runId)?.runId;
      if (childId && (await t.engine.state(childId)).status === "waiting_for_human") break;
      await new Promise((r) => setTimeout(r, 25));
    }
    if (!childId) throw new Error("child run never appeared");
    const childState = await t.engine.state(childId);
    expect(childState).toMatchObject({ runId: childId, workflow: "child-state", parentRunId: h.runId });
    expect(childState.createdAt).toBeGreaterThan(0);

    const [pending] = await t.engine.pending(childId);
    await t.engine.answer(childId, pending!.id, { approved: true });
    expect(await h.result).toEqual({ ok: true });
  });

  test("a non-owning answer is checked against the wire schema's constraints, not just types", async () => {
    const def = defineWorkflow(
      { name: "asky", description: "a", input: z.object({}), output: z.object({ name: z.string() }) },
      async (ctx) => {
        const a = await ctx.human.ask({ question: "name?", schema: z.object({ name: z.string().min(3) }) });
        return { name: a.name };
      },
    );
    const t1 = testEngine();
    const h1 = await t1.engine.start(def, { input: {}, cwd: await tempDir() });
    const o1 = await h1.outcome();
    if (o1.status !== "waiting_for_human") throw new Error("expected suspension");
    const id = o1.pending[0]!.id;
    await t1.engine.cancel(h1.runId); // abandon: the answers below take the non-owning path

    // minLength rides the wire schema; a host without the real schema must still enforce it
    const t2 = reopen(t1);
    await expect(t2.engine.answer(h1.runId, id, { name: "ab" })).rejects.toMatchObject({
      code: "invalid_answer",
    });
    await t2.engine.answer(h1.runId, id, { name: "abc" });
    const h2 = await reopen(t2).engine.resume(h1.runId, { def });
    expect(await h2.result).toEqual({ name: "abc" });
  });

  test("an answer that fails the real schema re-opens the request instead of failing the run", async () => {
    // .refine() is invisible to JSON Schema, so a non-owning host cannot catch this.
    const magic = z.object({ name: z.string().refine((v) => v === "magic", "must be magic") });
    const def = defineWorkflow(
      { name: "refined", description: "r", input: z.object({}), output: z.object({ name: z.string() }) },
      async (ctx) => {
        const a = await ctx.human.ask({ question: "say the word", schema: magic });
        return { name: a.name };
      },
    );
    const t1 = testEngine();
    const h1 = await t1.engine.start(def, { input: {}, cwd: await tempDir() });
    const o1 = await h1.outcome();
    if (o1.status !== "waiting_for_human") throw new Error("expected suspension");
    const id = o1.pending[0]!.id;
    await t1.engine.cancel(h1.runId);

    const t2 = reopen(t1);
    await t2.engine.answer(h1.runId, id, { name: "wrong" }); // passes the wire schema

    // The resume must reject it on the record and wait again — never fail the run
    // (the journal says "answered", so a failure here could never be re-answered).
    const t3 = reopen(t2);
    const h3 = await t3.engine.resume(h1.runId, { def });
    const o3 = await h3.outcome();
    expect(o3.status).toBe("waiting_for_human");
    const recs = await records(t3.journal, h1.runId);
    expect(recs.some((r) => r.ev.type === "human.rejected" && r.ev.id === id)).toBe(true);
    const state = await t3.engine.state(h1.runId);
    expect(state.humans.find((h) => h.id === id)?.status).toBe("pending");

    // The rejection re-opens the answered-guard: a replacement completes the run.
    await t3.engine.answer(h1.runId, id, { name: "magic" });
    expect(await h3.result).toEqual({ name: "magic" });
  });

  test("a live run rejects a bad remote answer and accepts the replacement", async () => {
    const magic = z.object({ word: z.string().refine((v) => v === "magic", "must be magic") });
    const def = defineWorkflow(
      { name: "live-refined", description: "r", input: z.object({}), output: z.object({ word: z.string() }) },
      async (ctx) => {
        const a = await ctx.human.ask({ question: "word?", schema: magic });
        return { word: a.word };
      },
    );
    const t1 = testEngine();
    const h1 = await t1.engine.start(def, { input: {}, cwd: await tempDir() });
    const o1 = await h1.outcome();
    if (o1.status !== "waiting_for_human") throw new Error("expected suspension");
    const id = o1.pending[0]!.id;

    // A second engine (another process) answers with something the refine refuses;
    // the owning engine's tailer delivers it, rejects it, and keeps waiting.
    const t2 = reopen(t1);
    await t2.engine.answer(h1.runId, id, { word: "wrong" });
    const deadline = Date.now() + 5_000;
    for (;;) {
      const recs = await records(t1.journal, h1.runId);
      if (recs.some((r) => r.ev.type === "human.rejected" && r.ev.id === id)) break;
      if (Date.now() > deadline) throw new Error("rejection never journaled");
      await new Promise((r) => setTimeout(r, 20));
    }
    expect((await h1.outcome()).status).toBe("waiting_for_human");

    await t2.engine.answer(h1.runId, id, { word: "magic" });
    expect(await h1.result).toEqual({ word: "magic" });
  });

  test("an answer landing while a resume is mid-replay is buffered, not dropped", async () => {
    const def = defineWorkflow(
      { name: "racy", description: "r", input: z.object({}), output: z.object({ ok: z.boolean() }) },
      async (ctx) => {
        await ctx.agent("one", { schema: z.object({ ok: z.boolean() }), key: "a1" });
        await ctx.agent("two", { schema: z.object({ ok: z.boolean() }), key: "a2" });
        const g = await ctx.human.approve({ action: "ship it" });
        return { ok: g.approved };
      },
    );
    const t1 = testEngine();
    t1.builder.on({ key: "*" }, { ok: true });
    const h1 = await t1.engine.start(def, { input: {}, cwd: await tempDir() });
    const o1 = await h1.outcome();
    if (o1.status !== "waiting_for_human") throw new Error("expected suspension");
    const id = o1.pending[0]!.id;
    await t1.engine.cancel(h1.runId);

    // Resume, then answer immediately from ANOTHER engine: the answer lands after the
    // resume read the journal, so only the owner's tailer can deliver it — usually
    // before the replayed workflow re-registers the wait. It must be buffered until
    // the waiter shows up, never dropped.
    const t2 = reopen(t1);
    const h2 = await t2.engine.resume(h1.runId, { def });
    await reopen(t2).engine.answer(h1.runId, id, { approved: true });
    expect(await h2.result).toEqual({ ok: true });
  });
});

describe("codex review findings, round 4 (PR #1)", () => {
  test("a run held by one engine cannot be woken into a second runtime by another", async () => {
    const def = defineWorkflow(
      { name: "held-run", description: "h", input: z.object({}), output: z.object({ ok: z.boolean() }) },
      async (ctx) => {
        const go = await ctx.human.approve({ action: "go?" });
        return { ok: go.approved };
      },
    );
    const t1 = testEngine();
    const h1 = await t1.engine.start(def, { input: {}, cwd: await tempDir() });
    const o1 = await h1.outcome();
    if (o1.status !== "waiting_for_human") throw new Error("expected suspension");

    // Another process may answer, but must never EXECUTE the run concurrently.
    const t2 = reopen(t1);
    await expect(t2.engine.resume(h1.runId, { def })).rejects.toThrow(/active in another process/);

    await t2.engine.answer(h1.runId, o1.pending[0]!.id, { approved: true });
    expect(await h1.result).toEqual({ ok: true });
    // The terminal run released its claim: a later engine replays freely.
    const h2 = await t2.engine.resume(h1.runId, { def });
    expect(await h2.result).toEqual({ ok: true });
  });

  test("replay's restored spend includes failed attempts", async () => {
    const t1 = testEngine();
    t1.builder.on({ key: "wonky" }, { never: true }, { usage: { input: 300, output: 100 } });
    const def = defineWorkflow(
      { name: "lossy", description: "l", input: z.object({}), output: z.object({}) },
      async (ctx) => {
        try {
          await ctx.agent("wonky", { schema: z.object({ ok: z.boolean() }), key: "wonky" });
        } catch (err) {
          if ((err as { code?: string }).code !== "schema_repair_exhausted") throw err;
        }
        return {};
      },
    );
    const h1 = await t1.engine.start(def, { input: {}, cwd: await tempDir() });
    expect(await h1.result).toEqual({});
    const recs = await records(t1.journal, h1.runId);
    // 3 repair turns × 400 tokens, every one failed: the completion event never
    // carries them, so the failure record must — or a resume under-restores.
    expect(ReplayIndex.fromRecords(recs).totalUsage.tokens).toBe(1200);
  });

  test("parallel agent calls cannot collectively blow through the budget", async () => {
    const t = testEngine();
    t.builder.on({ key: "*" }, { ok: true }, { usage: { input: 500, output: 100 } });
    const def = defineWorkflow(
      {
        name: "swarm",
        description: "s",
        input: z.object({}),
        output: z.object({ done: z.number(), refused: z.number(), spent: z.number() }),
      },
      async (ctx) => {
        const results = await Promise.allSettled(
          ["a", "b", "c", "d"].map((k) => ctx.agent(k, { schema: z.object({ ok: z.boolean() }), key: k })),
        );
        const done = results.filter((r) => r.status === "fulfilled").length;
        const refused = results.filter(
          (r) => r.status === "rejected" && (r.reason as { code?: string }).code === "budget_exceeded",
        ).length;
        return { done, refused, spent: ctx.budget.spent.tokens };
      },
    );
    const h = await t.engine.start(def, { input: {}, cwd: await tempDir(), budget: { tokens: 1000 } });
    const out = (await h.result) as { done: number; refused: number; spent: number };
    // 4 × 600 against 1000: without a shared reservation every call dispatches and the
    // run spends 2400. With one, calls probe one at a time until a cost is observed —
    // the ceiling holds even though each refused sibling costs a budget_exceeded.
    expect(out.spent).toBeLessThanOrEqual(1000);
    expect(out.done).toBeGreaterThanOrEqual(1);
    expect(out.done + out.refused).toBe(4);
  });

  test("cancelling an already-terminal run never overwrites its outcome", async () => {
    const def = defineWorkflow(
      { name: "fin", description: "f", input: z.object({}), output: z.object({ ok: z.boolean() }) },
      async () => ({ ok: true }),
    );
    const t1 = testEngine();
    const h1 = await t1.engine.start(def, { input: {}, cwd: await tempDir() });
    expect(await h1.result).toEqual({ ok: true });

    // A stale UI cancel arriving after completion must not flip the projection.
    const t2 = reopen(t1);
    await expect(t2.engine.cancel(h1.runId)).rejects.toThrow(/already complete/);
    const state = await t2.engine.state(h1.runId);
    expect(state.status).toBe("complete");
    expect(state.output).toEqual({ ok: true });
  });

  test("a USD-only budget refuses a call whose cost cannot be known", async () => {
    const t = testEngine();
    t.builder.on({ key: "c" }, { ok: true }, { usage: { input: 100, output: 50 } });
    // Stand-in for the real Codex adapter: tokens only, no self-reported cost.
    const base = t.builder.provider("codex");
    t.engine.registerProvider({
      id: "codex",
      capabilities: () => ({ ...base.capabilities(), reportsUsd: false }),
      run: base.run.bind(base),
      repair: base.repair.bind(base),
    });
    const def = defineWorkflow(
      { name: "usd", description: "u", input: z.object({}), output: z.object({ ok: z.boolean() }) },
      async (ctx) => {
        const r = await ctx.agent("c", {
          schema: z.object({ ok: z.boolean() }),
          key: "c",
          provider: "codex",
        });
        return { ok: r.ok };
      },
    );
    // No price configured and no token ceiling: every call would charge $0 forever.
    const h1 = await t.engine.start(def, { input: {}, cwd: await tempDir(), budget: { usd: 5 } });
    await expect(h1.result).rejects.toMatchObject({ code: "invalid_input" });
    // A token ceiling backing the same USD budget makes the dispatch legal again.
    const h2 = await t.engine.start(def, {
      input: {},
      cwd: await tempDir(),
      budget: { usd: 5, tokens: 10_000 },
    });
    expect(await h2.result).toEqual({ ok: true });
  });

  test("a signal wait with a timeout fails as a timeout, never as a cancellation", async () => {
    const def = defineWorkflow(
      { name: "sigtimeout", description: "s", input: z.object({}), output: z.object({}) },
      async (ctx) => {
        await ctx.signal("never-arrives", z.object({}), { timeout: "150ms" });
        return {};
      },
    );
    const t = testEngine();
    const h = await t.engine.start(def, { input: {}, cwd: await tempDir() });
    // The timer's abort used to reject the wait with CancelledError first, which
    // journaled the whole run as cancelled (and skipped retries).
    await expect(h.result).rejects.toMatchObject({ code: "timeout" });
    expect((await t.engine.state(h.runId)).status).toBe("failed");
  });

  test("a fn check honours its timeout instead of hanging the run", async () => {
    let sawAbort = false;
    const def = defineWorkflow(
      { name: "hangcheck", description: "h", input: z.object({}), output: z.object({}) },
      async (ctx) => {
        await ctx.check("stuck", {
          fn: (signal) =>
            new Promise(() => {
              signal.addEventListener("abort", () => {
                sawAbort = true;
              });
            }),
          timeout: "150ms",
        });
        return {};
      },
    );
    const t = testEngine();
    const h = await t.engine.start(def, { input: {}, cwd: await tempDir() });
    // Like an exec check, the timeout records a FAILED check; the run itself finishes.
    expect(await h.result).toEqual({});
    const state = await t.engine.state(h.runId);
    expect(state.checks).toEqual([
      { name: "stuck", status: "fail", required: false, evidence: "check timed out after 150ms" },
    ]);
    // The fn was told to stop: abort-aware callbacks do not keep working past the timeout.
    expect(sawAbort).toBe(true);
  });
});

describe("codex review findings, round 5 (PR #1)", () => {
  test("shutdown disarms human deadline timers instead of leaving them to fire", async () => {
    const def = defineWorkflow(
      { name: "deadline", description: "d", input: z.object({}), output: z.object({ ok: z.boolean() }) },
      async (ctx) => {
        const go = await ctx.human.approve({
          action: "soon?",
          timeout: "200ms",
          onTimeout: { default: { approved: false } },
        });
        return { ok: go.approved };
      },
    );
    const t1 = testEngine();
    const h1 = await t1.engine.start(def, { input: {}, cwd: await tempDir() });
    const o1 = await h1.outcome();
    if (o1.status !== "waiting_for_human") throw new Error("expected suspension");
    await t1.engine.shutdown(); // the CLI exits; the NEXT owner re-arms the deadline

    await new Promise((r) => setTimeout(r, 400));
    const recs = await records(t1.journal, h1.runId);
    // The detached process's timer must not answer a run it no longer owns.
    expect(recs.some((r) => r.ev.type === "human.answered")).toBe(false);
  });

  test("of two racing answers, everyone uses the FIRST - projections and replay agree", async () => {
    const def = defineWorkflow(
      { name: "firstwins", description: "f", input: z.object({}), output: z.object({ note: z.string() }) },
      async (ctx) => {
        const go = await ctx.human.approve({ action: "which?" });
        return { note: go.note ?? "" };
      },
    );
    const t1 = testEngine();
    const h1 = await t1.engine.start(def, { input: {}, cwd: await tempDir() });
    const o1 = await h1.outcome();
    if (o1.status !== "waiting_for_human") throw new Error("expected suspension");
    const id = o1.pending[0]!.id;
    await t1.engine.cancel(h1.runId);

    // Two processes raced past the answered-guard: both appends landed.
    await t1.journal.append(h1.runId, [
      { type: "human.answered", id, answer: { approved: true, note: "first" }, answeredBy: "human" },
    ]);
    await t1.journal.append(h1.runId, [
      { type: "human.answered", id, answer: { approved: true, note: "second" }, answeredBy: "human" },
    ]);

    const t2 = reopen(t1);
    const h2 = await t2.engine.resume(h1.runId, { def });
    expect(await h2.result).toEqual({ note: "first" });
    const state = await t2.engine.state(h1.runId);
    expect((state.humans[0]?.answer as { note?: string } | undefined)?.note).toBe("first");
  });

  test("a workflow output the journal cannot hold fails loudly, not silently", async () => {
    const def = defineWorkflow(
      { name: "mapout", description: "m", input: z.object({}), output: z.object({ m: z.any() }) },
      async () => ({ m: new Map([["k", 1]]) }),
    );
    const t = testEngine();
    const h = await t.engine.start(def, { input: {}, cwd: await tempDir() });
    // A Map would journal as {} and replay would disagree with the live handle.
    await expect(h.result).rejects.toMatchObject({
      code: "invalid_output",
      message: expect.stringContaining("cannot be journaled as JSON"),
    });
  });
});

describe("codex review findings, round 6 (PR #1)", () => {
  test("a schema transform's input survives resume: the journal holds RAW input, re-validated on wake", async () => {
    const def = defineWorkflow(
      {
        name: "when",
        description: "w",
        input: z.object({ when: z.string().transform((s) => new Date(s)) }),
        output: z.object({ time: z.number() }),
      },
      async (ctx, input) => {
        const go = await ctx.human.approve({ action: "proceed?" });
        if (!go.approved) throw new Error("denied");
        // .getTime() exists only on a real Date: a resume fed the journal's
        // serialized string here (the old behavior) would crash.
        return { time: input.when.getTime() };
      },
    );
    const t1 = testEngine();
    const h1 = await t1.engine.start(def, {
      input: { when: "2026-01-02T03:04:05.000Z" },
      cwd: await tempDir(),
    });
    const o1 = await h1.outcome();
    if (o1.status !== "waiting_for_human") throw new Error("expected suspension");
    await t1.engine.shutdown(); // the owner dies; a new process resumes from the journal

    const recs = await records(t1.journal, h1.runId);
    const created = recs.find((r) => r.ev.type === "run.created")?.ev;
    if (created?.type !== "run.created") throw new Error("missing run.created");
    // Journaled raw: the transformed Date would have serialized into a lossy string.
    expect(created.input).toEqual({ when: "2026-01-02T03:04:05.000Z" });

    const t2 = reopen(t1);
    const h2 = await t2.engine.resume(h1.runId, { def });
    await t2.engine.answer(h1.runId, o1.pending[0]!.id, { approved: true });
    expect(await h2.result).toEqual({ time: Date.parse("2026-01-02T03:04:05.000Z") });
  });

  test("input that cannot round-trip through the journal is refused at start", async () => {
    const def = defineWorkflow(
      { name: "rawdate", description: "r", input: z.object({ when: z.date() }), output: z.object({}) },
      async () => ({}),
    );
    const t = testEngine();
    await expect(
      t.engine.start(def, { input: { when: new Date() }, cwd: await tempDir() }),
    ).rejects.toMatchObject({
      code: "invalid_input",
      message: expect.stringContaining("cannot be journaled as JSON"),
    });
  });

  test("shutdown mid-step DRAINS the work before releasing ownership; the run stays resumable", async () => {
    const def = defineWorkflow(
      { name: "midstep", description: "m", input: z.object({}), output: z.object({ ok: z.boolean() }) },
      async (ctx) => {
        await ctx.sleep(300);
        return { ok: true };
      },
    );
    const t1 = testEngine();
    const h1 = await t1.engine.start(def, { input: {}, cwd: await tempDir() });
    let settled = false;
    void h1.result.catch(() => {
      settled = true;
    });
    await new Promise((r) => setTimeout(r, 50)); // the sleep step is live in-flight
    await t1.engine.shutdown();
    // Drained BEFORE shutdown returned: a claim released over still-running work
    // would let another process execute the same run concurrently.
    expect(settled).toBe(true);
    await expect(h1.result).rejects.toMatchObject({ code: "detached" });
    const recs = await records(t1.journal, h1.runId);
    // No journaled outcome — the run is the next owner's to finish.
    expect(recs.some((r) => ["run.completed", "run.failed", "run.cancelled"].includes(r.ev.type))).toBe(
      false,
    );

    const t2 = reopen(t1);
    const h2 = await t2.engine.resume(h1.runId, { def });
    expect(await h2.result).toEqual({ ok: true });
  });

  test("a lost ownership claim STOPS the runtime instead of double-executing the run", async () => {
    class LeaseLosingStore extends MemoryJournalStore {
      override async acquireRun() {
        // A claim another process takes over immediately: the first refresh reports the loss.
        return { refresh: async () => false, release: async () => {} };
      }
    }
    const def = defineWorkflow(
      { name: "fencedrun", description: "f", input: z.object({}), output: z.object({ ok: z.boolean() }) },
      async (ctx) => {
        await ctx.sleep(60_000);
        return { ok: true };
      },
    );
    const journal = new LeaseLosingStore();
    const engine = new Engine({
      journal,
      blobs: new MemoryBlobStore(),
      providers: new ProviderRegistry(),
    });
    const cwd = await tempDir();
    vi.useFakeTimers();
    let runId: string;
    try {
      const h = await engine.start(def, { input: {}, cwd });
      runId = h.runId;
      await vi.advanceTimersByTimeAsync(0); // the sleep step dispatches
      await vi.advanceTimersByTimeAsync(5_000); // the refresh interval fires and reports the loss
      await expect(h.result).rejects.toMatchObject({
        code: "detached",
        message: expect.stringContaining("ownership"),
      });
    } finally {
      vi.useRealTimers();
    }
    const recs = await records(journal, runId);
    // Fenced, not failed: the journal stays exactly as the new owner found it.
    expect(recs.some((r) => ["run.completed", "run.failed", "run.cancelled"].includes(r.ev.type))).toBe(
      false,
    );
  });

  test("a cross-process cancel cannot overwrite a completion committed in its read/write gap", async () => {
    class RacingStore extends MemoryJournalStore {
      raced = false;
      override async appendIf(runId: string, expected: number, events: JournalEvent[]) {
        if (!this.raced) {
          this.raced = true;
          // The run's owner commits its outcome between the canceller's fold and append.
          await this.append(runId, [{ type: "run.completed", output: { ok: true } }]);
        }
        return super.appendIf(runId, expected, events);
      }
    }
    const journal = new RacingStore();
    await journal.append("race-1", [
      { type: "run.created", runId: "race-1", workflow: { name: "w" }, input: {}, cwd: "/", depth: 0 },
    ]);
    const engine = new Engine({
      journal,
      blobs: new MemoryBlobStore(),
      providers: new ProviderRegistry(),
    });
    await expect(engine.cancel("race-1")).rejects.toThrow(/already complete/);
    const recs = await records(journal, "race-1");
    // The completed outcome stands; the stale cancel never landed.
    expect(recs.some((r) => r.ev.type === "run.cancelled")).toBe(false);
  });
});

describe("codex review findings, round 7 (PR #1)", () => {
  test("a signal payload the journal cannot hold is refused before either append path", async () => {
    const def = defineWorkflow(
      { name: "sigjson", description: "s", input: z.object({}), output: z.object({ n: z.number() }) },
      async (ctx) => {
        const got = await ctx.signal("go", z.object({ n: z.number() }));
        return { n: got.n };
      },
    );
    const t = testEngine();
    const h = await t.engine.start(def, { input: {}, cwd: await tempDir() });
    await h.outcome(); // waiting on the signal

    // ACTIVE path: a Map would journal as {} — the live waiter and a resumed
    // replay would then disagree about what the signal carried.
    await expect(t.engine.signal(h.runId, "go", { n: new Map() })).rejects.toMatchObject({
      code: "invalid_input",
      message: expect.stringContaining("cannot be journaled as JSON"),
    });
    let recs = await records(t.journal, h.runId);
    expect(recs.some((r) => r.ev.type === "signal.received")).toBe(false);

    // A journal-safe payload still flows through to completion.
    await t.engine.signal(h.runId, "go", { n: 7 });
    expect(await h.result).toEqual({ n: 7 });

    // NON-ACTIVE path (a CLI signalling a parked run): a bigint would make the
    // filesystem append itself throw mid-batch.
    const t2 = reopen(t);
    await expect(t2.engine.signal(h.runId, "later", { size: 10n })).rejects.toMatchObject({
      code: "invalid_input",
    });
    recs = await records(t2.journal, h.runId);
    expect(recs.filter((r) => r.ev.type === "signal.received")).toHaveLength(1);
  });
});

describe("codex review findings, round 8 (PR #1)", () => {
  const FixResult = z.object({ summary: z.string() });

  test("an integrated patch whose lines a LATER patch edited replays as served, not reapplied", async () => {
    const t1 = testEngine();
    t1.builder.on({ key: "w1" }, { summary: "one" }, { writes: { "f.txt": "A\n" } });
    t1.builder.on({ key: "w2" }, { summary: "two" }, { writes: { "f.txt": "B\n" } });
    const cwd = await tempRepo();
    const def = defineWorkflow(
      { name: "chain", description: "c", input: z.object({}), output: z.object({ ok: z.boolean() }) },
      async (ctx) => {
        const p1 = await ctx.agent.detailed("one", {
          schema: FixResult,
          key: "w1",
          write: { paths: ["f.txt"] },
        });
        await ctx.integrate([p1]);
        const p2 = await ctx.agent.detailed("two", {
          schema: FixResult,
          key: "w2",
          write: { paths: ["f.txt"] },
        });
        await ctx.integrate([p2]);
        const go = await ctx.human.approve({ action: "done?" });
        return { ok: go.approved };
      },
    );
    const h1 = await t1.engine.start(def, { input: {}, cwd });
    const o1 = await h1.outcome();
    if (o1.status !== "waiting_for_human") throw new Error("expected suspension");
    await t1.engine.shutdown();

    const t2 = reopen(t1);
    const h2 = await t2.engine.resume(h1.runId, { def });
    const o2 = await h2.outcome(); // the replay must reach the request again first
    if (o2.status !== "waiting_for_human") throw new Error(`expected re-suspension, got ${o2.status}`);
    await t2.engine.answer(h1.runId, o2.pending[0]!.id, { approved: true });
    expect(await h2.result).toEqual({ ok: true });
    // Patch 2 rewrote the very line patch 1 added, so patch 1 no longer
    // reverse-applies — the journaled CHAIN (patch 2 built on patch 1's result
    // tree) is what proves the integration held. Reapplying would conflict.
    const recs = await records(t2.journal, h1.runId);
    const merged = recs.filter((r) => r.ev.type === "patch.merged");
    expect(merged.map((r) => (r.ev as { key?: string }).key)).toEqual(["w1", "w2"]);
    expect(await readFile(join(cwd, "f.txt"), "utf8")).toBe("B\n");
  });

  test("a conflict resolver's stray edits are rolled back and reported — its scope is ENFORCED", async () => {
    const t = testEngine();
    t.builder.on({ key: "fix:c" }, { summary: "edit" }, { writes: { "a.txt": "AGENT\n" } });
    // The resolver fixes the conflict file but ALSO drops a file it was told not to touch.
    t.builder.on(
      { key: "merge:fix:c" },
      { resolved: true, notes: "fixed" },
      { writes: { "a.txt": "RESOLVED\n", "stray.txt": "oops\n" } },
    );
    const cwd = await tempRepo({ "a.txt": "base\n" });
    const def = defineWorkflow(
      { description: "m", input: z.object({}), output: z.object({}) },
      async (ctx) => {
        const fix = await ctx.agent.detailed("fix", {
          schema: FixResult,
          key: "fix:c",
          write: { paths: ["a.txt"] },
        });
        // Drift the integration tree so the patch 3-way conflicts.
        await ctx.bash("printf 'MAIN\\n' > a.txt");
        await ctx.integrate([fix], { onConflict: "agent" });
        return {};
      },
    );
    const handle = await t.engine.start(def, { input: {}, cwd });
    expect(await handle.result).toEqual({});
    // The resolution itself stands...
    expect(await readFile(join(cwd, "a.txt"), "utf8")).toBe("RESOLVED\n");
    // ...but the out-of-scope edit was rolled back, not silently accepted.
    expect(existsSync(join(cwd, "stray.txt"))).toBe(false);
    const recs = await records(t.journal, handle.runId);
    const violation = recs.find((r) => r.ev.type === "scope.violation")?.ev;
    if (violation?.type !== "scope.violation") throw new Error("missing scope.violation");
    expect(violation.files).toEqual(["stray.txt"]);
    expect(violation.mode).toBe("strict");
  });

  test("spend charged before a post-processing failure is journaled for the resume's budget restore", async () => {
    class FailingBlobs extends MemoryBlobStore {
      override async put(bytes: Uint8Array | string, meta?: { kind?: string }) {
        if (meta?.kind === "transcript") throw new Error("blob store down");
        return super.put(bytes);
      }
    }
    const journal = new MemoryJournalStore();
    const builder = mock();
    builder.on({ key: "paid" }, { ok: true }, { usage: { input: 800, output: 200 } });
    const providers = new ProviderRegistry();
    providers.register(builder.provider("claude"));
    const engine = new Engine({ journal, blobs: new FailingBlobs(), providers });
    const def = defineWorkflow(
      { name: "paidfail", description: "p", input: z.object({}), output: z.object({}) },
      async (ctx) => {
        await ctx.agent("do", { schema: z.object({ ok: z.boolean() }), key: "paid" });
        return {};
      },
    );
    const h = await engine.start(def, { input: {}, cwd: await tempDir() });
    await expect(h.result).rejects.toMatchObject({ code: "internal" });
    const recs = await records(journal, h.runId);
    const failed = recs.find((r) => r.ev.type === "step.failed")?.ev;
    if (failed?.type !== "step.failed") throw new Error("missing step.failed");
    // The provider call was PAID before the transcript blob store failed: the
    // spend rides the failure record...
    const carried = (failed.error.detail as { usage?: { input: number; output: number } }).usage;
    expect(carried).toMatchObject({ input: 800, output: 200 });
    // ...and a resume's budget restore counts it.
    expect(ReplayIndex.fromRecords(recs).totalUsage.tokens).toBe(1_000);
  });
});

describe("codex review findings, round 9 (PR #1)", () => {
  test("fetch: a 304 with a stray Location header is returned, never followed", async () => {
    let secondHit = false;
    const second = createServer((_req, res) => {
      secondHit = true;
      res.writeHead(200, { "content-type": "text/plain" }).end("should never be reached");
    });
    await new Promise<void>((r) => second.listen(0, "127.0.0.1", r));
    const secondPort = (second.address() as { port: number }).port;
    const first = createServer((_req, res) => {
      // A conditional-request answer that (incorrectly) carries a Location:
      // Fetch redirects only on 301/302/303/307/308, so this must come back as-is.
      res.writeHead(304, { location: `http://127.0.0.1:${secondPort}/elsewhere` }).end();
    });
    await new Promise<void>((r) => first.listen(0, "127.0.0.1", r));
    const firstPort = (first.address() as { port: number }).port;

    try {
      const t = testEngine({ config: { fetchAllow: ["127.0.0.1"] } });
      const def = defineWorkflow(
        { description: "cond", input: z.object({}), output: z.object({ status: z.number() }) },
        async (ctx) => {
          const res = await ctx.fetch(`http://127.0.0.1:${firstPort}/cached`, {
            headers: { "if-none-match": '"etag"' },
          });
          return { status: res.status };
        },
      );
      const handle = await t.engine.start(def, { input: {}, cwd: await tempRepo() });
      expect(await handle.result).toEqual({ status: 304 });
      expect(secondHit).toBe(false);
    } finally {
      first.close();
      second.close();
    }
  });

  test("an explicit null input is preserved through start, journal, and resume", async () => {
    const def = defineWorkflow(
      { name: "nullin", description: "n", input: z.null(), output: z.object({ isNull: z.boolean() }) },
      async (ctx, input) => {
        const go = await ctx.human.approve({ action: "check" });
        if (!go.approved) throw new Error("denied");
        return { isNull: input === null };
      },
    );
    const t1 = testEngine();
    const h1 = await t1.engine.start(def, { input: null, cwd: await tempDir() });
    const o1 = await h1.outcome();
    if (o1.status !== "waiting_for_human") throw new Error("expected suspension");
    await t1.engine.shutdown();

    const recs = await records(t1.journal, h1.runId);
    const created = recs.find((r) => r.ev.type === "run.created")?.ev;
    if (created?.type !== "run.created") throw new Error("missing run.created");
    // null is a VALUE, not an omission: journaled as itself, never as {}.
    expect(created.input).toBeNull();

    const t2 = reopen(t1);
    const h2 = await t2.engine.resume(h1.runId, { def });
    const o2 = await h2.outcome();
    if (o2.status !== "waiting_for_human") throw new Error("expected re-suspension");
    await t2.engine.answer(h1.runId, o2.pending[0]!.id, { approved: true });
    expect(await h2.result).toEqual({ isNull: true });
  });

  test("a timed-out attempt is aborted and DRAINED before the timeout surfaces", async () => {
    let settledAt = 0;
    const hanging: AgentProvider = {
      id: "claude",
      capabilities: () => ({
        structured: "tool",
        permissionHook: false,
        sessionResume: false,
        reportsUsd: true,
      }),
      run: (_req, ctl) =>
        new Promise((_, reject) => {
          // Hangs until aborted; settles 100ms after the abort lands — the step
          // must wait for that settle, not fail while the attempt still runs.
          ctl.signal.addEventListener(
            "abort",
            () => {
              setTimeout(() => {
                settledAt = Date.now();
                reject(new Error("aborted"));
              }, 100);
            },
            { once: true },
          );
        }),
      repair: () => Promise.reject(new Error("no session to repair")),
    };
    const providers = new ProviderRegistry();
    providers.register(hanging);
    const engine = new Engine({
      journal: new MemoryJournalStore(),
      blobs: new MemoryBlobStore(),
      providers,
    });
    const def = defineWorkflow(
      { name: "hangstep", description: "h", input: z.object({}), output: z.object({}) },
      async (ctx) => {
        await ctx.agent("never returns", {
          schema: z.object({ ok: z.boolean() }),
          key: "hang",
          timeout: "300ms",
        });
        return {};
      },
    );
    const h = await engine.start(def, { input: {}, cwd: await tempDir() });
    await expect(h.result).rejects.toMatchObject({ code: "timeout" });
    // The losing execution settled BEFORE the failure was published: a retry (or
    // a terminal outcome releasing ownership) never overlaps a live attempt.
    expect(settledAt).not.toBe(0);
  });
});

describe("codex review findings, round 10 (PR #1)", () => {
  test("an answer the journal cannot hold is refused on both append paths", async () => {
    const def = defineWorkflow(
      { name: "ansjson", description: "a", input: z.object({}), output: z.object({ ok: z.boolean() }) },
      async (ctx) => {
        const go = await ctx.human.approve({ action: "ship?" });
        return { ok: go.approved };
      },
    );
    const t1 = testEngine();
    const h1 = await t1.engine.start(def, { input: {}, cwd: await tempDir() });
    const o1 = await h1.outcome();
    if (o1.status !== "waiting_for_human") throw new Error("expected suspension");
    const id = o1.pending[0]!.id;

    // ACTIVE path: a Date would journal as an ISO string — replay would then
    // disagree with what the live waiter was handed.
    await expect(t1.engine.answer(h1.runId, id, { approved: true, note: new Date() })).rejects.toMatchObject({
      code: "invalid_answer",
      message: expect.stringContaining("cannot be journaled as JSON"),
    });
    let recs = await records(t1.journal, h1.runId);
    expect(recs.some((r) => r.ev.type === "human.answered")).toBe(false);
    await t1.engine.shutdown();

    // NON-ACTIVE path (a CLI answering a parked run): a bigint would make the
    // filesystem append itself throw after its cached count advanced.
    const t2 = reopen(t1);
    await expect(t2.engine.answer(h1.runId, id, { approved: true, extra: 10n })).rejects.toMatchObject({
      code: "invalid_answer",
    });
    recs = await records(t2.journal, h1.runId);
    expect(recs.some((r) => r.ev.type === "human.answered")).toBe(false);

    // A journal-safe answer still lands and the resumed run completes on it.
    await t2.engine.answer(h1.runId, id, { approved: true });
    const h2 = await t2.engine.resume(h1.runId, { def });
    expect(await h2.result).toEqual({ ok: true });
  });

  test("a PRESENT-but-undefined output property fails loudly instead of silently vanishing", async () => {
    const def = defineWorkflow(
      {
        name: "undef",
        description: "u",
        input: z.object({}),
        output: z.object({ ok: z.boolean(), note: z.string().optional() }),
      },
      // The key exists with value undefined: JSON drops it, so the journal would
      // replay a different shape than the live handle returned.
      async () => ({ ok: true, note: undefined }),
    );
    const t = testEngine();
    const h = await t.engine.start(def, { input: {}, cwd: await tempDir() });
    await expect(h.result).rejects.toMatchObject({
      code: "invalid_output",
      message: expect.stringContaining("$.note (undefined)"),
    });
  });
});

describe("codex review findings, round 11 (PR #1)", () => {
  const FixResult = z.object({ summary: z.string() });

  test("conflict rollback restores the WORKING TREE only — the caller's staged state survives", async () => {
    const t = testEngine();
    t.builder.on({ key: "fix:s" }, { summary: "edit" }, { writes: { "a.txt": "AGENT\n" } });
    const cwd = await tempRepo({ "a.txt": "base\n" });
    const def = defineWorkflow(
      { description: "s", input: z.object({}), output: z.object({}) },
      async (ctx) => {
        const fix = await ctx.agent.detailed("fix", {
          schema: FixResult,
          key: "fix:s",
          write: { paths: ["a.txt"] },
        });
        // The caller stages one version, then drifts the working tree past it —
        // the patch will 3-way conflict and roll back.
        await ctx.bash("printf 'STAGED\\n' > a.txt && git add a.txt && printf 'MAIN\\n' > a.txt");
        await ctx.integrate([fix], { onConflict: "fail" });
        return {};
      },
    );
    const handle = await t.engine.start(def, { input: {}, cwd });
    await expect(handle.result).rejects.toMatchObject({ code: "conflict" });
    // Working tree rolled back; the index is not ours to touch.
    expect(await readFile(join(cwd, "a.txt"), "utf8")).toBe("MAIN\n");
    const staged = await execa("git", ["show", ":a.txt"], { cwd });
    expect(staged.stdout).toBe("STAGED");
  });

  test("a transformed schema's timeout default is journaled RAW and transformed on apply", async () => {
    const def = defineWorkflow(
      { name: "tdefault", description: "t", input: z.object({}), output: z.object({ time: z.number() }) },
      async (ctx) => {
        const when = await ctx.human.ask({
          question: "when?",
          schema: z.string().transform((s) => new Date(s)),
          timeout: "150ms",
          onTimeout: { default: "2026-03-04T05:06:07.000Z" },
        });
        // The deadline's fallback flows through the schema like any answer:
        // the workflow receives the TRANSFORMED value, live and after resume alike.
        return { time: when.getTime() };
      },
    );
    const t = testEngine();
    const h = await t.engine.start(def, { input: {}, cwd: await tempDir() });
    expect(await h.result).toEqual({ time: Date.parse("2026-03-04T05:06:07.000Z") });
  });

  test("an unusable timeout default fails at the REQUEST, never at the deadline", async () => {
    // Not JSON: the journal could not even hold it with the request.
    const bigintDef = defineWorkflow(
      { name: "tdefbig", description: "t", input: z.object({}), output: z.object({}) },
      async (ctx) => {
        await ctx.human.ask({
          question: "size?",
          schema: z.any(),
          timeout: "1h",
          onTimeout: { default: 10n },
        });
        return {};
      },
    );
    const t = testEngine();
    const h1 = await t.engine.start(bigintDef, { input: {}, cwd: await tempDir() });
    await expect(h1.result).rejects.toMatchObject({
      code: "invalid_input",
      message: expect.stringContaining("onTimeout.default"),
    });

    // JSON, but the schema would reject it when the deadline fired.
    const mismatchDef = defineWorkflow(
      { name: "tdefbad", description: "t", input: z.object({}), output: z.object({}) },
      async (ctx) => {
        await ctx.human.ask({
          question: "name?",
          schema: z.string(),
          timeout: "1h",
          onTimeout: { default: 42 as unknown as string },
        });
        return {};
      },
    );
    const h2 = await t.engine.start(mismatchDef, { input: {}, cwd: await tempDir() });
    await expect(h2.result).rejects.toMatchObject({
      code: "invalid_input",
      message: expect.stringContaining("failed the request schema"),
    });
  });
});

describe("codex review findings, round 12 (PR #1)", () => {
  test("a cancellation committed in the tailer's blind spot outranks the owner's completion", async () => {
    class CancelRacingStore extends MemoryJournalStore {
      raced = false;
      override async appendIf(runId: string, expected: number, events: JournalEvent[]) {
        if (!this.raced && events.some((ev) => ev.type === "run.completed")) {
          this.raced = true;
          // A CLI's cancel CAS lands while the owner's tailer has not seen it.
          await this.append(runId, [{ type: "run.cancelled" }, { type: "run.status", status: "cancelled" }]);
        }
        return super.appendIf(runId, expected, events);
      }
    }
    const journal = new CancelRacingStore();
    const engine = new Engine({
      journal,
      blobs: new MemoryBlobStore(),
      providers: new ProviderRegistry(),
    });
    const def = defineWorkflow(
      { name: "fastdone", description: "f", input: z.object({}), output: z.object({ ok: z.boolean() }) },
      async () => ({ ok: true }),
    );
    const h = await engine.start(def, { input: {}, cwd: await tempDir() });
    // The committed cancellation wins: never a "complete" over it.
    await expect(h.result).rejects.toMatchObject({ code: "cancelled" });
    const recs = await records(journal, h.runId);
    expect(recs.some((r) => r.ev.type === "run.completed")).toBe(false);
    expect(recs.filter((r) => r.ev.type === "run.cancelled")).toHaveLength(1);
    expect((await engine.state(h.runId)).status).toBe("cancelled");
  });

  test("an undefined timeout default is rejected at the request — it cannot ride the journal", async () => {
    const def = defineWorkflow(
      { name: "tdefundef", description: "t", input: z.object({}), output: z.object({}) },
      async (ctx) => {
        await ctx.human.ask({
          question: "note?",
          // The schema ACCEPTS undefined — but the journaled request cannot hold
          // it, and the deadline would reconstruct it as null and reject it.
          schema: z.string().optional(),
          timeout: "1h",
          onTimeout: { default: undefined },
        });
        return {};
      },
    );
    const t = testEngine();
    const h = await t.engine.start(def, { input: {}, cwd: await tempDir() });
    await expect(h.result).rejects.toMatchObject({
      code: "invalid_input",
      message: expect.stringContaining("onTimeout.default"),
    });
  });

  test("child step identity distinguishes an explicit null input from an omitted one", async () => {
    const child = defineWorkflow(
      {
        name: "nullchild",
        description: "c",
        input: z.union([z.null(), z.object({})]),
        output: z.object({ got: z.string() }),
      },
      async (_ctx, input) => ({ got: input === null ? "null" : "object" }),
    );
    const mkParent = (childInput: null | undefined) =>
      defineWorkflow(
        { name: "nullparent", description: "p", input: z.object({}), output: z.object({ got: z.string() }) },
        async (ctx) => {
          // Cast: the typed overload demands the child input; the omission scenario is an edit.
          const r = (await ctx.workflow(child, childInput as never, { key: "child" })) as { got: string };
          await ctx.human.approve({ action: "done?" });
          return { got: r.got };
        },
      );
    const t1 = testEngine();
    const h1 = await t1.engine.start(mkParent(null), { input: {}, cwd: await tempDir() });
    const o1 = await h1.outcome();
    if (o1.status !== "waiting_for_human") throw new Error("expected suspension");
    await t1.engine.shutdown();

    // The edited code now OMITS the input. If null and omission hashed alike,
    // replay would serve the old child's output for what is a different call.
    const t2 = reopen(t1);
    const h2 = await t2.engine.resume(h1.runId, { def: mkParent(undefined) });
    const o2 = await h2.outcome();
    if (o2.status !== "waiting_for_human") throw new Error("expected re-suspension");
    await t2.engine.answer(h1.runId, o2.pending[0]!.id, { approved: true });
    expect(await h2.result).toEqual({ got: "object" });
  });
});

describe("codex review findings, round 13 (PR #1)", () => {
  test("a zombie attempt abandoned past the drain window cannot open human requests", async () => {
    let sneaky = "not attempted";
    const zombie: AgentProvider = {
      id: "claude",
      capabilities: () => ({
        structured: "tool",
        permissionHook: false,
        sessionResume: false,
        reportsUsd: true,
      }),
      run: (req, ctl) =>
        new Promise(() => {
          // Ignores its abort entirely — a hung SDK subprocess. Once aborted,
          // the zombie tries to open a human request through its HITL seam.
          ctl.signal.addEventListener(
            "abort",
            () => {
              void req.hitl.onAsk("zombie asking", undefined).then(
                () => {
                  sneaky = "answered";
                },
                () => {
                  sneaky = "refused";
                },
              );
            },
            { once: true },
          );
        }),
      repair: () => Promise.reject(new Error("no session to repair")),
    };
    const journal = new MemoryJournalStore();
    const providers = new ProviderRegistry();
    providers.register(zombie);
    const engine = new Engine({ journal, blobs: new MemoryBlobStore(), providers });
    const def = defineWorkflow(
      { name: "zombiestep", description: "z", input: z.object({}), output: z.object({}) },
      async (ctx) => {
        await ctx.agent("never settles", {
          schema: z.object({ ok: z.boolean() }),
          key: "hang",
          timeout: "300ms",
        });
        return {};
      },
    );
    const cwd = await tempDir();
    vi.useFakeTimers();
    let runId: string;
    try {
      const h = await engine.start(def, { input: {}, cwd });
      runId = h.runId;
      await vi.advanceTimersByTimeAsync(1_300); // the engine-side timeout aborts the attempt
      await vi.advanceTimersByTimeAsync(5_000); // the bounded drain gives up on the zombie
      await expect(h.result).rejects.toMatchObject({ code: "timeout" });
    } finally {
      vi.useRealTimers();
    }
    // The zombie's ask was refused, and nothing of it reached the journal.
    expect(sneaky).toBe("refused");
    const recs = await records(journal, runId);
    expect(recs.some((r) => r.ev.type === "human.requested")).toBe(false);
  });

  test("a conflict resolver's IGNORED stray file is still caught and rolled back", async () => {
    const FixResult = z.object({ summary: z.string() });
    const t = testEngine();
    t.builder.on({ key: "fix:i" }, { summary: "edit" }, { writes: { "a.txt": "AGENT\n" } });
    // The resolver fixes the conflict file but drops a file the SNAPSHOTS cannot
    // see: it matches .gitignore, so only the ignored-file listing catches it.
    t.builder.on(
      { key: "merge:fix:i" },
      { resolved: true, notes: "fixed" },
      { writes: { "a.txt": "RESOLVED\n", "stray.log": "oops\n" } },
    );
    const cwd = await tempRepo({ ".gitignore": "stray.log\n", "a.txt": "base\n" });
    const def = defineWorkflow(
      { description: "mi", input: z.object({}), output: z.object({}) },
      async (ctx) => {
        const fix = await ctx.agent.detailed("fix", {
          schema: FixResult,
          key: "fix:i",
          write: { paths: ["a.txt"] },
        });
        await ctx.bash("printf 'MAIN\\n' > a.txt");
        await ctx.integrate([fix], { onConflict: "agent" });
        return {};
      },
    );
    const handle = await t.engine.start(def, { input: {}, cwd });
    expect(await handle.result).toEqual({});
    expect(await readFile(join(cwd, "a.txt"), "utf8")).toBe("RESOLVED\n");
    expect(existsSync(join(cwd, "stray.log"))).toBe(false);
    const recs = await records(t.journal, handle.runId);
    const violation = recs.find((r) => r.ev.type === "scope.violation")?.ev;
    if (violation?.type !== "scope.violation") throw new Error("missing scope.violation");
    expect(violation.files).toEqual(["stray.log"]);
    expect(violation.mode).toBe("strict");
  });
});

describe("codex review findings, round 14 (PR #1)", () => {
  test("a resumed run's nonterminal status clears the previous pass's outcome", () => {
    const recs: JournalRecord[] = [
      {
        i: 0,
        at: 1,
        ev: { type: "run.created", runId: "r", workflow: { name: "w" }, input: {}, cwd: "/", depth: 0 },
      },
      {
        i: 1,
        at: 2,
        ev: {
          type: "run.failed",
          error: { name: "StepError", code: "internal", message: "boom", step: {} },
        },
      },
      // A new execution resumed past the failure and is running again: the state
      // (and the daemon's report) must not keep showing the old failure.
      { i: 2, at: 3, ev: { type: "run.status", status: "executing" } },
    ];
    const state = reduceState(recs);
    expect(state.status).toBe("executing");
    expect(state.error).toBeUndefined();
    expect(state.output).toBeUndefined();
  });
});

describe("codex review findings, round 15 (PR #1)", () => {
  test("fs.stat surfaces real filesystem failures; only absence is a value", async () => {
    const t = testEngine();
    const cwd = await tempDir();
    await symlink("loop", join(cwd, "loop")); // self-referential: stat fails with ELOOP
    const failing = defineWorkflow(
      { name: "statloop", description: "s", input: z.object({}), output: z.object({}) },
      async (ctx) => {
        // Reporting { exists: false } here would journal a false premise forever.
        await ctx.fs.stat("loop");
        return {};
      },
    );
    const h1 = await t.engine.start(failing, { input: {}, cwd });
    await expect(h1.result).rejects.toMatchObject({ code: "exec_failed" });

    const missing = defineWorkflow(
      {
        name: "statmissing",
        description: "s",
        input: z.object({}),
        output: z.object({ exists: z.boolean() }),
      },
      async (ctx) => ({ exists: (await ctx.fs.stat("definitely-not-there.txt")).exists }),
    );
    const h2 = await t.engine.start(missing, { input: {}, cwd });
    expect(await h2.result).toEqual({ exists: false });
  });
});

describe("codex review findings, round 16 (PR #1)", () => {
  test("a resumed budget knows how many calls its restored spend came from", () => {
    // Two prior calls averaged 100 tokens; plenty of budget remains.
    const resumed = new Budget({ tokens: 1_000 });
    resumed.restore(200, 0, 2);
    // With the samples restored, TWO concurrent reservations fit the average.
    // With them lost, the first call counts as an unpriced probe and the second
    // would be refused despite being easily affordable.
    const r1 = resumed.reserveCall({ kind: "agent" });
    const r2 = resumed.reserveCall({ kind: "agent" });
    r1();
    r2();
    // The observed-average gate still enforces: a tight remainder refuses.
    const tight = new Budget({ tokens: 700 });
    tight.restore(600, 0, 2); // avg 300, remaining 100
    expect(() => tight.reserveCall({ kind: "agent" })).toThrow(/budget/);
  });
});
