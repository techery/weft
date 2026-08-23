import {
  Budget,
  canonicalJson,
  hashStep,
  MemoryJournalStore,
  OrderedDelivery,
  ReplayIndex,
  Semaphore,
  structuralCheck,
  toWireSchema,
} from "@weft/core";
import { StepError } from "@weft/sdk";
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
    const d = new OrderedDelivery([10, 20, 30], () => 0);
    const done: number[] = [];
    const p20 = d.deliver(20).then(() => done.push(20));
    await new Promise((r) => setTimeout(r, 5));
    expect(done).toEqual([]);
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

describe("toWireSchema", () => {
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
    expect(idx.totalUsage).toEqual({ tokens: 15, usd: 0 });
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
