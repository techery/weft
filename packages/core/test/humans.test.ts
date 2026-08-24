import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import type { JournalRecord } from "@techery/weft-core";
import { defineWorkflow, z } from "@techery/weft-sdk";
import { afterAll, describe, expect, test } from "vitest";
import { cleanupRepos, tempDir, tempRepo, testEngine } from "./helpers.ts";

afterAll(cleanupRepos);

async function records(journal: { read(runId: string): AsyncIterable<JournalRecord> }, runId: string) {
  const out: JournalRecord[] = [];
  for await (const rec of journal.read(runId)) out.push(rec);
  return out;
}

describe("human review, confirm tokens, escalation", () => {
  test("human.review stores the artifact as a blob and returns the typed verdict", async () => {
    const t = testEngine();
    const report = "# Findings\n\n1. off-by-one in auth loop\n";
    const def = defineWorkflow(
      { description: "review", input: z.object({}), output: z.object({ verdict: z.string() }) },
      async (ctx) => {
        const fb = await ctx.human.review({
          artifact: report,
          schema: z.object({ verdict: z.enum(["ship", "revise"]), notes: z.string() }),
        });
        return { verdict: fb.verdict };
      },
    );
    const handle = await t.engine.start(def, { input: {}, cwd: await tempDir() });
    const outcome = await handle.outcome();
    if (outcome.status !== "waiting_for_human") throw new Error("expected review request");
    expect(outcome.pending[0]!.kind).toBe("review");
    // the artifact is journaled as a blob reference and retrievable
    const recs = await records(t.journal, handle.runId);
    const req = recs.find((r) => r.ev.type === "human.requested")?.ev;
    if (req?.type !== "human.requested") throw new Error("missing request");
    expect(req.artifactRef).toBeDefined();
    expect(await t.blobs.getText(req.artifactRef!.$blob)).toBe(report);
    await t.engine.answer(handle.runId, outcome.pending[0]!.id, { verdict: "ship", notes: "looks right" });
    expect(await handle.result).toEqual({ verdict: "ship" });
  });

  test("irreversible gate requires the typed confirm token; a mismatch denies", async () => {
    const t = testEngine();
    const def = defineWorkflow(
      { description: "irrev", input: z.object({}), output: z.object({ approved: z.boolean() }) },
      async (ctx) => {
        const go = await ctx.gate({ action: "git.push --force origin/main", risk: "irreversible" });
        return { approved: go.approved };
      },
    );
    const handle = await t.engine.start(def, { input: {}, cwd: await tempDir() });
    const outcome = await handle.outcome();
    if (outcome.status !== "waiting_for_human") throw new Error("expected confirm request");
    const pending = outcome.pending[0]!;
    expect(pending.kind).toBe("confirm");
    expect(pending.confirmToken).toMatch(/^confirm:/);
    // wrong token → approved but unconfirmed → treated as denied
    await t.engine.answer(handle.runId, pending.id, { approved: true, confirm: "confirm:wrong" });
    expect(await handle.result).toEqual({ approved: false });
  });

  test("irreversible gate with the exact token approves", async () => {
    const t = testEngine();
    const def = defineWorkflow(
      { description: "irrev2", input: z.object({}), output: z.object({ approved: z.boolean() }) },
      async (ctx) => {
        const go = await ctx.gate({ action: "git.push --force origin/main", risk: "irreversible" });
        return { approved: go.approved };
      },
    );
    const handle = await t.engine.start(def, { input: {}, cwd: await tempDir() });
    const outcome = await handle.outcome();
    if (outcome.status !== "waiting_for_human") throw new Error("expected confirm request");
    await t.engine.answer(handle.runId, outcome.pending[0]!.id, {
      approved: true,
      confirm: outcome.pending[0]!.confirmToken!,
    });
    expect(await handle.result).toEqual({ approved: true });
  });

  test("onTimeout: 'escalate' keeps the request pending past its deadline", async () => {
    const t = testEngine();
    const def = defineWorkflow(
      { description: "esc", input: z.object({}), output: z.object({ ok: z.boolean() }) },
      async (ctx) => {
        const r = await ctx.human.approve({ action: "risky", timeout: 40, onTimeout: "escalate" });
        return { ok: r.approved };
      },
    );
    const handle = await t.engine.start(def, { input: {}, cwd: await tempDir() });
    const outcome = await handle.outcome();
    if (outcome.status !== "waiting_for_human") throw new Error("expected suspension");
    await new Promise((r) => setTimeout(r, 120));
    // still pending after the deadline; the escalation was logged
    expect(await t.engine.pending(handle.runId)).toHaveLength(1);
    const state = await t.engine.state(handle.runId);
    expect(state.logs.some((l) => l.includes("escalated"))).toBe(true);
    await t.engine.answer(handle.runId, outcome.pending[0]!.id, { approved: true });
    expect(await handle.result).toEqual({ ok: true });
  });

  test("onTimeout: 'deny' on an ask throws human_timeout inside the workflow", async () => {
    const t = testEngine();
    const def = defineWorkflow(
      { description: "deny", input: z.object({}), output: z.object({ fell_back: z.boolean() }) },
      async (ctx) => {
        try {
          await ctx.human.ask({
            question: "pick",
            schema: z.object({ v: z.string() }),
            timeout: 30,
            onTimeout: "deny",
          });
          return { fell_back: false };
        } catch (err) {
          if ((err as { code?: string }).code === "human_timeout") return { fell_back: true };
          throw err;
        }
      },
    );
    const handle = await t.engine.start(def, { input: {}, cwd: await tempDir() });
    expect(await handle.result).toEqual({ fell_back: true });
  });
});

describe("integrate conflict resolutions via ask", () => {
  async function conflictRun(resolution: "skip" | "keep-conflicts") {
    const t = testEngine();
    t.builder.on({ key: "fix:1" }, { summary: "one" }, { writes: { "shared.txt": "agent one\n" } });
    t.builder.on({ key: "fix:2" }, { summary: "two" }, { writes: { "shared.txt": "agent two\n" } });
    const cwd = await tempRepo({ "shared.txt": "base\n" });
    const FixResult = z.object({ summary: z.string() });
    const def = defineWorkflow(
      {
        description: "conflict-ask",
        input: z.object({}),
        output: z.object({
          merged: z.array(z.string()),
          skipped: z.array(z.string()),
          conflicts: z.array(z.string()),
        }),
      },
      async (ctx) => {
        const fixes = ctx.ok(
          await ctx.parallel([
            ctx.agent.detailed("one", { schema: FixResult, key: "fix:1", write: { paths: ["shared.txt"] } }),
            ctx.agent.detailed("two", { schema: FixResult, key: "fix:2", write: { paths: ["shared.txt"] } }),
          ]),
        );
        const ledger = await ctx.integrate(fixes, { onConflict: "ask" });
        return { merged: ledger.merged, skipped: ledger.skipped, conflicts: ledger.conflicts };
      },
    );
    const handle = await t.engine.start(def, { input: {}, cwd });
    const outcome = await handle.outcome();
    if (outcome.status !== "waiting_for_human") throw new Error("expected conflict ask");
    expect(outcome.pending[0]!.question).toContain("conflicts on");
    await t.engine.answer(handle.runId, outcome.pending[0]!.id, { resolution });
    return { handle, cwd, t };
  }

  test("skip drops the conflicting patch and restores the tree", async () => {
    const { handle, cwd } = await conflictRun("skip");
    const out = (await handle.result) as { merged: string[]; skipped: string[] };
    expect(out.merged).toEqual(["fix:1"]);
    expect(out.skipped).toEqual(["fix:2"]);
    expect(await readFile(join(cwd, "shared.txt"), "utf8")).toBe("agent one\n");
  });

  test("keep-conflicts keeps the tree state and flags the patch as conflicted", async () => {
    const { handle, t } = await conflictRun("keep-conflicts");
    const out = (await handle.result) as { merged: string[]; conflicts: string[] };
    expect(out.merged).toEqual(["fix:1"]);
    expect(out.conflicts).toEqual(["fix:2"]);
    const recs = await records(t.journal, handle.runId);
    const merged = recs.filter((r) => r.ev.type === "patch.merged");
    expect(merged.some((r) => r.ev.type === "patch.merged" && r.ev.key === "fix:2" && r.ev.conflicted)).toBe(
      true,
    );
  });
});

describe("fetch happy path", () => {
  test("fetch returns status/headers/body; schema validates 2xx JSON", async () => {
    const server = createServer((req, res) => {
      if (req.url === "/issues") {
        res.writeHead(200, { "content-type": "application/json", "x-weft": "yes" });
        res.end(JSON.stringify([{ id: 1, title: "bug" }]));
      } else {
        res.writeHead(404);
        res.end("nope");
      }
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as { port: number }).port;
    try {
      const t = testEngine();
      const def = defineWorkflow(
        {
          description: "fetch",
          input: z.object({}),
          output: z.object({ title: z.string(), missStatus: z.number() }),
        },
        async (ctx) => {
          const issues = await ctx.fetch(`http://127.0.0.1:${port}/issues`, {
            schema: z.array(z.object({ id: z.number(), title: z.string() })),
          });
          const miss = await ctx.fetch(`http://127.0.0.1:${port}/missing`);
          // non-2xx does NOT throw without a schema
          return { title: issues[0]!.title, missStatus: miss.status };
        },
      );
      const handle = await t.engine.start(def, { input: {}, cwd: await tempDir() });
      expect(await handle.result).toEqual({ title: "bug", missStatus: 404 });
    } finally {
      server.close();
    }
  });
});
