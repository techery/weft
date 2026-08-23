import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { JournalRecord } from "@weft/core";
import { defineWorkflow, z } from "@weft/sdk";
import { afterAll, describe, expect, test } from "vitest";
import { cleanupRepos, tempRepo, testEngine } from "./helpers.ts";

afterAll(cleanupRepos);

async function records(journal: { read(runId: string): AsyncIterable<JournalRecord> }, runId: string) {
  const out: JournalRecord[] = [];
  for await (const rec of journal.read(runId)) out.push(rec);
  return out;
}

const FixResult = z.object({ summary: z.string() });

describe("write steps, patches, integration", () => {
  test("a write step edits in its own worktree; integrate lands the patch on the tree", async () => {
    const t = testEngine();
    t.builder.on(
      { key: "fix:auth" },
      { summary: "bounded the loop" },
      {
        writes: { "src/auth.ts": "export const fixed = true;\n" },
      },
    );
    const cwd = await tempRepo({ "src/auth.ts": "export const fixed = false;\n" });
    const def = defineWorkflow(
      { description: "fix", input: z.object({}), output: z.object({ merged: z.array(z.string()) }) },
      async (ctx) => {
        const fix = await ctx.agent.detailed("Fix the loop bound", {
          schema: FixResult,
          key: "fix:auth",
          write: { paths: ["src/**"], mode: "warn" },
        });
        expect(fix.patch).toBeDefined();
        expect(fix.files).toEqual(["src/auth.ts"]);
        // the integration tree is untouched until integrate()
        const before = await ctx.fs.read("src/auth.ts");
        expect(before.content).toContain("false");
        const ledger = await ctx.integrate([fix]);
        return { merged: ledger.merged };
      },
    );
    const handle = await t.engine.start(def, { input: {}, cwd });
    expect(await handle.result).toEqual({ merged: ["fix:auth"] });
    expect(await readFile(join(cwd, "src/auth.ts"), "utf8")).toContain("true");
    const recs = await records(t.journal, handle.runId);
    expect(recs.some((r) => r.ev.type === "patch.captured")).toBe(true);
    expect(recs.some((r) => r.ev.type === "patch.merged")).toBe(true);
    // write-scope prompt lines reached the agent
    expect(t.builder.calls[0]!.prompt).toContain("Write scope");
    expect(t.builder.calls[0]!.prompt).toContain("src/**");
  });

  test("warn mode: out-of-scope edit is flagged but the patch still lands", async () => {
    const t = testEngine();
    t.builder.on(
      { key: "fix:api" },
      { summary: "did too much" },
      {
        writes: { "src/api.ts": "api\n", "docs/notes.md": "oops\n" },
      },
    );
    const cwd = await tempRepo({ "src/api.ts": "old\n" });
    const def = defineWorkflow(
      { description: "warn", input: z.object({}), output: z.object({ merged: z.number() }) },
      async (ctx) => {
        const fix = await ctx.agent.detailed("fix", {
          schema: FixResult,
          key: "fix:api",
          write: { paths: ["src/**"], mode: "warn" },
        });
        expect(fix.patch?.outOfScope).toEqual(["docs/notes.md"]);
        expect(fix.patch?.quarantined).toBeUndefined();
        const ledger = await ctx.integrate([fix]);
        return { merged: ledger.merged.length };
      },
    );
    const handle = await t.engine.start(def, { input: {}, cwd });
    expect(await handle.result).toEqual({ merged: 1 });
    expect(await readFile(join(cwd, "docs/notes.md"), "utf8")).toBe("oops\n");
    const recs = await records(t.journal, handle.runId);
    const violation = recs.find((r) => r.ev.type === "scope.violation")?.ev;
    expect(violation).toMatchObject({ files: ["docs/notes.md"], mode: "warn" });
  });

  test("strict mode quarantines the patch; integrate refuses it; discard clears it", async () => {
    const t = testEngine();
    t.builder.on(
      { key: "fix:db" },
      { summary: "overreached" },
      {
        writes: { "src/db.ts": "db\n", "src/auth.ts": "poked\n" },
      },
    );
    const cwd = await tempRepo({ "src/db.ts": "old\n", "src/auth.ts": "auth\n" });
    const def = defineWorkflow(
      { description: "strict", input: z.object({}), output: z.object({ quarantined: z.number() }) },
      async (ctx) => {
        const fix = await ctx.agent.detailed("fix", {
          schema: FixResult,
          key: "fix:db",
          write: { paths: ["src/db.ts"], mode: "strict" },
        });
        expect(fix.patch?.quarantined).toBe(true);
        const ledger = await ctx.integrate([fix]);
        expect(ledger.quarantined).toEqual(["fix:db"]);
        await ctx.discard([fix]);
        return { quarantined: ledger.quarantined.length };
      },
    );
    const handle = await t.engine.start(def, { input: {}, cwd });
    expect(await handle.result).toEqual({ quarantined: 1 });
    // quarantined patch never touched the integration tree
    expect(await readFile(join(cwd, "src/auth.ts"), "utf8")).toBe("auth\n");
  });

  test("a run ending with an un-integrated patch fails with the documented error", async () => {
    const t = testEngine();
    t.builder.on({ key: "fix:x" }, { summary: "s" }, { writes: { "a.txt": "x\n" } });
    const cwd = await tempRepo({ "a.txt": "a\n" });
    const def = defineWorkflow(
      { description: "dangling", input: z.object({}), output: z.object({}) },
      async (ctx) => {
        await ctx.agent.detailed("fix", { schema: FixResult, key: "fix:x", write: { paths: ["a.txt"] } });
        return {};
      },
    );
    const handle = await t.engine.start(def, { input: {}, cwd });
    await expect(handle.result).rejects.toMatchObject({
      code: "unintegrated_patches",
      message: expect.stringContaining("fix:x"),
    });
  });

  test("conflicting patch with onConflict: 'fail' throws and restores the tree", async () => {
    const t = testEngine();
    t.builder.on({ key: "fix:1" }, { summary: "one" }, { writes: { "shared.txt": "agent one\n" } });
    t.builder.on({ key: "fix:2" }, { summary: "two" }, { writes: { "shared.txt": "agent two\n" } });
    const cwd = await tempRepo({ "shared.txt": "base\n" });
    const def = defineWorkflow(
      { description: "conflict", input: z.object({}), output: z.object({}) },
      async (ctx) => {
        const fixes = ctx.ok(
          await ctx.parallel([
            ctx.agent.detailed("one", { schema: FixResult, key: "fix:1", write: { paths: ["shared.txt"] } }),
            ctx.agent.detailed("two", { schema: FixResult, key: "fix:2", write: { paths: ["shared.txt"] } }),
          ]),
        );
        await ctx.integrate(fixes, { onConflict: "fail" });
        return {};
      },
    );
    const handle = await t.engine.start(def, { input: {}, cwd });
    await expect(handle.result).rejects.toMatchObject({ code: "conflict" });
    // first patch landed, then the conflicting one was rolled back
    expect(await readFile(join(cwd, "shared.txt"), "utf8")).toBe("agent one\n");
  });
});

describe("side-effect steps", () => {
  test("exec returns exitCode/stdout/stderr; schema parses JSON stdout regardless of exit code", async () => {
    const t = testEngine();
    const cwd = await tempRepo();
    const def = defineWorkflow(
      {
        description: "exec",
        input: z.object({}),
        output: z.object({ failedTests: z.number(), code: z.number() }),
      },
      async (ctx) => {
        const plain = await ctx.exec("node", ["-e", "console.error('warn'); console.log('out')"]);
        expect(plain).toMatchObject({
          exitCode: 0,
          stdout: expect.stringContaining("out"),
          stderr: expect.stringContaining("warn"),
        });
        const typed = await ctx.exec(
          "node",
          ["-e", `console.log(JSON.stringify({ failed: 2 })); process.exit(1)`],
          { schema: z.object({ failed: z.number() }) },
        );
        return { failedTests: typed.failed, code: plain.exitCode };
      },
    );
    const handle = await t.engine.start(def, { input: {}, cwd });
    expect(await handle.result).toEqual({ failedTests: 2, code: 0 });
  });

  test("bash runs through a shell (pipes work)", async () => {
    const t = testEngine();
    const cwd = await tempRepo();
    const def = defineWorkflow(
      { description: "bash", input: z.object({}), output: z.object({ out: z.string() }) },
      async (ctx) => {
        const r = await ctx.bash("printf 'a\\nb\\nc\\n' | head -2 | tail -1");
        return { out: r.stdout.trim() };
      },
    );
    const handle = await t.engine.start(def, { input: {}, cwd });
    expect(await handle.result).toEqual({ out: "b" });
  });

  test("secrets resolve engine-side and never reach the journal", async () => {
    process.env.WEFT_TEST_SECRET = "hunter2";
    const t = testEngine();
    const cwd = await tempRepo();
    const def = defineWorkflow(
      { description: "secret", input: z.object({}), output: z.object({ leaked: z.boolean() }) },
      async (ctx) => {
        const r = await ctx.exec("node", ["-e", "console.log((process.env.MY_TOKEN ?? '').length)"], {
          env: { MY_TOKEN: ctx.secret("WEFT_TEST_SECRET") },
        });
        return { leaked: r.stdout.trim() !== "7" };
      },
    );
    const handle = await t.engine.start(def, { input: {}, cwd });
    expect(await handle.result).toEqual({ leaked: false }); // the process saw the real value
    const raw = JSON.stringify(await records(t.journal, handle.runId));
    expect(raw).not.toContain("hunter2");
    expect(raw).toContain("<redacted:WEFT_TEST_SECRET>");
    delete process.env.WEFT_TEST_SECRET;
  });

  test("fs.read/glob/stat are journaled steps with hashes", async () => {
    const t = testEngine();
    const cwd = await tempRepo({ "src/a.ts": "aaa\n", "src/b.ts": "bbb\n", "README.md": "r\n" });
    const def = defineWorkflow(
      {
        description: "fs",
        input: z.object({}),
        output: z.object({ n: z.number(), sha: z.string(), missing: z.boolean() }),
      },
      async (ctx) => {
        const { paths } = await ctx.fs.glob("src/**/*.ts");
        const { sha256 } = await ctx.fs.read("src/a.ts");
        const stat = await ctx.fs.stat("nope.txt");
        return { n: paths.length, sha: sha256, missing: !stat.exists };
      },
    );
    const handle = await t.engine.start(def, { input: {}, cwd });
    const out = (await handle.result) as { n: number; sha: string; missing: boolean };
    expect(out.n).toBe(2);
    expect(out.sha).toMatch(/^[0-9a-f]{64}$/);
    expect(out.missing).toBe(true);
  });

  test("fetch: allow-list denies unlisted hosts before any network call", async () => {
    const t = testEngine({ config: { fetchAllow: ["api.example.com"] } });
    const cwd = await tempRepo();
    const def = defineWorkflow(
      { description: "fetch", input: z.object({}), output: z.object({}) },
      async (ctx) => {
        await ctx.fetch("https://evil.example.net/data");
        return {};
      },
    );
    const handle = await t.engine.start(def, { input: {}, cwd });
    await expect(handle.result).rejects.toMatchObject({ code: "fetch_denied" });
  });

  test("large step outputs are offloaded to the blob store transparently", async () => {
    const t = testEngine({ config: { limits: { blobThresholdBytes: 512 } } });
    const cwd = await tempRepo();
    const big = "x".repeat(4_000);
    const def = defineWorkflow(
      { description: "blob", input: z.object({}), output: z.object({ len: z.number() }) },
      async (ctx) => {
        const r = await ctx.bash(`printf '%s' '${big}'`);
        return { len: r.stdout.length };
      },
    );
    const handle = await t.engine.start(def, { input: {}, cwd });
    expect(await handle.result).toEqual({ len: 4_000 });
    const recs = await records(t.journal, handle.runId);
    const completed = recs.find((r) => r.ev.type === "step.completed" && r.ev.seq === 1)?.ev;
    if (completed?.type !== "step.completed") throw new Error("missing completion");
    expect((completed.output as { $outputBlob?: string }).$outputBlob).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("ctx.git steps", () => {
  test("reads are journaled; low-tier writes auto-approve; resume serves them", async () => {
    const t = testEngine();
    const cwd = await tempRepo({ "file.txt": "one\n" });
    const def = defineWorkflow(
      {
        name: "gitty",
        description: "git",
        input: z.object({}),
        output: z.object({ branch: z.string(), sha: z.string() }),
      },
      async (ctx) => {
        const status = await ctx.git.status();
        expect(status.clean).toBe(true);
        await ctx.git.branch.create("weft/test", { checkout: true });
        await ctx.bash("echo two >> file.txt");
        await ctx.git.add({ paths: ["file.txt"] });
        const { sha } = await ctx.git.commit({ message: "second line" });
        const { branch } = await ctx.git.status();
        return { branch, sha };
      },
    );
    const handle = await t.engine.start(def, { input: {}, cwd });
    const out = (await handle.result) as { branch: string; sha: string };
    expect(out.branch).toBe("weft/test");
    const recs = await records(t.journal, handle.runId);
    // both writes were policy-approved gates
    const gates = recs.filter((r) => r.ev.type === "human.answered");
    expect(gates.length).toBe(3);
    expect(gates.every((g) => g.ev.type === "human.answered" && g.ev.answeredBy === "policy")).toBe(true);
  });

  test("high-tier git write asks; denial throws gate_denied", async () => {
    const t = testEngine();
    const cwd = await tempRepo();
    const def = defineWorkflow(
      { description: "push", input: z.object({}), output: z.object({ pushed: z.boolean() }) },
      async (ctx) => {
        try {
          await ctx.git.push({ branch: "main" });
          return { pushed: true };
        } catch (err) {
          if ((err as { code?: string }).code === "gate_denied") return { pushed: false };
          throw err;
        }
      },
    );
    const handle = await t.engine.start(def, { input: {}, cwd });
    const outcome = await handle.outcome();
    if (outcome.status !== "waiting_for_human") throw new Error(`expected ask, got ${outcome.status}`);
    expect(outcome.pending[0]!.risk).toBe("high");
    await t.engine.answer(handle.runId, outcome.pending[0]!.id, { approved: false, note: "not today" });
    expect(await handle.result).toEqual({ pushed: false });
  });

  test("changedSince flows into a review fan-out (the quickstart shape)", async () => {
    const t = testEngine();
    t.builder.on({ key: "review:*" }, (req) => ({
      findings: [{ file: req.key!.split(":")[1]!, line: 1, claim: "meh" }],
    }));
    const cwd = await tempRepo({ "src/a.ts": "a\n", "src/b.ts": "b\n" });
    // create changes on a branch vs main
    const { execa } = await import("execa");
    await execa("git", ["checkout", "-b", "feature"], { cwd });
    await execa(
      "bash",
      ["-c", "echo changed >> src/a.ts && echo new > src/new.ts && git add -A && git commit -m change"],
      {
        cwd,
      },
    );
    const def = defineWorkflow(
      {
        description: "review",
        input: z.object({ base: z.string().default("main") }),
        output: z.object({ n: z.number() }),
      },
      async (ctx, { base }) => {
        const { files } = await ctx.git.changedSince(base);
        const paths = files.filter((f) => f.status !== "D").map((f) => f.path);
        expect(paths.sort()).toEqual(["src/a.ts", "src/new.ts"]);
        const found = ctx.ok(
          await ctx.parallel(
            paths.map((f) =>
              ctx.agent(`Review ${f}`, {
                schema: z.object({
                  findings: z.array(z.object({ file: z.string(), line: z.number(), claim: z.string() })),
                }),
                key: `review:${f}`,
              }),
            ),
          ),
        );
        return { n: found.flatMap((r) => r.findings).length };
      },
    );
    const handle = await t.engine.start(def, { input: {}, cwd });
    expect(await handle.result).toEqual({ n: 2 });
  });
});
