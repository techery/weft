/**
 * The index is derived data, so every test here is really the same claim in a
 * different shape: whatever the journals say, the rows agree — and if the rows are
 * ever lost, dropped, or stale, a rebuild restores exactly the same answers.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { MemoryJournalStore } from "@weft/core";
import { FsJournalStore } from "@weft/store-fs";
import { afterEach, describe, expect, test } from "vitest";
import { RunIndex, SCHEMA_VERSION } from "../src/index.ts";
import { type RunSpec, readRecords, seedRun, steppingClock } from "./helpers.ts";

const temps: string[] = [];
const openIndexes: RunIndex[] = [];

afterEach(async () => {
  for (const idx of openIndexes.splice(0)) {
    try {
      idx.close();
    } catch {
      // already closed by the test
    }
  }
  for (const dir of temps.splice(0))
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "weft-index-sqlite-"));
  temps.push(dir);
  return dir;
}

function openIndex(dbPath = ":memory:"): RunIndex {
  const index = new RunIndex({ dbPath });
  openIndexes.push(index);
  return index;
}

const SPECS: RunSpec[] = [
  {
    runId: "run-audit",
    workflow: "audit",
    status: "complete",
    steps: [
      {
        key: "find:src/pay.ts",
        label: "Find bugs in pay.ts",
        usage: { input: 1_000, output: 200, usd: 0.05 },
      },
      { key: "verify:pay", label: "Verify finding", usage: { input: 500, output: 100, usd: 0.02 } },
      // The child run's roll-up: a parent's workflow step journals its child's
      // total usage at completion (that is how the parent budget restores).
      { key: "child:run-fix", kind: "workflow", usage: { input: 300, output: 700 } },
      { key: "check:tsc", kind: "check" },
    ],
    questions: ["Ship the refund fix?"],
  },
  {
    runId: "run-fix",
    workflow: "fix",
    parentRunId: "run-audit",
    status: "waiting_for_human",
    steps: [{ key: "patch:pay", label: "Write the patch", usage: { input: 300, output: 700 } }],
    questions: ["Approve the migration rollback?"],
  },
  {
    runId: "run-sweep",
    workflow: "audit",
    status: "failed",
    steps: [{ key: "sweep:docs", usage: { input: 10, output: 5, usd: 0.001 } }],
  },
];

async function seeded(): Promise<{ store: MemoryJournalStore; index: RunIndex }> {
  const store = new MemoryJournalStore({ now: steppingClock() });
  const index = openIndex();
  for (const spec of SPECS) index.indexRun(spec.runId, await seedRun(store, spec));
  return { store, index };
}

describe("indexRun", () => {
  test("folds a journal into one row: identity, spend, and agent-step count", async () => {
    const { index } = await seeded();
    const [audit] = index.search({ workflow: "audit", status: "complete" });
    expect(audit).toEqual({
      runId: "run-audit",
      workflow: "audit",
      status: "complete",
      createdAt: expect.any(Number),
      updatedAt: expect.any(Number),
      agentSteps: 2, // the `check` step is not an agent step
      tokens: 2_800,
      usd: 0.07,
    });
    expect(audit!.updatedAt).toBeGreaterThan(audit!.createdAt);

    const [fix] = index.search({ workflow: "fix" });
    expect(fix?.parentRunId).toBe("run-audit");
    expect(fix?.usd).toBe(0);
  });

  test("results come back newest first", async () => {
    const { index } = await seeded();
    expect(index.search().map((r) => r.runId)).toEqual(["run-sweep", "run-fix", "run-audit"]);
  });

  test("re-indexing the same run updates it in place", async () => {
    const store = new MemoryJournalStore({ now: steppingClock() });
    const index = openIndex();
    const spec: RunSpec = { runId: "run-a", workflow: "audit", status: "executing", steps: [{ key: "one" }] };
    index.indexRun("run-a", await seedRun(store, spec));
    expect(index.search()[0]?.status).toBe("executing");

    await store.append("run-a", [{ type: "run.completed", output: { ok: true } }]);
    index.indexRun("run-a", await readRecords(store, "run-a"));

    expect(index.stats().runs).toBe(1);
    expect(index.search()[0]?.status).toBe("complete");
  });

  test("a run with an empty journal indexes nothing", () => {
    const index = openIndex();
    index.indexRun("run-ghost", []);
    expect(index.search()).toEqual([]);
    expect(index.stats()).toEqual({ runs: 0, tokens: 0, usd: 0 });
  });

  test("a budget sample wins over summed step usage", async () => {
    const store = new MemoryJournalStore({ now: steppingClock() });
    const index = openIndex();
    // Resumed runs restore prior spend into the sample, so it is the truer number.
    const records = await seedRun(store, {
      runId: "run-a",
      workflow: "audit",
      steps: [{ key: "one", usage: { input: 10, output: 10, usd: 0.01 } }],
      budget: { tokens: 9_000, usd: 1.25 },
    });
    index.indexRun("run-a", records);
    expect(index.search()[0]).toMatchObject({ tokens: 9_000, usd: 1.25 });
  });
});

describe("search", () => {
  test("text matches the workflow name, step keys, step labels, and human questions", async () => {
    const { index } = await seeded();
    expect(index.search({ text: "sweep" }).map((r) => r.runId)).toEqual(["run-sweep"]);
    expect(index.search({ text: "src/pay.ts" }).map((r) => r.runId)).toEqual(["run-audit"]);
    expect(index.search({ text: "Write the patch" }).map((r) => r.runId)).toEqual(["run-fix"]);
    expect(index.search({ text: "migration rollback" }).map((r) => r.runId)).toEqual(["run-fix"]);
    expect(index.search({ text: "audit" }).map((r) => r.runId)).toEqual(["run-sweep", "run-audit"]);
  });

  test("text is case-insensitive and misses are empty, not everything", async () => {
    const { index } = await seeded();
    expect(index.search({ text: "SHIP THE REFUND" }).map((r) => r.runId)).toEqual(["run-audit"]);
    expect(index.search({ text: "nothing matches this" })).toEqual([]);
    // LIKE wildcards in user text are literal, so a bare `%` matches nothing here.
    expect(index.search({ text: "%" })).toEqual([]);
    expect(index.search({ text: "" }).map((r) => r.runId)).toEqual(["run-sweep", "run-fix", "run-audit"]);
  });

  test("status, workflow, and limit narrow the result", async () => {
    const { index } = await seeded();
    expect(index.search({ status: "failed" }).map((r) => r.runId)).toEqual(["run-sweep"]);
    expect(index.search({ status: "waiting_for_human" }).map((r) => r.runId)).toEqual(["run-fix"]);
    expect(index.search({ workflow: "audit" }).map((r) => r.runId)).toEqual(["run-sweep", "run-audit"]);
    expect(index.search({ workflow: "audit", status: "failed" }).map((r) => r.runId)).toEqual(["run-sweep"]);
    expect(index.search({ workflow: "audit", text: "pay" }).map((r) => r.runId)).toEqual(["run-audit"]);
    expect(index.search({ limit: 2 }).map((r) => r.runId)).toEqual(["run-sweep", "run-fix"]);
    expect(index.search({ limit: 0 })).toEqual([]);
    expect(index.search({ status: "planning" })).toEqual([]);
  });
});

describe("stats", () => {
  test("sums each run's OWN spend exactly once — workflow roll-ups excluded", async () => {
    const { index } = await seeded();
    const stats = index.stats();
    expect(stats.runs).toBe(3);
    // run-audit's own steps (1,800) + run-fix's own step (1,000) + run-sweep (15).
    // run-audit's workflow roll-up of run-fix does NOT count again: every token
    // is attributed to the run that actually spent it.
    expect(stats.tokens).toBe(1_800 + 1_000 + 15);
    expect(stats.usd).toBeCloseTo(0.071, 10);
  });

  test("child spend that no completed parent step ever rolled up still counts", async () => {
    const store = new MemoryJournalStore({ now: steppingClock() });
    const index = openIndex();
    // The child failed (or the parent stopped mid-child): its spend exists ONLY
    // in its own journal. A root-only sum would silently lose these tokens.
    index.indexRun(
      "run-parent",
      await seedRun(store, { runId: "run-parent", workflow: "audit", status: "executing" }),
    );
    index.indexRun(
      "run-child",
      await seedRun(store, {
        runId: "run-child",
        workflow: "fix",
        parentRunId: "run-parent",
        status: "failed",
        steps: [{ key: "burn", usage: { input: 100, output: 50, usd: 0.004 } }],
      }),
    );
    expect(index.stats()).toEqual({ runs: 2, tokens: 150, usd: 0.004 });
  });

  test("an empty index sums to zero rather than null", () => {
    expect(openIndex().stats()).toEqual({ runs: 0, tokens: 0, usd: 0 });
  });

  test("a sequence number reused across resumes is classified per pass, not forever", async () => {
    const store = new MemoryJournalStore({ now: steppingClock() });
    const index = openIndex();
    // Pass 1: seq 1 was a child-workflow roll-up. After a resume (sequence
    // numbers restart) the edited workflow's seq 1 is a plain AGENT step — its
    // spend is the run's OWN and must count.
    await store.append("run-reseq", [
      {
        type: "run.created",
        runId: "run-reseq",
        workflow: { name: "audit" },
        input: {},
        cwd: "/repo",
        depth: 0,
      },
      { type: "step.scheduled", seq: 1, hash: "h1", kind: "workflow", key: "child" },
      { type: "step.completed", seq: 1, output: {}, usage: { input: 300, output: 700, samples: 2 } },
      { type: "step.scheduled", seq: 1, hash: "h2", kind: "agent", key: "direct" },
      { type: "step.completed", seq: 1, output: {}, usage: { input: 100, output: 50 } },
      { type: "run.completed", output: {} },
    ]);
    index.indexRun("run-reseq", await readRecords(store, "run-reseq"));
    // A global seq set would have excluded BOTH seq-1 completions.
    expect(index.stats()).toEqual({ runs: 1, tokens: 150, usd: 0 });
  });
});

describe("rebuild", () => {
  test("re-indexes every run in the store and is idempotent", async () => {
    const store = new MemoryJournalStore({ now: steppingClock() });
    for (const spec of SPECS) await seedRun(store, spec);
    const index = openIndex();

    await index.rebuild(store);
    const first = index.search();
    expect(first.map((r) => r.runId)).toEqual(["run-sweep", "run-fix", "run-audit"]);

    await index.rebuild(store);
    expect(index.search()).toEqual(first);
    expect(index.stats().runs).toBe(3);
  });

  test("wipes rows for runs the store no longer has, and picks up new ones", async () => {
    const store = new MemoryJournalStore({ now: steppingClock() });
    const index = openIndex();
    index.indexRun("run-stale", await seedRun(store, { runId: "run-stale", workflow: "gone" }));

    const fresh = new MemoryJournalStore({ now: steppingClock() });
    await seedRun(fresh, { runId: "run-new", workflow: "audit", status: "complete" });
    await index.rebuild(fresh);

    expect(index.search().map((r) => r.runId)).toEqual(["run-new"]);
  });

  test("rebuilds from a filesystem journal store just as well", async () => {
    const store = new FsJournalStore(join(await tempDir(), "runs"));
    for (const spec of SPECS) await seedRun(store, spec);
    const index = openIndex();

    await index.rebuild(store);
    expect(index.stats().runs).toBe(3);
    expect(index.search({ text: "refund" }).map((r) => r.runId)).toEqual(["run-audit"]);
    expect(index.search({ status: "failed" }).map((r) => r.runId)).toEqual(["run-sweep"]);
  });
});

describe("persistence", () => {
  test("the same dbPath survives close and reopen", async () => {
    const dbPath = join(await tempDir(), "nested", "index.db");
    const store = new MemoryJournalStore({ now: steppingClock() });
    const first = openIndex(dbPath);
    for (const spec of SPECS) first.indexRun(spec.runId, await seedRun(store, spec));
    const before = first.search();
    first.close();

    const reopened = openIndex(dbPath);
    expect(reopened.search()).toEqual(before);
    expect(reopened.stats().runs).toBe(3);
  });

  test("a schema-version mismatch drops the index instead of migrating it", async () => {
    const dbPath = join(await tempDir(), "index.db");
    const store = new MemoryJournalStore({ now: steppingClock() });
    const first = openIndex(dbPath);
    first.indexRun("run-a", await seedRun(store, { runId: "run-a", workflow: "audit" }));
    expect(first.stats().runs).toBe(1);
    first.close();

    // Stand in for a future (or ancient) build of the index.
    const raw = new DatabaseSync(dbPath);
    expect(raw.prepare("PRAGMA user_version").get()?.["user_version"]).toBe(SCHEMA_VERSION);
    raw.exec("PRAGMA user_version = 9999");
    raw.close();

    const reopened = openIndex(dbPath);
    expect(reopened.stats()).toEqual({ runs: 0, tokens: 0, usd: 0 });
    expect(reopened.search()).toEqual([]);

    reopened.indexRun("run-a", await readRecords(store, "run-a"));
    expect(reopened.search().map((r) => r.runId)).toEqual(["run-a"]);
    reopened.close();

    const check = new DatabaseSync(dbPath);
    expect(check.prepare("PRAGMA user_version").get()?.["user_version"]).toBe(SCHEMA_VERSION);
    check.close();
  });
});
