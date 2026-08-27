/**
 * A daemon, as far as the app can tell.
 *
 * The screens are wired to `fetch` and an `EventSource`, so the honest way to test them is
 * to answer both rather than to mock the hooks — a test that stubs `useRuns` proves the
 * component renders an object, not that it reads the daemon's actual shapes. Every payload
 * here is the real wire shape from `api/types.ts`.
 */
import { vi } from "vitest";
import type {
  ArtifactEntry,
  ConfigResponse,
  Meta,
  PatchResponse,
  PendingResponse,
  RunDetail,
  RunRow,
  WorkflowDetail,
  WorkflowIssue,
  WorkflowRow,
  WorkflowStats,
  WorkflowTask,
} from "~/api/types";

export interface DaemonState {
  meta: Meta;
  runs: RunRow[];
  detail: Record<string, RunDetail>;
  pending: PendingResponse;
  workflows: WorkflowRow[];
  workflowIssues: WorkflowIssue[];
  workflow: Record<string, WorkflowDetail>;
  tasks: Record<string, WorkflowTask[]>;
  stats: Record<string, WorkflowStats>;
  artifacts: Record<string, ArtifactEntry[]>;
  patch: Record<string, PatchResponse>;
  config: ConfigResponse;
  blobs: Record<string, string>;
}

export interface FakeDaemon {
  state: DaemonState;
  /** Every request the app made, in order — so a test can assert what it asked for. */
  calls: Array<{ method: string; path: string; body?: unknown }>;
  /** Make one path fail, to drive the error state. */
  fail(path: string, status: number, error: string): void;
  restore(): void;
}

const NOW = 1_700_000_000_000;
const TRANSCRIPT_REF = "d".repeat(64);

export function defaultState(): DaemonState {
  return {
    meta: {
      version: "0.9.0",
      repo: {
        name: "treel",
        cwd: "/repo/treel",
        weftDir: "/repo/treel/.weft",
        runsDir: "/repo/treel/.weft/runs",
      },
      defaults: { provider: "claude", model: "sonnet" },
      limits: { concurrency: 8, maxTurns: 50, maxDepth: 3, stepTimeoutMs: 600_000 },
      approvalPolicy: { tiers: { low: "auto", high: "ask" } },
      fetchAllow: ["api.github.com"],
      providers: [
        { id: "claude", registered: true },
        { id: "codex", registered: false },
      ],
    },
    runs: [
      {
        runId: "r-waiting",
        workflow: "release",
        status: "waiting_for_human",
        createdAt: NOW - 600_000,
        updatedAt: NOW - 60_000,
        spend: { tokens: 9_712, usd: 0.71 },
        steps: 3,
        running: 0,
      },
      {
        runId: "r-live",
        workflow: "triage",
        status: "executing",
        createdAt: NOW - 60_000,
        updatedAt: NOW,
        spend: { tokens: 400, usd: 0.09 },
        steps: 5,
        running: 2,
      },
      {
        runId: "r-done",
        workflow: "release",
        status: "complete",
        createdAt: NOW - 86_400_000,
        updatedAt: NOW - 86_000_000,
        spend: { tokens: 8_912, usd: 0.68 },
        steps: 4,
        running: 0,
      },
    ],
    detail: {
      "r-waiting": {
        runId: "r-waiting",
        workflow: "release",
        status: "waiting_for_human",
        input: { tag: "v0.9.0" },
        createdAt: NOW - 600_000,
        updatedAt: NOW - 60_000,
        depth: 0,
        cwd: "/repo/treel",
        phases: [
          { name: "Draft", steps: [1] },
          { name: "Review", steps: [2] },
        ],
        steps: [
          {
            seq: 1,
            kind: "agent",
            label: "draft release notes",
            phase: "Draft",
            status: "ok",
            startedAt: NOW - 600_000,
            endedAt: NOW - 420_000,
            route: { provider: "claude", model: "sonnet" },
            usage: { input: 8_000, output: 1_712, usd: 0.71 },
            sessionId: "session-release-1",
            transcriptRef: { $blob: TRANSCRIPT_REF, size: 144 },
            output: { sections: 6 },
          },
          {
            seq: 2,
            kind: "human",
            label: "approve publish",
            phase: "Review",
            status: "running",
            startedAt: NOW - 400_000,
          },
        ],
        humans: [
          {
            id: "h1",
            seq: 2,
            kind: "approve",
            question: "Approve the v0.9.0 release",
            detail: "Publishing creates a public GitHub release — weft cannot undo it.",
            risk: "high",
            schema: {
              type: "object",
              properties: { approved: { type: "boolean" }, note: { type: "string" } },
              required: ["approved"],
            },
            status: "pending",
            requestedAt: NOW - 400_000,
            artifactRef: { $blob: "a".repeat(64), size: 28, preview: "# Changelog" },
          },
        ],
        notes: [{ kind: "risk", text: "two commits had no linked issue", evidence: "commits.json" }],
        checks: [],
        patches: {
          captured: [{ key: "notes", ref: "a".repeat(64), files: ["CHANGELOG.md"] }],
          merged: [],
          discarded: [],
        },
        budget: { tokens: 9_712, usd: 0.71 },
        limits: { usd: 4 },
        inputs: { "1": { tag: "v0.9.0", since: "v0.8.4" } },
        records: 12,
      },
      "r-live": {
        runId: "r-live",
        workflow: "triage",
        status: "executing",
        input: {},
        createdAt: NOW - 60_000,
        updatedAt: NOW,
        depth: 0,
        cwd: "/repo/treel",
        phases: [{ name: "Classify", steps: [1, 2] }],
        steps: [
          {
            seq: 1,
            kind: "agent",
            label: "classify #815",
            phase: "Classify",
            status: "running",
            startedAt: NOW - 30_000,
          },
          {
            seq: 2,
            kind: "agent",
            label: "classify #816",
            phase: "Classify",
            status: "running",
            startedAt: NOW - 10_000,
          },
        ],
        humans: [],
        notes: [],
        checks: [],
        patches: { captured: [], merged: [], discarded: [] },
        budget: { tokens: 400, usd: 0.09 },
        limits: null,
        inputs: {},
        records: 6,
      },
    },
    pending: {
      pending: [
        {
          runId: "r-waiting",
          id: "h1",
          kind: "approve",
          question: "Approve the v0.9.0 release",
          detail: "Publishing creates a public GitHub release — weft cannot undo it.",
          risk: "high",
          schema: {
            type: "object",
            properties: { approved: { type: "boolean" }, note: { type: "string" } },
            required: ["approved"],
          },
          createdAt: NOW - 400_000,
          workflow: "release",
          rootRunId: "r-waiting",
          rootWorkflow: "release",
          artifactRef: { $blob: "a".repeat(64), size: 28, preview: "# Changelog" },
        },
      ],
      unreadable: [],
    },
    workflows: [
      {
        id: "release",
        name: "release",
        file: ".weft/workflows/release/main.ts",
        description: "Draft and publish release notes",
      },
      {
        id: "triage",
        name: "triage",
        file: ".weft/workflows/triage/main.ts",
        description: "Classify new issues",
      },
    ],
    workflowIssues: [],
    workflow: {
      release: {
        id: "release",
        name: "release",
        file: ".weft/workflows/release/main.ts",
        description: "Draft and publish release notes",
        hash: "b".repeat(64),
        input: {
          type: "object",
          properties: { tag: { type: "string" }, draft: { type: "boolean", default: true } },
          required: ["tag"],
        },
        output: { type: "object", properties: { url: { type: "string" } } },
        taskExtensions: null,
        taskExtensionSchemaVersion: 1,
        tasksConfigured: true,
        defaults: null,
      },
      triage: {
        id: "triage",
        name: "triage",
        file: ".weft/workflows/triage/main.ts",
        description: "Classify new issues",
        hash: "c".repeat(64),
        input: { type: "object", properties: { window: { type: "string", enum: ["24h", "7d"] } } },
        output: { type: "object", properties: {} },
        taskExtensions: null,
        taskExtensionSchemaVersion: 1,
        tasksConfigured: false,
        defaults: null,
      },
    },
    tasks: {
      release: [
        {
          schemaVersion: 1,
          extensionSchemaVersion: 1,
          id: "task-1234abcd",
          workflowId: "release",
          dedupeKey: "changelog|release-notes|missing-source-evidence",
          title: "Verify release notes",
          description: "Check every note against the commit range before publishing.",
          status: "in_progress",
          priority: "high",
          tags: ["release", "verification"],
          dependencies: [],
          relatedFiles: ["CHANGELOG.md"],
          acceptanceCriteria: [
            { id: "criterion-evidence", text: "Every note links to source evidence", met: true },
            { id: "criterion-heading", text: "Version heading matches the tag", met: false },
          ],
          notes: [
            { text: "Initial source scan completed", at: NOW - 120_000, actor: "review-agent" },
            { text: "Two commits still need issue links", at: NOW - 60_000, actor: "draft-agent" },
          ],
          extensions: {},
          createdAt: NOW - 500_000,
          updatedAt: NOW - 60_000,
          createdBy: "draft-agent",
          updatedBy: "draft-agent",
          revision: 3,
        },
      ],
      triage: [],
    },
    stats: {
      release: {
        name: "release",
        windowDays: 30,
        runs: 2,
        truncated: false,
        settled: 1,
        ok: 1,
        failed: 0,
        cancelled: 0,
        successRate: 100,
        p50Ms: 184_000,
        p95Ms: 184_000,
        usd: 1.39,
        tokens: 18_624,
        p50Usd: 0.68,
        lastRunAt: NOW - 600_000,
        recent: [
          {
            runId: "r-waiting",
            status: "waiting_for_human",
            createdAt: NOW - 600_000,
            updatedAt: NOW - 60_000,
            usd: 0.71,
            tokens: 9_712,
            agentSteps: 1,
          },
          {
            runId: "r-done",
            status: "complete",
            createdAt: NOW - 86_400_000,
            updatedAt: NOW - 86_000_000,
            usd: 0.68,
            tokens: 8_912,
            agentSteps: 1,
          },
        ],
      },
      triage: {
        name: "triage",
        windowDays: 30,
        runs: 1,
        truncated: false,
        settled: 0,
        ok: 0,
        failed: 0,
        cancelled: 0,
        successRate: null,
        p50Ms: null,
        p95Ms: null,
        usd: 0.09,
        tokens: 400,
        p50Usd: null,
        lastRunAt: NOW - 60_000,
        recent: [
          {
            runId: "r-live",
            status: "executing",
            createdAt: NOW - 60_000,
            updatedAt: NOW,
            usd: 0.09,
            tokens: 400,
            agentSteps: 2,
          },
        ],
      },
    },
    artifacts: {
      "r-waiting": [
        {
          ref: "a".repeat(64),
          id: "notes",
          kind: "patch",
          size: null,
          producedBy: { seq: 1, kind: "agent", label: "draft release notes" },
          at: NOW - 420_000,
          key: "notes",
          files: ["CHANGELOG.md"],
          available: true,
        },
      ],
      "r-live": [],
    },
    patch: {
      "r-waiting": {
        runId: "r-waiting",
        patches: [
          {
            key: "notes",
            ref: "a".repeat(64),
            files: ["CHANGELOG.md"],
            outOfScope: [],
            merged: false,
            discarded: false,
            available: true,
            stats: [{ path: "CHANGELOG.md", adds: 2, dels: 0, status: "modified" }],
            diff: [
              "diff --git a/CHANGELOG.md b/CHANGELOG.md",
              "--- a/CHANGELOG.md",
              "+++ b/CHANGELOG.md",
              "@@ -1,2 +1,4 @@",
              " # Changelog",
              "+## v0.9.0",
              "+- Run tree and commit gates",
            ].join("\n"),
          },
        ],
      },
      "r-live": { runId: "r-live", patches: [] },
    },
    config: {
      file: "config.json",
      path: "/repo/treel/.weft/config.json",
      exists: true,
      config: { limits: { concurrency: 8 } },
      effective: {
        defaults: { provider: "claude", model: "sonnet" },
        limits: { concurrency: 8, maxTurns: 50, maxDepth: 3, stepTimeoutMs: 600_000 },
        approvalPolicy: { tiers: { low: "auto", high: "ask" } },
        fetchAllow: ["api.github.com"],
        providers: { claude: { concurrency: 4 } },
      },
    },
    blobs: {
      ["a".repeat(64)]: "# Changelog\n## v0.9.0\n",
      [TRANSCRIPT_REF]: [
        "reasoning: Inspect the release history and current changelog.",
        "exec (exit 0): git log --oneline v0.8.4..HEAD",
        "files (completed): modify CHANGELOG.md",
        "assistant: Drafted six release-note sections.",
        "result: success",
      ].join("\n"),
    },
  };
}

/** Install the fake. Returns the state so a test can bend it before or during a render. */
export function fakeDaemon(overrides: Partial<DaemonState> = {}): FakeDaemon {
  const state = { ...defaultState(), ...overrides };
  const calls: FakeDaemon["calls"] = [];
  const failures = new Map<string, { status: number; error: string }>();

  const original = globalThis.fetch;
  const originalEventSource = globalThis.EventSource;

  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const path = url.replace(/^https?:\/\/[^/]+/, "");
    const method = init?.method ?? "GET";
    const body = init?.body ? (JSON.parse(String(init.body)) as unknown) : undefined;
    calls.push({ method, path, ...(body !== undefined ? { body } : {}) });

    const failure = failures.get(path);
    if (failure) return json({ error: failure.error }, failure.status);

    const [route, query = ""] = path.split("?");
    const blob = /^\/api\/blobs\/([0-9a-f]{64})$/.exec(route ?? "");
    if (blob) {
      const content = state.blobs[blob[1] ?? ""];
      if (content === undefined) return json({ error: "blob not found" }, 404);
      return new Response(content, { status: 200 });
    }

    const runMatch = /^\/api\/runs\/([^/]+)(\/[a-z]+)?$/.exec(route ?? "");
    if (runMatch) {
      const runId = decodeURIComponent(runMatch[1] ?? "");
      const sub = runMatch[2];
      if (method === "POST" && sub === "/answer") {
        // Answering removes the question and moves the run on, the way the daemon does.
        state.pending = { ...state.pending, pending: state.pending.pending.filter((p) => p.runId !== runId) };
        const detail = state.detail[runId];
        if (detail) {
          state.detail[runId] = {
            ...detail,
            status: "executing",
            humans: detail.humans.map((h) => ({ ...h, status: "answered" as const, answeredBy: "you" })),
          };
        }
        state.runs = state.runs.map((r) => (r.runId === runId ? { ...r, status: "executing" as const } : r));
        return json({ ok: true, woke: false });
      }
      if (method === "POST" && sub === "/cancel") {
        state.runs = state.runs.map((r) => (r.runId === runId ? { ...r, status: "cancelled" as const } : r));
        const detail = state.detail[runId];
        if (detail) state.detail[runId] = { ...detail, status: "cancelled" };
        return json({ ok: true });
      }
      if (sub === "/artifacts") return json(state.artifacts[runId] ?? []);
      if (sub === "/patch") return json(state.patch[runId] ?? { runId, patches: [] });
      if (sub === undefined) {
        const detail = state.detail[runId];
        return detail ? json(detail) : json({ error: `run ${runId} not found` }, 404);
      }
    }

    if (route === "/api/workflows/issues") return json(state.workflowIssues);

    const wf = /^\/api\/workflows\/([^/]+)(\/(?:stats|tasks))?$/.exec(route ?? "");
    if (wf) {
      const name = decodeURIComponent(wf[1] ?? "");
      if (wf[2] === "/stats") {
        const stats = state.stats[name];
        return stats ? json(stats) : json({ error: `workflow ${name} not found` }, 404);
      }
      if (wf[2] === "/tasks") return json(state.tasks[name] ?? []);
      const detail = state.workflow[name];
      return detail ? json(detail) : json({ error: `workflow ${name} not found` }, 404);
    }

    if (route === "/api/runs" && method === "POST") {
      const started = body as { workflow: string };
      const runId = `r-${state.runs.length + 1}`;
      state.runs = [
        ...state.runs,
        {
          runId,
          workflow: started.workflow,
          status: "executing",
          createdAt: NOW,
          updatedAt: NOW,
          running: 1,
          steps: 1,
        },
      ];
      state.detail[runId] = {
        ...(state.detail["r-live"] as RunDetail),
        runId,
        workflow: started.workflow,
      };
      return json({ ok: true, runId, workflow: started.workflow }, 202);
    }
    if (route === "/api/runs") {
      const spend = query.includes("spend=1");
      return json(spend ? state.runs : state.runs.map(({ spend: _s, ...rest }) => rest));
    }
    if (route === "/api/meta") return json(state.meta);
    if (route === "/api/pending") return json(state.pending);
    if (route === "/api/workflows") return json(state.workflows);
    if (route === "/api/config") {
      if (method === "PUT") {
        state.config = { ...state.config, config: body as never, exists: true };
        return json({ ok: true, path: state.config.path, restartRequired: true });
      }
      return json(state.config);
    }
    return json({ error: `no route for ${method} ${path}` }, 404);
  });

  // Every run screen opens one; nothing in these tests depends on it delivering.
  class SilentEventSource {
    onmessage: ((event: MessageEvent) => void) | null = null;
    onerror: ((event: Event) => void) | null = null;
    close(): void {}
  }
  vi.stubGlobal("EventSource", SilentEventSource);

  return {
    state,
    calls,
    fail: (path, status, error) => failures.set(path, { status, error }),
    restore: () => {
      vi.stubGlobal("fetch", original);
      vi.stubGlobal("EventSource", originalEventSource);
    },
  };
}
