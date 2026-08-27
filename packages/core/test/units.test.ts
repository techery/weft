import {
  Budget,
  canonicalJson,
  hashStep,
  type JournalRecord,
  MemoryJournalStore,
  OrderedDelivery,
  ReplayIndex,
  reduceState,
  renderReport,
  Semaphore,
  structuralCheck,
  toWireSchema,
} from "@techery/weft-core";
import { StepError, z } from "@techery/weft-sdk";
import { describe, expect, test } from "vitest";

describe("canonical json & hashing", () => {
  test("key order does not matter; undefined fields are dropped", () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe(canonicalJson({ a: { c: 3, d: 2 }, b: 1 }));
    expect(canonicalJson({ a: 1, gone: undefined })).toBe(canonicalJson({ a: 1 }));
  });

  test("hashStep separates kind, payload, and schema", () => {
    const base = hashStep("agent", { prompt: "x" }, { type: "object" });
    expect(hashStep("bash", { prompt: "x" }, { type: "object" })).not.toBe(base);
    expect(hashStep("agent", { prompt: "y" }, { type: "object" })).not.toBe(base);
    expect(hashStep("agent", { prompt: "x" }, { type: "string" })).not.toBe(base);
    expect(hashStep("agent", { prompt: "x" }, { type: "object" })).toBe(base);
  });
});

describe("Budget", () => {
  test("charges flow up the parent chain and remaining respects both limits", () => {
    const parent = new Budget({ tokens: 1000 });
    const child = parent.child({ fraction: 0.5 });
    expect(child.remainingTokens()).toBe(500);
    child.charge({ input: 300, output: 100 });
    expect(child.spentTokens()).toBe(400);
    expect(parent.spentTokens()).toBe(400);
    expect(child.remainingTokens()).toBe(100);
    expect(parent.remainingTokens()).toBe(600);
    // parent exhaustion caps the child even below its own limit
    parent.charge({ input: 600, output: 0 });
    expect(child.remainingTokens()).toBe(0);
    expect(() => child.checkBeforeStep({ key: "x" })).toThrow(/budget exhausted/);
  });

  test("usd limits work independently", () => {
    const b = new Budget({ usd: 1 });
    b.charge({ input: 0, output: 0, usd: 0.75 });
    expect(b.remainingUsd()).toBe(0.25);
    expect(b.exhausted()).toBe(false);
    b.charge({ input: 0, output: 0, usd: 0.5 });
    expect(b.exhausted()).toBe(true);
  });
});

describe("Semaphore", () => {
  test("caps concurrency and grants FIFO", async () => {
    const sem = new Semaphore(2);
    let running = 0;
    let peak = 0;
    const order: number[] = [];
    await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        sem.with(async () => {
          order.push(i);
          running++;
          peak = Math.max(peak, running);
          await new Promise((r) => setTimeout(r, 10));
          running--;
        }),
      ),
    );
    expect(peak).toBe(2);
    expect(order).toEqual([0, 1, 2, 3, 4, 5]);
  });

  test("a task that ignores its abort does not keep the permit", async () => {
    // The engine's step timeout aborts an unresponsive attempt and gives up on it, but
    // the zombie keeps running. Holding the permit until it settles wedges every later
    // step behind work nothing can stop — with the default cap that is the whole run.
    const sem = new Semaphore(1);
    const ac = new AbortController();
    const hung = sem.with(() => new Promise<never>(() => undefined), ac.signal);
    hung.catch(() => undefined);

    let ran = false;
    const queued = sem.with(async () => {
      ran = true;
    });

    ac.abort();
    await Promise.race([
      queued,
      new Promise((_, reject) => setTimeout(() => reject(new Error("permit never freed")), 2_000)),
    ]);
    expect(ran).toBe(true);
  });

  test("a settled task releases exactly once, even with an abort afterwards", async () => {
    const sem = new Semaphore(1);
    const ac = new AbortController();
    expect(await sem.with(async () => "done", ac.signal)).toBe("done");
    ac.abort();
    // A double release would let two holders in at once.
    const held = await sem.acquire();
    let second = false;
    void sem.acquire().then(() => {
      second = true;
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(second).toBe(false);
    held();
  });

  test("aborted waiters leave the queue", async () => {
    const sem = new Semaphore(1);
    const release = await sem.acquire();
    const ac = new AbortController();
    const waiter = sem.acquire(ac.signal);
    ac.abort();
    await expect(waiter).rejects.toThrow(/aborted/);
    release();
    // the slot is still usable
    (await sem.acquire())();
  });
});

describe("OrderedDelivery", () => {
  test("delivers strictly in journaled order while pure", async () => {
    // `busy` is what tells the watchdog a continuation is still on its way: the runtime
    // counts live dispatches plus replay-path I/O. While the step that will deliver 10
    // is still working, the replay has not quiesced and 20 must stay parked.
    let busy = 1;
    const d = new OrderedDelivery([10, 20, 30], () => busy);
    const done: number[] = [];
    const p20 = d.deliver(20).then(() => done.push(20));
    await new Promise((r) => setTimeout(r, 5));
    expect(done).toEqual([]);
    busy = 0;
    await d.deliver(10).then(() => done.push(10));
    await p20;
    await d.deliver(30).then(() => done.push(30));
    expect(done).toEqual([10, 20, 30]);
  });

  test("breakOrder flushes everything parked", async () => {
    const d = new OrderedDelivery([1, 2, 3], () => 1);
    const done: number[] = [];
    const p3 = d.deliver(3).then(() => done.push(3));
    const p2 = d.deliver(2).then(() => done.push(2));
    d.breakOrder();
    await Promise.all([p2, p3]);
    expect(done.sort()).toEqual([2, 3]);
    await d.deliver(1); // resolves immediately after the break
  });

  test("watchdog skips orders the edited code never requests", async () => {
    const d = new OrderedDelivery([1, 2, 3], () => 0);
    const done: number[] = [];
    // order 1 is never requested (its step was deleted in an edit)
    await d.deliver(2).then(() => done.push(2));
    await d.deliver(3).then(() => done.push(3));
    expect(done).toEqual([2, 3]);
  });

  test("orders below the cursor deliver immediately", async () => {
    const d = new OrderedDelivery([5, 6], () => 0);
    await d.deliver(6); // watchdog skips 5
    await d.deliver(5); // now below cursor: immediate
  });
});

describe("structuralCheck", () => {
  const schema = {
    type: "object",
    properties: {
      module: { enum: ["auth", "api"] },
      count: { type: "integer" },
      tags: { type: "array", items: { type: "string" } },
      nested: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] },
    },
    required: ["module"],
  };

  test("accepts valid values", () => {
    expect(structuralCheck(schema, { module: "auth", count: 2, tags: ["a"], nested: { ok: true } })).toEqual(
      [],
    );
  });

  test("reports missing required, wrong types, bad enum with paths", () => {
    const issues = structuralCheck(schema, { count: 1.5, tags: [1], nested: {} });
    const paths = issues.map((i) => i.path).sort();
    expect(paths).toContain("module");
    expect(paths).toContain("count");
    expect(paths).toContain("tags.0");
    expect(paths).toContain("nested.ok");
  });

  test("anyOf matches any branch", () => {
    const s = { anyOf: [{ type: "string" }, { type: "number" }] };
    expect(structuralCheck(s, 5)).toEqual([]);
    expect(structuralCheck(s, "x")).toEqual([]);
    expect(structuralCheck(s, true)).toHaveLength(1);
  });

  test("enforces the constraint keywords the wire schema carries", () => {
    const min = { type: "string", minLength: 3 };
    expect(structuralCheck(min, "ab")).toHaveLength(1);
    expect(structuralCheck(min, "abc")).toEqual([]);
    expect(structuralCheck({ type: "string", maxLength: 2 }, "abc")).toHaveLength(1);
    expect(structuralCheck({ type: "string", pattern: "^a+$" }, "bbb")).toHaveLength(1);
    expect(structuralCheck({ type: "string", pattern: "^a+$" }, "aaa")).toEqual([]);
    expect(structuralCheck({ type: "number", minimum: 5 }, 4)).toHaveLength(1);
    expect(structuralCheck({ type: "number", maximum: 5 }, 6)).toHaveLength(1);
    expect(structuralCheck({ type: "number", exclusiveMinimum: 5 }, 5)).toHaveLength(1);
    expect(structuralCheck({ type: "number", exclusiveMaximum: 5 }, 5)).toHaveLength(1);
    expect(structuralCheck({ type: "number", multipleOf: 2 }, 3)).toHaveLength(1);
    expect(structuralCheck({ type: "array", minItems: 1 }, [])).toHaveLength(1);
    expect(structuralCheck({ type: "array", maxItems: 1 }, [1, 2])).toHaveLength(1);
    expect(structuralCheck({ const: "yes" }, "no")).toHaveLength(1);
    expect(structuralCheck({ const: "yes" }, "yes")).toEqual([]);
    const strict = { type: "object", properties: { a: { type: "number" } }, additionalProperties: false };
    expect(structuralCheck(strict, { a: 1, extra: true })).toHaveLength(1);
    expect(structuralCheck(strict, { a: 1 })).toEqual([]);
    // Nested constraints ride along (the { value } wire wrapping for primitives).
    const wired = {
      type: "object",
      properties: { value: { type: "string", minLength: 3 } },
      required: ["value"],
      additionalProperties: false,
    };
    expect(structuralCheck(wired, { value: "ab" })).toHaveLength(1);
    expect(structuralCheck(wired, { value: "abc" })).toEqual([]);
  });
});

describe("reduceState check metadata", () => {
  test("a re-scheduled seq binds each completion to its own occurrence", () => {
    // Seqs restart on resume, so an edited workflow can put a DIFFERENT check at a
    // seq an earlier pass used; each completion must read its own schedule's payload.
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
          type: "step.scheduled",
          seq: 1,
          hash: "h1",
          kind: "check",
          payload: { name: "lint", required: true },
        },
      },
      { i: 2, at: 3, ev: { type: "step.completed", seq: 1, output: { status: "fail" } } },
      {
        i: 3,
        at: 4,
        ev: {
          type: "step.scheduled",
          seq: 1,
          hash: "h2",
          kind: "check",
          payload: { name: "types", required: false },
          schema: { type: "object", properties: { status: { type: "string" } } },
        },
      },
      {
        i: 4,
        at: 5,
        ev: {
          type: "step.completed",
          seq: 1,
          output: {
            status: "pass",
            summary: "Types are sound",
            details: [
              { kind: "metric", name: "errors", actual: 0, expected: 0 },
              { kind: "file", path: "src/index.ts", line: 12, message: "validated" },
            ],
          },
          sessionId: "session-1",
          transcriptRef: { $blob: "a".repeat(64), size: 120 },
        },
      },
    ];
    const state = reduceState(recs);
    expect(state.checks).toEqual([
      { name: "lint", status: "fail", disposition: "executed", required: true },
      {
        name: "types",
        status: "pass",
        disposition: "executed",
        summary: "Types are sound",
        details: [
          { kind: "metric", name: "errors", actual: 0, expected: 0 },
          { kind: "file", path: "src/index.ts", line: 12, message: "validated" },
        ],
        required: false,
      },
    ]);
    expect(state.steps.at(-1)?.schema).toEqual({
      type: "object",
      properties: { status: { type: "string" } },
    });
    expect(state.steps.at(-1)?.sessionId).toBe("session-1");
    expect(state.steps.at(-1)?.transcriptRef).toEqual({ $blob: "a".repeat(64), size: 120 });
    const report = renderReport(state);
    expect(report).toContain("| types | pass | executed |  | Types are sound |");
    expect(report).toContain("**types:** errors: 0 (expected 0)");
    expect(report).toContain("**types:** src/index.ts:12 — validated");
  });
});

describe("reduceState terminal outcomes", () => {
  test("a resumed terminal outcome clears its opposite's fields", () => {
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
          error: { name: "StepError", code: "provider_error", message: "boom", step: {} },
        },
      },
      // a later resume re-executes and completes
      { i: 2, at: 3, ev: { type: "run.status", status: "executing" } },
      { i: 3, at: 4, ev: { type: "run.completed", output: { ok: true } } },
    ];
    const state = reduceState(recs);
    expect(state.status).toBe("complete");
    expect(state.output).toEqual({ ok: true });
    expect(state.error).toBeUndefined(); // the stale failure must not survive in reports
  });
});

describe("toWireSchema", () => {
  test("a zod union root travels wrapped: providers demand an object root", () => {
    const wire = toWireSchema(z.union([z.string(), z.number()]) as never);
    expect(wire.wrapped).toBe(true);
    expect((wire.json as { type?: string }).type).toBe("object");
    expect(structuralCheck(wire.json, { value: "x" })).toEqual([]);
    expect(structuralCheck(wire.json, { value: 4 })).toEqual([]);
    expect(structuralCheck(wire.json, { value: true })).toHaveLength(1);
  });

  test("a non-zod Standard Schema travels as a wrapped { value } carrier", () => {
    // A stand-in for e.g. a valibot string schema — its real value is a primitive.
    const custom = {
      "~standard": {
        version: 1,
        vendor: "custom",
        validate: (v: unknown) =>
          typeof v === "string" ? { value: v } : { issues: [{ message: "expected string" }] },
      },
    };
    const wire = toWireSchema(custom as never);
    expect(wire.wrapped).toBe(true);
    expect(wire.lints.some((l) => l.includes("non-zod"))).toBe(true);
    // The wrapper admits ANY value inside { value } — including primitives an
    // object-typed fallback would have refused before the real schema ever ran.
    expect(structuralCheck(wire.json, { value: "hi" })).toEqual([]);
    expect(structuralCheck(wire.json, { value: 42 })).toEqual([]);
    expect(structuralCheck(wire.json, "bare")).toHaveLength(1);
  });
});

describe("ReplayIndex", () => {
  test("indexes completions, humans, signals, and FIFO-consumes duplicate hashes", async () => {
    const store = new MemoryJournalStore();
    await store.append("r", [
      { type: "run.created", runId: "r", workflow: { name: "w" }, input: {}, cwd: "/", depth: 0 },
      { type: "step.scheduled", seq: 1, hash: "h1", kind: "agent", key: "a" },
      { type: "step.completed", seq: 1, output: { v: 1 }, usage: { input: 10, output: 5 } },
      { type: "step.scheduled", seq: 2, hash: "h1", kind: "agent", key: "a" },
      { type: "step.completed", seq: 2, output: { v: 2 } },
      { type: "step.scheduled", seq: 3, hash: "h2", kind: "bash" },
      { type: "step.failed", seq: 3, error: { name: "StepError", code: "timeout", message: "t", step: {} } },
      { type: "signal.received", name: "go", payload: { n: 1 } },
    ]);
    const records = [];
    for await (const rec of store.read("r")) records.push(rec);
    const idx = ReplayIndex.fromRecords(records);

    // duplicate hash: FIFO order
    const first = idx.matchStep(1, "h1", "agent", "a", "content");
    expect(first?.entry.output).toEqual({ v: 1 });
    first!.entry.consumed = true;
    const second = idx.matchStep(9, "h1", "agent", "a", "content");
    expect(second?.entry.output).toEqual({ v: 2 });
    expect(second?.via).toBe("salvage");
    // failed steps are never indexed
    expect(idx.matchStep(3, "h2", "bash", undefined, "content")).toBeUndefined();
    // usage restored
    expect(idx.totalUsage).toEqual({ tokens: 15, usd: 0, samples: 1 });
    // signals FIFO
    expect(idx.takeSignal("go")?.payload).toEqual({ n: 1 });
    expect(idx.takeSignal("go")).toBeUndefined();
  });

  test("reuse key matches a reworded step by identity only", async () => {
    const store = new MemoryJournalStore();
    await store.append("r", [
      { type: "step.scheduled", seq: 1, hash: "old-hash", kind: "agent", key: "the-step" },
      { type: "step.completed", seq: 1, output: { tag: "cached" } },
    ]);
    const records = [];
    for await (const rec of store.read("r")) records.push(rec);
    const idx = ReplayIndex.fromRecords(records);
    expect(idx.matchStep(1, "new-hash", "agent", "the-step", "content")).toBeUndefined();
    const byKey = idx.matchStep(1, "new-hash", "agent", "the-step", "key");
    expect(byKey?.via).toBe("key");
    expect(byKey?.entry.output).toEqual({ tag: "cached" });
  });

  test("retains completed settlement failures but drops a later execution failure", async () => {
    const store = new MemoryJournalStore();
    await store.append("r", [
      { type: "step.scheduled", seq: 1, hash: "h", kind: "agent", key: "task-agent" },
      { type: "step.completed", seq: 1, output: { taskBatchId: "batch-1" } },
      {
        type: "step.failed",
        seq: 1,
        phase: "settle",
        error: { name: "StepError", code: "conflict", message: "settlement failed", step: {} },
      },
    ]);
    const settlementRecords = [];
    for await (const rec of store.read("r")) settlementRecords.push(rec);
    const settlementIndex = ReplayIndex.fromRecords(settlementRecords);
    expect(settlementIndex.matchStep(1, "h", "agent", "task-agent", "content")?.entry.output).toEqual({
      taskBatchId: "batch-1",
    });

    await store.append("r", [
      { type: "step.scheduled", seq: 1, hash: "h", kind: "agent", key: "task-agent" },
      {
        type: "step.failed",
        seq: 1,
        phase: "execute",
        error: { name: "StepError", code: "timeout", message: "provider failed", step: {} },
      },
    ]);
    const executionRecords = [];
    for await (const rec of store.read("r")) executionRecords.push(rec);
    expect(
      ReplayIndex.fromRecords(executionRecords).matchStep(1, "h", "agent", "task-agent", "content"),
    ).toBeUndefined();
  });

  test("recognizes legacy completed-then-failed records as settlement failures", async () => {
    const store = new MemoryJournalStore();
    await store.append("r", [
      { type: "step.scheduled", seq: 1, hash: "legacy", kind: "agent" },
      { type: "step.completed", seq: 1, output: { paid: true } },
      {
        type: "step.failed",
        seq: 1,
        error: { name: "StepError", code: "conflict", message: "old settlement failure", step: {} },
      },
    ]);
    const records = [];
    for await (const rec of store.read("r")) records.push(rec);
    expect(
      ReplayIndex.fromRecords(records).matchStep(1, "legacy", "agent", undefined, "content")?.entry.output,
    ).toEqual({
      paid: true,
    });
  });
});

describe("StepError ergonomics", () => {
  test("carries step identity through serialization", () => {
    const e = new StepError("conflict", "patch fix:api conflicts on src/x.ts", {
      step: { key: "fix:api", kind: "sideeffect", runId: "7f3a" },
    });
    expect(StepError.deserialize(e.serialize()).step).toEqual({
      key: "fix:api",
      kind: "sideeffect",
      runId: "7f3a",
    });
  });
});

describe("ctx.pipeline builders", () => {
  test("branching a pipeline does not merge the branches' stages", async () => {
    const { runWorkflow } = await import("@techery/weft-testing");
    const { defineWorkflow } = await import("@techery/weft-sdk");

    const wf = defineWorkflow(
      {
        name: "branch",
        description: "two branches off one prefix",
        input: z.object({}),
        output: z.object({ a: z.array(z.number()), b: z.array(z.number()) }),
      },
      async (ctx) => {
        const base = ctx.pipeline([1, 2, 3]).map((n) => (n as number) * 10);
        // Sharing one mutable stage array made these two see each other's stages.
        const a = await base.map((n) => (n as number) + 1).run();
        const b = await base.map((n) => (n as number) + 2).run();
        return {
          a: ctx.successes(a) as number[],
          b: ctx.successes(b) as number[],
        };
      },
    );

    const { output } = await runWorkflow(wf, { input: {} });
    expect(output.a).toEqual([11, 21, 31]);
    expect(output.b).toEqual([12, 22, 32]);
  });
});
