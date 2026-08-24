import type { JournalRecord } from "@techery/weft-core";
import { mock } from "@techery/weft-provider-mock";
import { defineWorkflow, z } from "@techery/weft-sdk";
import { afterAll, describe, expect, test } from "vitest";
import { cleanupRepos, reopen, tempDir, testEngine } from "./helpers.ts";

afterAll(cleanupRepos);

async function records(journal: { read(runId: string): AsyncIterable<JournalRecord> }, runId: string) {
  const out: JournalRecord[] = [];
  for await (const rec of journal.read(runId)) out.push(rec);
  return out;
}

const Out = z.object({ values: z.array(z.string()) });

describe("replay & edit-tolerant resume", () => {
  test("journaled now/random/uuid reproduce exactly on resume", async () => {
    const seen: Array<{ n: number; r: number; u: string }> = [];
    const def = defineWorkflow(
      { name: "rand", description: "rand", input: z.object({}), output: z.object({ u: z.string() }) },
      async (ctx) => {
        const n = await ctx.now();
        const r = await ctx.random();
        const u = await ctx.uuid();
        seen.push({ n, r, u });
        await ctx.human.approve({ action: "continue?" });
        return { u };
      },
    );
    const t1 = testEngine();
    const cwd = await tempDir();
    const h1 = await t1.engine.start(def, { input: {}, cwd });
    const outcome = await h1.outcome();
    if (outcome.status !== "waiting_for_human") throw new Error(`expected suspension, got ${outcome.status}`);
    await t1.engine.answer(h1.runId, outcome.pending[0]!.id, { approved: true });
    await h1.result;

    const t2 = reopen(t1);
    const h2 = await t2.engine.resume(h1.runId, { def });
    const out = (await h2.result) as { u: string };
    expect(seen).toHaveLength(2);
    expect(seen[1]).toEqual(seen[0]);
    expect(out.u).toBe(seen[0]!.u);
  });

  test("reordering steps salvages by content; nothing re-runs", async () => {
    const mkDef = (order: string[]) =>
      defineWorkflow(
        { name: "sweep", description: "sweep", input: z.object({}), output: Out },
        async (ctx) => {
          const values: string[] = [];
          for (const item of order) {
            const r = await ctx.agent(`analyze ${item}`, {
              schema: z.object({ tag: z.string() }),
              key: `analyze:${item}`,
            });
            values.push(r.tag);
          }
          await ctx.human.approve({ action: "done?" });
          return { values };
        },
      );

    const t1 = testEngine();
    t1.builder.on({ key: "analyze:*" }, (req) => ({ tag: `tag-${req.key!.split(":")[1]}` }));
    const cwd = await tempDir();
    const h1 = await t1.engine.start(mkDef(["a", "b", "c"]), { input: {}, cwd });
    const o1 = await h1.outcome();
    if (o1.status !== "waiting_for_human") throw new Error("expected suspension");
    // The first process exits (releasing its claim); the run stays suspended on disk.
    await t1.engine.shutdown();
    // Suspended run; edit reorders the loop. Resume with NO fixtures: any provider call throws.
    const t2 = reopen(t1);
    await t2.engine.answer(h1.runId, o1.pending[0]!.id, { approved: true });
    const t3 = reopen(t1);
    const h2 = await t3.engine.resume(h1.runId, { def: mkDef(["c", "a", "b"]) });
    const out = (await h2.result) as { values: string[] };
    expect(out.values).toEqual(["tag-c", "tag-a", "tag-b"]);
    expect(t3.builder.calls).toHaveLength(0);
    const recs = await records(t3.journal, h1.runId);
    expect(recs.filter((r) => r.ev.type === "replay.salvaged").length).toBeGreaterThan(0);
  });

  test("rewording one prompt re-runs that step only; the rest serve from the journal", async () => {
    const mkDef = (promptB: string) =>
      defineWorkflow({ name: "two", description: "two", input: z.object({}), output: Out }, async (ctx) => {
        const a = await ctx.agent("stable prompt A", { schema: z.object({ tag: z.string() }), key: "a" });
        const b = await ctx.agent(promptB, { schema: z.object({ tag: z.string() }), key: "b" });
        await ctx.human.approve({ action: "done?" });
        return { values: [a.tag, b.tag] };
      });
    const t1 = testEngine();
    t1.builder.on({ key: "*" }, (req) => ({ tag: `v1:${req.key}` }));
    const cwd = await tempDir();
    const h1 = await t1.engine.start(mkDef("original B"), { input: {}, cwd });
    const o1 = await h1.outcome();
    if (o1.status !== "waiting_for_human") throw new Error("expected suspension");
    await t1.engine.answer(h1.runId, o1.pending[0]!.id, { approved: true });
    await h1.result;

    const t2 = reopen(t1);
    t2.builder.on({ key: "b" }, { tag: "v2:b" });
    const h2 = await t2.engine.resume(h1.runId, { def: mkDef("reworded B") });
    const out = (await h2.result) as { values: string[] };
    expect(out.values).toEqual(["v1:a", "v2:b"]);
    expect(t2.builder.calls.map((c) => c.key)).toEqual(["b"]);
    const recs = await records(t2.journal, h1.runId);
    expect(recs.filter((r) => r.ev.type === "replay.diverged").length).toBeGreaterThan(0);
  });

  test("--reuse key serves a reworded step by identity (deliberate staleness)", async () => {
    const mkDef = (prompt: string) =>
      defineWorkflow(
        { name: "iter", description: "iter", input: z.object({}), output: z.object({ tag: z.string() }) },
        async (ctx) => {
          const r = await ctx.agent(prompt, { schema: z.object({ tag: z.string() }), key: "the-step" });
          await ctx.human.approve({ action: "done?" });
          return { tag: r.tag };
        },
      );
    const t1 = testEngine();
    t1.builder.on({ key: "the-step" }, { tag: "yesterday" });
    const cwd = await tempDir();
    const h1 = await t1.engine.start(mkDef("v1"), { input: {}, cwd });
    const o1 = await h1.outcome();
    if (o1.status !== "waiting_for_human") throw new Error("expected suspension");
    await t1.engine.answer(h1.runId, o1.pending[0]!.id, { approved: true });
    await h1.result;

    const t2 = reopen(t1); // no fixtures — a re-run would fail
    const h2 = await t2.engine.resume(h1.runId, { def: mkDef("v2 fully reworded"), reuse: "key" });
    expect(await h2.result).toEqual({ tag: "yesterday" });
    expect(t2.builder.calls).toHaveLength(0);
  });

  test("failed steps are not served: resume re-runs them", async () => {
    const def = defineWorkflow(
      { name: "flaky", description: "flaky", input: z.object({}), output: z.object({ ok: z.boolean() }) },
      async (ctx) => {
        const r = await ctx.agent("do it", {
          schema: z.object({ ok: z.boolean() }),
          key: "flaky",
          repair: 0,
        });
        return { ok: r.ok };
      },
    );
    const t1 = testEngine();
    t1.builder.on({ key: "flaky" }, { wrong: true });
    const cwd = await tempDir();
    const h1 = await t1.engine.start(def, { input: {}, cwd });
    await expect(h1.result).rejects.toMatchObject({ code: "schema_repair_exhausted" });

    const t2 = reopen(t1);
    t2.builder.on({ key: "flaky" }, { ok: true });
    const h2 = await t2.engine.resume(h1.runId, { def });
    expect(await h2.result).toEqual({ ok: true });
    expect(t2.builder.calls).toHaveLength(1);
  });

  test("parallel completion order is reproduced (continuation determinism)", async () => {
    const def = defineWorkflow(
      { name: "par", description: "par", input: z.object({}), output: Out },
      async (ctx) => {
        const order: string[] = [];
        const settled = await ctx.parallel(
          ["fast", "slow", "mid"].map((k) =>
            ctx.agent(`work ${k}`, { schema: z.object({ tag: z.string() }), key: `w:${k}` }).then((r) => {
              order.push(k);
              return r;
            }),
          ),
        );
        await ctx.human.approve({ action: "done?" });
        return { values: [...order, ...ctx.ok(settled).map((s) => s.tag)] };
      },
    );
    const t1 = testEngine();
    t1.builder.on({ key: "w:fast" }, { tag: "f" }, { delayMs: 5 });
    t1.builder.on({ key: "w:slow" }, { tag: "s" }, { delayMs: 120 });
    t1.builder.on({ key: "w:mid" }, { tag: "m" }, { delayMs: 60 });
    const cwd = await tempDir();
    const h1 = await t1.engine.start(def, { input: {}, cwd });
    const o1 = await h1.outcome();
    if (o1.status !== "waiting_for_human") throw new Error("expected suspension");
    await t1.engine.answer(h1.runId, o1.pending[0]!.id, { approved: true });
    const out1 = (await h1.result) as { values: string[] };
    // The original completion order is wall-clock (mock delays under scheduler
    // contention on slow machines) — the contract is only that replay REPRODUCES
    // whatever order the journal recorded, asserted below.
    expect([...out1.values.slice(0, 3)].sort()).toEqual(["fast", "mid", "slow"]);

    // Resume from scratch with no fixtures: cached completions must be delivered
    // in the journaled order, so the continuation order reproduces.
    const t2 = reopen(t1);
    const h2 = await t2.engine.resume(h1.runId, { def });
    const out2 = (await h2.result) as { values: string[] };
    expect(out2.values).toEqual(out1.values);
    expect(t2.builder.calls).toHaveLength(0);
  });

  test("an unanswered human request re-surfaces with the same id, never duplicated", async () => {
    const def = defineWorkflow(
      { name: "wait", description: "wait", input: z.object({}), output: z.object({ ok: z.boolean() }) },
      async (ctx) => {
        const r = await ctx.human.approve({ action: "proceed?" });
        return { ok: r.approved };
      },
    );
    const t1 = testEngine();
    const cwd = await tempDir();
    const h1 = await t1.engine.start(def, { input: {}, cwd });
    const o1 = await h1.outcome();
    if (o1.status !== "waiting_for_human") throw new Error("expected suspension");
    const firstId = o1.pending[0]!.id;

    // Resume without answering: same request id, still exactly one human.requested.
    await t1.engine.shutdown(); // the first process dies, releasing its claim
    const t2 = reopen(t1);
    const h2 = await t2.engine.resume(h1.runId, { def });
    const o2 = await h2.outcome();
    if (o2.status !== "waiting_for_human") throw new Error("expected suspension again");
    expect(o2.pending[0]!.id).toBe(firstId);
    const recs = await records(t2.journal, h1.runId);
    expect(recs.filter((r) => r.ev.type === "human.requested")).toHaveLength(1);

    await t2.engine.answer(h1.runId, firstId, { approved: true });
    expect(await h2.result).toEqual({ ok: true });
  });

  test("replay --dry reports hits, salvage, and the diverged step without touching providers", async () => {
    const mkDef = (promptB: string) =>
      defineWorkflow({ name: "dry", description: "dry", input: z.object({}), output: Out }, async (ctx) => {
        const a = await ctx.agent("A", { schema: z.object({ tag: z.string() }), key: "a" });
        const b = await ctx.agent(promptB, { schema: z.object({ tag: z.string() }), key: "b" });
        return { values: [a.tag, b.tag] };
      });
    const t1 = testEngine();
    t1.builder.on({ key: "*" }, (req) => ({ tag: req.key! }));
    const cwd = await tempDir();
    const h1 = await t1.engine.start(mkDef("B"), { input: {}, cwd });
    await h1.result;

    const t2 = reopen(t1); // no fixtures
    const clean = await t2.engine.replayDry(h1.runId, { def: mkDef("B") });
    expect(clean).toMatchObject({ hits: 2, salvaged: 0, completed: true });
    expect(clean.diverged).toHaveLength(0);

    const edited = await t2.engine.replayDry(h1.runId, { def: mkDef("B reworded") });
    expect(edited.hits).toBe(1);
    expect(edited.completed).toBe(false);
    expect(edited.diverged[0]).toMatchObject({ key: "b" });
    expect(t2.builder.calls).toHaveLength(0);
  });

  test("resuming an already-complete run just returns its output", async () => {
    const def = defineWorkflow(
      { name: "done", description: "done", input: z.object({}), output: z.object({ n: z.number() }) },
      async (ctx) => {
        const r = await ctx.agent("x", { schema: z.object({ n: z.number() }), key: "only" });
        return { n: r.n };
      },
    );
    const t1 = testEngine();
    t1.builder.on({ key: "only" }, { n: 42 });
    const h1 = await t1.engine.start(def, { input: {}, cwd: await tempDir() });
    await h1.result;
    const t2 = reopen(t1);
    const h2 = await t2.engine.resume(h1.runId, { def });
    expect(await h2.result).toEqual({ n: 42 });
    expect(t2.builder.calls).toHaveLength(0);
  });

  test("a sub-workflow interrupted mid-flight resumes its child run by id", async () => {
    const child = defineWorkflow(
      { name: "inner", description: "inner", input: z.object({}), output: z.object({ ok: z.boolean() }) },
      async (ctx) => {
        const r = await ctx.agent("inner work", { schema: z.object({ ok: z.boolean() }), key: "inner-step" });
        const approval = await ctx.human.approve({ action: "child gate" });
        return { ok: r.ok && approval.approved };
      },
    );
    const parent = defineWorkflow(
      { name: "outer", description: "outer", input: z.object({}), output: z.object({ ok: z.boolean() }) },
      async (ctx) => {
        const r = (await ctx.workflow(child, {})) as { ok: boolean };
        return { ok: r.ok };
      },
    );
    const t1 = testEngine();
    t1.builder.on({ key: "inner-step" }, { ok: true });
    const cwd = await tempDir();
    const h1 = await t1.engine.start(parent, { input: {}, cwd });
    // wait for the child's human gate to surface
    await new Promise((r) => setTimeout(r, 200));
    const runs = await t1.journal.list();
    const childRun = runs.find((r) => r.parentRunId === h1.runId);
    expect(childRun).toBeDefined();

    // New process: answer the child's request, resume the PARENT; it resumes the child.
    await t1.engine.shutdown(); // the first process dies, releasing parent + child claims
    const t2 = reopen(t1);
    const childPending = await t2.engine.pending(childRun!.runId);
    expect(childPending).toHaveLength(1);
    await t2.engine.answer(childRun!.runId, childPending[0]!.id, { approved: true });
    const t3 = reopen(t1);
    const h2 = await t3.engine.resume(h1.runId, { def: parent });
    expect(await h2.result).toEqual({ ok: true });
    expect(t3.builder.calls).toHaveLength(0);
  });
});

describe("replay identity: a cache hit must not lie", () => {
  const Colours = z.object({ before: z.string(), after: z.string() });
  const Answer = z.object({ answer: z.string() });

  /**
   * Two probes ask the same question either side of a change to the world. Their prompt
   * and schema are identical and neither carries a `key`, so the journal cannot tell
   * them apart by content. Deleting the first slides the second into seq 1 — where the
   * fast path would hand it the deleted probe's PRE-change answer.
   */
  test("deleting one of two identical keyless steps re-runs rather than serving the stale entry", async () => {
    let world = "RED";
    const both = defineWorkflow(
      { name: "world", description: "world", input: z.object({}), output: Colours },
      async (ctx) => {
        const before = await ctx.agent("what colour is the build?", { schema: Answer });
        world = "GREEN";
        const after = await ctx.agent("what colour is the build?", { schema: Answer });
        await ctx.human.approve({ action: "ship?" });
        return { before: before.answer, after: after.answer };
      },
    );
    const onlyAfter = defineWorkflow(
      { name: "world", description: "world", input: z.object({}), output: Colours },
      async (ctx) => {
        world = "GREEN";
        const after = await ctx.agent("what colour is the build?", { schema: Answer });
        await ctx.human.approve({ action: "ship?" });
        return { before: "n/a", after: after.answer };
      },
    );

    const answerWorld = () => mock().on({}, () => ({ answer: world }));
    const t1 = testEngine({ builder: answerWorld() });
    const cwd = await tempDir();
    const h1 = await t1.engine.start(both, { input: {}, cwd });
    const o1 = await h1.outcome();
    if (o1.status !== "waiting_for_human") throw new Error(`expected suspension, got ${o1.status}`);
    await t1.engine.answer(h1.runId, o1.pending[0]!.id, { approved: true });
    expect(await h1.result).toEqual({ before: "RED", after: "GREEN" });

    world = "GREEN";
    const t2 = reopen(t1, { builder: answerWorld() });
    const h2 = await t2.engine.resume(h1.runId, { def: onlyAfter });
    const o2 = await h2.outcome();
    if (o2.status === "waiting_for_human") {
      await t2.engine.answer(h1.runId, o2.pending[0]!.id, { approved: true });
    }
    // The pre-change "RED" must not survive the edit.
    expect((await h2.result) as { after: string }).toMatchObject({ after: "GREEN" });

    const recs = await records(t2.journal, h1.runId);
    expect(
      recs.some((r) => r.ev.type === "replay.diverged" && /ambiguous keyless identity/.test(r.ev.reason)),
    ).toBe(true);
  });

  /**
   * The body hash sees `def.run`'s own source and nothing else, so a body that delegates
   * — `async (ctx) => steps(ctx)` — reads identical no matter how the module behind
   * `steps` is edited. The bundle hash is what covers that module, and `positionsTrusted`
   * folds both in.
   */
  test("an edit inside a delegated module is caught by the bundle hash", async () => {
    let world = "RED";
    let steps: (ctx: never) => Promise<{ before: string; after: string }>;
    const bothSteps = async (ctx: never) => {
      const c = ctx as unknown as {
        agent(p: string, o: unknown): Promise<{ answer: string }>;
        human: { approve(o: unknown): Promise<unknown> };
      };
      const before = await c.agent("what colour is the build?", { schema: Answer });
      world = "GREEN";
      const after = await c.agent("what colour is the build?", { schema: Answer });
      await c.human.approve({ action: "ship?" });
      return { before: before.answer, after: after.answer };
    };
    const laterStepsOnly = async (ctx: never) => {
      const c = ctx as unknown as {
        agent(p: string, o: unknown): Promise<{ answer: string }>;
        human: { approve(o: unknown): Promise<unknown> };
      };
      world = "GREEN";
      const after = await c.agent("what colour is the build?", { schema: Answer });
      await c.human.approve({ action: "ship?" });
      return { before: "n/a", after: after.answer };
    };
    // ONE definition across both runs: `def.run.toString()` is byte-identical, so the
    // body hash cannot tell the two versions apart. Only the bundle hash can.
    const def = defineWorkflow(
      { name: "delegated", description: "delegated", input: z.object({}), output: Colours },
      async (ctx) => steps(ctx as never),
    );

    const answerWorld = () => mock().on({}, () => ({ answer: world }));
    steps = bothSteps;
    const t1 = testEngine({ builder: answerWorld() });
    const cwd = await tempDir();
    const h1 = await t1.engine.start(def, { input: {}, cwd, defHash: "bundle-v1" });
    const o1 = await h1.outcome();
    if (o1.status !== "waiting_for_human") throw new Error(`expected suspension, got ${o1.status}`);
    await t1.engine.answer(h1.runId, o1.pending[0]!.id, { approved: true });
    expect(await h1.result).toEqual({ before: "RED", after: "GREEN" });

    // The helper module changed — one probe deleted — and the host's bundle hash moved
    // with it, which is the only signal available.
    steps = laterStepsOnly;
    world = "GREEN";
    const t2 = reopen(t1, { builder: answerWorld() });
    const h2 = await t2.engine.resume(h1.runId, { def, defHash: "bundle-v2" });
    const o2 = await h2.outcome();
    if (o2.status === "waiting_for_human") {
      await t2.engine.answer(h1.runId, o2.pending[0]!.id, { approved: true });
    }
    expect((await h2.result) as { after: string }).toMatchObject({ after: "GREEN" });
    const recs = await records(t2.journal, h1.runId);
    expect(
      recs.some((r) => r.ev.type === "replay.diverged" && /ambiguous keyless identity/.test(r.ev.reason)),
    ).toBe(true);
  });

  test("an unchanged bundle hash still serves both identical steps for free", async () => {
    // The other half: the stamp must not make every resume re-run. Same script, same
    // bundle hash, two identical keyless steps — nothing re-dispatches.
    let calls = 0;
    const def = defineWorkflow(
      { name: "twice-hashed", description: "twice", input: z.object({}), output: Colours },
      async (ctx) => {
        const a = await ctx.agent("same question", { schema: Answer });
        const b = await ctx.agent("same question", { schema: Answer });
        await ctx.human.approve({ action: "ship?" });
        return { before: a.answer, after: b.answer };
      },
    );
    const builder = () =>
      mock().on({}, () => {
        calls++;
        return { answer: "same" };
      });
    const t1 = testEngine({ builder: builder() });
    const h1 = await t1.engine.start(def, { input: {}, cwd: await tempDir(), defHash: "bundle-v1" });
    const o1 = await h1.outcome();
    if (o1.status !== "waiting_for_human") throw new Error(`expected suspension, got ${o1.status}`);
    await t1.engine.answer(h1.runId, o1.pending[0]!.id, { approved: true });
    await h1.result;
    expect(calls).toBe(2);

    const t2 = reopen(t1, { builder: builder() });
    const h2 = await t2.engine.resume(h1.runId, { def, defHash: "bundle-v1" });
    const o2 = await h2.outcome();
    if (o2.status === "waiting_for_human") {
      await t2.engine.answer(h1.runId, o2.pending[0]!.id, { approved: true });
    }
    await h2.result;
    expect(calls).toBe(2); // nothing re-dispatched
  });

  /**
   * A child run has its own journal, its own replay and its own call sites to move, so it
   * needs the same version stamp the root gets. It used to journal only its name and
   * default to trusting positions, which handed the second of two identical keyless
   * probes the deleted first one's answer — inside any `ctx.workflow` whose definition
   * changed between the runs.
   */
  test("a child workflow's own edit re-runs its ambiguous keyless step", async () => {
    let world = "RED";
    const childBoth = defineWorkflow(
      { name: "probe", description: "probe", input: z.object({}), output: Colours },
      async (ctx) => {
        const before = await ctx.agent("what colour is the build?", { schema: Answer });
        world = "GREEN";
        const after = await ctx.agent("what colour is the build?", { schema: Answer });
        await ctx.human.approve({ action: "child gate" });
        return { before: before.answer, after: after.answer };
      },
    );
    const childLater = defineWorkflow(
      { name: "probe", description: "probe", input: z.object({}), output: Colours },
      async (ctx) => {
        world = "GREEN";
        const after = await ctx.agent("what colour is the build?", { schema: Answer });
        await ctx.human.approve({ action: "child gate" });
        return { before: "n/a", after: after.answer };
      },
    );
    const parentOf = (child: typeof childBoth) =>
      defineWorkflow(
        { name: "outer", description: "outer", input: z.object({}), output: Colours },
        async (ctx) => (await ctx.workflow(child, {})) as { before: string; after: string },
      );

    const answerWorld = () => mock().on({}, () => ({ answer: world }));
    const t1 = testEngine({ builder: answerWorld() });
    const cwd = await tempDir();
    const h1 = await t1.engine.start(parentOf(childBoth), { input: {}, cwd });
    // The child suspends on its own gate; the parent surfaces it.
    const o1 = await h1.outcome();
    if (o1.status !== "waiting_for_human") throw new Error(`expected suspension, got ${o1.status}`);
    const runs = await t1.journal.list();
    const childRun = runs.find((r) => r.parentRunId === h1.runId);
    expect(childRun).toBeDefined();
    await t1.engine.answer(childRun!.runId, o1.pending[0]!.id, { approved: true });
    expect(await h1.result).toEqual({ before: "RED", after: "GREEN" });

    // The CHILD's definition changed; the parent's did not.
    world = "GREEN";
    const t2 = reopen(t1, { builder: answerWorld() });
    const h2 = await t2.engine.resume(h1.runId, { def: parentOf(childLater) });
    const o2 = await h2.outcome();
    if (o2.status === "waiting_for_human") {
      await t2.engine.answer(childRun!.runId, o2.pending[0]!.id, { approved: true });
    }
    // The pre-change "RED" must not survive the child's edit either.
    expect((await h2.result) as { after: string }).toMatchObject({ after: "GREEN" });
    const childRecs = await records(t2.journal, childRun!.runId);
    expect(
      childRecs.some(
        (r) => r.ev.type === "replay.diverged" && /ambiguous keyless identity/.test(r.ev.reason),
      ),
    ).toBe(true);
  });

  test("an unchanged resume of the same two identical steps still costs zero calls", async () => {
    let calls = 0;
    const def = defineWorkflow(
      { name: "twice", description: "twice", input: z.object({}), output: Colours },
      async (ctx) => {
        const before = await ctx.agent("what colour is the build?", { schema: Answer });
        const after = await ctx.agent("what colour is the build?", { schema: Answer });
        await ctx.human.approve({ action: "ship?" });
        return { before: before.answer, after: after.answer };
      },
    );
    const counting = () =>
      mock().on({}, () => {
        calls++;
        return { answer: "RED" };
      });

    const t1 = testEngine({ builder: counting() });
    const cwd = await tempDir();
    const h1 = await t1.engine.start(def, { input: {}, cwd });
    const o1 = await h1.outcome();
    if (o1.status !== "waiting_for_human") throw new Error(`expected suspension, got ${o1.status}`);
    await t1.engine.answer(h1.runId, o1.pending[0]!.id, { approved: true });
    await h1.result;
    expect(calls).toBe(2);

    const t2 = reopen(t1, { builder: counting() });
    const h2 = await t2.engine.resume(h1.runId, { def });
    const o2 = await h2.outcome();
    if (o2.status === "waiting_for_human") {
      await t2.engine.answer(h1.runId, o2.pending[0]!.id, { approved: true });
    }
    await h2.result;
    // Edit-tolerant replay is unaffected when the script did not change.
    expect(calls).toBe(2);
  });
});
