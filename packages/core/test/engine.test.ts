import type { JournalRecord } from "@weft/core";
import { defineWorkflow, StepError, z } from "@weft/sdk";
import { afterAll, describe, expect, test } from "vitest";
import { cleanupRepos, reopen, tempDir, testEngine } from "./helpers.ts";

afterAll(cleanupRepos);

const Finding = z.object({ file: z.string(), line: z.number(), claim: z.string() });

async function records(journal: { read(runId: string): AsyncIterable<JournalRecord> }, runId: string) {
  const out: JournalRecord[] = [];
  for await (const rec of journal.read(runId)) out.push(rec);
  return out;
}

describe("engine end to end", () => {
  test("runs a sequential workflow with typed agent steps and journals everything", async () => {
    const t = testEngine();
    t.builder.on(
      { key: "plan" },
      { steps: ["a", "b"], risk: "low" },
      { usage: { input: 1000, output: 200 } },
    );
    const def = defineWorkflow(
      {
        name: "planner",
        description: "plan",
        input: z.object({ goal: z.string() }),
        output: z.object({ stepCount: z.number() }),
      },
      async (ctx, { goal }) => {
        ctx.phase("Plan");
        const plan = await ctx.agent(`Plan: ${goal}`, {
          schema: z.object({ steps: z.array(z.string()), risk: z.enum(["low", "medium", "high"]) }),
          key: "plan",
        });
        return { stepCount: plan.steps.length };
      },
    );
    const handle = await t.engine.start(def, { input: { goal: "migrate" }, cwd: await tempDir() });
    const output = await handle.result;
    expect(output).toEqual({ stepCount: 2 });

    const recs = await records(t.journal, handle.runId);
    const types = recs.map((r) => r.ev.type);
    expect(types).toContain("run.created");
    expect(types).toContain("phase");
    expect(types).toContain("step.scheduled");
    expect(types).toContain("step.completed");
    expect(types).toContain("run.completed");
    const scheduled = recs.find((r) => r.ev.type === "step.scheduled")?.ev;
    expect(scheduled).toMatchObject({ kind: "agent", key: "plan", phase: "Plan" });
    expect(t.builder.calls[0]!.prompt).toContain("Plan: migrate");
    // read-only steps get the read-only instruction
    expect(t.builder.calls[0]!.prompt).toContain("read-only");
  });

  test("parallel collects per-branch failures; ok() records drops", async () => {
    const t = testEngine();
    t.builder.on({ key: "review:a.ts" }, { findings: [{ file: "a.ts", line: 3, claim: "off-by-one" }] });
    t.builder.on({ key: "review:b.ts" }, () => {
      throw new Error("provider blew up");
    });
    const def = defineWorkflow(
      { description: "review", input: z.object({}), output: z.object({ count: z.number() }) },
      async (ctx) => {
        const settled = await ctx.parallel(
          ["a.ts", "b.ts"].map((f) =>
            ctx.agent(`Review ${f}`, {
              schema: z.object({ findings: z.array(Finding) }),
              key: `review:${f}`,
            }),
          ),
        );
        expect(settled).toHaveLength(2);
        expect(settled[0]!.ok).toBe(true);
        expect(settled[1]!.ok).toBe(false);
        if (!settled[1]!.ok) expect(settled[1]!.error).toBeInstanceOf(StepError);
        const good = ctx.ok(settled);
        return { count: good.flatMap((g) => g.findings).length };
      },
    );
    const handle = await t.engine.start(def, { input: {}, cwd: await tempDir() });
    expect(await handle.result).toEqual({ count: 1 });
    const recs = await records(t.journal, handle.runId);
    expect(recs.some((r) => r.ev.type === "step.failed")).toBe(true);
    expect(recs.some((r) => r.ev.type === "drop")).toBe(true);
  });

  test("pipeline: step → filter → map with lanes and no barrier", async () => {
    const t = testEngine();
    t.builder.on({ key: "verify:*" }, (req) => ({ real: req.key!.endsWith("1"), reason: "checked" }));
    const def = defineWorkflow(
      { description: "verify", input: z.object({}), output: z.object({ kept: z.array(z.number()) }) },
      async (ctx) => {
        const out = await ctx
          .pipeline([1, 2, 3])
          .step((n) =>
            ctx.agent(`verify ${n}`, {
              schema: z.object({ real: z.boolean(), reason: z.string() }),
              key: `verify:${n}`,
            }),
          )
          .filter((verdict) => verdict.real)
          .map((_verdict, n) => n * 10)
          .run({ concurrency: 2 });
        return { kept: ctx.ok(out) as number[] };
      },
    );
    const handle = await t.engine.start(def, { input: {}, cwd: await tempDir() });
    expect(await handle.result).toEqual({ kept: [10] });
  });

  test("invalid output is repaired in the same session; attempts journaled", async () => {
    const t = testEngine();
    let calls = 0;
    t.builder.on({ key: "flaky" }, () => {
      calls++;
      return calls === 1 ? { real: "yes" } : { real: true, reason: "fixed" };
    });
    const def = defineWorkflow(
      { description: "repair", input: z.object({}), output: z.object({ real: z.boolean() }) },
      async (ctx) => {
        const v = await ctx.agent("check", {
          schema: z.object({ real: z.boolean(), reason: z.string() }),
          key: "flaky",
        });
        return { real: v.real };
      },
    );
    const handle = await t.engine.start(def, { input: {}, cwd: await tempDir() });
    expect(await handle.result).toEqual({ real: true });
    expect(calls).toBe(2);
    const repairCall = t.builder.calls.find((c) => c.attempt > 1);
    expect(repairCall?.issues?.length).toBeGreaterThan(0);
    const recs = await records(t.journal, handle.runId);
    const completed = recs.find((r) => r.ev.type === "step.completed")?.ev;
    expect(completed).toMatchObject({ attempts: 2 });
  });

  test("repair exhausted → StepError with the documented message shape", async () => {
    const t = testEngine();
    t.builder.on({ key: "bad" }, { wrong: true });
    const def = defineWorkflow(
      { description: "exhaust", input: z.object({}), output: z.object({}) },
      async (ctx) => {
        await ctx.agent("x", { schema: z.object({ real: z.boolean() }), key: "bad" });
        return {};
      },
    );
    const handle = await t.engine.start(def, { input: {}, cwd: await tempDir() });
    await expect(handle.result).rejects.toMatchObject({
      code: "schema_repair_exhausted",
      message: expect.stringContaining("schema repair exhausted (2 attempts)"),
    });
  });

  test("onError: 'null' resolves to null and records the drop", async () => {
    const t = testEngine();
    t.builder.on({ key: "bad" }, { wrong: 1 });
    const def = defineWorkflow(
      { description: "null", input: z.object({}), output: z.object({ got: z.boolean() }) },
      async (ctx) => {
        const v = await ctx.agent("x", {
          schema: z.object({ real: z.boolean() }),
          key: "bad",
          repair: 0,
          onError: "null",
        });
        return { got: v !== null };
      },
    );
    const handle = await t.engine.start(def, { input: {}, cwd: await tempDir() });
    expect(await handle.result).toEqual({ got: false });
  });

  test("budget: exhaustion throws inside the next step; view is exact", async () => {
    const t = testEngine();
    t.builder.on({ key: "*" }, { ok: true }, { usage: { input: 800, output: 300 } });
    const def = defineWorkflow(
      { description: "budget", input: z.object({}), output: z.object({ spent: z.number() }) },
      async (ctx) => {
        await ctx.agent("one", { schema: z.object({ ok: z.boolean() }), key: "s1" });
        expect(ctx.budget.spent.tokens).toBe(1100);
        expect(ctx.budget.remaining.tokens).toBe(0);
        await ctx.agent("two", { schema: z.object({ ok: z.boolean() }), key: "s2" });
        return { spent: ctx.budget.spent.tokens };
      },
    );
    const handle = await t.engine.start(def, { input: {}, cwd: await tempDir(), budget: { tokens: 1000 } });
    await expect(handle.result).rejects.toMatchObject({ code: "budget_exceeded" });
  });

  test("gate with low risk auto-approves and records answered_by: policy", async () => {
    const t = testEngine();
    const def = defineWorkflow(
      {
        description: "gate",
        input: z.object({}),
        output: z.object({ approved: z.boolean(), by: z.string() }),
      },
      async (ctx) => {
        const go = await ctx.gate({ action: "create scratch branch", risk: "low" });
        return { approved: go.approved, by: go.answeredBy };
      },
    );
    const handle = await t.engine.start(def, { input: {}, cwd: await tempDir() });
    expect(await handle.result).toEqual({ approved: true, by: "policy" });
    const recs = await records(t.journal, handle.runId);
    const answered = recs.find((r) => r.ev.type === "human.answered")?.ev;
    expect(answered).toMatchObject({ answeredBy: "policy" });
  });

  test("approval policy: action pattern flips high risk to auto", async () => {
    const t = testEngine({ config: { approvalPolicy: { actions: { "git.push origin/wip/*": "auto" } } } });
    const def = defineWorkflow(
      { description: "gate", input: z.object({}), output: z.object({ approved: z.boolean() }) },
      async (ctx) => {
        const go = await ctx.gate({ action: "git.push origin/wip/experiment", risk: "high" });
        return { approved: go.approved };
      },
    );
    const handle = await t.engine.start(def, { input: {}, cwd: await tempDir() });
    expect(await handle.result).toEqual({ approved: true });
  });

  test("human.ask suspends the run durably; answer resumes it in-process", async () => {
    const t = testEngine();
    const def = defineWorkflow(
      { description: "ask", input: z.object({}), output: z.object({ module: z.string() }) },
      async (ctx) => {
        const pick = await ctx.human.ask({
          question: "Which module first?",
          schema: z.object({ module: z.enum(["auth", "api"]), notes: z.string().optional() }),
        });
        return { module: pick.module };
      },
    );
    const handle = await t.engine.start(def, { input: {}, cwd: await tempDir() });
    const outcome = await handle.outcome();
    expect(outcome.status).toBe("waiting_for_human");
    if (outcome.status !== "waiting_for_human") throw new Error("unreachable");
    expect(outcome.pending[0]).toMatchObject({ kind: "ask", question: "Which module first?" });

    // Structural validation rejects a bad answer before it reaches the journal.
    await expect(
      t.engine.answer(handle.runId, outcome.pending[0]!.id, { module: "billing" }),
    ).rejects.toMatchObject({
      code: "invalid_answer",
    });
    await t.engine.answer(handle.runId, outcome.pending[0]!.id, { module: "auth" });
    expect(await handle.result).toEqual({ module: "auth" });
  });

  test("human timeout with a default answers by policy", async () => {
    const t = testEngine();
    const def = defineWorkflow(
      { description: "timeout", input: z.object({}), output: z.object({ module: z.string() }) },
      async (ctx) => {
        const pick = await ctx.human.ask({
          question: "Pick",
          schema: z.object({ module: z.string() }),
          timeout: 50,
          onTimeout: { default: { module: "auth" } },
        });
        return { module: pick.module };
      },
    );
    const handle = await t.engine.start(def, { input: {}, cwd: await tempDir() });
    expect(await handle.result).toEqual({ module: "auth" });
    const recs = await records(t.journal, handle.runId);
    const answered = recs.find((r) => r.ev.type === "human.answered")?.ev;
    expect(answered).toMatchObject({ answeredBy: "timeout" });
  });

  test("input and output schema validation gate the run", async () => {
    const t = testEngine();
    const def = defineWorkflow(
      { description: "io", input: z.object({ n: z.number() }), output: z.object({ n: z.number() }) },
      async (_ctx, input) => ({ n: String(input.n) }) as never,
    );
    await expect(t.engine.start(def, { input: { n: "x" }, cwd: await tempDir() })).rejects.toMatchObject({
      code: "invalid_input",
    });
    const handle = await t.engine.start(def, { input: { n: 1 }, cwd: await tempDir() });
    await expect(handle.result).rejects.toMatchObject({ code: "invalid_output" });
  });

  test("returning an unawaited promise fails with the forgot-to-await hint", async () => {
    const t = testEngine();
    t.builder.on({ key: "*" }, { ok: true });
    const def = defineWorkflow(
      { description: "clone", input: z.object({}), output: z.any() },
      async (ctx) => ({ pending: ctx.agent("x", { schema: z.object({ ok: z.boolean() }), key: "p" }) }),
    );
    const handle = await t.engine.start(def, { input: {}, cwd: await tempDir() });
    await expect(handle.result).rejects.toMatchObject({
      message: expect.stringContaining("did you forget to await"),
    });
  });

  test("sub-workflows: typed output, own journal, inherited budget pool, depth cap", async () => {
    const child = defineWorkflow(
      {
        name: "fix-pass",
        description: "child",
        input: z.object({ target: z.string() }),
        output: z.object({ fixed: z.boolean() }),
      },
      async (ctx, { target }) => {
        const r = await ctx.agent(`fix ${target}`, {
          schema: z.object({ ok: z.boolean() }),
          key: `fix:${target}`,
        });
        return { fixed: r.ok };
      },
    );
    const t = testEngine({
      registry: { get: async (name) => (name === "fix-pass" ? child : undefined) },
    });
    t.builder.on({ key: "fix:*" }, { ok: true }, { usage: { input: 10, output: 5 } });
    const def = defineWorkflow(
      {
        description: "parent",
        input: z.object({}),
        output: z.object({ fixed: z.boolean(), byName: z.boolean() }),
      },
      async (ctx) => {
        const direct = await ctx.workflow(child, { target: "auth" }, { budget: { fraction: 0.5 } });
        const named = (await ctx.workflow("fix-pass", { target: "api" })) as { fixed: boolean };
        return { fixed: direct.fixed, byName: named.fixed };
      },
    );
    const handle = await t.engine.start(def, { input: {}, cwd: await tempDir() });
    expect(await handle.result).toEqual({ fixed: true, byName: true });

    const recs = await records(t.journal, handle.runId);
    const childIds = recs
      .filter((r) => r.ev.type === "step.scheduled" && r.ev.childRunId)
      .map((r) => (r.ev.type === "step.scheduled" ? r.ev.childRunId : undefined));
    expect(childIds).toHaveLength(2);
    const childRecs = await records(t.journal, childIds[0]!);
    expect(childRecs.some((r) => r.ev.type === "run.completed")).toBe(true);
    // the child's samples read from the SHARED pool, so parent spend is visible there
    const sampled = childRecs.filter((r) => r.ev.type === "budget.sampled");
    expect(sampled.length).toBeGreaterThan(0);
    const last = sampled[sampled.length - 1]!.ev;
    if (last.type === "budget.sampled") expect(last.tokens).toBeGreaterThan(0);
  });

  test("depth cap rejects nesting past 3", async () => {
    const deep: ReturnType<typeof defineWorkflow>[] = [];
    for (let i = 0; i < 5; i++) {
      const inner = deep[i - 1];
      deep.push(
        defineWorkflow(
          {
            name: `d${i}`,
            description: "deep",
            input: z.object({}),
            output: z.object({ depth: z.number() }),
          },
          async (ctx) => {
            if (!inner) return { depth: 0 };
            const r = (await ctx.workflow(inner as never, {})) as { depth: number };
            return { depth: r.depth + 1 };
          },
        ),
      );
    }
    const t = testEngine();
    const handle = await t.engine.start(deep[4]! as never, { input: {}, cwd: await tempDir() });
    await expect(handle.result).rejects.toMatchObject({ code: "depth_exceeded" });
  });

  test("check with exec: pass/fail, and a failed required check fails the run", async () => {
    const t = testEngine();
    const def = defineWorkflow(
      { description: "check", input: z.object({}), output: z.object({ status: z.string() }) },
      async (ctx) => {
        const good = await ctx.check("truth", { exec: ["true"] });
        expect(good.status).toBe("pass");
        const bad = await ctx.check("lies", { exec: ["false"], required: true });
        expect(bad.status).toBe("fail");
        return { status: bad.status };
      },
    );
    const handle = await t.engine.start(def, { input: {}, cwd: await tempDir() });
    await expect(handle.result).rejects.toMatchObject({
      code: "check_failed",
      message: expect.stringContaining("lies"),
    });
  });

  test("trust-prior records the deliberate skip", async () => {
    const t = testEngine();
    const def = defineWorkflow(
      { description: "tp", input: z.object({}), output: z.object({ status: z.string() }) },
      async (ctx) => {
        const r = await ctx.check("tests", { trustPrior: { run: "7f3a", reason: "unchanged since" } });
        return { status: r.status };
      },
    );
    const handle = await t.engine.start(def, { input: {}, cwd: await tempDir() });
    expect(await handle.result).toEqual({ status: "trust-prior" });
    const state = await t.engine.state(handle.runId);
    expect(state.checks[0]).toMatchObject({ name: "tests", status: "trust-prior" });
  });

  test("cancel aborts in-flight work; the run stays journaled as cancelled", async () => {
    const t = testEngine();
    t.builder.on({ key: "slow" }, { ok: true }, { delayMs: 5_000 });
    const def = defineWorkflow(
      { description: "cancel", input: z.object({}), output: z.object({}) },
      async (ctx) => {
        await ctx.agent("slow", { schema: z.object({ ok: z.boolean() }), key: "slow" });
        return {};
      },
    );
    const handle = await t.engine.start(def, { input: {}, cwd: await tempDir() });
    await new Promise((r) => setTimeout(r, 50));
    await t.engine.cancel(handle.runId);
    await expect(handle.result).rejects.toMatchObject({ code: "cancelled" });
    const state = await t.engine.state(handle.runId);
    expect(state.status).toBe("cancelled");
  });

  test("notes feed the ledger and the report renders them", async () => {
    const t = testEngine();
    const def = defineWorkflow(
      { description: "notes", input: z.object({}), output: z.object({}) },
      async (ctx) => {
        await ctx.note({ kind: "decision", text: "auth first", evidence: "smallest blast radius" });
        await ctx.note({ kind: "risk", text: "api untested" });
        return {};
      },
    );
    const handle = await t.engine.start(def, { input: {}, cwd: await tempDir() });
    await handle.result;
    const report = await t.engine.report(handle.runId);
    expect(report).toContain("auth first");
    expect(report).toContain("**risk**: api untested");
  });

  test("signal: durable external wait resolves with a validated payload", async () => {
    const t = testEngine();
    const def = defineWorkflow(
      { description: "signal", input: z.object({}), output: z.object({ sha: z.string() }) },
      async (ctx) => {
        const payload = await ctx.signal("ci-done", z.object({ sha: z.string() }));
        return { sha: payload.sha };
      },
    );
    const handle = await t.engine.start(def, { input: {}, cwd: await tempDir() });
    const outcome = await handle.outcome();
    expect(outcome.status).toBe("waiting_for_signal");
    await t.engine.signal(handle.runId, "ci-done", { sha: "abc123" });
    expect(await handle.result).toEqual({ sha: "abc123" });
  });

  test("sleep completes after its duration without blocking live work counters", async () => {
    const t = testEngine();
    const def = defineWorkflow(
      { description: "sleep", input: z.object({}), output: z.object({ ok: z.boolean() }) },
      async (ctx) => {
        await ctx.sleep(30);
        return { ok: true };
      },
    );
    const handle = await t.engine.start(def, { input: {}, cwd: await tempDir() });
    expect(await handle.result).toEqual({ ok: true });
    const recs = await records(t.journal, handle.runId);
    expect(recs.some((r) => r.ev.type === "timer.fired")).toBe(true);
  });

  test("now/random/uuid are journaled steps", async () => {
    const t = testEngine();
    const def = defineWorkflow(
      {
        description: "rand",
        input: z.object({}),
        output: z.object({ n: z.number(), r: z.number(), u: z.string() }),
      },
      async (ctx) => ({ n: await ctx.now(), r: await ctx.random(), u: await ctx.uuid() }),
    );
    const handle = await t.engine.start(def, { input: {}, cwd: await tempDir() });
    const out = (await handle.result) as { n: number; r: number; u: string };
    expect(out.n).toBeGreaterThan(0);
    expect(out.u).toMatch(/^[0-9a-f-]{36}$/);
    const recs = await records(t.journal, handle.runId);
    expect(recs.filter((r) => r.ev.type === "step.completed")).toHaveLength(3);
  });

  test("routing: per-step provider override reaches the other vendor; defaults fill the rest", async () => {
    const t = testEngine();
    t.builder.on({ key: "*" }, { ok: true });
    const def = defineWorkflow(
      { description: "route", input: z.object({}), output: z.object({}) },
      async (ctx) => {
        await ctx.agent("first", { schema: z.object({ ok: z.boolean() }), key: "a" });
        await ctx.agent("second", {
          schema: z.object({ ok: z.boolean() }),
          key: "b",
          provider: "codex",
          model: "gpt-5.2-codex",
        });
        return {};
      },
    );
    const handle = await t.engine.start(def, { input: {}, cwd: await tempDir() });
    await handle.result;
    const recs = await records(t.journal, handle.runId);
    const routes = recs
      .filter((r) => r.ev.type === "step.scheduled" && r.ev.kind === "agent")
      .map((r) => (r.ev.type === "step.scheduled" ? r.ev.route : undefined));
    expect(routes[0]).toMatchObject({ provider: "claude", model: "claude-opus-5", effort: "high" });
    expect(routes[1]).toMatchObject({ provider: "codex", model: "gpt-5.2-codex" });
  });
});

describe("resume across engine instances", () => {
  test("a run suspended on a human resumes in a new process and completes with zero re-calls", async () => {
    const def = defineWorkflow(
      {
        name: "review",
        description: "review",
        input: z.object({ base: z.string().default("main") }),
        output: z.object({ approved: z.boolean(), claims: z.number() }),
      },
      async (ctx, { base }) => {
        const found = await ctx.agent(`review since ${base}`, {
          schema: z.object({ findings: z.array(Finding) }),
          key: "find",
        });
        const ok = await ctx.human.approve({ action: `Fix ${found.findings.length} findings?` });
        return { approved: ok.approved, claims: found.findings.length };
      },
    );

    const t1 = testEngine();
    t1.builder.on({ key: "find" }, { findings: [{ file: "a.ts", line: 1, claim: "bug" }] });
    const cwd = await tempDir();
    const h1 = await t1.engine.start(def, { input: {}, cwd });
    const outcome = await h1.outcome();
    expect(outcome.status).toBe("waiting_for_human");
    const reqId = outcome.status === "waiting_for_human" ? outcome.pending[0]!.id : "";

    // "Process exits" — release the claim so a later process can really resume.
    await t1.engine.shutdown();
    // Answer lands from the CLI against a fresh engine (no active run).
    const t2 = reopen(t1);
    await t2.engine.answer(h1.runId, reqId, { approved: true, note: "ship it" });

    // Third process resumes: agent step served from journal — the mock has NO rules,
    // so any provider call would throw.
    const t3 = reopen(t1);
    const h2 = await t3.engine.resume(h1.runId, { def });
    expect(await h2.result).toEqual({ approved: true, claims: 1 });
    expect(t3.builder.calls).toHaveLength(0);
  });
});
