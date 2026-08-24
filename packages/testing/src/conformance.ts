/**
 * Store conformance suites. A new JournalStore or BlobStore is correct when it
 * passes these: they encode exactly what the engine relies on — monotonic
 * indices, resumable reads, a live watch, run listing, projections, and content
 * addressing. Each suite is a `describe()` block; call it at the top level of a
 * test file with a factory that builds a fresh store per test.
 */
import type { BlobStore, JournalEvent, JournalRecord, JournalStore } from "@techery/weft-core";
import { describe, expect, test } from "vitest";

export interface StoreFixture<T> {
  store: T;
  cleanup?: () => Promise<void>;
}

async function collect(source: AsyncIterable<JournalRecord>): Promise<JournalRecord[]> {
  const out: JournalRecord[] = [];
  for await (const rec of source) out.push(rec);
  return out;
}

function created(runId: string, workflow: string): JournalEvent {
  return { type: "run.created", runId, workflow: { name: workflow }, input: {}, cwd: "/tmp", depth: 0 };
}

export function journalStoreConformance(
  name: string,
  factory: () => Promise<StoreFixture<JournalStore>>,
): void {
  describe(`JournalStore conformance: ${name}`, () => {
    const withStore = async (fn: (store: JournalStore) => Promise<void>): Promise<void> => {
      const fixture = await factory();
      try {
        await fn(fixture.store);
      } finally {
        await fixture.cleanup?.();
      }
    };

    test("append assigns monotonic indices that continue across batches", async () => {
      await withStore(async (store) => {
        const first = await store.append("run-a", [
          created("run-a", "alpha"),
          { type: "log", message: "one" },
        ]);
        expect(first.map((r) => r.i)).toEqual([0, 1]);
        expect(first[0]!.at).toBeGreaterThan(0);
        const second = await store.append("run-a", [{ type: "log", message: "two" }]);
        expect(second.map((r) => r.i)).toEqual([2]);
        const all = await collect(store.read("run-a"));
        expect(all.map((r) => r.i)).toEqual([0, 1, 2]);
        expect(all[2]!.ev).toEqual({ type: "log", message: "two" });
        // Runs are independent: a second run starts its own index sequence.
        const other = await store.append("run-b", [created("run-b", "beta")]);
        expect(other.map((r) => r.i)).toEqual([0]);
      });
    });

    test("read(fromIndex) resumes at the requested index", async () => {
      await withStore(async (store) => {
        await store.append("run-a", [
          created("run-a", "alpha"),
          { type: "log", message: "one" },
          { type: "log", message: "two" },
        ]);
        const tail = await collect(store.read("run-a", 1));
        expect(tail.map((r) => r.i)).toEqual([1, 2]);
        expect(await collect(store.read("run-a", 99))).toEqual([]);
        expect(await collect(store.read("never-written"))).toEqual([]);
      });
    });

    test("watch replays what is already there and then sees a live append", async () => {
      await withStore(async (store) => {
        await store.append("run-a", [created("run-a", "alpha")]);
        const abort = new AbortController();
        const seen: JournalRecord[] = [];
        const watching = (async () => {
          for await (const rec of store.watch("run-a", { signal: abort.signal })) {
            seen.push(rec);
            if (seen.length === 2) break;
          }
        })();
        await new Promise((resolve) => setTimeout(resolve, 25));
        await store.append("run-a", [{ type: "log", message: "live" }]);
        await watching;
        abort.abort();
        expect(seen.map((r) => r.i)).toEqual([0, 1]);
        expect(seen[1]!.ev).toEqual({ type: "log", message: "live" });
      });
    });

    test("list filters by workflow and status, and honours limit", async () => {
      await withStore(async (store) => {
        await store.append("run-a", [
          created("run-a", "alpha"),
          { type: "run.completed", output: { ok: true } },
        ]);
        await store.append("run-b", [created("run-b", "beta")]);
        const all = await store.list();
        expect(all.map((r) => r.runId).sort()).toEqual(["run-a", "run-b"]);
        const alpha = await store.list({ workflow: "alpha" });
        expect(alpha).toHaveLength(1);
        expect(alpha[0]).toMatchObject({ runId: "run-a", workflow: "alpha", status: "complete" });
        expect(await store.list({ status: "complete" })).toHaveLength(1);
        expect(await store.list({ status: "cancelled" })).toHaveLength(0);
        expect(await store.list({ limit: 1 })).toHaveLength(1);
      });
    });

    test("snapshot round-trips through readSnapshot", async () => {
      await withStore(async (store) => {
        await store.append("run-s", [created("run-s", "alpha")]);
        await store.snapshot("run-s", {
          state: { runId: "run-s", status: "complete" },
          report: "# report\n",
        });
        if (!store.readSnapshot) return; // optional capability
        const projections = await store.readSnapshot("run-s");
        expect(projections?.state).toEqual({ runId: "run-s", status: "complete" });
        expect(projections?.report).toBe("# report\n");
        // A snapshot never replaces the journal.
        expect(await collect(store.read("run-s"))).toHaveLength(1);
      });
    });

    test("exists is false until the run has a record", async () => {
      await withStore(async (store) => {
        expect(await store.exists("run-a")).toBe(false);
        await store.append("run-a", [created("run-a", "alpha")]);
        expect(await store.exists("run-a")).toBe(true);
      });
    });
  });
}

export function blobStoreConformance(name: string, factory: () => Promise<StoreFixture<BlobStore>>): void {
  describe(`BlobStore conformance: ${name}`, () => {
    const withStore = async (fn: (store: BlobStore) => Promise<void>): Promise<void> => {
      const fixture = await factory();
      try {
        await fn(fixture.store);
      } finally {
        await fixture.cleanup?.();
      }
    };

    test("put/get/getText/has round-trip both strings and bytes", async () => {
      await withStore(async (store) => {
        const ref = await store.put("hello weft", { kind: "transcript" });
        expect(ref.hash).toMatch(/^[0-9a-f]{64}$/);
        expect(ref.size).toBe(10);
        expect(await store.getText(ref.hash)).toBe("hello weft");
        expect(new TextDecoder().decode(await store.get(ref.hash))).toBe("hello weft");
        expect(await store.has(ref.hash)).toBe(true);

        const bytes = await store.put(new TextEncoder().encode("raw bytes"));
        expect(await store.getText(bytes.hash)).toBe("raw bytes");
        expect(bytes.size).toBe(9);
      });
    });

    test("content addressing: same bytes give the same ref, re-putting is idempotent", async () => {
      await withStore(async (store) => {
        const a = await store.put("same content");
        const b = await store.put(new TextEncoder().encode("same content"));
        expect(b.hash).toBe(a.hash);
        expect(b.size).toBe(a.size);
        expect(await store.getText(a.hash)).toBe("same content");

        const other = await store.put("different content");
        expect(other.hash).not.toBe(a.hash);
        expect(await store.has(other.hash)).toBe(true);
      });
    });

    test("a missing ref is absent and throws on read", async () => {
      await withStore(async (store) => {
        const missing = "0".repeat(64);
        expect(await store.has(missing)).toBe(false);
        await expect(store.get(missing)).rejects.toThrow(/not found/);
        await expect(store.getText(missing)).rejects.toThrow(/not found/);
      });
    });
  });
}
