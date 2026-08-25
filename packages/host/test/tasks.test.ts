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

  it("returns extension defaults and transforms from the active workflow schema", async () => {
    const root = await tempRoot();
    const writer = new TaskStore(join(root, ".weft", "tasks"));
    await writer.create("release", {
      title: "Legacy task",
      description: "Persisted before the workflow added an extension default.",
      extensions: {},
    });
    const reader = new TaskStore(join(root, ".weft", "tasks"), async () =>
      z.object({ lane: z.string().default("api") }),
    );

    expect((await reader.list("release"))[0]?.extensions).toEqual({ lane: "api" });
  });

  it("persists extension schema input while returning transformed output across mutations", async () => {
    const root = await tempRoot();
    const extensions = z
      .object({ source: z.string() })
      .transform(({ source }) => ({ normalized: source.trim().toLowerCase() }));
    const store = new TaskStore(join(root, ".weft", "tasks"), async () => extensions);
    await store.registerWorkflow({ id: "release", name: "release" }, extensions, null);

    const created = await store.create("release", {
      title: "Normalize",
      description: "Transform extension data",
      extensions: { source: " API " },
    });
    expect(created.extensions).toEqual({ normalized: "api" });
    expect((await store.get("release", created.id)).extensions).toEqual({ normalized: "api" });

    expect((await store.addNote("release", created.id, "Still readable")).extensions).toEqual({
      normalized: "api",
    });
    expect((await store.update("release", created.id, { status: "in_progress" })).extensions).toEqual({
      normalized: "api",
    });
    expect((await store.get("release", created.id)).extensions).toEqual({ normalized: "api" });
    const persisted = JSON.parse(
      await readFile(join(root, ".weft", "tasks", "release", `${created.id}.json`), "utf8"),
    ) as { extensions: unknown };
    expect(persisted.extensions).toEqual({ source: " API " });
  });

  it("binds each run to its exact extension schema even when another definition registers", async () => {
    const root = await tempRoot();
    const store = new TaskStore(join(root, ".weft", "tasks"));
    const api = z.object({ lane: z.literal("api") });
    const ui = z.object({ lane: z.literal("ui") });
    const task = await store.create(
      "release",
      { title: "API", description: "Schema-bound task", extensions: { lane: "api" } },
      api,
    );
    const apiBinding = await store.registerWorkflow(
      { id: "release", name: "release" },
      api,
      z.toJSONSchema(api),
    );
    const uiBinding = await store.registerWorkflow(
      { id: "release", name: "release" },
      ui,
      z.toJSONSchema(ui),
    );

    const apiSnapshot = (await store.snapshot("release", {}, apiBinding)) as {
      tasks: Array<{ id: string; extensions: unknown }>;
    };
    expect(apiSnapshot.tasks).toEqual([
      expect.objectContaining({ id: task.id, extensions: { lane: "api" } }),
    ]);
    await expect(store.snapshot("release", {}, uiBinding)).rejects.toThrow(/task extensions failed/);
    expect(await store.schema("release", apiBinding)).toMatchObject({ type: "object" });
  });

  it("migrates older workflow extension values before validating and persists on update", async () => {
    const root = await tempRoot();
    const store = new TaskStore(join(root, ".weft", "tasks"));
    const task = await store.create("release", {
      title: "Legacy",
      description: "Old extension shape",
      extensions: { lane: "api" },
    });
    const current = z.object({ owner: z.string(), estimate: z.number().int() });
    const binding = await store.registerWorkflow(
      { id: "release", name: "release" },
      current,
      z.toJSONSchema(current),
      {
        schemaVersion: 2,
        migrate: (value) => ({ owner: (value as { lane: string }).lane, estimate: 1 }),
      },
    );

    const snapshot = (await store.snapshot("release", {}, binding)) as {
      tasks: Array<{ extensionSchemaVersion: number; extensions: unknown }>;
    };
    expect(snapshot.tasks[0]).toMatchObject({ extensions: { owner: "api", estimate: 1 } });
    const updated = await store.update("release", task.id, { status: "in_progress" }, current);
    expect(updated).toMatchObject({
      extensionSchemaVersion: 2,
      extensions: { owner: "api", estimate: 1 },
    });
    const raw = JSON.parse(
      await readFile(join(root, ".weft", "tasks", "release", `${task.id}.json`), "utf8"),
    ) as { extensionSchemaVersion: number };
    expect(raw.extensionSchemaVersion).toBe(2);
  });

  it("binds dry replay in memory and recovers a lost old-schema batch through migration", async () => {
    const root = await tempRoot();
    const taskRoot = join(root, ".weft", "tasks");
    const oldStore = new TaskStore(taskRoot);
    const oldSchema = z.object({ lane: z.string() });
    const oldBinding = await oldStore.registerWorkflow(
      { id: "review", name: "review" },
      oldSchema,
      z.toJSONSchema(oldSchema),
      { identity: "definition-a" },
    );
    const oldContext = {
      workflowId: "review",
      workflowName: "review",
      runId: "run-old",
      step: "record",
      provider: "workflow",
      source: "workflow" as const,
      schemaBinding: oldBinding,
      schemaVersion: 1,
    };
    const operation = {
      op: "create" as const,
      title: "Migrate me",
      description: "The old marker was lost",
      extensions: { lane: "api" },
    };
    await oldStore.applyBatch(oldContext, "already-applied", [operation]);

    const currentStore = new TaskStore(taskRoot);
    const currentSchema = z.object({ owner: z.string(), estimate: z.number().int() });
    await currentStore.registerWorkflow(
      { id: "review", name: "review" },
      currentSchema,
      z.toJSONSchema(currentSchema),
      {
        schemaVersion: 2,
        identity: "definition-b",
        migrate: (value) => ({ owner: (value as { lane: string }).lane, estimate: 1 }),
      },
    );
    await expect(
      currentStore.applyBatch(oldContext, "already-applied", [operation]),
    ).resolves.toBeUndefined();
    await currentStore.applyBatch(oldContext, "lost-marker", [operation]);
    expect(await currentStore.list("review")).toEqual([
      expect.objectContaining({
        extensionSchemaVersion: 2,
        extensions: { owner: "api", estimate: 1 },
      }),
      expect.objectContaining({
        extensionSchemaVersion: 2,
        extensions: { owner: "api", estimate: 1 },
      }),
    ]);

    const dryRoot = join(root, "dry");
    const dryStore = new TaskStore(dryRoot);
    await dryStore.registerWorkflow(
      { id: "review", name: "review" },
      currentSchema,
      z.toJSONSchema(currentSchema),
      { schemaVersion: 2, persist: false },
    );
    expect(await dryStore.namespace("review")).toBeUndefined();
  });

  it("preflights a whole batch before writing and limits agents to observed tasks", async () => {
    const root = await tempRoot();
    const store = new TaskStore(join(root, ".weft", "tasks"));
    const visible = await store.create("review", { title: "Visible", description: "May change" });
    const hidden = await store.create("review", { title: "Hidden", description: "Must not change" });
    const context = {
      workflowId: "review",
      workflowName: "review",
      runId: "run-1",
      step: "review",
      provider: "codex",
      source: "agent" as const,
      mode: "write" as const,
      visibleTaskIds: [visible.id],
    };

    await expect(
      store.applyBatch(context, "invalid-batch", [
        { op: "note", id: visible.id, text: "would be partial" },
        { op: "note", id: hidden.id, text: "not observed" },
      ]),
    ).rejects.toThrow(/not present in this step's observed task context/);
    expect((await store.get("review", visible.id)).notes).toEqual([]);
    expect((await store.get("review", hidden.id)).notes).toEqual([]);
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

    const optimisticBatch = "run-1:agent:9";
    const optimistic = [
      { op: "update" as const, id: final.id, status: "in_progress" as const, ifRevision: 2 },
    ];
    await store.applyBatch(context, optimisticBatch, optimistic);
    await unlink(
      join(taskRoot, "release", `.batch-${createHash("sha256").update(optimisticBatch).digest("hex")}.json`),
    );
    await expect(store.applyBatch(context, optimisticBatch, optimistic)).resolves.toBeUndefined();
    expect(await store.get("release", final.id)).toMatchObject({ status: "in_progress", revision: 3 });
  });

  it("atomically upserts deduplicated work and filters journaled snapshots", async () => {
    const root = await tempRoot();
    const store = new TaskStore(join(root, ".weft", "tasks"));
    const context = {
      workflowId: "review",
      workflowName: "review",
      runId: "run-1",
      step: "record:finding",
      provider: "workflow",
      source: "workflow" as const,
    };
    const operation = {
      op: "upsert" as const,
      dedupeKey: "src/state.ts|store|invalid-shape",
      create: {
        title: "Validate persisted state",
        description: "Invalid JSON shapes crash derived state.",
        tags: ["code-review", "correctness"],
        relatedFiles: ["src/state.ts"],
        acceptanceCriteria: ["Regression test passes"],
      },
      update: { priority: "high" as const },
      note: "seen in run-1",
    };
    await store.applyBatch(context, "batch-1", [operation]);
    await store.applyBatch({ ...context, runId: "run-2" }, "batch-2", [
      { ...operation, note: "seen in run-2" },
    ]);

    const tasks = await store.list("review");
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({
      dedupeKey: operation.dedupeKey,
      priority: "high",
      revision: 2,
    });
    expect(tasks[0]?.notes.map((note) => note.text)).toEqual(["seen in run-1", "seen in run-2"]);

    const criterionId = tasks[0]?.acceptanceCriteria[0]?.id ?? "";
    await store.setCriterion("review", tasks[0]?.id ?? "", criterionId, true, "verifier");
    await store.applyBatch({ ...context, runId: "run-3" }, "batch-3", [
      {
        ...operation,
        update: {
          ...operation.update,
          acceptanceCriteria: ["Regression test passes"],
          resetAcceptance: true,
        },
        note: "reopened in run-3",
      },
    ]);
    const reopened = await store.get("review", tasks[0]?.id ?? "");
    expect(reopened).toMatchObject({ revision: 4 });
    expect(reopened.acceptanceCriteria).toEqual([expect.objectContaining({ id: criterionId, met: false })]);
    expect(reopened.notes.map((note) => note.text)).toEqual([
      "seen in run-1",
      "seen in run-2",
      "reopened in run-3",
    ]);

    const matching = (await store.snapshot("review", {
      tags: ["not-present", "code-review"],
      relatedFiles: ["src/state.ts"],
    })) as { tasks: Array<{ dedupeKey?: string }> };
    expect(matching.tasks).toEqual([expect.objectContaining({ dedupeKey: operation.dedupeKey })]);
    const missing = (await store.snapshot("review", { relatedFiles: ["src/other.ts"] })) as {
      tasks: unknown[];
    };
    expect(missing.tasks).toEqual([]);

    await expect(
      store.create("review", {
        dedupeKey: operation.dedupeKey,
        title: "Duplicate",
        description: "Must be rejected",
      }),
    ).rejects.toThrow(/dedupe key/);
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
