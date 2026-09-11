/**
 * The endpoints the workflow manager needs and the run-scoped API did not have: the
 * registry, starting a run, the bytes behind a ref, the artifact inventory, the config
 * file, and one cross-run view of what is waiting on a person.
 *
 * Driven through `app.request()` against a real engine over a throwaway repo, the same
 * way `daemon.test.ts` drives the run routes. Each suite registers only the module it is
 * testing, so a failure names one endpoint rather than the whole app.
 */
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createWeft, type RunState, resolveWorkflow, type Weft } from "@techery/weft-host";
import { Hono } from "hono";
import { afterAll, describe, expect, it } from "vitest";
import {
  createApp,
  parseDiffStats,
  registerArtifactRoutes,
  registerBlobRoutes,
  registerConfigRoutes,
  registerMetaRoutes,
  registerPendingRoutes,
  registerStartRoutes,
  registerWorkflowRoutes,
} from "../src/index.ts";

/** Two steps and a question: enough to have a journal, a phase, and a pending request. */
const GATED = `import { defineWorkflow, z } from "@techery/weft-sdk";

export default defineWorkflow(
  {
    id: "gated-state",
    name: "gated",
    description: "asks a person before it lands anything",
    input: z.object({ note: z.string().default("hi"), count: z.number().int().optional() }),
    output: z.object({ approved: z.boolean(), at: z.number() }),
    tasks: {
      extensions: z.object({ ownerTeam: z.string(), estimate: z.number().int() }),
      semanticRevision: "gated-task-fields-v2",
      schemaVersion: 2,
      migrate: (value) => {
        const old = value as Record<string, unknown>;
        return { ...old, estimate: typeof old.estimate === "number" ? old.estimate : 1 };
      },
    },
  },
  async (ctx) => {
    ctx.phase("Review");
    const at = await ctx.now();
    const verdict = await ctx.human.approve({ action: "land the patch", detail: "3 files, 40 lines" });
    return { approved: verdict.approved, at };
  },
);
`;

const STANDARD_SCHEMA = `import { defineWorkflow } from "@techery/weft-sdk";

const AnyValue = {
  "~standard": {
    version: 1,
    vendor: "test-standard-schema",
    validate: (value) => ({ value }),
  },
} as const;

export default defineWorkflow(
  {
    id: "standard-schema",
    description: "uses a non-Zod Standard Schema",
    input: AnyValue,
    output: AnyValue,
  },
  async (_ctx, input) => input,
);
`;

/** No question, so it runs to completion — what the stats and start suites need. */
const QUICK = `import { defineWorkflow, z } from "@techery/weft-sdk";

export default defineWorkflow(
  {
    name: "quick",
    description: "does one journaled thing and stops",
    input: z.object({ label: z.string() }),
    output: z.object({ label: z.string(), at: z.number() }),
  },
  async (ctx, input) => {
    ctx.phase("Work");
    return { label: input.label, at: await ctx.now() };
  },
);
`;

const opened: Weft[] = [];
const roots: string[] = [];

afterAll(async () => {
  for (const weft of opened) await weft.close().catch(() => undefined);
  opened.length = 0;
  await Promise.all(
    roots.map((dir) => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })),
  );
  roots.length = 0;
});

async function repo(config?: unknown): Promise<string> {
  const cwd = await mkdtemp(path.join(tmpdir(), "weft-api-"));
  roots.push(cwd);
  await writeWorkflow(cwd, "gated", GATED);
  await writeWorkflow(cwd, "quick", QUICK);
  if (config !== undefined) {
    await writeFile(path.join(cwd, ".weft", "config.json"), JSON.stringify(config, null, 2), "utf8");
  }
  return cwd;
}

async function writeWorkflow(cwd: string, name: string, source: string): Promise<void> {
  const packageDir = path.join(cwd, ".weft", "workflows", name);
  await Promise.all([
    mkdir(path.join(packageDir, "lib"), { recursive: true }),
    mkdir(path.join(packageDir, "tests"), { recursive: true }),
  ]);
  await Promise.all([
    writeFile(path.join(packageDir, "main.ts"), source, "utf8"),
    writeFile(path.join(packageDir, "CHANGELOG.md"), `# ${name} changelog\n`, "utf8"),
  ]);
}

/** An engine over a throwaway repo, plus a Hono app carrying only the given modules. */
async function open(
  cwd: string,
  ...register: Array<(app: Hono, weft: Weft) => void>
): Promise<{ weft: Weft; app: Hono; cwd: string }> {
  const weft = await createWeft({ cwd, providers: "mock" });
  opened.push(weft);
  const app = new Hono();
  for (const fn of register) fn(app, weft);
  return { weft, app, cwd };
}

/** Start `gated` and leave it parked on its approval request. */
async function seedGated(weft: Weft, cwd: string): Promise<string> {
  const { def, hash } = await resolveWorkflow(weft, "gated");
  const handle = await weft.engine.start(def, {
    input: {},
    cwd,
    ...(hash !== undefined ? { defHash: hash } : {}),
  });
  const outcome = await handle.outcome();
  expect(outcome.status).toBe("waiting_for_human");
  // A run reports itself idle before the status event it wrote reaches the journal, so
  // wait for the durable record rather than the in-memory one.
  await expect.poll(async () => (await weft.engine.state(handle.runId)).status).toBe("waiting_for_human");
  return handle.runId;
}

async function seedQuick(weft: Weft, cwd: string, label = "one"): Promise<string> {
  const { def, hash } = await resolveWorkflow(weft, "quick");
  const handle = await weft.engine.start(def, {
    input: { label },
    cwd,
    ...(hash !== undefined ? { defHash: hash } : {}),
  });
  expect((await handle.outcome()).status).toBe("complete");
  return handle.runId;
}

// ---------------------------------------------------------------------------

describe("GET /api/meta", () => {
  it("reports the repo, the resolved engine config and which providers are wired", async () => {
    const cwd = await repo({ limits: { concurrency: 5 }, approvalPolicy: { tiers: { high: "auto" } } });
    const h = await open(cwd, registerMetaRoutes);
    const res = await h.app.request("/api/meta");
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      version: string;
      repo: { name: string; cwd: string; runsDir: string };
      limits: { concurrency: number };
      approvalPolicy: { tiers?: Record<string, string> };
      fetchAllow: string[] | null;
      providers: Array<{ id: string; registered: boolean }>;
    };
    expect(body.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(body.repo.name).toBe(path.basename(cwd));
    expect(body.repo.cwd).toBe(cwd);
    expect(body.repo.runsDir).toContain(".weft");
    // The config file's own values, resolved.
    expect(body.limits.concurrency).toBe(5);
    expect(body.approvalPolicy.tiers?.high).toBe("auto");
    // Unset means "every host allowed"; JSON says so as null rather than omitting it.
    expect(body.fetchAllow).toBeNull();
    expect(body.providers.some((p) => p.registered)).toBe(true);
  });
});

describe("GET /api/workflows", () => {
  it("lists the registry with repo-relative paths", async () => {
    const h = await open(await repo(), registerWorkflowRoutes);
    const body = (await (await h.app.request("/api/workflows")).json()) as Array<{
      name: string;
      file: string;
      description: string;
    }>;
    expect(body.map((w) => w.name).sort()).toEqual(["gated", "quick"]);
    expect(body.find((w) => w.name === "gated")?.file).toBe(".weft/workflows/gated/main.ts");
    expect(body.find((w) => w.name === "quick")?.description).toContain("one journaled thing");
  });

  it("converts a workflow's declared input to JSON Schema so a client can build a form", async () => {
    const h = await open(await repo(), registerWorkflowRoutes);
    const res = await h.app.request("/api/workflows/gated");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      name: string;
      file: string;
      hash: string;
      input: { type: string; properties: Record<string, { type?: string; default?: unknown }> };
      output: { properties: Record<string, unknown> };
      taskExtensions: { properties: Record<string, { type?: string }> };
      taskExtensionSchemaVersion: number;
      tasksConfigured: boolean;
      schemaWarnings: string[];
    };
    expect(body.name).toBe("gated");
    expect(body.hash).toMatch(/^[0-9a-f]{8,}$/);
    expect(body.input.type).toBe("object");
    expect(body.input.properties.note?.type).toBe("string");
    expect(body.input.properties.note?.default).toBe("hi");
    expect(body.input.properties.count?.type).toBe("integer");
    expect(Object.keys(body.output.properties)).toEqual(["approved", "at"]);
    // Converted on the OUTPUT side: what a run produced, not what a caller may send.
    expect((body.output as { required?: string[] }).required).toEqual(["approved", "at"]);
    expect(body.taskExtensions.properties.ownerTeam?.type).toBe("string");
    expect(body.taskExtensionSchemaVersion).toBe(2);
    expect(body.tasksConfigured).toBe(true);
    expect(body.schemaWarnings).toEqual([]);
  });

  it("exposes a permissive schema and only provider-bound warnings for non-Zod Standard Schemas", async () => {
    const cwd = await repo();
    await writeWorkflow(cwd, "standard", STANDARD_SCHEMA);
    const h = await open(cwd, registerWorkflowRoutes);

    const res = await h.app.request("/api/workflows/standard");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      input: { type: string; properties: Record<string, unknown> };
      output: { type: string; properties: Record<string, unknown> };
      schemaWarnings: string[];
    };
    expect(body.input).toMatchObject({ type: "object", properties: { value: {} } });
    expect(body.output).toMatchObject({ type: "object", properties: { value: {} } });
    expect(body.schemaWarnings).toEqual(
      expect.arrayContaining([expect.stringContaining("input: non-zod schema")]),
    );
    expect(body.schemaWarnings).not.toEqual(
      expect.arrayContaining([expect.stringContaining("output: non-zod schema")]),
    );
  });

  it("lists every durable task for the selected workflow", async () => {
    const h = await open(await repo(), registerWorkflowRoutes);
    const loaded = await h.weft.registry.load("gated");
    const task = await h.weft.tasks.create(
      "gated-state",
      {
        dedupeKey: "gate|decision|missing-evidence",
        title: "Review gate evidence",
        description: "Carry the decision context into the next workflow step.",
        acceptanceCriteria: ["decision is recorded"],
        extensions: { ownerTeam: "platform", estimate: 2 },
      },
      loaded.def.meta.tasks?.extensions,
    );
    const res = await h.app.request("/api/workflows/gated/tasks");
    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<{
      id: string;
      dedupeKey?: string;
      title: string;
      extensions: unknown;
    }>;
    expect(body).toEqual([
      expect.objectContaining({
        id: task.id,
        dedupeKey: "gate|decision|missing-evidence",
        title: "Review gate evidence",
        extensions: { ownerTeam: "platform", estimate: 2 },
      }),
    ]);
  });

  it("404s a workflow that is not in the registry", async () => {
    const h = await open(await repo(), registerWorkflowRoutes);
    const res = await h.app.request("/api/workflows/nope");
    expect(res.status).toBe(404);
    expect((await res.json()) as { error: string }).toMatchObject({ error: "workflow nope not found" });
    const tasks = await h.app.request("/api/workflows/nope/tasks");
    expect(tasks.status).toBe(404);
    expect((await tasks.json()) as { error: string }).toMatchObject({ error: "workflow nope not found" });
  });

  it("scores a workflow over its own runs, and says nothing rather than guessing at zero", async () => {
    const cwd = await repo();
    const h = await open(cwd, registerWorkflowRoutes);
    const empty = (await (await h.app.request("/api/workflows/quick/stats")).json()) as {
      runs: number;
      successRate: number | null;
      p50Ms: number | null;
      lastRunAt: number | null;
    };
    expect(empty.runs).toBe(0);
    expect(empty.successRate).toBeNull();
    expect(empty.p50Ms).toBeNull();
    expect(empty.lastRunAt).toBeNull();

    await seedQuick(h.weft, cwd, "a");
    await seedQuick(h.weft, cwd, "b");
    // A second app so the memoized index is rebuilt over the runs that now exist.
    const fresh = await open(cwd, registerWorkflowRoutes);
    const body = (await (await fresh.app.request("/api/workflows/quick/stats")).json()) as {
      runs: number;
      settled: number;
      ok: number;
      failed: number;
      successRate: number;
      p50Ms: number;
      recent: Array<{ runId: string; status: string }>;
      windowDays: number;
      cancelled: number;
      truncated: boolean;
    };
    expect(body.runs).toBe(2);
    expect(body.settled).toBe(2);
    expect(body.ok).toBe(2);
    expect(body.failed).toBe(0);
    expect(body.successRate).toBe(100);
    expect(body.p50Ms).toBeGreaterThanOrEqual(0);
    expect(body.recent).toHaveLength(2);
    expect(body.recent.every((r) => r.status === "complete")).toBe(true);
    expect(body.windowDays).toBe(30);
    expect(body.cancelled).toBe(0);
    expect(body.truncated).toBe(false);
  });
});

describe("POST /api/runs", () => {
  it("starts a registry workflow and reports the run id", async () => {
    const cwd = await repo();
    const h = await open(cwd, registerStartRoutes);
    const res = await h.app.request("/api/runs", {
      method: "POST",
      body: JSON.stringify({ workflow: "quick", input: { label: "from-http" } }),
      headers: { "content-type": "application/json" },
    });
    expect(res.status).toBe(202);
    const body = (await res.json()) as { ok: boolean; runId: string; workflow: string };
    expect(body).toMatchObject({ ok: true, workflow: "quick" });
    expect(body.runId).toMatch(/^[0-9a-f]{8}$/);

    await expect.poll(async () => (await h.weft.engine.state(body.runId)).status).toBe("complete");
    const state = await h.weft.engine.state(body.runId);
    expect(state.input).toEqual({ label: "from-http" });
    expect((state.output as { label: string }).label).toBe("from-http");
  });

  it("accepts a budget in the same grammar as --budget", async () => {
    const cwd = await repo();
    const h = await open(cwd, registerStartRoutes);
    const res = await h.app.request("/api/runs", {
      method: "POST",
      body: JSON.stringify({ workflow: "quick", input: { label: "x" }, budget: "500k,$5" }),
      headers: { "content-type": "application/json" },
    });
    expect(res.status).toBe(202);
  });

  it("refuses a path, so one POST can never mean 'execute this file'", async () => {
    const cwd = await repo();
    const h = await open(cwd, registerStartRoutes);
    for (const workflow of ["./evil.ts", "../evil.ts", "/tmp/evil.ts", "sub/dir", "evil.ts"]) {
      const res = await h.app.request("/api/runs", {
        method: "POST",
        body: JSON.stringify({ workflow }),
        headers: { "content-type": "application/json" },
      });
      expect(res.status, workflow).toBe(400);
      expect(((await res.json()) as { error: string }).error, workflow).toContain("registry workflows only");
    }
  });

  it("rejects a bad body before anything is reserved", async () => {
    const cwd = await repo();
    const h = await open(cwd, registerStartRoutes);
    const cases: Array<[unknown, string]> = [
      [{}, "workflow is required"],
      [{ workflow: "quick", input: [] }, "input must be a JSON object"],
      [{ workflow: "quick", budget: "nonsense" }, "invalid budget"],
      [{ workflow: "quick", reuse: "sideways" }, 'reuse must be "content" or "key"'],
      // resolveWorkflow's own message, which lists what IS available — a 400 because the
      // request body is wrong, not because /api/runs is missing.
      [{ workflow: "missing" }, 'unknown workflow "missing"'],
    ];
    for (const [body, message] of cases) {
      const res = await h.app.request("/api/runs", {
        method: "POST",
        body: JSON.stringify(body),
        headers: { "content-type": "application/json" },
      });
      expect(res.status, JSON.stringify(body)).toBeGreaterThanOrEqual(400);
      expect(((await res.json()) as { error: string }).error, JSON.stringify(body)).toContain(message);
    }
    // A rejected start leaves no reserved run directory behind.
    expect(await h.weft.engine.list()).toEqual([]);
  });

  it("surfaces a schema violation as a bad request, not a started run", async () => {
    const cwd = await repo();
    const h = await open(cwd, registerStartRoutes);
    const res = await h.app.request("/api/runs", {
      method: "POST",
      // `quick` requires `label`.
      body: JSON.stringify({ workflow: "quick", input: { label: 7 } }),
      headers: { "content-type": "application/json" },
    });
    expect(res.status).toBe(400);
  });
});

describe("GET /api/blobs/:ref", () => {
  it("serves the bytes behind a ref, immutably", async () => {
    const h = await open(await repo(), registerBlobRoutes);
    const ref = await h.weft.engine.blobs.put("hello blob", { contentType: "text/plain" });
    const res = await h.app.request(`/api/blobs/${ref.hash}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(res.headers.get("content-type")).toBe("application/octet-stream");
    expect(await res.text()).toBe("hello blob");

    const asText = await h.app.request(`/api/blobs/${ref.hash}?as=text`);
    expect(asText.headers.get("content-type")).toContain("text/plain");
  });

  it("never lets a ref become a path", async () => {
    const h = await open(await repo(), registerBlobRoutes);
    for (const ref of [
      "../../etc/passwd",
      "..%2F..%2Fetc%2Fpasswd",
      "0".repeat(63),
      "0".repeat(65),
      "G".repeat(64),
      `${"0".repeat(62)}/x`,
      "",
    ]) {
      const res = await h.app.request(`/api/blobs/${ref}`);
      expect(res.status, ref).toBeGreaterThanOrEqual(400);
      expect(await res.text(), ref).not.toContain("root:");
    }
  });

  it("404s a well-formed ref nothing has stored", async () => {
    const h = await open(await repo(), registerBlobRoutes);
    const res = await h.app.request(`/api/blobs/${"a".repeat(64)}`);
    expect(res.status).toBe(404);
  });
});

describe("GET /api/runs/:id/presentations/:presentationId/frame", () => {
  it("serves only the bundle sealed into a presentation event with strict frame headers", async () => {
    const cwd = await repo();
    await mkdir(path.join(cwd, ".weft", "workflows", "panel", "lib"), { recursive: true });
    await writeFile(
      path.join(cwd, ".weft", "workflows", "panel", "lib", "panel.ui.tsx"),
      [
        `import { defineResultView } from "@techery/weft-sdk/ui";`,
        `export default defineResultView<{ message: string }>({`,
        `  id: "panel", revision: "1",`,
        `  component: ({ props }) => <strong>{props.message}</strong>,`,
        `});`,
      ].join("\n"),
      "utf8",
    );
    await writeWorkflow(
      cwd,
      "panel",
      [
        `import { defineWorkflow, z } from "@techery/weft-sdk";`,
        `import panel from "./lib/panel.ui.tsx";`,
        `export default defineWorkflow(`,
        `  { name: "panel", description: "panel", input: z.object({}), output: z.object({ ok: z.boolean() }) },`,
        `  async (ctx) => { await ctx.ui.render({ key: "panel", view: panel, props: { message: "hello" } }); return { ok: true }; },`,
        `);`,
      ].join("\n"),
    );
    const weft = await createWeft({ cwd, providers: "mock" });
    opened.push(weft);
    const resolved = await resolveWorkflow(weft, "panel");
    const run = await weft.engine.start(resolved.def, {
      input: {},
      cwd,
      defHash: resolved.hash,
      uiCatalog: resolved.uiCatalog,
    });
    await run.result;
    const state = await weft.engine.state(run.runId);
    const presentation = state.steps.find((step) => step.presentation)?.presentation;
    expect(presentation).toBeDefined();

    const app = createApp(weft, { web: null });
    const response = await app.request(`/api/runs/${run.runId}/presentations/${presentation!.id}/frame`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-security-policy")).toContain("default-src 'none'");
    expect(response.headers.get("content-security-policy")).toContain("sandbox allow-scripts");
    expect(response.headers.get("content-security-policy")).toContain("frame-ancestors 'self'");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(await response.text()).toContain("weft.ui.init");

    await weft.engine.blobs.put("alert('not journaled')", { kind: "ui-bundle" });
    const arbitrary = await app.request(`/api/runs/${run.runId}/presentations/not-recorded/frame`);
    expect(arbitrary.status).toBe(404);
  });
});

describe("GET /api/runs/:id/artifacts and /patch", () => {
  it("inventories what a run produced, and says what is still readable", async () => {
    const cwd = await repo();
    const h = await open(cwd, registerArtifactRoutes);
    const runId = await seedGated(h.weft, cwd);
    const res = await h.app.request(`/api/runs/${runId}/artifacts`);
    expect(res.status).toBe(200);
    // This workflow attaches nothing, which is the honest empty case: a list, not a 404.
    expect((await res.json()) as unknown[]).toEqual([]);
  });

  it("404s a run nobody journaled", async () => {
    const h = await open(await repo(), registerArtifactRoutes);
    expect((await h.app.request("/api/runs/nope/artifacts")).status).toBe(404);
    expect((await h.app.request("/api/runs/nope/patch")).status).toBe(404);
  });

  it("returns no patches for a run that staged nothing", async () => {
    const cwd = await repo();
    const h = await open(cwd, registerArtifactRoutes);
    const runId = await seedGated(h.weft, cwd);
    const body = (await (await h.app.request(`/api/runs/${runId}/patch`)).json()) as {
      runId: string;
      patches: unknown[];
    };
    expect(body).toEqual({ runId, patches: [] });
  });

  it("404s a patch key the run never captured", async () => {
    const cwd = await repo();
    const h = await open(cwd, registerArtifactRoutes);
    const runId = await seedGated(h.weft, cwd);
    const res = await h.app.request(`/api/runs/${runId}/patch?key=nope`);
    expect(res.status).toBe(404);
  });
});

describe("parseDiffStats", () => {
  it("counts content lines and never the +++/--- headers", () => {
    const diff = [
      "diff --git a/src/net/fetchWithRetry.ts b/src/net/fetchWithRetry.ts",
      "index 1111111..2222222 100644",
      "--- a/src/net/fetchWithRetry.ts",
      "+++ b/src/net/fetchWithRetry.ts",
      "@@ -12,4 +12,6 @@ fetchWithRetry()",
      " export async function fetchWithRetry(req: Request) {",
      "-  return await fetch(req);",
      "+  return await retryGuard(backoff, async () => {",
      "+    const res = await fetch(req);",
      "+    return res;",
      " }",
      "",
    ].join("\n");
    expect(parseDiffStats(diff)).toEqual([
      { path: "src/net/fetchWithRetry.ts", adds: 3, dels: 1, status: "modified" },
    ]);
  });

  it("reads adds, deletes and binary files across several files in one patch", () => {
    const diff = [
      "diff --git a/added.txt b/added.txt",
      "new file mode 100644",
      "--- /dev/null",
      "+++ b/added.txt",
      "@@ -0,0 +1,2 @@",
      "+one",
      "+two",
      "diff --git a/gone.txt b/gone.txt",
      "deleted file mode 100644",
      "--- a/gone.txt",
      "+++ /dev/null",
      "@@ -1,1 +0,0 @@",
      "-bye",
      "diff --git a/logo.png b/logo.png",
      "index 3333333..4444444 100644",
      "Binary files a/logo.png and b/logo.png differ",
    ].join("\n");
    expect(parseDiffStats(diff)).toEqual([
      { path: "added.txt", adds: 2, dels: 0, status: "added" },
      { path: "gone.txt", adds: 0, dels: 1, status: "deleted" },
      { path: "logo.png", adds: 0, dels: 0, status: "binary" },
    ]);
  });

  it("is empty for an empty patch", () => {
    expect(parseDiffStats("")).toEqual([]);
  });
});

describe("GET and PUT /api/config", () => {
  it("reports the file and what the engine resolved it to", async () => {
    const cwd = await repo({ limits: { concurrency: 3 } });
    const h = await open(cwd, registerConfigRoutes);
    const body = (await (await h.app.request("/api/config")).json()) as {
      file: string;
      exists: boolean;
      config: { limits?: { concurrency?: number } };
      effective: { limits: { concurrency: number; maxTurns: number } };
    };
    expect(body.file).toBe("config.json");
    expect(body.exists).toBe(true);
    expect(body.config.limits?.concurrency).toBe(3);
    expect(body.effective.limits.concurrency).toBe(3);
    // Everything the file did not say, defaulted.
    expect(body.effective.limits.maxTurns).toBeGreaterThan(0);
  });

  it("says so plainly when there is no config file", async () => {
    const h = await open(await repo(), registerConfigRoutes);
    const body = (await (await h.app.request("/api/config")).json()) as {
      exists: boolean;
      config: unknown;
    };
    expect(body.exists).toBe(false);
    expect(body.config).toEqual({});
  });

  it("writes a valid config and reads it back", async () => {
    const cwd = await repo();
    const h = await open(cwd, registerConfigRoutes);
    const next = { limits: { concurrency: 11 }, approvalPolicy: { tiers: { high: "auto" } } };
    const res = await h.app.request("/api/config", {
      method: "PUT",
      body: JSON.stringify(next),
      headers: { "content-type": "application/json" },
    });
    expect(res.status).toBe(200);
    expect((await res.json()) as { restartRequired: boolean }).toMatchObject({ restartRequired: true });

    const onDisk = JSON.parse(await readFile(path.join(cwd, ".weft", "config.json"), "utf8")) as unknown;
    expect(onDisk).toEqual(next);
    const reread = (await (await h.app.request("/api/config")).json()) as { config: unknown };
    expect(reread.config).toEqual(next);
  });

  it("refuses a config the next process could not load, and leaves the old one in place", async () => {
    const cwd = await repo({ limits: { concurrency: 7 } });
    const h = await open(cwd, registerConfigRoutes);
    const file = path.join(cwd, ".weft", "config.json");

    for (const bad of [
      { limits: { concurrency: "many" } },
      { limits: { stepTimoutMs: 1000 } },
      { approvalPolicy: { tiers: { high: "maybe" } } },
      { defaults: { effort: "colossal" } },
    ]) {
      const res = await h.app.request("/api/config", {
        method: "PUT",
        body: JSON.stringify(bad),
        headers: { "content-type": "application/json" },
      });
      expect(res.status, JSON.stringify(bad)).toBe(400);
      expect(((await res.json()) as { error: string }).error).toContain("not a valid weft config");
      // Untouched: a rejected write must not be a half-written file either.
      expect(JSON.parse(await readFile(file, "utf8")) as unknown).toEqual({ limits: { concurrency: 7 } });
    }

    const notObject = await h.app.request("/api/config", {
      method: "PUT",
      body: JSON.stringify([1, 2]),
      headers: { "content-type": "application/json" },
    });
    expect(notObject.status).toBe(400);
  });
});

describe("GET /api/pending", () => {
  it("collects every waiting question in one request, oldest first", async () => {
    const cwd = await repo();
    const h = await open(cwd, registerPendingRoutes);
    expect((await (await h.app.request("/api/pending")).json()) as unknown).toEqual({
      pending: [],
      unreadable: [],
    });

    const first = await seedGated(h.weft, cwd);
    const second = await seedGated(h.weft, cwd);
    await seedQuick(h.weft, cwd);

    const { pending: body } = (await (await h.app.request("/api/pending")).json()) as {
      pending: Array<{
        runId: string;
        rootRunId: string;
        workflow: string;
        rootWorkflow: string;
        question: string;
        kind: string;
        createdAt: number;
      }>;
    };
    expect(body.map((entry) => entry.runId).sort()).toEqual([first, second].sort());
    expect(body.every((entry) => entry.workflow === "gated")).toBe(true);
    expect(body.every((entry) => entry.rootRunId === entry.runId)).toBe(true);
    expect(body.every((entry) => entry.question.length > 0)).toBe(true);
    expect(body.every((entry) => entry.kind === "approve")).toBe(true);
    // Completed runs contribute nothing, and the order is by age.
    expect(body).toHaveLength(2);
    expect(body[0]!.createdAt).toBeLessThanOrEqual(body[1]!.createdAt);
  });

  it("drops a run from the queue once it is answered", async () => {
    const cwd = await repo();
    const h = await open(cwd, registerPendingRoutes);
    const runId = await seedGated(h.weft, cwd);
    const before = (await (await h.app.request("/api/pending")).json()) as {
      pending: Array<{ id: string }>;
    };
    expect(before.pending).toHaveLength(1);

    await h.weft.engine.answer(runId, before.pending[0]!.id, { approved: true }, { channel: "test" });
    const after = (await (await h.app.request("/api/pending")).json()) as { pending: unknown[] };
    expect(after.pending).toEqual([]);
  });
});

describe("the whole app", () => {
  it("carries every new route alongside the ones that were already there", async () => {
    const cwd = await repo();
    const weft = await createWeft({ cwd, providers: "mock" });
    opened.push(weft);
    const app = createApp(weft, { web: null });
    const runId = await seedGated(weft, cwd);

    for (const route of [
      "/api/meta",
      "/api/pending",
      "/api/workflows",
      "/api/workflows/gated",
      "/api/workflows/gated/stats",
      "/api/config",
      `/api/runs/${runId}`,
      `/api/runs/${runId}/artifacts`,
      `/api/runs/${runId}/patch`,
      "/api/runs",
    ]) {
      expect((await app.request(route)).status, route).toBe(200);
    }

    // `?spend=1` is the runs list a cost column needs.
    const rows = (await (await app.request("/api/runs?spend=1")).json()) as Array<{
      runId: string;
      spend: { tokens: number; usd: number };
      steps: number;
      running: number;
    }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.runId).toBe(runId);
    expect(rows[0]!.spend).toEqual({ tokens: 0, usd: 0 });
    expect(rows[0]!.steps).toBeGreaterThan(0);

    // Without it, the plain summary stays a summary.
    const plain = (await (await app.request("/api/runs")).json()) as Array<Record<string, unknown>>;
    expect(plain[0]).not.toHaveProperty("spend");

    // A POST start still goes through the full app, loopback guard and all.
    const started = await app.request("/api/runs", {
      method: "POST",
      body: JSON.stringify({ workflow: "quick", input: { label: "via-app" } }),
      headers: { "content-type": "application/json" },
    });
    expect(started.status).toBe(202);
  });

  it("keeps the loopback guard in front of every new route", async () => {
    const h = await open(await repo(), registerMetaRoutes);
    const app = createApp(h.weft, { web: null });
    for (const route of ["/api/meta", "/api/workflows", "/api/config", "/api/pending"]) {
      const rebound = await app.request(route, { headers: { host: "attacker.example:4100" } });
      expect(rebound.status, route).toBe(403);
    }
    const crossSite = await app.request("/api/runs", {
      method: "POST",
      body: JSON.stringify({ workflow: "quick" }),
      headers: { "content-type": "application/json", origin: "https://evil.example" },
    });
    expect(crossSite.status).toBe(403);
  });
});

/** Referenced so the RunState import is load-bearing for the shapes asserted above. */
type _State = RunState;

// ---------------------------------------------------------------------------
// Regressions
//
// One case per defect found reviewing the endpoints above. Each names the thing that was
// wrong, because the wrong behaviour was plausible enough to be written once already.
// ---------------------------------------------------------------------------

/** A workflow that does not declare `meta.name` — the repo's own documented style. */
const UNNAMED = `import { defineWorkflow, z } from "@techery/weft-sdk";

export default defineWorkflow(
  {
    description: "name derives from the package directory",
    input: z.object({ base: z.string().default("main") }),
    output: z.object({ base: z.string() }),
  },
  async (ctx, input) => {
    ctx.phase("Work");
    await ctx.now();
    return { base: input.base };
  },
);
`;

/** Exists, exports a workflow, and violates a gate rule — a build failure, not a miss. */
const BROKEN = `import { defineWorkflow, z } from "@techery/weft-sdk";

export default defineWorkflow(
  { description: "uses a forbidden clock", input: z.object({}), output: z.object({ at: z.number() }) },
  async () => ({ at: Date.now() }),
);
`;

describe("regression: a run must be journaled under its registry name", () => {
  it("names a definition that declares no meta.name, so the run stays resumable", async () => {
    const cwd = await repo();
    await writeWorkflow(cwd, "unnamed", UNNAMED);
    const h = await open(cwd, registerStartRoutes);

    const res = await h.app.request("/api/runs", {
      method: "POST",
      body: JSON.stringify({ workflow: "unnamed", input: {} }),
      headers: { "content-type": "application/json" },
    });
    expect(res.status).toBe(202);
    const { runId } = (await res.json()) as { runId: string };
    await expect.poll(async () => (await h.weft.engine.state(runId)).status).toBe("complete");

    // The journal has to carry "unnamed", not engine.start's "workflow" fallback: a resume
    // looks the definition up by the journaled name, and nothing can resolve "workflow".
    expect((await h.weft.engine.state(runId)).workflow).toBe("unnamed");
    expect((await h.weft.engine.list({ workflow: "unnamed" })).map((r) => r.runId)).toEqual([runId]);
    expect(await h.weft.engine.list({ workflow: "workflow" })).toEqual([]);
  });
});

describe("regression: input a schema would silently drop", () => {
  it("refuses a typo'd field instead of running the wrong job", async () => {
    const cwd = await repo();
    await writeWorkflow(cwd, "unnamed", UNNAMED);
    const h = await open(cwd, registerStartRoutes);
    const res = await h.app.request("/api/runs", {
      method: "POST",
      body: JSON.stringify({ workflow: "unnamed", input: { basse: "release-2.0" } }),
      headers: { "content-type": "application/json" },
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain('has no input field "basse"');
    expect(await h.weft.engine.list()).toEqual([]);
  });
});

describe("regression: a workflow that exists but does not build", () => {
  it("reports the gate diagnostics, not a fabricated 404", async () => {
    const cwd = await repo();
    await writeWorkflow(cwd, "broken", BROKEN);
    const h = await open(cwd, registerStartRoutes, registerWorkflowRoutes);

    const started = await h.app.request("/api/runs", {
      method: "POST",
      body: JSON.stringify({ workflow: "broken" }),
      headers: { "content-type": "application/json" },
    });
    expect(started.status).toBe(400);
    const startError = ((await started.json()) as { error: string }).error;
    expect(startError).toContain("no-date-now");
    expect(startError).not.toContain("not found");

    const fetched = await h.app.request("/api/workflows/broken");
    expect(fetched.status).toBe(400);
    expect(((await fetched.json()) as { error: string }).error).toContain("no-date-now");

    // A genuine miss is still a 404.
    expect((await h.app.request("/api/workflows/nope")).status).toBe(404);
  });
});

describe("regression: a budget the caller believes is a cap", () => {
  it("refuses a misspelled axis rather than starting with no ceiling", async () => {
    const cwd = await repo();
    const h = await open(cwd, registerStartRoutes);
    for (const budget of [{ token: 10 }, { dollars: 1 }, {}, { tokens: 10, usdd: 1 }]) {
      const res = await h.app.request("/api/runs", {
        method: "POST",
        body: JSON.stringify({ workflow: "quick", input: { label: "x" }, budget }),
        headers: { "content-type": "application/json" },
      });
      expect(res.status, JSON.stringify(budget)).toBe(400);
      expect(((await res.json()) as { error: string }).error).toMatch(/budget (has no field|must set)/);
    }
    expect(await h.weft.engine.list()).toEqual([]);
  });
});

describe("regression: :name is not a path", () => {
  it("refuses a percent-encoded traversal before the registry loads anything", async () => {
    const cwd = await repo();
    // A gate-clean workflow outside the registry, which a traversal would bundle and run.
    const outside = path.join(cwd, "outside.ts");
    await writeFile(outside, UNNAMED, "utf8");
    const h = await open(cwd, registerWorkflowRoutes);

    // A percent-encoded SEPARATOR survives routing untouched — URL normalisation collapses
    // dot segments, encoded or not, but never turns %2f into one — so an encoded slash is
    // what actually reaches the handler, and the guard is the only thing standing there.
    for (const name of ["..%2f..%2foutside", "..%2Foutside", "%2e%2e%2foutside", "quick.ts"]) {
      const res = await h.app.request(`/api/workflows/${name}`);
      expect(res.status, name).toBe(400);
      expect(((await res.json()) as { error: string }).error, name).toContain("registry workflow name");
      expect((await h.app.request(`/api/workflows/${name}/stats`)).status, name).toBe(400);
    }

    // A raw `../` is collapsed by URL normalisation before any route sees it, so it lands
    // on a path this app has no handler for. Never a 200, either way.
    // Dot segments are collapsed before routing, encoded or not, so these never arrive.
    for (const name of ["../outside", `${path.dirname(cwd)}/outside`, "sub/dir", "..", ".", "%2e%2e"]) {
      expect((await h.app.request(`/api/workflows/${name}`)).status, name).toBeGreaterThanOrEqual(400);
    }

    // The legitimate name still works.
    expect((await h.app.request("/api/workflows/quick")).status).toBe(200);
  });
});

describe("regression: stats must not freeze at the first request", () => {
  it("sees a run created after the index was first built", async () => {
    const cwd = await repo();
    const h = await open(cwd, registerWorkflowRoutes);
    const first = (await (await h.app.request("/api/workflows/quick/stats")).json()) as { runs: number };
    expect(first.runs).toBe(0);

    await seedQuick(h.weft, cwd, "later");
    // The listing and the index are cached for a few seconds; a poll after that window
    // must reflect the world as it is now, not as it was on first sight.
    await expect
      .poll(
        async () =>
          ((await (await h.app.request("/api/workflows/quick/stats")).json()) as { runs: number }).runs,
        { timeout: 10_000, interval: 500 },
      )
      .toBe(1);
  });
});

describe("regression: a cancelled run is not a failure", () => {
  it("counts cancellations separately and keeps them out of the success rate", async () => {
    const cwd = await repo();
    const h = await open(cwd, registerWorkflowRoutes);
    const runId = await seedGated(h.weft, cwd);
    await h.weft.engine.cancel(runId);
    await expect.poll(async () => (await h.weft.engine.state(runId)).status).toBe("cancelled");

    const fresh = await open(cwd, registerWorkflowRoutes);
    const body = (await (await fresh.app.request("/api/workflows/gated/stats")).json()) as {
      ok: number;
      failed: number;
      cancelled: number;
      settled: number;
      successRate: number | null;
    };
    expect(body.cancelled).toBe(1);
    expect(body.failed).toBe(0);
    expect(body.settled).toBe(1);
    // Nothing failed, and nothing succeeded either — a rate over an empty sample is null,
    // not zero.
    expect(body.successRate).toBeNull();
  });
});

describe("regression: a still-waiting child under a terminal root", () => {
  it("keeps a sibling's question in the queue after the root has failed", async () => {
    const cwd = await repo();
    // One child asks, the other throws. The root journals `run.failed` while the asking
    // child stays parked on a person, its question still answerable — so a queue that
    // walked roots downward and skipped terminal ones lost it here.
    const siblings = `import { defineWorkflow, z } from "@techery/weft-sdk";
const asker = defineWorkflow(
  { name: "asker", description: "asks", input: z.object({}), output: z.object({ ok: z.boolean() }) },
  async (ctx) => ({ ok: (await ctx.human.approve({ action: "child gate" })).approved }),
);
const boom = defineWorkflow(
  { name: "boom", description: "throws", input: z.object({}), output: z.object({ ok: z.boolean() }) },
  async () => { throw new Error("boom"); },
);
export default defineWorkflow(
  { name: "siblings", description: "one asks, one throws", input: z.object({}), output: z.object({ ok: z.boolean() }) },
  async (ctx) => {
    const [a] = await Promise.all([ctx.workflow(asker, {}), ctx.workflow(boom, {})]);
    return a as { ok: boolean };
  },
);
`;
    await writeWorkflow(cwd, "siblings", siblings);
    const h = await open(cwd, registerPendingRoutes);

    const { def, hash } = await resolveWorkflow(h.weft, "siblings");
    const handle = await h.weft.engine.start(def, {
      input: {},
      cwd,
      ...(hash !== undefined ? { defHash: hash } : {}),
    });
    await handle.outcome().catch(() => undefined);
    await expect.poll(async () => (await h.weft.engine.state(handle.runId)).status).toBe("failed");

    const body = (await (await h.app.request("/api/pending")).json()) as {
      pending: Array<{ runId: string; rootRunId: string; workflow: string; rootWorkflow: string }>;
      unreadable: unknown[];
    };
    expect(body.pending).toHaveLength(1);
    const entry = body.pending[0]!;
    // The child owns the question; the terminal root is still what a queue groups by.
    expect(entry.workflow).toBe("asker");
    expect(entry.runId).not.toBe(handle.runId);
    expect(entry.rootRunId).toBe(handle.runId);
    expect(entry.rootWorkflow).toBe("siblings");
    expect(body.unreadable).toEqual([]);
  });
});

describe("regression: an unreadable journal must not blank the queue", () => {
  it("returns what it could read and names what it could not", async () => {
    const cwd = await repo();
    const h = await open(cwd, registerPendingRoutes);
    const readable = await seedGated(h.weft, cwd);
    const broken = await seedGated(h.weft, cwd);

    // Unreadable, not corrupt: the store's own list() drops a run whose journal is
    // damaged, so corruption never reaches this route. A permission fault does — the run
    // is still listed and only the fold fails.
    const journal = path.join(cwd, ".weft", "runs", broken, "journal.jsonl");
    await chmod(journal, 0o000);
    try {
      const res = await h.app.request("/api/pending");
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        pending: Array<{ runId: string }>;
        unreadable: Array<{ runId: string; error: string }>;
      };
      // The healthy run's question survives, and the fault is named rather than hidden
      // behind an empty list that reads as "nothing is waiting on you".
      expect(body.pending.map((p) => p.runId)).toEqual([readable]);
      expect(body.unreadable.map((u) => u.runId)).toEqual([broken]);
      expect(body.unreadable[0]!.error).toContain("EACCES");
    } finally {
      // Readable again, or the suite's own cleanup cannot remove the directory.
      await chmod(journal, 0o600);
    }
  });
});

describe("regression: diff content that looks like a header", () => {
  it("counts in-hunk lines starting with -- or ++ as content, not as file headers", () => {
    // What git actually emits for a removed `-- drop me` and an added `++ plus line`.
    const diff = [
      "diff --git a/q.sql b/q.sql",
      "index 1111111..2222222 100644",
      "--- a/q.sql",
      "+++ b/q.sql",
      "@@ -1,3 +1,2 @@",
      " select 1;",
      "--- drop me",
      "-select 2;",
      "+select 3;",
      "diff --git a/fixture.patch b/fixture.patch",
      "new file mode 100644",
      "--- /dev/null",
      "+++ b/fixture.patch",
      "@@ -0,0 +1,2 @@",
      "+++ plus line",
      "+tail",
    ].join("\n");
    expect(parseDiffStats(diff)).toEqual([
      { path: "q.sql", adds: 1, dels: 2, status: "modified" },
      // The path must be the file, never the content line's own text.
      { path: "fixture.patch", adds: 2, dels: 0, status: "added" },
    ]);
  });

  it("reads a C-quoted path so it matches the journal's own file list", () => {
    const diff = [
      'diff --git "a/caf\\303\\251.ts" "b/caf\\303\\251.ts"',
      "index 1111111..2222222 100644",
      '--- "a/caf\\303\\251.ts"',
      '+++ "b/caf\\303\\251.ts"',
      "@@ -1 +1 @@",
      "-old",
      "+new",
      'diff --git "a/qu\\"ote.txt" "b/qu\\"ote.txt"',
      '--- "a/qu\\"ote.txt"',
      '+++ "b/qu\\"ote.txt"',
      "@@ -0,0 +1 @@",
      "+x",
    ].join("\n");
    expect(parseDiffStats(diff).map((f) => f.path)).toEqual(["café.ts", 'qu"ote.txt']);
  });

  it("strips whatever prefix git was configured to use, not just a/ and b/", () => {
    // What `diff.mnemonicPrefix = true` emits.
    const diff = [
      "diff --git c/s.txt i/s.txt",
      "index 1111111..2222222 100644",
      "--- c/s.txt",
      "+++ i/s.txt",
      "@@ -1 +1 @@",
      "-a",
      "+b",
    ].join("\n");
    expect(parseDiffStats(diff)).toEqual([{ path: "s.txt", adds: 1, dels: 1, status: "modified" }]);
  });

  it("ignores the no-newline marker and survives CRLF", () => {
    const diff = [
      "diff --git a/x.txt b/x.txt",
      "--- a/x.txt",
      "+++ b/x.txt",
      "@@ -1 +1 @@",
      "-one",
      "\\ No newline at end of file",
      "+two",
      "\\ No newline at end of file",
    ].join("\r\n");
    expect(parseDiffStats(diff)).toEqual([{ path: "x.txt", adds: 1, dels: 1, status: "modified" }]);
  });
});
