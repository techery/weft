/**
 * The session loop, end to end, over a real MCP transport: a client calls the tools the
 * way Claude Code or Codex would, and every assertion is made against the JSON a session
 * would parse — never against prose.
 */
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterAll, describe, expect, it } from "vitest";
import { createWeftMcpServer, type WeftMcpServer } from "../src/index.ts";

/** No agent, no fs, no clock: `ctx.now` and `ctx.log` are the only side effects. */
const HELLO = `import { defineWorkflow, z } from "@weft/sdk";

export default defineWorkflow(
  {
    name: "hello",
    description: "greets, and stamps the greeting with journaled time",
    input: z.object({ name: z.string() }),
    output: z.object({ greeting: z.string(), at: z.number() }),
  },
  async (ctx, input) => {
    ctx.log(\`greeting \${input.name}\`);
    return { greeting: \`hello \${input.name}\`, at: await ctx.now() };
  },
);
`;

/** Suspends on a person the moment it starts — the shape the MCP bridge exists to carry. */
const GATED = `import { defineWorkflow, z } from "@weft/sdk";

export default defineWorkflow(
  {
    name: "gated",
    description: "asks before it lands anything",
    input: z.object({}),
    output: z.object({ approved: z.boolean(), note: z.string() }),
  },
  async (ctx) => {
    const verdict = await ctx.human.approve({ action: "apply the fixes", detail: "4 files" });
    return { approved: verdict.approved, note: verdict.note ?? "" };
  },
);
`;

/** Alive but unanswerable for a moment: the case a long poll has to hold open. */
const SLEEPY = `import { defineWorkflow, z } from "@weft/sdk";

export default defineWorkflow(
  {
    name: "sleepy",
    description: "waits, then finishes on its own",
    input: z.object({}),
    output: z.object({ slept: z.boolean() }),
  },
  async (ctx) => {
    await ctx.sleep("800ms");
    return { slept: true };
  },
);
`;

interface Session extends WeftMcpServer {
  client: Client;
  cwd: string;
}

const open: Session[] = [];
const roots: string[] = [];

afterAll(async () => {
  for (const session of open) {
    await session.client.close();
    await session.server.close();
    await session.weft.close();
  }
  await Promise.all(
    roots.map((dir) => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })),
  );
});

/** A throwaway repo, a mock-wired server over it, and a connected client. */
async function session(over?: string): Promise<Session> {
  const cwd = over ?? (await tempRepo());
  const built = await createWeftMcpServer({ cwd, providers: "mock" });
  const client = new Client({ name: "test-session", version: "0.0.0" });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await Promise.all([built.server.connect(serverSide), client.connect(clientSide)]);
  const live: Session = { ...built, client, cwd };
  open.push(live);
  return live;
}

async function tempRepo(): Promise<string> {
  const cwd = await mkdtemp(path.join(tmpdir(), "weft-mcp-"));
  roots.push(cwd);
  return cwd;
}

interface Reply {
  isError: boolean;
  text: string;
}

async function call(s: Session, name: string, args: Record<string, unknown> = {}): Promise<Reply> {
  const result = await s.client.callTool({ name, arguments: args });
  const blocks = result.content as Array<{ type: string; text?: string }>;
  expect(blocks).toHaveLength(1); // one JSON text block, always
  expect(blocks[0]?.type).toBe("text");
  return { isError: result.isError === true, text: blocks[0]?.text ?? "" };
}

/**
 * The run ids `weft_list` reports for a filter. Handed to `expect.poll` where the filter
 * is one a projection has to catch up to: a suspended run's `state.json` is written a beat
 * after it suspends, so status filters are eventually consistent by design.
 */
async function listIds(s: Session, filter: Record<string, unknown> = {}): Promise<string[]> {
  const { runs } = await json<{ runs: Array<{ runId: string }> }>(s, "weft_list", filter);
  return runs.map((run) => run.runId);
}

/** Call a tool and parse the JSON block, failing loudly on `isError`. */
async function json<T>(s: Session, name: string, args: Record<string, unknown> = {}): Promise<T> {
  const reply = await call(s, name, args);
  if (reply.isError) throw new Error(`${name} returned isError: ${reply.text}`);
  return JSON.parse(reply.text) as T;
}

type WaitReply = {
  status?: string;
  output?: { greeting?: string; at?: number; approved?: boolean; note?: string; isNull?: boolean };
  error?: { code?: string; message?: string };
  awaiting?: { id: string; kind: string; question: string; detail?: string; schema: Record<string, unknown> };
};

describe("the weft MCP server", () => {
  it("advertises the seven session tools", async () => {
    const s = await session();
    const { tools } = await s.client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "weft_answer",
      "weft_list",
      "weft_report",
      "weft_resume",
      "weft_run",
      "weft_types",
      "weft_wait",
    ]);
    // Every tool describes itself well enough for a session to pick it without guessing.
    for (const tool of tools) expect(tool.description ?? "").not.toBe("");
    expect(tools.find((t) => t.name === "weft_run")?.inputSchema.properties).toHaveProperty("source");
  });

  it("runs inline source, returns the runId at once, and waits for the output", async () => {
    const s = await session();
    const started = await json<{ runId: string }>(s, "weft_run", {
      source: HELLO,
      input: { name: "weft" },
    });
    expect(started.runId).toMatch(/^[0-9a-f]{8}$/);

    const done = await json<WaitReply>(s, "weft_wait", { runId: started.runId, timeout: "10s" });
    expect(done.status).toBe("complete");
    expect(done.output?.greeting).toBe("hello weft");
    expect(done.output?.at).toBeGreaterThan(0);

    const { report } = await json<{ report: string }>(s, "weft_report", { runId: started.runId });
    expect(report).toContain("hello");
    expect(report).toContain("complete");
  });

  it("accepts any JSON input — an explicit null reaches the workflow as itself", async () => {
    const NULLIN = `import { defineWorkflow, z } from "@weft/sdk";
export default defineWorkflow(
  { description: "null input", input: z.null(), output: z.object({ isNull: z.boolean() }) },
  async (_ctx, input) => ({ isNull: input === null }),
);
`;
    const s = await session();
    // The tool schema must not reject what the workflow's own schema accepts.
    const started = await json<{ runId: string }>(s, "weft_run", { source: NULLIN, input: null });
    const done = await json<WaitReply>(s, "weft_wait", { runId: started.runId, timeout: "10s" });
    expect(done.status).toBe("complete");
    expect(done.output?.isNull).toBe(true);
  });

  it("a failed start leaves no orphaned provenance behind", async () => {
    const s = await session();
    // The input fails hello's schema, so engine.start throws AFTER the inline
    // script was persisted — the reservation must be cleaned up, not leaked.
    const res = await s.client.callTool({
      name: "weft_run",
      arguments: { source: HELLO, input: { name: 42 } },
    });
    expect(res.isError).toBe(true);
    const dirs = await readdir(path.join(s.cwd, ".weft", "runs")).catch(() => [] as string[]);
    expect(dirs).toEqual([]);
  });

  it("carries a pending approval out to the session and back in through weft_answer", async () => {
    const s = await session();
    const { runId } = await json<{ runId: string }>(s, "weft_run", { source: GATED });

    const suspended = await json<WaitReply>(s, "weft_wait", { runId, timeout: "10s" });
    expect(suspended.status).toBeUndefined();
    const awaiting = suspended.awaiting;
    expect(awaiting).toBeDefined();
    expect(awaiting?.kind).toBe("approve");
    expect(awaiting?.question).toBe("apply the fixes");
    expect(awaiting?.detail).toBe("4 files");
    // The schema is what lets a session shape an answer instead of guessing at one.
    expect(awaiting?.schema).toMatchObject({
      type: "object",
      properties: { approved: { type: "boolean" }, note: { type: "string" } },
      required: ["approved"],
    });

    const answered = await json<{ ok: boolean }>(s, "weft_answer", {
      runId,
      requestId: awaiting?.id,
      answer: { approved: true, note: "reviewed the diff" },
    });
    expect(answered.ok).toBe(true);

    const done = await json<WaitReply>(s, "weft_wait", { runId, timeout: "10s" });
    expect(done.status).toBe("complete");
    expect(done.output).toEqual({ approved: true, note: "reviewed the diff" });
  });

  it("rejects an answer the request schema does not accept, and leaves the run waiting", async () => {
    const s = await session();
    const { runId } = await json<{ runId: string }>(s, "weft_run", { source: GATED });
    const suspended = await json<WaitReply>(s, "weft_wait", { runId, timeout: "10s" });
    const requestId = suspended.awaiting?.id;
    expect(requestId).toBeDefined();

    const rejected = await call(s, "weft_answer", { runId, requestId, answer: { approved: "yes" } });
    expect(rejected.isError).toBe(true);
    expect(rejected.text).toContain("schema");
    expect(rejected.text).toContain("approved");

    // Still answerable: a bad answer is a correction, not a lost run.
    const retried = await json<WaitReply>(s, "weft_wait", { runId, timeout: "10s" });
    expect(retried.awaiting?.id).toBe(requestId);
    await json(s, "weft_answer", { runId, requestId, answer: { approved: false } });
    const done = await json<WaitReply>(s, "weft_wait", { runId, timeout: "10s" });
    expect(done.status).toBe("complete");
    expect(done.output?.approved).toBe(false);
  });

  it("reports a bad ref, a bad input, and a run it has never heard of as tool errors", async () => {
    const s = await session();

    const noRef = await call(s, "weft_run", {});
    expect(noRef.isError).toBe(true);
    expect(noRef.text).toContain("exactly one of");

    const unknown = await call(s, "weft_run", { workflow: "nope" });
    expect(unknown.isError).toBe(true);
    expect(unknown.text).toContain("unknown workflow");

    const badInput = await call(s, "weft_run", { source: HELLO, input: { name: 42 } });
    expect(badInput.isError).toBe(true);
    expect(badInput.text).toContain("input schema");

    const missing = await call(s, "weft_wait", { runId: "deadbeef", timeout: "1s" });
    expect(missing.isError).toBe(true);
    expect(missing.text).toContain("not found");
  });

  it("lists the runs in the repo and filters them by status", async () => {
    const s = await session();
    const finished = await json<{ runId: string }>(s, "weft_run", { source: HELLO, input: { name: "one" } });
    await json<WaitReply>(s, "weft_wait", { runId: finished.runId, timeout: "10s" });
    const suspended = await json<{ runId: string }>(s, "weft_run", { source: GATED });
    await json<WaitReply>(s, "weft_wait", { runId: suspended.runId, timeout: "10s" });

    expect((await listIds(s)).sort()).toEqual([finished.runId, suspended.runId].sort());
    expect(await listIds(s, { status: "complete" })).toEqual([finished.runId]);
    await expect.poll(() => listIds(s, { status: "waiting_for_human", limit: 5 })).toEqual([suspended.runId]);

    const capped = await json<{ runs: unknown[] }>(s, "weft_list", { limit: 1 });
    expect(capped.runs).toHaveLength(1);
  });

  it("holds the poll open while a run is working, and says so when the clock runs out", async () => {
    const s = await session();
    const { runId } = await json<{ runId: string }>(s, "weft_run", { source: SLEEPY });

    const early = await json<WaitReply>(s, "weft_wait", { runId, timeout: "150ms" });
    expect(early).toEqual({ status: "running" });

    const done = await json<WaitReply>(s, "weft_wait", { runId, timeout: "10s" });
    expect(done.status).toBe("complete");
  });

  it("answers and resumes a run from a second session over the same repo", async () => {
    const cwd = await tempRepo();
    await mkdir(path.join(cwd, ".weft", "workflows"), { recursive: true });
    await writeFile(path.join(cwd, ".weft", "workflows", "gated.ts"), GATED, "utf8");

    // The session that starts the run: it gets as far as the question and stops there.
    const starter = await session(cwd);
    const { runId } = await json<{ runId: string }>(starter, "weft_run", { workflow: "gated" });
    const suspended = await json<WaitReply>(starter, "weft_wait", { runId, timeout: "10s" });
    const requestId = suspended.awaiting?.id;
    expect(requestId).toBeDefined();

    // A different session, holding no handle: it finds the run by id, answers it into the
    // journal, and resumes it from the registry name the run recorded.
    const other = await session(cwd);
    await expect.poll(() => listIds(other, { status: "waiting_for_human" })).toContain(runId);

    const pending = await json<WaitReply>(other, "weft_wait", { runId, timeout: "10s" });
    expect(pending.awaiting?.id).toBe(requestId);

    await json(other, "weft_answer", {
      runId,
      requestId,
      answer: { approved: true, note: "from elsewhere" },
    });
    // The starting session still lives: its journal tailer delivers the answer and
    // finishes the run, releasing its ownership claim — only then may another
    // session's resume take the run (it replays and serves the settled result).
    await expect.poll(() => listIds(other, { status: "complete" }), { timeout: 10_000 }).toContain(runId);
    const resumed = await json<{ runId: string; status: string }>(other, "weft_resume", { runId });
    expect(resumed).toEqual({ runId, status: "resumed" });

    const done = await json<WaitReply>(other, "weft_wait", { runId, timeout: "10s" });
    expect(done.status).toBe("complete");
    expect(done.output).toEqual({ approved: true, note: "from elsewhere" });
  });

  it("wakes an ownerless suspended run after weft_answer, without weft_resume", async () => {
    const cwd = await tempRepo();
    await mkdir(path.join(cwd, ".weft", "workflows"), { recursive: true });
    await writeFile(path.join(cwd, ".weft", "workflows", "gated.ts"), GATED, "utf8");

    const starter = await session(cwd);
    const { runId } = await json<{ runId: string }>(starter, "weft_run", { workflow: "gated" });
    const suspended = await json<WaitReply>(starter, "weft_wait", { runId, timeout: "10s" });
    const requestId = suspended.awaiting?.id;
    expect(requestId).toBeDefined();
    await starter.weft.engine.shutdown(); // the owning process dies

    // Nobody holds the run: the answer itself must wake it — "wait again" would
    // otherwise poll a journal with no pending request and no runtime forever.
    const other = await session(cwd);
    await json(other, "weft_answer", { runId, requestId, answer: { approved: true, note: "go" } });
    const done = await json<WaitReply>(other, "weft_wait", { runId, timeout: "10s" });
    expect(done.status).toBe("complete");
    expect(done.output).toEqual({ approved: true, note: "go" });
  });

  it("hands back the SDK source a session needs to write an inline workflow", async () => {
    const s = await session();
    const { types } = await json<{ types: string }>(s, "weft_types");
    expect(types).toContain("defineWorkflow");
    expect(types).toContain("export interface Ctx");
    expect(types).toContain("StandardSchemaV1");
    expect(types).toContain("@weft/sdk/types.ts");
  });
});
