/**
 * The daemon end to end. Every route is driven through `app.request()` against a real
 * engine over a throwaway repo — no socket, no browser — and the one test that does open
 * a socket only checks what a socket adds: a real port, and a `close()` that returns.
 *
 * The run every test starts from is suspended on a person, because that is the state the
 * daemon exists for: a journal on disk, a question nobody has answered, and no process
 * holding it.
 */
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  createWeft,
  type JournalRecord,
  loadWorkflow,
  persistInlineScript,
  type RunState,
  type RunSummary,
  resolveWorkflow,
  type Weft,
} from "@techery/weft-host";
import type { Hono } from "hono";
import { afterAll, describe, expect, it } from "vitest";
import {
  BUNDLED_WEB_ROOT,
  type CreateAppOptions,
  createApp,
  DEFAULT_PORT,
  openWebBundle,
  startDaemon,
  type WebBundle,
} from "../src/index.ts";

/** No agent, no shell: one journaled clock read, then a question only a person can answer. */
const GATED = `import { defineWorkflow, z } from "@techery/weft-sdk";

export default defineWorkflow(
  {
    name: "gated",
    description: "asks a person before it lands anything",
    input: z.object({}),
    output: z.object({ approved: z.boolean(), note: z.string(), at: z.number() }),
  },
  async (ctx) => {
    ctx.phase("Review");
    const at = await ctx.now();
    const verdict = await ctx.human.approve({ action: "land the patch", detail: "3 files, 40 lines" });
    return { approved: verdict.approved, note: verdict.note ?? "", at };
  },
);
`;

/** A parent whose only work is a child that asks — the tree suspends on the CHILD's journal. */
const NESTED = `import { defineWorkflow, z } from "@techery/weft-sdk";
const child = defineWorkflow(
  { name: "gatechild", description: "asks", input: z.object({}), output: z.object({ approved: z.boolean() }) },
  async (ctx) => {
    const v = await ctx.human.approve({ action: "child gate" });
    return { approved: v.approved };
  },
);
export default defineWorkflow(
  { name: "nested", description: "parent of an asking child", input: z.object({}), output: z.object({ approved: z.boolean() }) },
  async (ctx) => (await ctx.workflow(child, {})) as { approved: boolean },
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

interface Harness {
  weft: Weft;
  app: Hono;
  cwd: string;
}

/**
 * A stand-in for what `apps/ui` builds: a document plus one hashed script and stylesheet.
 * It sits in a `web/` subdirectory of a temp root, so the traversal tests have a readable
 * file outside the bundle to try to reach.
 */
async function bundle(): Promise<WebBundle> {
  const root = await mkdtemp(path.join(tmpdir(), "weft-web-"));
  roots.push(root);
  const web = path.join(root, "web");
  await mkdir(path.join(web, "assets"), { recursive: true });
  await writeFile(
    path.join(web, "index.html"),
    '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
      "<title>weft workflow manager</title>" +
      '<link rel="stylesheet" href="/assets/index-abc123.css"></head>' +
      '<body><div id="root"></div>' +
      '<script type="module" src="/assets/index-abc123.js"></script></body></html>',
    "utf8",
  );
  await writeFile(path.join(web, "assets", "index-abc123.js"), 'console.log("manager");', "utf8");
  await writeFile(path.join(web, "assets", "index-abc123.css"), ".queue { display: flex; }", "utf8");
  const opened = openWebBundle(web);
  if (opened === undefined) throw new Error("the fixture bundle did not open");
  return opened;
}

/** A throwaway repo with `gated` registered, so a second process can resume its runs. */
async function repo(): Promise<string> {
  const cwd = await mkdtemp(path.join(tmpdir(), "weft-daemon-"));
  roots.push(cwd);
  await writeWorkflow(cwd, "gated", GATED);
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

async function open(cwd: string, appOpts: CreateAppOptions = { web: null }): Promise<Harness> {
  const weft = await createWeft({ cwd, providers: "mock" });
  opened.push(weft);
  return { weft, app: createApp(weft, appOpts), cwd };
}

/** Start `gated` and return once its journal shows it parked on the approval request. */
async function seed(h: Harness): Promise<string> {
  const { def, hash } = await resolveWorkflow(h.weft, "gated");
  const handle = await h.weft.engine.start(def, {
    input: {},
    cwd: h.cwd,
    ...(hash !== undefined ? { defHash: hash } : {}),
  });
  const outcome = await handle.outcome();
  expect(outcome.status).toBe("waiting_for_human");
  // A run reports itself idle before the status event it wrote reaches the journal, so
  // every assertion after this waits for the durable record rather than the in-memory one.
  await expect.poll(() => statusOf(h.app, handle.runId)).toBe("waiting_for_human");
  return handle.runId;
}

/** A repo whose only run is suspended on disk, and a daemon that never saw it start. */
async function suspendedElsewhere(): Promise<{ app: Hono; runId: string; weft: Weft }> {
  const cwd = await repo();
  const first = await open(cwd);
  const runId = await seed(first);
  // The starting process is gone: detach so its ownership claim is released.
  await first.weft.engine.shutdown();
  const fresh = await open(cwd);
  return { app: fresh.app, runId, weft: fresh.weft };
}

async function getJson<T>(app: Hono, url: string): Promise<T> {
  const res = await app.request(url);
  expect(res.status).toBe(200);
  return (await res.json()) as T;
}

async function post(app: Hono, url: string, body: unknown): Promise<Response> {
  return app.request(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function statusOf(app: Hono, runId: string): Promise<string> {
  return (await getJson<RunState>(app, `/api/runs/${runId}`)).status;
}

// ---------------------------------------------------------------------------

describe("the daemon's read routes", () => {
  it("lists a run and serves its state, tree, pending requests, and report", async () => {
    const h = await open(await repo());
    const runId = await seed(h);

    const runs = await getJson<Array<{ runId: string; workflow: string; status: string }>>(
      h.app,
      "/api/runs",
    );
    expect(runs.map((run) => run.runId)).toContain(runId);
    expect(runs.find((run) => run.runId === runId)?.workflow).toBe("gated");

    const state = await getJson<RunState>(h.app, `/api/runs/${runId}`);
    expect(state.runId).toBe(runId);
    expect(state.workflow).toBe("gated");
    expect(state.status).toBe("waiting_for_human");
    expect(state.steps.map((step) => step.label)).toContain("now");

    // The tree is the phase the workflow declared, carrying the one step it has run.
    const tree = await getJson<Array<{ name: string; nodes: Array<{ label: string; status: string }> }>>(
      h.app,
      `/api/runs/${runId}/tree`,
    );
    expect(tree.map((phase) => phase.name)).toEqual(["Review"]);
    expect(tree[0]?.nodes.map((node) => node.label)).toEqual(["now"]);
    expect(tree[0]?.nodes[0]?.status).toBe("ok");

    const pending = await getJson<Array<{ id: string; kind: string; question: string; schema: unknown }>>(
      h.app,
      `/api/runs/${runId}/pending`,
    );
    expect(pending).toHaveLength(1);
    expect(pending[0]?.kind).toBe("approve");
    expect(pending[0]?.question).toBe("land the patch");
    expect(pending[0]?.schema).toMatchObject({ properties: { approved: { type: "boolean" } } });

    const report = await h.app.request(`/api/runs/${runId}/report`);
    expect(report.status).toBe(200);
    expect(report.headers.get("content-type")).toContain("text/markdown");
    const markdown = await report.text();
    expect(markdown).toContain(`# gated — run ${runId}`);
    expect(markdown).toContain("land the patch");
  });

  it("names every run in the list, whatever the stored projection says", async () => {
    const cwd = await repo();
    const h = await open(cwd);
    const runId = await seed(h);

    // A run being driven right now can leave `state.json` without so much as its own id in
    // it, and the list is what the UI polls: it has to name the workflow regardless...
    const runs = await getJson<RunSummary[]>(h.app, "/api/runs");
    expect(runs.find((run) => run.runId === runId)?.workflow).toBe("gated");

    // ...and leave the projection repaired, so the next poll reads it for free.
    const stored = JSON.parse(await readFile(path.join(cwd, ".weft", "runs", runId, "state.json"), "utf8"));
    expect((stored as RunState).workflow).toBe("gated");
    expect((stored as RunState).runId).toBe(runId);
  });

  it("reports a run nobody has journaled as 404, on every shape of it", async () => {
    const h = await open(await repo());
    for (const url of [
      "/api/runs/nope",
      "/api/runs/nope/report",
      "/api/runs/nope/tree",
      "/api/runs/nope/events",
    ]) {
      const res = await h.app.request(url);
      expect(res.status, url).toBe(404);
      expect(((await res.json()) as { error: string }).error).toContain("not found");
    }
  });
});

describe("answering from the daemon", () => {
  it("delivers an answer to the run this process is holding and finishes it", async () => {
    const h = await open(await repo());
    const runId = await seed(h);
    const [request] = await getJson<Array<{ id: string }>>(h.app, `/api/runs/${runId}/pending`);

    const res = await post(h.app, `/api/runs/${runId}/answer`, {
      requestId: request?.id,
      answer: { approved: true, note: "looks good" },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, woke: false });

    await expect.poll(() => statusOf(h.app, runId), { timeout: 10_000 }).toBe("complete");
    const state = await getJson<RunState>(h.app, `/api/runs/${runId}`);
    expect(state.output).toMatchObject({ approved: true, note: "looks good" });
    expect((await getJson<unknown[]>(h.app, `/api/runs/${runId}/pending`)).length).toBe(0);
  });

  it("wakes a suspended run no process is holding — the daemon's whole job", async () => {
    const { app, runId } = await suspendedElsewhere();
    const [request] = await getJson<Array<{ id: string }>>(app, `/api/runs/${runId}/pending`);

    const res = await post(app, `/api/runs/${runId}/answer`, {
      requestId: request?.id,
      answer: { approved: false, note: "not yet" },
    });
    expect(res.status).toBe(200);
    // Nothing here was waiting on the answer, so the daemon resumes the run to serve it.
    expect(await res.json()).toEqual({ ok: true, woke: true });

    await expect.poll(() => statusOf(app, runId), { timeout: 15_000 }).toBe("complete");
    expect((await getJson<RunState>(app, `/api/runs/${runId}`)).output).toMatchObject({ approved: false });
  });

  it("refuses an answer the request's schema rejects, with the reason", async () => {
    const h = await open(await repo());
    const runId = await seed(h);
    const [request] = await getJson<Array<{ id: string }>>(h.app, `/api/runs/${runId}/pending`);

    const res = await post(h.app, `/api/runs/${runId}/answer`, {
      requestId: request?.id,
      answer: { approved: "yes" },
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain("approved");
    expect(await statusOf(h.app, runId)).toBe("waiting_for_human");
  });

  it("refuses a body with no requestId", async () => {
    const h = await open(await repo());
    const runId = await seed(h);
    const res = await post(h.app, `/api/runs/${runId}/answer`, { answer: { approved: true } });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain("requestId");
  });
});

describe("steering a run", () => {
  it("cancels a suspended run", async () => {
    const { app, runId } = await suspendedElsewhere();

    const res = await post(app, `/api/runs/${runId}/cancel`, {});
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(await statusOf(app, runId)).toBe("cancelled");
  });

  it("resumes a run from its journal", async () => {
    const { app, runId } = await suspendedElsewhere();

    const res = await post(app, `/api/runs/${runId}/resume`, {});
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, runId });
    // Nothing answered it, so a resumed run parks on the same request rather than moving on.
    await expect
      .poll(async () => (await getJson<Array<{ id: string }>>(app, `/api/runs/${runId}/pending`)).length)
      .toBe(1);
  });

  it("resumes an INLINE run through its persisted script — the registry has no entry for it", async () => {
    const cwd = await repo();
    const first = await open(cwd);
    const source = `import { defineWorkflow, z } from "@techery/weft-sdk";
export default defineWorkflow(
  { description: "inline gate", input: z.object({}), output: z.object({ ok: z.boolean() }) },
  async (ctx) => {
    const go = await ctx.human.approve({ action: "ship?" });
    return { ok: go.approved };
  },
);
`;
    const loaded = await loadWorkflow({ source, cwd });
    const handle = await first.weft.engine.start(loaded.def, { input: {}, cwd });
    const outcome = await handle.outcome();
    expect(outcome.status).toBe("waiting_for_human");
    await persistInlineScript(first.weft, handle.runId, loaded.code);
    await first.weft.engine.shutdown();

    // The daemon that serves the Resume click never saw the script — only script.ts.
    const fresh = await open(cwd);
    const res = await post(fresh.app, `/api/runs/${handle.runId}/resume`, {});
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, runId: handle.runId });
    await expect
      .poll(
        async () =>
          (await getJson<Array<{ id: string }>>(fresh.app, `/api/runs/${handle.runId}/pending`)).length,
      )
      .toBe(1);
  });

  it("carries a signal into the journal", async () => {
    const { app, runId } = await suspendedElsewhere();

    const res = await post(app, `/api/runs/${runId}/signal`, { name: "ci-green", payload: { sha: "abc" } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, woke: true });

    const bad = await post(app, `/api/runs/${runId}/signal`, { payload: 1 });
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { error: string }).error).toContain("name");
  });
});

describe("the event stream", () => {
  it("sends each journal record as one data line and ends when the client goes away", async () => {
    const h = await open(await repo());
    const runId = await seed(h);

    const client = new AbortController();
    const res = await h.app.request(`/api/runs/${runId}/events`, { signal: client.signal });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");

    const reader = res.body?.getReader();
    if (!reader) throw new Error("the event stream has no body");
    const decoder = new TextDecoder();
    let buffered = "";
    while (!buffered.includes("\n\n")) {
      const chunk = await reader.read();
      if (chunk.done) break;
      buffered += decoder.decode(chunk.value, { stream: true });
    }

    const line = buffered.split("\n").find((text) => text.startsWith("data: "));
    expect(line, buffered).toBeTruthy();
    const record = JSON.parse((line ?? "").slice("data: ".length)) as JournalRecord;
    expect(record.i).toBe(0);
    expect(typeof record.at).toBe("number");
    expect(record.ev.type).toBe("run.created");

    // A closed tab is the normal way this stream ends: the request aborts, the watch is
    // abandoned, and the body completes rather than erroring.
    client.abort();
    let done = false;
    for (let reads = 0; reads < 50 && !done; reads++) done = (await reader.read()).done;
    expect(done).toBe(true);
    await reader.cancel();
  });

  it("honours Last-Event-ID from an automatic EventSource reconnect", async () => {
    const h = await open(await repo());
    const runId = await seed(h);

    // A browser reconnect sends the last `id:` it saw as a header, not ?from=.
    const client = new AbortController();
    const res = await h.app.request(`/api/runs/${runId}/events`, {
      headers: { "Last-Event-ID": "1" },
      signal: client.signal,
    });
    expect(res.status).toBe(200);

    const reader = res.body?.getReader();
    if (!reader) throw new Error("the event stream has no body");
    const decoder = new TextDecoder();
    let buffered = "";
    while (!buffered.includes("\n\n")) {
      const chunk = await reader.read();
      if (chunk.done) break;
      buffered += decoder.decode(chunk.value, { stream: true });
    }
    const first = buffered.split("\n").find((text) => text.startsWith("data: "));
    expect(first, buffered).toBeTruthy();
    // Resumes one PAST the acknowledged id — nothing replayed, nothing skipped.
    expect((JSON.parse((first ?? "").slice("data: ".length)) as JournalRecord).i).toBe(2);

    client.abort();
    await reader.cancel().catch(() => undefined);
  });

  it("resumes from ?from= instead of replaying the whole journal", async () => {
    const h = await open(await repo());
    const runId = await seed(h);

    const client = new AbortController();
    const res = await h.app.request(`/api/runs/${runId}/events?from=2`, { signal: client.signal });
    expect(res.status).toBe(200);

    const reader = res.body?.getReader();
    if (!reader) throw new Error("the event stream has no body");
    const decoder = new TextDecoder();
    let buffered = "";
    while (!buffered.includes("\n\n")) {
      const chunk = await reader.read();
      if (chunk.done) break;
      buffered += decoder.decode(chunk.value, { stream: true });
    }
    // The reconnect cursor holds: nothing below index 2 is replayed.
    const first = buffered.split("\n").find((text) => text.startsWith("data: "));
    expect(first, buffered).toBeTruthy();
    const record = JSON.parse((first ?? "").slice("data: ".length)) as JournalRecord;
    expect(record.i).toBe(2);

    client.abort();
    await reader.cancel().catch(() => undefined);
  });
});

describe("the built-in page", () => {
  it("serves one self-contained page when nothing is built", async () => {
    const h = await open(await repo());
    const res = await h.app.request("/");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");

    const html = await res.text();
    expect(html).toContain("<title>weft</title>");
    expect(html).toContain('id="run-list"');
    expect(html).toContain("/api/runs");
    expect(html).toContain("EventSource");
    expect(html).toContain("prefers-color-scheme");
    // Self-contained: nothing to fetch, nothing to build.
    expect(html).not.toContain("<script src=");
    expect(html).not.toContain('<link rel="stylesheet"');
  });

  it("keeps a fixed address at /legacy even when the manager is on /", async () => {
    const h = await open(await repo(), { web: await bundle() });
    const root = await (await h.app.request("/")).text();
    const legacy = await (await h.app.request("/legacy")).text();
    expect(root).toContain("weft workflow manager");
    expect(legacy).toContain('id="run-list"');
  });
});

describe("the workflow manager", () => {
  it("serves the built document at /", async () => {
    const h = await open(await repo(), { web: await bundle() });
    const res = await h.app.request("/");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(res.headers.get("cache-control")).toBe("no-cache");
    expect(await res.text()).toContain("weft workflow manager");
  });

  it("serves its hashed assets, and lets them be cached forever", async () => {
    const h = await open(await repo(), { web: await bundle() });
    const js = await h.app.request("/assets/index-abc123.js");
    expect(js.status).toBe(200);
    expect(js.headers.get("content-type")).toContain("text/javascript");
    expect(js.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(await js.text()).toContain("console.log");

    const css = await h.app.request("/assets/index-abc123.css");
    expect(css.headers.get("content-type")).toContain("text/css");
    expect(await css.text()).toContain(".queue");
  });

  it("serves the document for its own client-side routes", async () => {
    const h = await open(await repo(), { web: await bundle() });
    for (const route of ["/queue", "/runs", "/runs/r-045", "/workflows", "/settings"]) {
      const res = await h.app.request(route);
      expect(res.status, route).toBe(200);
      expect(res.headers.get("content-type"), route).toContain("text/html");
      expect(await res.text()).toContain("weft workflow manager");
    }
  });

  it("answers an unknown /api/ path with JSON, never with the document", async () => {
    const h = await open(await repo(), { web: await bundle() });
    const res = await h.app.request("/api/nope");
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect((await res.json()) as { error: string }).toMatchObject({
      error: "no route for GET /api/nope",
    });
  });

  it("404s every path when no manager is built", async () => {
    const h = await open(await repo());
    for (const route of ["/queue", "/assets/index-abc123.js", "/api/nope"]) {
      expect((await h.app.request(route)).status, route).toBe(404);
    }
  });

  it("never serves a file from outside the bundle", async () => {
    const web = await bundle();
    // A readable file one level up from the bundle: escaping would return this.
    const outside = path.join(path.dirname(web.root), "secret.txt");
    await writeFile(outside, "do not serve me", "utf8");
    const h = await open(await repo(), { web });

    for (const attack of [
      "/../secret.txt",
      "/assets/../../secret.txt",
      "/%2e%2e%2fsecret.txt",
      "/..%2Fsecret.txt",
      "/%2e%2e/secret.txt",
    ]) {
      const res = await h.app.request(attack);
      const body = await res.text();
      expect(body, attack).not.toContain("do not serve me");
      // Anything that is not a file in the bundle is one of the manager's own routes.
      expect(body, attack).toContain("weft workflow manager");
    }
  });

  it("reads a directory, a missing file and an odd extension as not-a-file", async () => {
    const web = await bundle();
    await writeFile(path.join(web.root, "weird.xyz"), "opaque", "utf8");
    expect(await web.read("/assets")).toBeUndefined();
    expect(await web.read("/assets/")).toBeUndefined();
    expect(await web.read("/")).toBeUndefined();
    expect(await web.read("/nope.js")).toBeUndefined();
    expect((await web.read("/weird.xyz"))?.contentType).toBe("application/octet-stream");
  });

  it("is not a bundle without an index.html", async () => {
    const empty = await mkdtemp(path.join(tmpdir(), "weft-web-empty-"));
    roots.push(empty);
    expect(openWebBundle(empty)).toBeUndefined();
    expect(openWebBundle(path.join(empty, "does-not-exist"))).toBeUndefined();
  });

  // CI builds before it tests, so this runs against the artifact `weft ui` will serve.
  it.skipIf(!existsSync(path.join(BUNDLED_WEB_ROOT, "index.html")))(
    "is what the shipped bundle actually contains",
    async () => {
      const web = openWebBundle(BUNDLED_WEB_ROOT);
      expect(web).toBeDefined();
      const h = await open(await repo(), { web: web ?? null });
      const html = await (await h.app.request("/")).text();
      expect(html).toContain("weft");

      // Every asset the document asks for has to be one this app can serve.
      const refs = [...html.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)].map((m) => m[1] ?? "");
      expect(refs.length).toBeGreaterThan(0);
      for (const ref of refs) {
        expect((await h.app.request(ref)).status, ref).toBe(200);
      }
    },
  );
});

describe("the loopback guard", () => {
  it("refuses rebound Hosts and cross-site Origins, serves local clients", async () => {
    const h = await open(await repo());
    // DNS rebinding: the page's hostname now resolves to 127.0.0.1, but the
    // browser still sends the ATTACKER's Host — on every route, reads included.
    const rebound = await h.app.request("/api/runs", { headers: { host: "attacker.example:4100" } });
    expect(rebound.status).toBe(403);
    // Plain cross-site: a hostile page can fire side-effecting POSTs blind;
    // the browser stamps its Origin on them.
    const csrf = await h.app.request("/api/runs/deadbeef/cancel", {
      method: "POST",
      headers: { host: "127.0.0.1:4100", origin: "https://attacker.example" },
    });
    expect(csrf.status).toBe(403);
    // Honest local clients — with or without a port, IPv6 included — pass.
    for (const host of ["127.0.0.1:4100", "localhost", "[::1]:4100"]) {
      const res = await h.app.request("/api/runs", { headers: { host } });
      expect(res.status, host).toBe(200);
    }
    const sameOrigin = await h.app.request("/api/runs", {
      headers: { host: "127.0.0.1:4100", origin: "http://127.0.0.1:4100" },
    });
    expect(sameOrigin.status).toBe(200);
  });

  it("treats another localhost PORT as cross-site, not as one trusted loopback", async () => {
    const h = await open(await repo());
    // A dev server on :3000 is a different origin. A CORS-simple POST from it carries
    // an honest loopback Origin, which "any loopback passes" waved straight through --
    // enough to start runs and satisfy human approval gates.
    for (const origin of ["http://127.0.0.1:3000", "http://localhost:5173"]) {
      const res = await h.app.request("/api/runs/deadbeef/cancel", {
        method: "POST",
        headers: { host: "127.0.0.1:4100", origin },
      });
      expect(res.status, origin).toBe(403);
    }
    // The daemon's own page is still served.
    const own = await h.app.request("/api/runs", {
      headers: { host: "localhost:4100", origin: "http://localhost:4100" },
    });
    expect(own.status).toBe(200);
  });

  it("refuses a cross-site request that carries no Origin at all", async () => {
    const h = await open(await repo());
    // A no-cors GET (<img>, <script>, a form) omits Origin entirely, so the Host and
    // Origin checks never see it -- and this surface has a GET that writes.
    for (const site of ["cross-site", "same-site"]) {
      const res = await h.app.request("/api/workflows", {
        headers: { host: "127.0.0.1:4100", "sec-fetch-site": site },
      });
      expect(res.status, site).toBe(403);
    }
    // The UI, and a URL typed into the address bar, both still pass.
    for (const site of ["same-origin", "none"]) {
      const res = await h.app.request("/api/runs", {
        headers: { host: "127.0.0.1:4100", "sec-fetch-site": site },
      });
      expect(res.status, site).toBe(200);
    }
  });
});

describe("startDaemon", () => {
  it("listens on loopback, reports the port it actually got, and closes", async () => {
    const cwd = await repo();
    const daemon = await startDaemon({ cwd, port: 0, providers: "mock" });
    try {
      expect(daemon.port).toBeGreaterThan(0);
      expect(daemon.port).not.toBe(DEFAULT_PORT);
      expect(daemon.url).toBe(`http://127.0.0.1:${daemon.port}`);

      const res = await fetch(`${daemon.url}/api/runs`);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual([]);

      // Which page `/` is serving is what `weft ui` prints, so the handle has to say.
      const built = existsSync(path.join(BUNDLED_WEB_ROOT, "index.html"));
      expect(daemon.surface).toBe(built ? "manager" : "builtin");
      expect((await fetch(`${daemon.url}/`)).status).toBe(200);
      expect((await fetch(`${daemon.url}/legacy`)).status).toBe(200);
    } finally {
      await daemon.close();
      await daemon.close(); // idempotent: a second stop is not an error
    }
  });

  it("reports and answers a CHILD's pending request through the selected parent", async () => {
    const cwd = await repo();
    await writeWorkflow(cwd, "nested", NESTED);
    const h = await open(cwd);
    const { def } = await resolveWorkflow(h.weft, "nested");
    const run = await h.weft.engine.start(def, { input: {}, cwd });
    const o = await run.outcome();
    if (o.status !== "waiting_for_human") throw new Error("expected the child gate");

    // The question lives ONLY in the child's journal; the endpoint must follow
    // state.children or the UI renders no answer form for the parent-id flow.
    const res = await h.app.request(`/api/runs/${run.runId}/pending`);
    expect(res.status).toBe(200);
    const pending = (await res.json()) as Array<{ id: string; question: string; runId: string }>;
    expect(pending).toHaveLength(1);
    expect(pending[0]?.question).toContain("child gate");
    expect(pending[0]?.runId).not.toBe(run.runId); // owned by the CHILD run

    // Answered through the PARENT id — the engine routes to the owner.
    const answered = await h.app.request(`/api/runs/${run.runId}/answer`, {
      method: "POST",
      body: JSON.stringify({ requestId: pending[0]?.id, answer: { approved: true } }),
      headers: { "content-type": "application/json" },
    });
    expect(answered.status).toBe(200);
    expect(await run.result).toEqual({ approved: true });
  });

  it("answering a CHILD after a daemon restart wakes the ROOT, not just the child", async () => {
    const cwd = await repo();
    await writeWorkflow(cwd, "nested", NESTED);
    const first = await open(cwd);
    const { def } = await resolveWorkflow(first.weft, "nested");
    const run = await first.weft.engine.start(def, { input: {}, cwd });
    const o = await run.outcome();
    if (o.status !== "waiting_for_human") throw new Error("expected the child gate");
    const pending = await getJson<Array<{ id: string; runId: string }>>(
      first.app,
      `/api/runs/${run.runId}/pending`,
    );
    const child = pending[0];
    if (!child) throw new Error("expected the child request");
    await first.weft.engine.shutdown();

    // The UI posts to the request's OWNING run (the child). Waking only that
    // child completes ITS journal while the parent's workflow step never
    // re-executes — the selected root would stay nonterminal forever.
    const fresh = await open(cwd);
    const answered = await fresh.app.request(`/api/runs/${child.runId}/answer`, {
      method: "POST",
      body: JSON.stringify({ requestId: child.id, answer: { approved: true } }),
      headers: { "content-type": "application/json" },
    });
    expect(answered.status).toBe(200);
    await expect.poll(() => statusOf(fresh.app, run.runId), { timeout: 10_000 }).toBe("complete");
  });

  it("stops even with an event stream still open", async () => {
    const cwd = await repo();
    const daemon = await startDaemon({ cwd, port: 0, providers: "mock" });
    try {
      const runId = await seed({ weft: daemon.weft, app: createApp(daemon.weft), cwd });

      const stream = await fetch(`${daemon.url}/api/runs/${runId}/events`);
      expect(stream.status).toBe(200);
      expect(stream.headers.get("content-type")).toContain("text/event-stream");
      const reader = stream.body?.getReader();
      if (!reader) throw new Error("the event stream has no body");
      const first = await reader.read();
      expect(new TextDecoder().decode(first.value)).toContain("data: ");

      // An SSE request never ends on its own, so close() has to drop it rather than wait.
      await daemon.close();
      await reader.cancel().catch(() => undefined);
    } finally {
      await daemon.close();
    }
  });
});
