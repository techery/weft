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
