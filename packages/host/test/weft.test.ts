import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  createWeft,
  inlineDefOf,
  isWorkflowPathRef,
  loadWorkflow,
  persistedDefOf,
  persistInlineScript,
  persistWorkflowRef,
  resolveWorkflow,
  type Weft,
} from "../src/index.ts";
import { cleanupRoots, HELLO_WORKFLOW, tempRoot, write } from "./helpers.ts";

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
  it("persists an inline script with its run and reconstructs it for a later resume", async () => {
    const { weft } = await mockWeft();
    const source = `import { defineWorkflow, z } from "@weft/sdk";
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
      `import { defineWorkflow, z } from "@weft/sdk";
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
    expect(persisted?.meta.description).toBe("path gate");
    if (persisted === undefined) throw new Error("path ref not reconstructed");
    const resumed = await weft.engine.resume(run.runId, { def: persisted });
    const again = await resumed.outcome();
    if (again.status !== "waiting_for_human") throw new Error("expected suspension again");
    await weft.engine.answer(run.runId, again.pending[0]!.id, { approved: true });
    expect(await resumed.result).toEqual({ ok: true });
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

  it("routes agent steps to one shared mock builder in mock mode", async () => {
    const { weft, root } = await mockWeft();
    await write(
      root,
      ".weft/workflows/verdict.ts",
      `import { defineWorkflow, z } from "@weft/sdk";

      export default defineWorkflow(
        {
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
    weft.mockBuilder?.on({ key: "verdict" }, { verdict: "fine" });

    const { def } = await resolveWorkflow(weft, "verdict");
    const run = await weft.engine.start(def, { input: {}, cwd: weft.cwd });
    await expect(run.result).resolves.toEqual({ verdict: "fine" });
    expect(weft.mockBuilder?.calls.map((c) => c.key)).toEqual(["verdict"]);
  });

  it("gives the engine the registry, so sub-workflows resolve by name", async () => {
    const { weft, root } = await mockWeft();
    await write(
      root,
      ".weft/workflows/caller.ts",
      `import { defineWorkflow, z } from "@weft/sdk";

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
