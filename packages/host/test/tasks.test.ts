import { createHash } from "node:crypto";
import { mkdir, readFile, stat, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type AnySchema, z } from "@techery/weft-sdk";
import { afterAll, describe, expect, it } from "vitest";
import { TaskStore } from "../src/tasks.ts";
import { cleanupRoots, tempRoot } from "./helpers.ts";

afterAll(cleanupRoots);

describe("TaskStore", () => {
  it("preserves enough deterministic id entropy when legacy prefixes collide", async () => {
    const root = await tempRoot();
    const taskRoot = join(root, ".weft", "tasks");
    const store = new TaskStore(taskRoot);
    // These SHA-256 inputs share their first eight hex digits for this workflow.
    const operations = ["collision-7408", "collision-152431"].map((dedupeKey) => ({
      op: "upsert" as const,
      dedupeKey,
      create: { title: dedupeKey, description: "Distinct recurring review finding" },
    }));
    const context = {
      workflowId: "review",
      workflowName: "review",
      runId: "run-1",
      step: "review",
      provider: "codex",
    };

    await store.applyBatch(context, "collision-batch", operations);
    await store.applyBatch(context, "collision-batch", operations);

    const tasks = await new TaskStore(taskRoot).list("review");
    const byKey = new Map(tasks.map((task) => [task.dedupeKey, task]));
    const first = byKey.get("collision-7408");
    const second = byKey.get("collision-152431");

    expect(tasks).toHaveLength(2);
    expect(first?.id.slice(0, 13)).toBe(second?.id.slice(0, 13));
    expect(first?.id).toMatch(/^task-[a-f0-9]{32}$/);
    expect(second?.id).toMatch(/^task-[a-f0-9]{32}$/);
    expect(first?.id).not.toBe(second?.id);
  });

  it("recognizes legacy task ids while settling a lost batch marker", async () => {
    const root = await tempRoot();
    const taskRoot = join(root, ".weft", "tasks");
    const store = new TaskStore(taskRoot);
    const batchId = "legacy-batch";
    const operationKey = `${batchId}:0`;
    const legacyId = `task-${createHash("sha256").update(operationKey).digest("hex").slice(0, 8)}`;
    const operation = { op: "create" as const, title: "Legacy", description: "Already applied" };
    await store.create("review", {
      id: legacyId,
      title: operation.title,
      description: operation.description,
      operationKey,
    });

    await store.applyBatch(
      {
        workflowId: "review",
        workflowName: "review",
        runId: "run-1",
        step: "review",
        provider: "codex",
      },
      batchId,
      [operation],
    );

    expect(await store.list("review")).toEqual([expect.objectContaining({ id: legacyId })]);
  });

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

  it("rejects duplicate criterion ids without corrupting the stored task", async () => {
    const root = await tempRoot();
    const taskRoot = join(root, ".weft", "tasks");
    const store = new TaskStore(taskRoot);
    const task = await store.create("review", {
      title: "Keep readable",
      description: "Reject malformed criterion identity",
      acceptanceCriteria: ["Original"],
    });
    const file = join(taskRoot, "review", `${task.id}.json`);
    const before = await readFile(file, "utf8");

    await expect(
      store.update("review", task.id, {
        acceptanceCriteria: [
          { id: "criterion-aaaaaaaaaaaa", text: "First" },
          { id: "criterion-aaaaaaaaaaaa", text: "Second" },
        ],
      }),
    ).rejects.toThrow(/criterion ids must be unique/);

    expect(await readFile(file, "utf8")).toBe(before);
    expect(await store.get("review", task.id)).toMatchObject({
      revision: 1,
      acceptanceCriteria: [expect.objectContaining({ text: "Original" })],
    });
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

  it("passes omitted extensions through declared schemas and preserves their absence", async () => {
    const root = await tempRoot();
    const taskRoot = join(root, ".weft", "tasks");
    const defaulted = z.string().default("general");
    const optional = z.string().optional();
    const schemaFor = async (workflowId: string): Promise<AnySchema | undefined> => {
      if (workflowId === "defaulted") return defaulted;
      if (workflowId === "optional") return optional;
      return undefined;
    };
    const store = new TaskStore(taskRoot, schemaFor);
    await store.registerWorkflow({ id: "defaulted", name: "defaulted" }, defaulted, null, {
      semanticRevision: "defaulted-v1",
    });
    await store.registerWorkflow({ id: "optional", name: "optional" }, optional, null, {
      semanticRevision: "optional-v1",
    });

    const defaultedTask = await store.create("defaulted", {
      title: "Default extensions",
      description: "Let the declared schema provide its root default",
    });
    const optionalTask = await store.upsert("optional", "optional-finding", {
      create: {
        title: "Optional extensions",
        description: "Keep an omitted optional root absent",
      },
    });
    const plainTask = await store.create("plain", {
      title: "Plain extensions",
      description: "Schema-less workflows retain their object default",
    });

    expect(defaultedTask.extensions).toBe("general");
    expect(optionalTask.extensions).toBeUndefined();
    expect(plainTask.extensions).toEqual({});
    for (const [workflowId, task] of [
      ["defaulted", defaultedTask],
      ["optional", optionalTask],
    ] as const) {
      const persisted = JSON.parse(
        await readFile(join(taskRoot, workflowId, `${task.id}.json`), "utf8"),
      ) as Record<string, unknown>;
      expect(persisted).not.toHaveProperty("extensions");
    }
    expect(JSON.parse(await readFile(join(taskRoot, "plain", `${plainTask.id}.json`), "utf8"))).toMatchObject(
      { extensions: {} },
    );

    const reopened = new TaskStore(taskRoot, schemaFor);
    expect((await reopened.get("defaulted", defaultedTask.id)).extensions).toBe("general");
    expect((await reopened.get("optional", optionalTask.id)).extensions).toBeUndefined();
    const liveSnapshot = (await reopened.snapshot("optional")) as {
      tasks: Record<string, unknown>[];
    };
    expect(liveSnapshot.tasks[0]).not.toHaveProperty("extensions");
    expect(JSON.parse(JSON.stringify(liveSnapshot))).toEqual(liveSnapshot);
    await reopened.update("optional", optionalTask.id, { status: "in_progress" });
    const updated = JSON.parse(
      await readFile(join(taskRoot, "optional", `${optionalTask.id}.json`), "utf8"),
    ) as Record<string, unknown>;
    expect(updated).not.toHaveProperty("extensions");
  });

  it("persists extension schema input while returning transformed output across mutations", async () => {
    const root = await tempRoot();
    const extensions = z
      .object({ source: z.string() })
      .transform(({ source }) => ({ normalized: source.trim().toLowerCase() }));
    const store = new TaskStore(join(root, ".weft", "tasks"), async () => extensions);
    await store.registerWorkflow({ id: "release", name: "release" }, extensions, null, {
      semanticRevision: "normalized-source-v1",
    });

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

  it("round-trips explicit null extensions when the workflow schema accepts null", async () => {
    const root = await tempRoot();
    const taskRoot = join(root, ".weft", "tasks");
    const schema = z.null();
    const store = new TaskStore(taskRoot, async () => schema);
    const created = await store.create("release", {
      title: "Nullable context",
      description: "Preserve an explicit null",
      extensions: null,
    });
    expect(created.extensions).toBeNull();

    const updated = await store.update("release", created.id, {
      status: "in_progress",
      extensions: null,
    });
    expect(updated.extensions).toBeNull();
    expect((await store.addNote("release", created.id, "Null remains explicit")).extensions).toBeNull();

    const persisted = JSON.parse(await readFile(join(taskRoot, "release", `${created.id}.json`), "utf8")) as {
      extensions: unknown;
    };
    expect(persisted.extensions).toBeNull();
    const reopened = new TaskStore(taskRoot, async () => schema);
    expect((await reopened.get("release", created.id)).extensions).toBeNull();
  });

  it("uses durable namespace version and scalar semantics without a runtime definition", async () => {
    const root = await tempRoot();
    const taskRoot = join(root, ".weft", "tasks");
    const schema = z.null();
    const writer = new TaskStore(taskRoot, async () => schema);
    await writer.registerWorkflow(
      { id: "inline-review", name: "inline-review" },
      schema,
      { type: "null" },
      { schemaVersion: 2, semanticRevision: "nullable-extension-v2" },
    );
    const created = await writer.create("inline-review", {
      title: "Definition-independent lifecycle",
      description: "Keep durable scalar context readable",
      acceptanceCriteria: ["Lifecycle remains available"],
      extensions: null,
    });

    // A later CLI process can have only .workflow.json and task files: no
    // executable schema or migration is available in this store.
    const reader = new TaskStore(taskRoot);
    expect(await reader.list("inline-review")).toEqual([
      expect.objectContaining({
        id: created.id,
        extensionSchemaVersion: 2,
        extensions: null,
      }),
    ]);
    expect((await reader.addNote("inline-review", created.id, "Still inspectable")).extensions).toBeNull();
    expect(
      (await reader.setCriterion("inline-review", created.id, 1, true)).acceptanceCriteria[0],
    ).toMatchObject({ met: true });
    expect((await reader.update("inline-review", created.id, { status: "done" })).extensions).toBeNull();
    await reader.remove("inline-review", created.id);
    expect(await reader.list("inline-review")).toEqual([]);
  });

  it("keeps older extension records operable when only the upgraded namespace is available", async () => {
    const root = await tempRoot();
    const taskRoot = join(root, ".weft", "tasks");
    const legacy = z.object({ lane: z.string() }).default({ lane: "general" });
    const current = z.object({ owner: z.string(), estimate: z.number().int() });
    const migrate = (value: unknown) => ({
      owner: value === undefined ? "general" : (value as { lane: string }).lane,
      estimate: 1,
    });
    const writer = new TaskStore(taskRoot);
    await writer.registerWorkflow({ id: "review", name: "review" }, legacy, null, {
      semanticRevision: "legacy-lane-v1",
    });
    const retained = await writer.create(
      "review",
      {
        title: "Legacy task",
        description: "Remain usable until the definition returns",
        acceptanceCriteria: ["Core lifecycle remains available"],
        extensions: { lane: "api" },
      },
      legacy,
    );
    const removable = await writer.create(
      "review",
      {
        title: "Removable legacy task",
        description: "Namespace-only removal remains available",
        extensions: { lane: "ui" },
      },
      legacy,
    );
    const omitted = await writer.create(
      "review",
      {
        title: "Defaulted legacy task",
        description: "Opaque lifecycle must preserve omitted extension input",
      },
      legacy,
    );
    await writer.registerWorkflow({ id: "review", name: "review" }, current, null, {
      schemaVersion: 2,
      semanticRevision: "owner-estimate-v2",
      migrate,
    });
    const currentTask = await writer.create("review", {
      title: "Current task",
      description: "Mixed-version directories remain readable",
      extensions: { owner: "platform", estimate: 2 },
    });

    const reader = new TaskStore(taskRoot);
    expect(await reader.list("review")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: retained.id,
          extensionSchemaVersion: 1,
          extensions: { lane: "api" },
        }),
        expect.objectContaining({
          id: currentTask.id,
          extensionSchemaVersion: 2,
          extensions: { owner: "platform", estimate: 2 },
        }),
        expect.objectContaining({
          id: omitted.id,
          extensionSchemaVersion: 1,
          extensions: undefined,
        }),
      ]),
    );
    await reader.addNote("review", retained.id, "Reviewed without the definition");
    await reader.setCriterion("review", retained.id, 1, true);
    await reader.update("review", retained.id, { status: "in_progress" });
    await reader.update("review", omitted.id, { priority: "high" });
    await reader.remove("review", removable.id);
    await expect(
      reader.create("review", { title: "Unsafe create", description: "Cannot validate extensions" }),
    ).rejects.toThrow(/extension schema definition is unavailable/);
    await expect(
      reader.update("review", retained.id, { extensions: { owner: "unsafe", estimate: 3 } }),
    ).rejects.toThrow(/extension schema definition is unavailable/);
    await expect(
      reader.upsert("review", "new-task", {
        create: { title: "Unsafe upsert", description: "Cannot validate extensions" },
      }),
    ).rejects.toThrow(/extension schema definition is unavailable/);

    const opaque = JSON.parse(
      await readFile(join(taskRoot, "review", `${retained.id}.json`), "utf8"),
    ) as Record<string, unknown>;
    expect(opaque).toMatchObject({
      extensionSchemaVersion: 1,
      extensions: { lane: "api" },
      status: "in_progress",
    });
    const opaqueOmitted = JSON.parse(
      await readFile(join(taskRoot, "review", `${omitted.id}.json`), "utf8"),
    ) as Record<string, unknown>;
    expect(opaqueOmitted).toMatchObject({ extensionSchemaVersion: 1, priority: "high" });
    expect(opaqueOmitted).not.toHaveProperty("extensions");

    const runtime = new TaskStore(taskRoot, async () => current);
    await runtime.registerWorkflow({ id: "review", name: "review" }, current, null, {
      schemaVersion: 2,
      semanticRevision: "owner-estimate-v2",
      migrate,
    });
    const migrated = await runtime.update("review", retained.id, { status: "done" });
    expect(migrated).toMatchObject({
      extensionSchemaVersion: 2,
      extensions: { owner: "api", estimate: 1 },
      status: "done",
    });
    const persisted = JSON.parse(
      await readFile(join(taskRoot, "review", `${retained.id}.json`), "utf8"),
    ) as Record<string, unknown>;
    expect(persisted).toMatchObject({
      extensionSchemaVersion: 2,
      extensions: { owner: "api", estimate: 1 },
    });
  });

  it("rejects non-JSON extension outputs before exposing task context", async () => {
    const cases = [
      {
        name: "Date",
        schema: z.object({ source: z.string() }).transform(({ source }) => ({ parsed: new Date(source) })),
        source: "2026-08-25T00:00:00.000Z",
      },
      {
        name: "bigint",
        schema: z.object({ source: z.string() }).transform(({ source }) => ({ parsed: BigInt(source) })),
        source: "42",
      },
    ];

    for (const testCase of cases) {
      const root = await tempRoot();
      const taskRoot = join(root, ".weft", "tasks");
      const writer = new TaskStore(taskRoot);
      await writer.create("release", {
        title: `Unsafe ${testCase.name}`,
        description: "Raw JSON remains durable",
        extensions: { source: testCase.source },
      });
      const reader = new TaskStore(taskRoot, async () => testCase.schema);

      await expect(reader.snapshot("release")).rejects.toThrow(
        new RegExp(`task extension schema output must be JSON-safe.*${testCase.name}`),
      );
    }
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
      { semanticRevision: "api-lane-v1" },
    );
    const uiBinding = await store.registerWorkflow(
      { id: "release", name: "release" },
      ui,
      z.toJSONSchema(ui),
      { semanticRevision: "ui-lane-v1" },
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

  it("isolates executable transforms that share a JSON schema and schema version", async () => {
    const root = await tempRoot();
    const store = new TaskStore(join(root, ".weft", "tasks"));
    const transformed = (prefix: string) =>
      z
        .object({ source: z.string() })
        .transform(({ source }) => ({ normalized: `${prefix}:${source.toLowerCase()}` }));
    const previous = transformed("previous");
    const current = transformed("current");
    const previousJson = z.toJSONSchema(previous, {
      io: "input",
      unrepresentable: "any",
    });
    const currentJson = z.toJSONSchema(current, {
      io: "input",
      unrepresentable: "any",
    });
    expect(previousJson).toEqual(currentJson);
    await expect(
      store.registerWorkflow({ id: "missing-revision", name: "missing-revision" }, previous, previousJson),
    ).rejects.toThrow(/semantic revision is required/);

    const previousBinding = await store.registerWorkflow(
      { id: "release", name: "release" },
      previous,
      previousJson,
      { identity: "stable-workflow", semanticRevision: "transform-v1" },
    );
    const task = await store.create("release", {
      title: "Normalize",
      description: "Preserve the exact transform observed by each run",
      extensions: { source: "API" },
    });
    const currentBinding = await store.registerWorkflow(
      { id: "release", name: "release" },
      current,
      currentJson,
      { identity: "stable-workflow", semanticRevision: "transform-v2" },
    );

    expect(currentBinding).not.toBe(previousBinding);
    const previousSnapshot = (await store.snapshot("release", {}, previousBinding)) as {
      tasks: Array<{ id: string; extensions: unknown }>;
    };
    const currentSnapshot = (await store.snapshot("release", {}, currentBinding)) as {
      tasks: Array<{ id: string; extensions: unknown }>;
    };
    expect(previousSnapshot.tasks).toEqual([
      expect.objectContaining({ id: task.id, extensions: { normalized: "previous:api" } }),
    ]);
    expect(currentSnapshot.tasks).toEqual([
      expect.objectContaining({ id: task.id, extensions: { normalized: "current:api" } }),
    ]);
  });

  it("isolates captured migration behavior behind semantic revisions", async () => {
    const root = await tempRoot();
    const store = new TaskStore(join(root, ".weft", "tasks"));
    const task = await store.create("release", {
      title: "Migrate",
      description: "Retain the migration selected by the run binding",
      extensions: { lane: "api" },
    });
    const current = z.object({ owner: z.string(), estimate: z.number().int() });
    const migrateWith = (ownerPrefix: string) => (value: unknown) => ({
      owner: `${ownerPrefix}:${(value as { lane: string }).lane}`,
      estimate: 1,
    });
    const previousMigration = migrateWith("previous");
    const currentMigration = migrateWith("current");
    expect(String(previousMigration)).toBe(String(currentMigration));
    const jsonSchema = z.toJSONSchema(current);
    const previousBinding = await store.registerWorkflow(
      { id: "release", name: "release" },
      current,
      jsonSchema,
      {
        schemaVersion: 2,
        semanticRevision: "migration-v1",
        identity: "stable-workflow",
        migrate: previousMigration,
      },
    );
    const currentBinding = await store.registerWorkflow(
      { id: "release", name: "release" },
      current,
      jsonSchema,
      {
        schemaVersion: 2,
        semanticRevision: "migration-v2",
        identity: "stable-workflow",
        migrate: currentMigration,
      },
    );

    const previousSnapshot = (await store.snapshot("release", {}, previousBinding)) as {
      tasks: Array<{ id: string; extensions: unknown }>;
    };
    const currentSnapshot = (await store.snapshot("release", {}, currentBinding)) as {
      tasks: Array<{ id: string; extensions: unknown }>;
    };
    expect(previousSnapshot.tasks).toEqual([
      expect.objectContaining({ id: task.id, extensions: { owner: "previous:api", estimate: 1 } }),
    ]);
    expect(currentSnapshot.tasks).toEqual([
      expect.objectContaining({ id: task.id, extensions: { owner: "current:api", estimate: 1 } }),
    ]);
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
        semanticRevision: "owner-estimate-v2",
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

  it("rejects late schema downgrades without replacing the durable namespace or runtime binding", async () => {
    const root = await tempRoot();
    const taskRoot = join(root, ".weft", "tasks");
    const store = new TaskStore(taskRoot);
    const current = z.object({ owner: z.string() });
    await store.registerWorkflow({ id: "review", name: "review" }, current, z.toJSONSchema(current), {
      schemaVersion: 2,
      semanticRevision: "owner-v2",
    });
    const first = await store.create("review", {
      title: "Current task",
      description: "Uses the upgraded schema",
      extensions: { owner: "api" },
    });

    const stale = z.object({ lane: z.string() });
    await expect(
      store.registerWorkflow({ id: "review", name: "review" }, stale, z.toJSONSchema(stale), {
        schemaVersion: 1,
        semanticRevision: "lane-v1",
      }),
    ).rejects.toThrow(/schema downgrade from version 2 to 1/);

    expect(await store.namespace("review")).toMatchObject({
      extensionSchemaVersion: 2,
      extensionSchema: expect.objectContaining({
        properties: expect.objectContaining({ owner: expect.anything() }),
      }),
    });
    const second = await store.create("review", {
      title: "Still current",
      description: "A rejected registration cannot replace the in-memory binding",
      extensions: { owner: "ui" },
    });
    const reader = new TaskStore(taskRoot);
    expect(await reader.list("review")).toEqual([
      expect.objectContaining({ id: first.id, extensionSchemaVersion: 2, extensions: { owner: "api" } }),
      expect.objectContaining({ id: second.id, extensionSchemaVersion: 2, extensions: { owner: "ui" } }),
    ]);
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
      { identity: "definition-a", semanticRevision: "lane-v1" },
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
        semanticRevision: "owner-estimate-v2",
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
      { schemaVersion: 2, semanticRevision: "owner-estimate-v2", persist: false },
    );
    expect(await dryStore.namespace("review")).toBeUndefined();
  });

  it("fails closed when a lost-marker batch's exact same-version contract is unavailable", async () => {
    const root = await tempRoot();
    const taskRoot = join(root, ".weft", "tasks");
    const oldStore = new TaskStore(taskRoot);
    const transformed = (prefix: string) =>
      z
        .object({ source: z.string() })
        .transform(({ source }) => ({ normalized: `${prefix}:${source.toLowerCase()}` }));
    const previous = transformed("previous");
    const previousJson = z.toJSONSchema(previous, { io: "input", unrepresentable: "any" });
    const oldBinding = await oldStore.registerWorkflow(
      { id: "review", name: "review" },
      previous,
      previousJson,
      { identity: "stable-workflow", semanticRevision: "transform-v1" },
    );
    const context = {
      workflowId: "review",
      workflowName: "review",
      runId: "run-old",
      step: "review",
      provider: "codex",
      source: "agent" as const,
      mode: "write" as const,
      visibleTaskIds: [],
      visibleDedupeKeys: [],
      schemaBinding: oldBinding,
      schemaVersion: 1,
    };
    const batchId = "run-old:agent:7";
    const first = {
      op: "upsert" as const,
      dedupeKey: "src/state.ts|review|same-version",
      create: {
        title: "Review state",
        description: "Created before the restart",
        extensions: { source: "API" },
      },
    };
    const second = {
      ...first,
      update: { priority: "high" as const },
      note: "Must not be applied by a different transform",
    };
    await oldStore.applyBatch(context, batchId, [first]);
    await unlink(
      join(taskRoot, "review", `.batch-${createHash("sha256").update(batchId).digest("hex")}.json`),
    );

    const currentStore = new TaskStore(taskRoot);
    const current = transformed("current");
    const currentJson = z.toJSONSchema(current, { io: "input", unrepresentable: "any" });
    expect(currentJson).toEqual(previousJson);
    await currentStore.registerWorkflow({ id: "review", name: "review" }, current, currentJson, {
      identity: "stable-workflow",
      semanticRevision: "transform-v2",
    });
    await expect(currentStore.applyBatch(context, batchId, [first, second])).rejects.toThrow(
      /exact executable task contract is unavailable/,
    );
    expect(await currentStore.list("review")).toEqual([
      expect.objectContaining({
        priority: "medium",
        appliedOperations: [`${batchId}:0`],
        notes: [],
      }),
    ]);
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

  it("authorizes remaining operations only through applied keys from the replayed batch", async () => {
    const root = await tempRoot();
    const taskRoot = join(root, ".weft", "tasks");
    const store = new TaskStore(taskRoot);
    const context = {
      workflowId: "review",
      workflowName: "review",
      runId: "run-1",
      step: "review",
      provider: "codex",
      source: "agent" as const,
      mode: "write" as const,
      visibleTaskIds: [],
      visibleDedupeKeys: [],
    };
    const batchId = "run-1:agent:7";
    const first = {
      op: "upsert" as const,
      dedupeKey: "src/state.ts|store|invalid-shape",
      create: { title: "Validate state", description: "The task was absent when observed" },
    };
    const second = {
      ...first,
      update: { priority: "high" as const },
      note: "Recovered the remaining operation",
    };

    // Simulate a crash after operation zero was durable but before operation one
    // or the batch marker was written.
    await store.applyBatch(context, batchId, [first]);
    await unlink(
      join(taskRoot, "review", `.batch-${createHash("sha256").update(batchId).digest("hex")}.json`),
    );
    await expect(store.applyBatch(context, batchId, [first, second])).resolves.toBeUndefined();

    const [recovered] = await store.list("review");
    expect(recovered).toMatchObject({
      priority: "high",
      revision: 2,
      appliedOperations: [`${batchId}:0`, `${batchId}:1`],
    });
    expect(recovered?.notes.map((note) => note.text)).toEqual(["Recovered the remaining operation"]);

    const hidden = await store.create("review", {
      dedupeKey: "src/hidden.ts|store|existing",
      title: "Hidden",
      description: "Unrelated durable work",
    });
    await expect(
      store.applyBatch(context, "unrelated-batch", [
        {
          op: "upsert",
          dedupeKey: hidden.dedupeKey ?? "",
          create: { title: "Replacement", description: "Must remain unauthorized" },
          update: { priority: "low" },
        },
      ]),
    ).rejects.toThrow(/not present in this step's observed task context/);
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

  it("releases a crashed SQLite mutex and serializes concurrent task stores", async () => {
    const root = await tempRoot();
    const taskRoot = join(root, ".weft", "tasks");
    const workflowDir = join(taskRoot, "locked");
    await mkdir(workflowDir, { recursive: true });
    const { DatabaseSync } = await import("node:sqlite");
    const blocker = new DatabaseSync(join(workflowDir, ".mutex.sqlite"));
    blocker.exec("PRAGMA busy_timeout = 0; BEGIN IMMEDIATE");
    const firstStore = new TaskStore(taskRoot);
    const secondStore = new TaskStore(taskRoot);
    let settled = 0;
    const pending = [
      firstStore.create("locked", { title: "First", description: "Wait for crash release" }),
      secondStore.create("locked", { title: "Second", description: "Wait for crash release" }),
    ].map((operation) =>
      operation.finally(() => {
        settled++;
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(settled).toBe(0);
    // Closing a connection with an open transaction models the OS releasing a
    // mutex after its owner exits; there is no stale pathname to reclaim.
    blocker.close();
    await Promise.all(pending);
    expect(await firstStore.list("locked")).toHaveLength(2);

    const orphan = join(workflowDir, ".task-deadbeef.crash.tmp");
    await writeFile(orphan, "partial", "utf8");
    await firstStore.create("locked", { title: "Recovered", description: "Orphan temp removed" });
    await expect(stat(orphan)).rejects.toMatchObject({ code: "ENOENT" });

    let active = 0;
    let maxActive = 0;
    let calls = 0;
    let releaseFirst!: () => void;
    let reportFirst!: () => void;
    const firstEntered = new Promise<void>((resolve) => {
      reportFirst = resolve;
    });
    const firstRelease = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const blockingSchema: AnySchema = {
      "~standard": {
        version: 1,
        vendor: "test",
        validate: async (value: unknown) => {
          calls++;
          active++;
          maxActive = Math.max(maxActive, active);
          if (calls === 1) {
            reportFirst();
            await firstRelease;
          }
          active--;
          return { value };
        },
      },
    };
    const first = firstStore.create(
      "serialized",
      { title: "Held", description: "Hold the workflow mutex", extensions: {} },
      blockingSchema,
    );
    await firstEntered;
    const second = secondStore.create(
      "serialized",
      { title: "Queued", description: "Must not overlap", extensions: {} },
      blockingSchema,
    );
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(calls).toBe(1);
    expect(maxActive).toBe(1);
    releaseFirst();
    await Promise.all([first, second]);
    expect(maxActive).toBe(1);
    expect(await firstStore.list("serialized", blockingSchema)).toHaveLength(2);
  });
});
