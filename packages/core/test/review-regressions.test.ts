import type { JournalRecord } from "@weft/core";
import { defineWorkflow, z } from "@weft/sdk";
import { afterAll, describe, expect, test } from "vitest";
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
