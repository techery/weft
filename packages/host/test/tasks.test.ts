import { createHash } from "node:crypto";
import { mkdir, readFile, stat, unlink, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type AnySchema, z } from "@techery/weft-sdk";
import { afterAll, describe, expect, it } from "vitest";
import { TaskStore } from "../src/tasks.ts";
import { cleanupRoots, tempRoot } from "./helpers.ts";

afterAll(cleanupRoots);

describe("TaskStore", () => {
  it("stores workflow-scoped tasks, validates extensions, and preserves concurrent notes", async () => {
    const root = await tempRoot();
    const store = new TaskStore(join(root, ".weft", "tasks"));
    const extensions = z.object({ estimate: z.number().int().positive(), lane: z.enum(["api", "ui"]) });
    const task = await store.create(
      "release",
      {
        title: "Ship task context",
        description: "Make the tracker durable between workflow steps.",
        tags: ["context", "context"],
        relatedFiles: ["packages/host/src/tasks.ts"],
        acceptanceCriteria: ["parallel notes survive"],
        extensions: { estimate: 3, lane: "api" },
        actor: "planner",
      },
      extensions,
    );

    await Promise.all([
      store.addNote("release", task.id, "first agent checked the API", "agent-a"),
      store.addNote("release", task.id, "second agent checked the UI", "agent-b"),
    ]);
    const accepted = await store.setCriterion("release", task.id, 1, true, "verifier");

    expect(accepted.tags).toEqual(["context"]);
    expect(accepted.notes.map((note) => note.text).sort()).toEqual([
      "first agent checked the API",
      "second agent checked the UI",
    ]);
    expect(accepted.acceptanceCriteria).toEqual([
      expect.objectContaining({ text: "parallel notes survive", met: true }),
    ]);
    expect(accepted.extensions).toEqual({ estimate: 3, lane: "api" });
    expect(accepted.revision).toBe(4);

    await expect(
      store.create(
        "release",
        { title: "Bad", description: "Bad extension", extensions: { estimate: 0, lane: "docs" } },
        extensions,
      ),
    ).rejects.toThrow(/task extensions failed/);
  });

  it("enforces dependency existence, acyclicity, and removal safety", async () => {
    const root = await tempRoot();
    const store = new TaskStore(join(root, ".weft", "tasks"));
    const first = await store.create("build", { title: "First", description: "foundation" });
    const second = await store.create("build", {
      title: "Second",
      description: "consumer",
      dependencies: [first.id],
    });

    await expect(store.update("build", first.id, { dependencies: [second.id] })).rejects.toThrow(/cycle/);
    await expect(store.remove("build", first.id)).rejects.toThrow(/required by/);
    await store.update("build", second.id, { dependencies: [] });
    await store.remove("build", first.id);
    expect((await store.list("build")).map((task) => task.id)).toEqual([second.id]);
  });

  it("uses stable criterion ids and rejects stale revisions", async () => {
    const root = await tempRoot();
    const store = new TaskStore(join(root, ".weft", "tasks"));
    const task = await store.create("review", {
      title: "Verify",
      description: "Keep acceptance state stable",
      acceptanceCriteria: ["API passes", "UI passes"],
    });
    const criterion = task.acceptanceCriteria[1];
    expect(criterion).toBeDefined();
    await store.setCriterion("review", task.id, criterion?.id ?? "", true, "verifier", 1);
    const reordered = await store.update("review", task.id, {
      acceptanceCriteria: [{ text: "UI passes" }, { text: "API passes" }],
      ifRevision: 2,
    });
    expect(reordered.acceptanceCriteria[0]).toMatchObject({ id: criterion?.id, met: true });
    await expect(store.update("review", task.id, { status: "done", ifRevision: 1 })).rejects.toThrow(
      /expected revision 1, found 3/,
    );
  });

  it("validates persisted records and revalidates extension schema drift", async () => {
    const root = await tempRoot();
    let extensionSchema: AnySchema = z.object({ lane: z.literal("api") });
    const store = new TaskStore(join(root, ".weft", "tasks"), async () => extensionSchema);
    const task = await store.create("release", {
      title: "Typed",
      description: "Schema-bound task",
      extensions: { lane: "api" },
    });

    extensionSchema = z.object({ lane: z.literal("ui") });
    await expect(store.list("release", z.object({ lane: z.literal("api") }))).rejects.toThrow(
      /task extensions failed/,
    );

    extensionSchema = z.object({ lane: z.literal("api") });
    const file = join(root, ".weft", "tasks", "release", `${task.id}.json`);
    const corrupted = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
    corrupted.workflowId = "another-workflow";
    await writeFile(file, JSON.stringify(corrupted), "utf8");
    await expect(store.get("release", task.id)).rejects.toThrow(/workflowId does not match directory/);
  });

  it("applies journaled batches exactly once, even when the marker is lost", async () => {
    const root = await tempRoot();
    const taskRoot = join(root, ".weft", "tasks");
    const store = new TaskStore(taskRoot);
    const context = {
      workflowId: "release",
      workflowName: "Release",
      runId: "run-1",
      step: "plan",
      provider: "mock",
    };
    const batchId = "run-1:agent:7";
    await store.applyBatch(context, batchId, [
      { op: "create", title: "Ship", description: "Apply exactly once" },
    ]);
    const [created] = await store.list("release");
    expect(created).toBeDefined();

    const marker = join(
      taskRoot,
      "release",
      `.batch-${createHash("sha256").update(batchId).digest("hex")}.json`,
    );
    await unlink(marker);
    await store.applyBatch(context, batchId, [
      { op: "create", title: "Ship", description: "Apply exactly once" },
    ]);
    expect(await store.list("release")).toHaveLength(1);

    const noteBatch = "run-1:agent:8";
    await store.applyBatch(context, noteBatch, [{ op: "note", id: created?.id ?? "", text: "verified" }]);
    await store.applyBatch(context, noteBatch, [{ op: "note", id: created?.id ?? "", text: "verified" }]);
    const final = await store.get("release", created?.id ?? "");
    expect(final.notes.map((note) => note.text)).toEqual(["verified"]);
    expect(final.revision).toBe(2);
  });

  it("does not steal an old live lock, recovers a dead lock, and removes orphan temps", async () => {
    const root = await tempRoot();
    const taskRoot = join(root, ".weft", "tasks");
    const workflowDir = join(taskRoot, "locked");
    await mkdir(workflowDir, { recursive: true });
    const lock = join(workflowDir, ".lock");
    await writeFile(lock, JSON.stringify({ token: "live", pid: process.pid, createdAt: 0 }), "utf8");
    const old = new Date(Date.now() - 60_000);
    await utimes(lock, old, old);

    const store = new TaskStore(taskRoot);
    let settled = false;
    const pending = store
      .create("locked", { title: "Waited", description: "Live owner kept its lock" })
      .finally(() => {
        settled = true;
      });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(settled).toBe(false);
    await unlink(lock);
    await pending;

    await writeFile(lock, JSON.stringify({ token: "dead", pid: 2_147_483_647, createdAt: 0 }), "utf8");
    await utimes(lock, old, old);
    const orphan = join(workflowDir, ".task-deadbeef.crash.tmp");
    await writeFile(orphan, "partial", "utf8");
    await store.create("locked", { title: "Recovered", description: "Dead owner was replaced" });
    await expect(stat(orphan)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
