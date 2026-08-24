/**
 * The journal is the only thing that must survive, so these tests hit the file
 * layout directly: indices stay monotonic across batches, instances, and
 * processes; watch() serves the backlog before anything live; projections are
 * rebuildable from the JSONL alone.
 */
import { existsSync } from "node:fs";
import { appendFile, mkdir, readFile, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { JournalRecord, RunState, TreePhase } from "@techery/weft-core";
import { reduceState, renderReport, renderTree } from "@techery/weft-core";
import { afterEach, describe, expect, test } from "vitest";
import { FsJournalStore } from "../src/journal.ts";
import { logged, removeTemps, runCreated, sleep, tempDir, waitFor } from "./helpers.ts";

afterEach(removeTemps);

async function drain(store: FsJournalStore, runId: string, fromIndex?: number): Promise<JournalRecord[]> {
  const out: JournalRecord[] = [];
  for await (const rec of store.read(runId, fromIndex)) out.push(rec);
  return out;
}

describe("append", () => {
  test("assigns monotonic indices across batches", async () => {
    const store = new FsJournalStore(await tempDir());
    const first = await store.append("run-a", [runCreated("run-a", "audit"), logged("one")]);
    const second = await store.append("run-a", [logged("two")]);
    expect(first.map((r) => r.i)).toEqual([0, 1]);
    expect(second.map((r) => r.i)).toEqual([2]);
    expect((await drain(store, "run-a")).map((r) => r.i)).toEqual([0, 1, 2]);
  });

  test("a fresh instance over the same directory continues the numbering", async () => {
    const dir = await tempDir();
    const first = new FsJournalStore(dir);
    await first.append("run-a", [runCreated("run-a", "audit"), logged("one")]);

    const reopened = new FsJournalStore(dir);
    const appended = await reopened.append("run-a", [logged("two"), logged("three")]);
    expect(appended.map((r) => r.i)).toEqual([2, 3]);

    const lines = (await readFile(join(dir, "run-a", "journal.jsonl"), "utf8")).trim().split("\n");
    expect(lines).toHaveLength(4);
    expect(lines.map((l) => (JSON.parse(l) as JournalRecord).i)).toEqual([0, 1, 2, 3]);
  });

  test("two live instances over the same file never duplicate indices", async () => {
    const dir = await tempDir();
    const daemon = new FsJournalStore(dir);
    const cli = new FsJournalStore(dir);
    // Both instances hold a cache while the other appends (a CLI answering a
    // daemon-owned run): each append must fold the other's on-disk growth into
    // its cache before assigning the next index, or the indices duplicate.
    const first = await daemon.append("run-a", [runCreated("run-a", "audit"), logged("one")]);
    const answered = await cli.append("run-a", [logged("answer from the CLI")]);
    const caught = await daemon.append("run-a", [logged("daemon"), logged("again")]);
    const closing = await cli.append("run-a", [logged("cli again")]);
    expect(first.map((r) => r.i)).toEqual([0, 1]);
    expect(answered.map((r) => r.i)).toEqual([2]);
    expect(caught.map((r) => r.i)).toEqual([3, 4]);
    expect(closing.map((r) => r.i)).toEqual([5]);
    expect((await drain(daemon, "run-a")).map((r) => r.i)).toEqual([0, 1, 2, 3, 4, 5]);
  });

  test("concurrent appends from two live instances lose nothing", async () => {
    const dir = await tempDir();
    const a = new FsJournalStore(dir);
    const b = new FsJournalStore(dir);
    await a.append("run-a", [runCreated("run-a", "audit")]);
    // Without the append lock, one writer's reconcile→truncate could cut the other
    // writer's just-committed record as if it were a torn tail.
    await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        Promise.all([a.append("run-a", [logged(`a${i}`)]), b.append("run-a", [logged(`b${i}`)])]),
      ),
    );
    const indices = (await drain(a, "run-a")).map((r) => r.i);
    expect(indices).toEqual([...Array.from({ length: 21 }, (_, i) => i)]);
  });

  test("a crashed appender's stale lock is stolen, not waited on", async () => {
    const dir = await tempDir();
    const store = new FsJournalStore(dir);
    await store.append("run-a", [runCreated("run-a", "audit")]);
    // A writer died inside its critical section: journal.lock survives it.
    const lock = join(dir, "run-a", "journal.lock");
    await writeFile(lock, "");
    const past = new Date(Date.now() - 60_000);
    await utimes(lock, past, past);

    const appended = await store.append("run-a", [logged("after the crash")]);
    expect(appended.map((r) => r.i)).toEqual([1]);
  });

  test("a failed append leaves the cache consistent: the next append lands at the real index", async () => {
    const dir = await tempDir();
    const store = new FsJournalStore(dir);
    await store.append("run-a", [runCreated("run-a", "audit")]);
    // A bigint makes JSON.stringify throw AFTER indices would have been assigned:
    // the cached count must not advance for a record that never became durable.
    await expect(store.append("run-a", [{ type: "log", message: "x", n: 10n } as never])).rejects.toThrow();

    const appended = await store.append("run-a", [logged("after the failure")]);
    expect(appended.map((r) => r.i)).toEqual([1]);
    // Conditional appends against the REAL on-disk count still match.
    expect(await store.appendIf("run-a", 2, [logged("cas")])).toHaveLength(1);
    expect((await drain(store, "run-a")).map((r) => r.i)).toEqual([0, 1, 2]);
  });

  test("an ACTIVE holder renews its lock, so a slow append can never be stolen mid-write", async () => {
    const dir = await tempDir();
    const store = new FsJournalStore(dir);
    await store.append("run-a", [runCreated("run-a", "audit")]);
    const lock = join(dir, "run-a", "journal.lock");
    const locked = store as unknown as {
      withFileLock<T>(lockPath: string, what: string, fn: () => Promise<T>): Promise<T>;
    };
    await locked.withFileLock(lock, "run run-a", async () => {
      // The critical section has (apparently) run long enough to look stale —
      // exactly the window where a contender used to steal a LIVE holder's lock
      // and enter the same critical section.
      const past = new Date(Date.now() - 60_000);
      await utimes(lock, past, past);
      // The holder's periodic renewal must freshen it before the threshold matters.
      await sleep(3_000);
      const age = Date.now() - (await stat(lock)).mtimeMs;
      expect(age).toBeLessThan(3_000);
    });
    // Released normally afterwards: the next append proceeds unhindered.
    const appended = await store.append("run-a", [logged("after the slow append")]);
    expect(appended.map((r) => r.i)).toEqual([1]);
  });

  test("a lock whose creation fails for a real reason surfaces at once instead of spinning", async () => {
    const dir = await tempDir();
    const store = new FsJournalStore(dir);
    const locked = store as unknown as {
      withFileLock<T>(lockPath: string, what: string, fn: () => Promise<T>): Promise<T>;
    };
    // A missing parent directory is not contention: ENOENT used to be swallowed
    // like EEXIST and retried until the 30s give-up, hanging every append behind
    // a filesystem that is broken, not busy.
    const started = Date.now();
    await expect(
      locked.withFileLock(join(dir, "no-such-dir", "x.lock"), "run run-a", async () => undefined),
    ).rejects.toThrow(/ENOENT/);
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  test("a torn trailing record from a crashed writer is ignored and cut", async () => {
    const dir = await tempDir();
    const store = new FsJournalStore(dir);
    await store.append("run-a", [runCreated("run-a", "audit"), logged("one")]);
    // A writer died mid-write: half a record, no terminating newline.
    await appendFile(join(dir, "run-a", "journal.jsonl"), '{"i":2,"at":9,"ev":{"type":"log","mess');

    // A fresh instance reads only committed records...
    const fresh = new FsJournalStore(dir);
    expect((await drain(fresh, "run-a")).map((r) => r.i)).toEqual([0, 1]);
    // ...and the next append truncates the fragment instead of gluing onto it.
    const appended = await fresh.append("run-a", [logged("two")]);
    expect(appended.map((r) => r.i)).toEqual([2]);
    expect((await drain(fresh, "run-a")).map((r) => r.i)).toEqual([0, 1, 2]);
    // The instance that had the run cached recovers too.
    const more = await store.append("run-a", [logged("three")]);
    expect(more.map((r) => r.i)).toEqual([3]);
    expect((await drain(store, "run-a")).map((r) => r.i)).toEqual([0, 1, 2, 3]);
  });

  test("records carry a wall-clock stamp and the event verbatim", async () => {
    const store = new FsJournalStore(await tempDir());
    const before = Date.now();
    const [rec] = await store.append("run-a", [runCreated("run-a", "audit", { parentRunId: "run-parent" })]);
    expect(rec?.at).toBeGreaterThanOrEqual(before);
    expect(rec?.ev).toEqual(runCreated("run-a", "audit", { parentRunId: "run-parent" }));
  });
});

describe("read", () => {
  test("fromIndex skips everything before the cursor", async () => {
    const store = new FsJournalStore(await tempDir());
    await store.append("run-a", [runCreated("run-a", "audit"), logged("one"), logged("two")]);
    expect((await drain(store, "run-a", 1)).map((r) => r.i)).toEqual([1, 2]);
    expect(await drain(store, "run-a", 3)).toEqual([]);
  });

  test("an unknown run reads as empty rather than throwing", async () => {
    const store = new FsJournalStore(await tempDir());
    expect(await drain(store, "never-ran")).toEqual([]);
  });
});

describe("watch", () => {
  test("yields the backlog, then live in-process appends", async () => {
    const store = new FsJournalStore(await tempDir());
    await store.append("run-a", [runCreated("run-a", "audit"), logged("backlog")]);

    const seen: JournalRecord[] = [];
    const controller = new AbortController();
    const pump = (async () => {
      for await (const rec of store.watch("run-a", { signal: controller.signal })) seen.push(rec);
    })();

    await waitFor(() => seen.length === 2);
    await store.append("run-a", [logged("live")]);
    await waitFor(() => seen.length === 3);

    controller.abort();
    await pump;
    expect(seen.map((r) => r.i)).toEqual([0, 1, 2]);
    expect(seen[2]?.ev).toEqual(logged("live"));
  });

  test("fromIndex starts the follow after the backlog", async () => {
    const store = new FsJournalStore(await tempDir());
    await store.append("run-a", [runCreated("run-a", "audit"), logged("one"), logged("two")]);

    const seen: JournalRecord[] = [];
    for await (const rec of store.watch("run-a", { fromIndex: 2 })) {
      seen.push(rec);
      break;
    }
    expect(seen.map((r) => r.i)).toEqual([2]);
  });

  test("observing external appends does not skew the next local append's index", async () => {
    const dir = await tempDir();
    const local = new FsJournalStore(dir);
    const external = new FsJournalStore(dir);
    await local.append("run-a", [runCreated("run-a", "audit")]);

    const seen: JournalRecord[] = [];
    const controller = new AbortController();
    const pump = (async () => {
      for await (const rec of local.watch("run-a", { signal: controller.signal })) seen.push(rec);
    })();
    await waitFor(() => seen.length === 1);
    await external.append("run-a", [logged("external")]);
    await waitFor(() => seen.length === 2, 2_000);

    // The watcher saw record 1; reconcile must count it exactly once, so the next
    // local append continues at 2 — never 3 (a gap a watch cursor would fall into).
    const appended = await local.append("run-a", [logged("local")]);
    expect(appended.map((r) => r.i)).toEqual([2]);

    controller.abort();
    await pump;
  });

  test("picks up out-of-process appends by polling the file", async () => {
    const dir = await tempDir();
    const watcher = new FsJournalStore(dir);
    const writer = new FsJournalStore(dir);
    await watcher.append("run-a", [runCreated("run-a", "audit")]);

    const seen: JournalRecord[] = [];
    const controller = new AbortController();
    const pump = (async () => {
      for await (const rec of watcher.watch("run-a", { signal: controller.signal })) seen.push(rec);
    })();
    await waitFor(() => seen.length === 1);

    // A second store instance stands in for another process appending to the same file.
    await writer.append("run-a", [logged("from elsewhere")]);
    await waitFor(() => seen.length === 2, 2_000);

    controller.abort();
    await pump;
    expect(seen[1]?.ev).toEqual(logged("from elsewhere"));
  });
});

describe("list", () => {
  test("scans the journal when no projection has been written", async () => {
    const store = new FsJournalStore(await tempDir());
    await store.append("run-a", [runCreated("run-a", "audit", { parentRunId: "run-root" })]);
    await store.append("run-a", [{ type: "run.status", status: "executing" }]);

    const [summary] = await store.list();
    expect(summary).toMatchObject({
      runId: "run-a",
      workflow: "audit",
      status: "executing",
      parentRunId: "run-root",
    });
    expect(summary?.updatedAt).toBeGreaterThanOrEqual(summary?.createdAt ?? 0);
  });

  test("prefers state.json when the run has one", async () => {
    const store = new FsJournalStore(await tempDir());
    await store.append("run-a", [runCreated("run-a", "audit")]);
    const state = reduceState(await drain(store, "run-a"));
    // The projection is authoritative for list(): a status only it knows about must win.
    await store.snapshot("run-a", { state: { ...state, status: "complete" } satisfies RunState });

    expect((await store.list())[0]?.status).toBe("complete");
    expect(await store.list({ status: "complete" })).toHaveLength(1);
    expect(await store.list({ status: "planning" })).toEqual([]);
  });

  test("filters by status and workflow and sorts newest first", async () => {
    const store = new FsJournalStore(await tempDir());
    await store.append("run-old", [runCreated("run-old", "audit")]);
    await sleep(5);
    await store.append("run-mid", [runCreated("run-mid", "fix")]);
    await store.append("run-mid", [{ type: "run.completed", output: { ok: true } }]);
    await sleep(5);
    await store.append("run-new", [runCreated("run-new", "audit")]);
    await store.append("run-new", [
      { type: "run.failed", error: { name: "StepError", code: "internal", message: "boom", step: {} } },
    ]);

    expect((await store.list()).map((r) => r.runId)).toEqual(["run-new", "run-mid", "run-old"]);
    expect((await store.list({ workflow: "audit" })).map((r) => r.runId)).toEqual(["run-new", "run-old"]);
    expect((await store.list({ status: "failed" })).map((r) => r.runId)).toEqual(["run-new"]);
    expect((await store.list({ limit: 2 })).map((r) => r.runId)).toEqual(["run-new", "run-mid"]);
  });

  test("ignores directories without a journal and an absent runs directory", async () => {
    const dir = await tempDir();
    const store = new FsJournalStore(join(dir, "does-not-exist"));
    expect(await store.list()).toEqual([]);

    const real = new FsJournalStore(dir);
    await real.snapshot("empty-run", { report: "# nothing" });
    expect(await real.list()).toEqual([]);
  });
});

describe("projections", () => {
  test("snapshot writes state.json/tree.json/report.md and readSnapshot round-trips", async () => {
    const dir = await tempDir();
    const store = new FsJournalStore(dir);
    await store.append("run-a", [
      runCreated("run-a", "audit"),
      { type: "run.completed", output: { ok: true } },
    ]);

    const state = reduceState(await drain(store, "run-a"));
    const tree: TreePhase[] = renderTree(state);
    const report = renderReport(state);
    await store.snapshot("run-a", { state, tree, report });

    expect(JSON.parse(await readFile(join(dir, "run-a", "state.json"), "utf8"))).toEqual(state);
    expect(JSON.parse(await readFile(join(dir, "run-a", "tree.json"), "utf8"))).toEqual(tree);
    expect(await readFile(join(dir, "run-a", "report.md"), "utf8")).toBe(report);

    const round = await store.readSnapshot("run-a");
    expect(round?.state).toEqual(state);
    expect(round?.tree).toEqual(tree);
    expect(round?.report).toBe(report);
  });

  test("an older reduction can never replace a newer snapshot", async () => {
    const dir = await tempDir();
    const store = new FsJournalStore(dir);
    await store.append("run-a", [runCreated("run-a", "audit")]);
    const older = reduceState(await drain(store, "run-a"));
    await store.append("run-a", [{ type: "run.completed", output: { ok: true } }]);
    const newer = reduceState(await drain(store, "run-a"));

    // Two writers race (an engine and a daemon's refresh): the OLDER reduction
    // lands last. Atomic renames alone would let it stand — and summarize()
    // trusts any projection at least as fresh as the journal, indefinitely.
    await store.snapshot("run-a", { state: newer });
    await store.snapshot("run-a", { state: older });

    const kept = JSON.parse(await readFile(join(dir, "run-a", "state.json"), "utf8")) as RunState;
    expect(kept.status).toBe("complete");
    expect(kept.records).toBe(2);
    expect((await store.list())[0]?.status).toBe("complete");
  });

  test("readSnapshot is undefined until something is written", async () => {
    const store = new FsJournalStore(await tempDir());
    await store.append("run-a", [runCreated("run-a", "audit")]);
    expect(await store.readSnapshot("run-a")).toBeUndefined();

    await store.snapshot("run-a", { report: "# just a report" });
    expect(await store.readSnapshot("run-a")).toEqual({ report: "# just a report" });
  });

  test("concurrent snapshots never clobber each other's temp files", async () => {
    const dir = await tempDir();
    const store = new FsJournalStore(dir);
    await store.append("run-a", [runCreated("run-a", "audit")]);
    // Same-name temp files would make these rename each other away (ENOENT) or
    // interleave revisions; unique temp names make every write land whole.
    await Promise.all(Array.from({ length: 8 }, (_, i) => store.snapshot("run-a", { report: `# rev ${i}` })));
    const report = await readFile(join(dir, "run-a", "report.md"), "utf8");
    expect(report).toMatch(/^# rev \d$/);
  });

  test("a peer's committed records are never truncated as a torn tail", async () => {
    // The lock can be stolen from a holder frozen past the stale threshold, so a peer's
    // complete, fsynced records can land between one writer's reconcile and its
    // truncate. Only a genuinely incomplete trailing line may ever be cut.
    const dir = await tempDir();
    const store = new FsJournalStore(dir);
    await store.append("run-p", [runCreated("run-p", "audit")]);

    // A peer appends behind this instance's back, then a crashed writer leaves a torn
    // tail after it. The peer's line is complete; the fragment is not.
    const file = join(dir, "run-p", "journal.jsonl");
    const peer = `${JSON.stringify({ i: 1, at: 1, ev: { type: "log", message: "from a peer" } })}\n`;
    await appendFile(file, `${peer}{"i":2,"at":2,"ev":{"type":"lo`);

    await store.append("run-p", [{ type: "log", message: "mine" }]);

    const records: JournalRecord[] = [];
    for await (const rec of store.read("run-p")) records.push(rec);
    const messages = records
      .map((r) => (r.ev.type === "log" ? r.ev.message : undefined))
      .filter((m): m is string => m !== undefined);
    expect(messages).toContain("from a peer");
    expect(messages).toContain("mine");
  });

  test("rebuildProjections restores every projection, not just state.json", async () => {
    // "Only journal.jsonl has to survive" is the claim; tree.json and report.md were not
    // rebuilt, so a deleted one stayed deleted and a stale one kept reporting the status
    // the run had when it was last written.
    const dir = await tempDir();
    const store = new FsJournalStore(dir);
    await store.append("run-r", [
      runCreated("run-r", "audit"),
      { type: "run.status", status: "complete" },
      { type: "run.completed", output: { ok: true } },
    ]);

    const runDir = join(dir, "run-r");
    for (const file of ["state.json", "tree.json", "report.md"]) {
      await rm(join(runDir, file), { force: true });
    }
    await store.rebuildProjections("run-r");

    for (const file of ["state.json", "tree.json", "report.md"]) {
      expect(existsSync(join(runDir, file))).toBe(true);
    }
    expect(await readFile(join(runDir, "report.md"), "utf8")).toContain("complete");
  });

  test("rebuildProjections re-derives state.json from the journal", async () => {
    const dir = await tempDir();
    const store = new FsJournalStore(dir);
    await store.append("run-a", [runCreated("run-a", "audit"), logged("hello")]);
    await store.append("run-a", [{ type: "run.completed", output: { ok: true } }]);

    await store.rebuildProjections("run-a");
    const state = JSON.parse(await readFile(join(dir, "run-a", "state.json"), "utf8")) as RunState;
    expect(state).toMatchObject({ runId: "run-a", workflow: "audit", status: "complete", logs: ["hello"] });
    expect(state.output).toEqual({ ok: true });

    // Rebuilding a run that never journaled anything is a no-op, not a crash.
    await expect(store.rebuildProjections("ghost")).resolves.toBeUndefined();
    expect(await store.readSnapshot("ghost")).toBeUndefined();
  });
});

describe("list freshness", () => {
  test("a projection older than the journal is not trusted: the journal folds instead", async () => {
    const dir = await tempDir();
    const store = new FsJournalStore(dir);
    await store.append("run-a", [runCreated("run-a", "audit")]);
    // The snapshot lands, then the run completes but its FOLLOW-UP snapshot is
    // lost (a crash between fsync and state.json): the stale projection says
    // the run never finished.
    await store.snapshot("run-a", { state: reduceState(await drain(store, "run-a")) });
    await sleep(20); // distinct mtimes
    await store.append("run-a", [{ type: "run.completed", output: { ok: true } }]);

    const [summary] = await store.list();
    expect(summary?.status).toBe("complete");

    // A snapshot written AFTER the append is fresh again and served directly.
    await sleep(20);
    await store.snapshot("run-a", { state: reduceState(await drain(store, "run-a")) });
    const [fresh] = await store.list();
    expect(fresh?.status).toBe("complete");
  });
});

describe("acquireRun", () => {
  test("a live claim refuses a second owner; release frees it", async () => {
    const dir = await tempDir();
    const daemon = new FsJournalStore(dir);
    const cli = new FsJournalStore(dir);

    const lease = await daemon.acquireRun("run-a");
    expect(lease).toBeTruthy();
    expect(await cli.acquireRun("run-a")).toBeUndefined();
    await lease?.refresh(); // keeps the same claim; still exclusive
    expect(await cli.acquireRun("run-a")).toBeUndefined();

    await lease?.release();
    const second = await cli.acquireRun("run-a");
    expect(second).toBeTruthy();
    await second?.release();
  });

  test("of two contenders for one expired claim, exactly one wins", async () => {
    const dir = await tempDir();
    const dead = new FsJournalStore(dir);
    const short = await dead.acquireRun("run-a", { ttlMs: 10 });
    expect(short).toBeTruthy();
    await sleep(30);

    // Both read the same expired claim; the rename-based steal admits only one.
    const b = new FsJournalStore(dir);
    const c = new FsJournalStore(dir);
    const [x, y] = await Promise.all([b.acquireRun("run-a"), c.acquireRun("run-a")]);
    expect([x, y].filter((lease) => lease !== undefined)).toHaveLength(1);
    await x?.release();
    await y?.release();
  });

  test("an expired claim is stolen; the dead owner cannot release the thief's", async () => {
    const dir = await tempDir();
    const dead = new FsJournalStore(dir);
    const successor = new FsJournalStore(dir);

    const short = await dead.acquireRun("run-a", { ttlMs: 10 });
    expect(short).toBeTruthy();
    await sleep(30);
    const stolen = await successor.acquireRun("run-a");
    expect(stolen).toBeTruthy();

    await short?.refresh(); // the dead owner's refresh must not resurrect its claim
    await short?.release(); // no longer theirs: must not remove the new claim
    expect(await dead.acquireRun("run-a")).toBeUndefined();
    await stolen?.release();
  });

  test("refresh is a CAS: it reports a lost claim instead of evicting the successor", async () => {
    const dir = await tempDir();
    const stalled = new FsJournalStore(dir);
    const successor = new FsJournalStore(dir);

    const short = await stalled.acquireRun("run-a", { ttlMs: 10 });
    await sleep(30);
    const taken = await successor.acquireRun("run-a");
    expect(taken).toBeTruthy();

    // The stalled owner wakes up mid-refresh: the identity check and the claim
    // write are one atomic operation, so it LEARNS of the loss (and must stop
    // executing) rather than writing its claim over the successor's.
    expect(await short?.refresh()).toBe(false);
    expect(await taken?.refresh()).toBe(true);
    // Still exactly one live owner: the successor.
    expect(await stalled.acquireRun("run-a")).toBeUndefined();
    await taken?.release();
  });
});

describe("appendIf", () => {
  test("declines when records landed after the caller's read; appends when none did", async () => {
    const dir = await tempDir();
    const store = new FsJournalStore(dir);
    await store.append("run-a", [runCreated("run-a", "audit"), logged("one")]);

    // Stale expectation (the caller read 1 record; there are 2): nothing is written.
    expect(await store.appendIf("run-a", 1, [logged("late")])).toBeUndefined();
    expect(await drain(store, "run-a")).toHaveLength(2);

    const appended = await store.appendIf("run-a", 2, [logged("fresh")]);
    expect(appended).toHaveLength(1);
    expect(appended?.[0]?.i).toBe(2);
    expect(await drain(store, "run-a")).toHaveLength(3);
  });

  test("counts a PEER instance's appends: the condition holds across processes", async () => {
    const dir = await tempDir();
    const canceller = new FsJournalStore(dir);
    const owner = new FsJournalStore(dir);
    await canceller.append("run-a", [runCreated("run-a", "audit")]);

    // The owner (a separate store instance, as in a separate process) commits an
    // outcome after the canceller folded 1 record — the conditional append must
    // see it via reconcile and decline.
    await owner.append("run-a", [{ type: "run.completed", output: { ok: true } }]);
    expect(await canceller.appendIf("run-a", 1, [{ type: "run.cancelled" }])).toBeUndefined();
    const recs = await drain(canceller, "run-a");
    expect(recs.map((r) => r.ev.type)).toEqual(["run.created", "run.completed"]);
  });
});

describe("stolen locks", () => {
  test("a lock replaced while the holder was stalled is detected and refused", async () => {
    const dir = await tempDir();
    const store = new FsJournalStore(dir);
    const lock = join(dir, "y.lock");
    const locked = store as unknown as {
      withFileLock<T>(lockPath: string, what: string, fn: () => Promise<T>): Promise<T>;
    };
    const attempt = locked.withFileLock(lock, "run y", async () => {
      // A thief replaced the lock, as after a SIGSTOP past the stale threshold.
      // Blind mtime renewal would freshen the THIEF's lock and hide the theft;
      // the identity check on the next renewal tick must flag the mutex lost.
      await writeFile(lock, "thief-token");
      await sleep(3_200); // across one renewal tick
      return "finished";
    });
    await expect(attempt).rejects.toThrow(/stolen/);
  }, 10_000);
});

describe("read failures", () => {
  test("an unreadable journal surfaces instead of reading as an empty run", async () => {
    const dir = await tempDir();
    // journal.jsonl as a DIRECTORY: readFile fails with EISDIR — a real storage
    // fault, not absence. Swallowed, resume/state/indexing would report this
    // durable run as "not found".
    await mkdir(join(dir, "run-x", "journal.jsonl"), { recursive: true });
    const store = new FsJournalStore(dir);
    await expect(drain(store, "run-x")).rejects.toThrow(/EISDIR/);
    // True absence still reads as an empty run.
    expect(await drain(store, "run-absent")).toEqual([]);
  });
});

describe("exists & validation", () => {
  test("exists tracks the journal file", async () => {
    const store = new FsJournalStore(await tempDir());
    expect(await store.exists("run-a")).toBe(false);
    await store.append("run-a", [runCreated("run-a", "audit")]);
    expect(await store.exists("run-a")).toBe(true);
  });

  test("a runId that could escape the runs directory is rejected", async () => {
    const store = new FsJournalStore(await tempDir());
    for (const bad of ["../escape", "a/b", ""]) {
      await expect(store.append(bad, [logged("x")])).rejects.toThrow(/invalid runId/);
      await expect(store.exists(bad)).rejects.toThrow(/invalid runId/);
      await expect(store.snapshot(bad, { report: "x" })).rejects.toThrow(/invalid runId/);
      await expect(store.readSnapshot(bad)).rejects.toThrow(/invalid runId/);
    }
  });
});

describe("exists (codex review round 61, PR #1)", () => {
  test("surfaces a filesystem failure instead of reporting the run missing", async () => {
    const dir = await tempDir();
    const store = new FsJournalStore(dir);
    // Absence in both spellings stays false: no directory, and a FILE sitting
    // where the run directory would be (ENOTDIR on the journal path).
    expect(await store.exists("nope")).toBe(false);
    await writeFile(join(dir, "flat"), "not a directory\n");
    expect(await store.exists("flat")).toBe(false);
    // A self-looping symlink makes stat fail with ELOOP — an error that is NOT
    // absence. Folding it into false would let resume/cancel report "run not
    // found" (and the descendant pending walks skip a child) over a journal
    // that exists but cannot be read.
    await mkdir(join(dir, "looped"), { recursive: true });
    const target = join(dir, "looped", "journal.jsonl");
    await symlink(target, target);
    await expect(store.exists("looped")).rejects.toThrow();
  });
});
