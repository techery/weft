import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { mockTaskEnvelope } from "@techery/weft-provider-mock";
import { defineWorkflow, z } from "@techery/weft-sdk";
import { afterAll, describe, expect, it } from "vitest";
import {
  createWeft,
  inlineDefOf,
  isWorkflowPathRef,
  loadConfig,
  loadWorkflow,
  persistedDefOf,
  persistInlineScript,
  persistWorkflowRef,
  resolveWorkflow,
  resumeOptions,
  type Weft,
} from "../src/index.ts";
import { cleanupRoots, HELLO_WORKFLOW, tempRoot, write } from "./helpers.ts";

const execFileAsync = promisify(execFile);

const opened: Weft[] = [];

afterAll(async () => {
  await Promise.all(opened.map((weft) => weft.close()));
  await cleanupRoots();
});

interface JournalLine {
  ev: { type: string; workflow?: { name?: string; defHash?: string } };
}

async function readJournal(runDir: string): Promise<JournalLine[]> {
  const raw = await readFile(path.join(runDir, "journal.jsonl"), "utf8");
  return raw
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as JournalLine);
}

/** A repo root with `.weft/workflows/hello.ts` and a mock-wired engine over it. */
async function mockWeft(): Promise<{ weft: Weft; root: string }> {
  const root = await tempRoot();
  await write(root, ".weft/workflows/hello.ts", HELLO_WORKFLOW);
  const weft = await createWeft({ cwd: root, providers: "mock" });
  opened.push(weft);
  return { weft, root };
}

describe("createWeft", () => {
  it("marks the durable task root as protected provider storage", async () => {
    const { weft, root } = await mockWeft();
    expect(weft.engine.taskTracker?.protectedPaths).toEqual([path.join(root, ".weft", "tasks")]);
  });

  it("persists an inline script with its run and reconstructs it for a later resume", async () => {
    const { weft } = await mockWeft();
    const source = `import { defineWorkflow, z } from "@techery/weft-sdk";
export default defineWorkflow(
  { description: "inline gate", input: z.object({}), output: z.object({ ok: z.boolean() }) },
  async (ctx) => {
    const go = await ctx.human.approve({ action: "ship?" });
    return { ok: go.approved };
  },
);
`;
    const loaded = await loadWorkflow({ source, cwd: weft.cwd });
    const run = await weft.engine.start(loaded.def, { input: {}, cwd: weft.cwd });
    const outcome = await run.outcome();
    if (outcome.status !== "waiting_for_human") throw new Error("expected suspension");
    // What `weft run -` does: the bundled source rides with the run, then the
    // process goes away.
    await persistInlineScript(weft, run.runId, loaded.code);
    await weft.engine.shutdown();

    // A later process has no registry entry for the inline script — only script.ts.
    const def = await inlineDefOf(weft, run.runId);
    expect(def?.meta.description).toBe("inline gate");
    if (def === undefined) throw new Error("inline definition not reconstructed");
    const resumed = await weft.engine.resume(run.runId, { def });
    const again = await resumed.outcome();
    if (again.status !== "waiting_for_human") throw new Error("expected suspension again");
    await weft.engine.answer(run.runId, again.pending[0]!.id, { approved: true });
    expect(await resumed.result).toEqual({ ok: true });

    // Registry runs persist nothing; the fallback stays quiet for them.
    expect(await inlineDefOf(weft, "no-such-run")).toBeUndefined();
  });

  it("records a path ref with its run and re-resolves it for a later resume", async () => {
    const { weft, root } = await mockWeft();
    // A workflow FILE outside the registry: only its recorded ref can find it later.
    await write(
      root,
      "flows/gate.ts",
      `import { defineWorkflow, z } from "@techery/weft-sdk";
export default defineWorkflow(
  { description: "path gate", input: z.object({}), output: z.object({ ok: z.boolean() }) },
  async (ctx) => {
    const go = await ctx.human.approve({ action: "ship?" });
    return { ok: go.approved };
  },
);
`,
    );
    const { def } = await resolveWorkflow(weft, "./flows/gate.ts");
    const run = await weft.engine.start(def, { input: {}, cwd: weft.cwd });
    const outcome = await run.outcome();
    if (outcome.status !== "waiting_for_human") throw new Error("expected suspension");
    expect(isWorkflowPathRef("./flows/gate.ts")).toBe(true);
    await persistWorkflowRef(weft, run.runId, "./flows/gate.ts");
    await weft.engine.shutdown();

    // A later process re-resolves the recorded path — no registry entry involved.
    const persisted = await persistedDefOf(weft, run.runId);
    expect(persisted?.def.meta.description).toBe("path gate");
    if (persisted === undefined) throw new Error("path ref not reconstructed");
    // The bundle hash travels with the definition: it is the only stamp that catches an
    // edit inside a module the workflow body merely delegates to.
    expect(persisted.hash).toMatch(/^[0-9a-f]{16,}$/);
    const resumed = await weft.engine.resume(run.runId, resumeOptions(persisted));
    const again = await resumed.outcome();
    if (again.status !== "waiting_for_human") throw new Error("expected suspension again");
    await weft.engine.answer(run.runId, again.pending[0]!.id, { approved: true });
    expect(await resumed.result).toEqual({ ok: true });
  });

  it("binds path workflow task schemas into prompts and durable namespaces", async () => {
    const { weft, root } = await mockWeft();
    await write(
      root,
      "flows/tracked.ts",
      `import { defineWorkflow, z } from "@techery/weft-sdk";
export default defineWorkflow(
  {
    id: "path-tracked",
    description: "path workflow with task extensions",
    input: z.object({}),
    output: z.object({ ok: z.boolean() }),
    tasks: { extensions: z.object({ ownerTeam: z.string() }), semanticRevision: "owner-team-v1" },
  },
  async (ctx) => ctx.agent("Track this", { key: "path-task", schema: z.object({ ok: z.boolean() }) }),
);
`,
    );
    weft.mockBuilder?.on(
      { key: "path-task" },
      mockTaskEnvelope({ ok: true }, [
        {
          op: "create",
          title: "Path task",
          description: "Persist outside the registry",
          extensions: { ownerTeam: "runtime" },
        },
      ]),
    );
    const { def } = await resolveWorkflow(weft, "./flows/tracked.ts");
    const run = await weft.engine.start(def, { input: {}, cwd: weft.cwd });
    await expect(run.result).resolves.toEqual({ ok: true });
    expect(weft.mockBuilder?.calls[0]?.prompt).toContain('"ownerTeam"');
    expect(await weft.tasks.namespace("path-tracked")).toMatchObject({
      id: "path-tracked",
      extensionSchemaDeclared: true,
      extensionSchema: { type: "object", properties: { ownerTeam: { type: "string" } } },
    });
    expect(await weft.tasks.list("path-tracked")).toEqual([
      expect.objectContaining({ extensions: { ownerTeam: "runtime" } }),
    ]);
  });

  it("keeps suspended runs on their exact executable task contract", async () => {
    const { weft } = await mockWeft();
    await weft.tasks.create("concurrent-contract", {
      title: "Normalize",
      description: "Both resident definitions read the same durable input",
      extensions: { source: "API" },
    });
    const workflow = (semanticRevision: string, prefix: string) =>
      defineWorkflow(
        {
          id: "concurrent-contract",
          name: "concurrent-contract",
          description: "exercise concurrent executable task contracts",
          input: z.object({}),
          output: z.object({ normalized: z.string() }),
          tasks: {
            extensions: z
              .object({ source: z.string() })
              .transform(({ source }) => ({ normalized: `${prefix}:${source.toLowerCase()}` })),
            semanticRevision,
          },
        },
        async (ctx) => {
          await ctx.human.approve({ action: `continue ${semanticRevision}` });
          const snapshot = await ctx.tasks.observe({}, { key: "observe-contract" });
          const extensions = snapshot.tasks[0]?.extensions as { normalized: string };
          return { normalized: extensions.normalized };
        },
      );
    const previous = await weft.engine.start(workflow("transform-v1", "previous"), {
      input: {},
      cwd: weft.cwd,
    });
    const previousOutcome = await previous.outcome();
    if (previousOutcome.status !== "waiting_for_human") throw new Error("expected previous suspension");
    const current = await weft.engine.start(workflow("transform-v2", "current"), {
      input: {},
      cwd: weft.cwd,
    });
    const currentOutcome = await current.outcome();
    if (currentOutcome.status !== "waiting_for_human") throw new Error("expected current suspension");

    await weft.engine.answer(current.runId, currentOutcome.pending[0]!.id, { approved: true });
    await expect(current.result).resolves.toEqual({ normalized: "current:api" });
    await weft.engine.answer(previous.runId, previousOutcome.pending[0]!.id, { approved: true });
    await expect(previous.result).resolves.toEqual({ normalized: "previous:api" });
  });

  it("a recorded path ref that no longer resolves SURFACES instead of silently falling back", async () => {
    const { weft } = await mockWeft();
    // The run recorded "./flows/moved.ts", and that file has since moved away.
    // Swallowed, resume() would fall back to a registry lookup by the journaled
    // NAME — possibly a different workflow — so the failure must propagate.
    await persistWorkflowRef(weft, "run-moved", "./flows/moved.ts");
    await expect(persistedDefOf(weft, "run-moved")).rejects.toThrow();
    // ABSENCE of any persisted definition still falls through quietly: that is
    // the normal registry-run case.
    expect(await persistedDefOf(weft, "run-never-persisted")).toBeUndefined();
  });

  it("runs a registry workflow end to end and leaves the run on disk", async () => {
    const { weft, root } = await mockWeft();

    expect(weft.weftDir).toBe(path.join(root, ".weft"));
    expect(weft.runsDir).toBe(path.join(root, ".weft", "runs"));

    const { def, name, hash } = await resolveWorkflow(weft, "hello");
    expect(name).toBe("hello");
    expect(hash).toMatch(/^[0-9a-f]{64}$/);

    const run = await weft.engine.start(def, {
      input: { name: "weft" },
      cwd: weft.cwd,
      ...(hash !== undefined ? { defHash: hash } : {}),
    });
    const output = (await run.result) as { greeting: string; at: number };

    expect(output.greeting).toBe("hello weft");
    expect(output.at).toBeGreaterThan(0);

    const runDir = path.join(weft.runsDir, run.runId);
    expect(existsSync(path.join(runDir, "journal.jsonl"))).toBe(true);
    expect(existsSync(path.join(runDir, "state.json"))).toBe(true);
    expect(existsSync(path.join(runDir, "report.md"))).toBe(true);

    // The journal is the truth: it pins the bundle hash and the name a resume looks up.
    const events = await readJournal(runDir);
    expect(events[0]?.ev.type).toBe("run.created");
    expect(events[0]?.ev.workflow).toMatchObject({ name: "hello", defHash: hash });
    expect(events.some((e) => e.ev.type === "run.completed")).toBe(true);

    const state = JSON.parse(await readFile(path.join(runDir, "state.json"), "utf8")) as { status: string };
    expect(state.status).toBe("complete");
    await expect(readFile(path.join(runDir, "report.md"), "utf8")).resolves.toContain("hello");
  });

  it("resumes a run in a fresh process by the name it journaled", async () => {
    const { weft, root } = await mockWeft();
    const { def } = await resolveWorkflow(weft, "hello");
    const first = await weft.engine.start(def, { input: { name: "again" }, cwd: weft.cwd });
    const output = await first.result;

    // A second host over the same repo has never seen the file: only the registry can
    // turn the journaled name back into a definition.
    const later = await createWeft({ cwd: root, providers: "mock" });
    opened.push(later);
    const resumed = await later.engine.resume(first.runId);
    await expect(resumed.result).resolves.toEqual(output);
  });

  it("resumes a renamed registry workflow in a fresh process by durable id", async () => {
    const root = await tempRoot();
    const source = (name: string) => `import { defineWorkflow, z } from "@techery/weft-sdk";
export default defineWorkflow(
  {
    id: "durable-renamed-review",
    name: ${JSON.stringify(name)},
    description: "renameable registry workflow",
    input: z.object({}),
    output: z.object({ approved: z.boolean() }),
  },
  async (ctx) => ctx.human.approve({ action: "Continue after rename?" }),
);
`;
    await write(root, ".weft/workflows/review.ts", source("old-review-name"));
    const first = await createWeft({ cwd: root, providers: "mock" });
    opened.push(first);
    const { def } = await resolveWorkflow(first, "old-review-name");
    const run = await first.engine.start(def, { input: {}, cwd: root });
    const outcome = await run.outcome();
    if (outcome.status !== "waiting_for_human") throw new Error("expected suspension");
    await first.engine.shutdown();

    await write(root, ".weft/workflows/review.ts", source("new-review-name"));
    const later = await createWeft({ cwd: root, providers: "mock" });
    opened.push(later);
    await later.engine.answer(run.runId, outcome.pending[0]!.id, { approved: true });
    const resumed = await later.engine.resume(run.runId);

    await expect(resumed.result).resolves.toEqual({ approved: true });
    expect((await later.tasks.namespace("durable-renamed-review"))?.name).toBe("new-review-name");
  });

  it("routes agent steps to one shared mock builder in mock mode", async () => {
    const { weft, root } = await mockWeft();
    await write(
      root,
      ".weft/workflows/verdict.ts",
      `import { defineWorkflow, z } from "@techery/weft-sdk";

      export default defineWorkflow(
        {
          id: "verdict-stable",
          description: "asks one agent for a verdict",
          input: z.object({}),
          output: z.object({ verdict: z.string() }),
        },
        async (ctx) => ctx.agent("Is this fine?", { key: "verdict", schema: z.object({ verdict: z.string() }) }),
      );
      `,
    );

    // The default provider is "claude"; in mock mode the builder answers for it.
    expect(weft.engine.providers.ids().sort()).toEqual(["claude", "codex", "mock"]);
    weft.mockBuilder?.on(
      { key: "verdict" },
      mockTaskEnvelope({ verdict: "fine" }, [
        {
          op: "create",
          title: "Record verdict",
          description: "Carry the verdict into later workflow steps.",
          acceptanceCriteria: ["verdict is journaled"],
        },
      ]),
    );

    const { def } = await resolveWorkflow(weft, "verdict");
    const run = await weft.engine.start(def, { input: {}, cwd: weft.cwd });
    await expect(run.result).resolves.toEqual({ verdict: "fine" });
    expect(weft.mockBuilder?.calls.map((c) => c.key)).toEqual(["verdict"]);
    expect((await weft.tasks.list("verdict-stable")).map((task) => task.title)).toEqual(["Record verdict"]);
    expect(await weft.tasks.namespace("verdict-stable")).toMatchObject({
      id: "verdict-stable",
      name: "verdict",
      extensionSchemaDeclared: false,
    });
    expect(weft.mockBuilder?.calls[0]?.prompt).toContain("Current task summary");

    // Replaying the completed step reapplies the journaled batch through onSettle;
    // TaskStore's batch marker keeps the create exactly-once.
    await weft.engine.shutdown();
    const later = await createWeft({ cwd: root, providers: "mock" });
    opened.push(later);
    const resumed = await later.engine.resume(run.runId, { def });
    await expect(resumed.result).resolves.toEqual({ verdict: "fine" });
    expect(await later.tasks.list("verdict-stable")).toHaveLength(1);
  });

  it("gives the engine the registry, so sub-workflows resolve by name", async () => {
    const { weft, root } = await mockWeft();
    await write(
      root,
      ".weft/workflows/caller.ts",
      `import { defineWorkflow, z } from "@techery/weft-sdk";

      export default defineWorkflow(
        {
          description: "delegates to the hello workflow by name",
          input: z.object({}),
          output: z.object({ greeting: z.string() }),
        },
        async (ctx) => {
          const child = (await ctx.workflow("hello", { name: "sub" })) as { greeting: string };
          return { greeting: child.greeting };
        },
      );
      `,
    );

    const { def } = await resolveWorkflow(weft, "caller");
    const run = await weft.engine.start(def, { input: {}, cwd: weft.cwd });
    await expect(run.result).resolves.toEqual({ greeting: "hello sub" });
  });

  it("honours a configured workflows directory", async () => {
    const root = await tempRoot();
    await write(root, "flows/hello.ts", HELLO_WORKFLOW);
    const weft = await createWeft({ cwd: root, providers: "mock", config: { workflows: { dir: "flows" } } });
    opened.push(weft);
    const { name } = await resolveWorkflow(weft, "hello");
    expect(name).toBe("hello");
  });

  it("registers the real adapters without credentials", async () => {
    const root = await tempRoot();
    const weft = await createWeft({ cwd: root });
    opened.push(weft);
    expect(weft.engine.providers.ids().sort()).toEqual(["claude", "codex", "mock"]);
    expect(weft.engine.providers.get("claude").capabilities().structured).toBe("tool");
    expect(weft.engine.providers.get("codex").capabilities().structured).toBe("native");
  });

  it("loads .weft/config.json when no config is passed", async () => {
    const root = await tempRoot();
    const json = JSON.stringify({ limits: { concurrency: 2 }, defaults: { effort: "low" } });
    await write(root, ".weft/config.json", json);
    const weft = await createWeft({ cwd: root, providers: "mock" });
    opened.push(weft);
    expect(weft.config.limits?.concurrency).toBe(2);
    expect(weft.engine.config.limits.concurrency).toBe(2);
    expect(weft.engine.config.defaults.effort).toBe("low");
  });
});

describe("resolveWorkflow", () => {
  it("resolves a path to a .ts file, relative and absolute", async () => {
    const { weft, root } = await mockWeft();
    const file = await write(root, "flows/standalone.ts", HELLO_WORKFLOW);

    const relative = await resolveWorkflow(weft, "./flows/standalone.ts");
    expect(relative.name).toBe("standalone");
    expect(relative.hash).toMatch(/^[0-9a-f]{64}$/);

    const absolute = await resolveWorkflow(weft, file);
    expect(absolute.hash).toBe(relative.hash);
    expect(absolute.def.meta.description).toContain("greets");
  });

  it("prefers the registry name over a same-named file", async () => {
    const { weft } = await mockWeft();
    const { def } = await resolveWorkflow(weft, "hello");
    const run = await weft.engine.start(def, { input: { name: "by-name" }, cwd: weft.cwd });
    await expect(run.result).resolves.toMatchObject({ greeting: "hello by-name" });
  });

  it("explains an unknown name and lists what is available", async () => {
    const { weft } = await mockWeft();
    const error = await resolveWorkflow(weft, "nope").then(
      () => undefined,
      (err: unknown) => err as Error,
    );
    expect(error?.message).toContain('unknown workflow "nope"');
    expect(error?.message).toContain("available: hello");
  });

  it("explains a path that does not exist", async () => {
    const { weft } = await mockWeft();
    await expect(resolveWorkflow(weft, "./flows/missing.ts")).rejects.toThrow(/no file at .*missing\.ts/);
  });

  it("rejects an empty ref", async () => {
    const { weft } = await mockWeft();
    await expect(resolveWorkflow(weft, "  ")).rejects.toThrow(/workflow ref is empty/);
  });

  it("propagates a gate failure from a file that is not a valid workflow", async () => {
    const { weft, root } = await mockWeft();
    await write(root, "flows/banned.ts", `${HELLO_WORKFLOW}\nconst stamp = Date.now();\n`);
    await expect(resolveWorkflow(weft, "./flows/banned.ts")).rejects.toThrow(/no-date-now/);
  });
});

describe("reindex", () => {
  it("builds a searchable index of the runs on disk", async () => {
    const { weft } = await mockWeft();
    const { def } = await resolveWorkflow(weft, "hello");
    const run = await weft.engine.start(def, { input: { name: "indexed" }, cwd: weft.cwd });
    await run.result;

    const index = await weft.reindex();
    expect(index.search({ text: "hello" }).map((r) => r.runId)).toContain(run.runId);
    expect(index.search({ workflow: "hello" }).map((r) => r.runId)).toContain(run.runId);
    expect(index.stats().runs).toBe(1);
    expect(existsSync(path.join(weft.weftDir, "index.sqlite"))).toBe(true);

    // Same handle on a second call, and it picks up runs added since.
    const second = await weft.engine.start(def, { input: { name: "later" }, cwd: weft.cwd });
    await second.result;
    const again = await weft.reindex();
    expect(again).toBe(index);
    expect(again.stats().runs).toBe(2);
  });
});

describe("config hardening (codex review round 15, PR #1)", () => {
  it("config allowBare entries EXTEND the default bare imports rather than replacing them", async () => {
    const root = await tempRoot();
    await write(root, ".weft/workflows/hello.ts", HELLO_WORKFLOW);
    const weft = await createWeft({
      cwd: root,
      providers: "mock",
      config: { workflows: { allowBare: ["left-pad"] } },
    });
    opened.push(weft);
    // HELLO imports zod: the default allowance must survive the extension.
    const { def } = await resolveWorkflow(weft, "hello");
    expect(def.meta.description).toBeTruthy();
  });

  it("rejects a typo inside a known config section instead of silently ignoring it", async () => {
    const root = await tempRoot();
    // A misspelled limit silently falling back to the default defeats validation.
    await write(root, ".weft/config.json", JSON.stringify({ limits: { stepTimoutMs: 5 } }));
    await expect(loadConfig(root)).rejects.toThrow(/stepTimoutMs|nrecognized/);
    // Top-level unknown keys stay forward-compatible on purpose.
    await write(root, ".weft/config.json", JSON.stringify({ futureSetting: true }));
    await expect(loadConfig(root)).resolves.toBeTruthy();
  });
});

describe("`.weft/` keeps its run state out of the user's git tree", () => {
  it("writes .weft/.gitignore, and never overwrites an existing one", async () => {
    // weft's tree helpers run `git add -A .` on every write-step dispatch and inside
    // every ctx.integrate, so without this the journal and blob store fold into a git
    // object on the first write step and ride into every agent worktree.
    const cwd = await tempRoot();
    const git = (...args: string[]) => execFileAsync("git", args, { cwd });
    await git("init", "-b", "main");

    const weft = await createWeft({ cwd, providers: "mock" });
    await weft.close();

    const file = path.join(cwd, ".weft", ".gitignore");
    const body = await readFile(file, "utf8");
    for (const entry of ["runs/", "blobs/", "tasks/", "index.sqlite"]) {
      expect(body).toContain(entry);
    }
    // workflows/ is source and must stay tracked — check the RULES, not the comments.
    const rules = body
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l !== "" && !l.startsWith("#"));
    expect(rules).not.toContain("workflows/");

    // git agrees: run state is ignored, a workflow is not.
    await write(cwd, ".weft/runs/r1/journal.jsonl", "{}\n");
    await write(cwd, ".weft/workflows/w.ts", "export {};\n");
    // `check-ignore` answers per path; `status` collapses a wholly untracked directory.
    const ignores = async (rel: string): Promise<boolean> =>
      execFileAsync("git", ["check-ignore", "-q", rel], { cwd }).then(
        () => true,
        () => false,
      );
    expect(await ignores(".weft/runs/r1/journal.jsonl")).toBe(true);
    expect(await ignores(".weft/blobs/ab/cd")).toBe(true);
    expect(await ignores(".weft/workflows/w.ts")).toBe(false);

    // A second assembly leaves a user's edited file alone.
    await writeFile(file, "mine\n", "utf8");
    const again = await createWeft({ cwd, providers: "mock" });
    await again.close();
    expect(await readFile(file, "utf8")).toBe("mine\n");
  });
});
