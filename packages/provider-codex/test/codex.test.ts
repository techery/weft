import type {
  CodexOptions,
  Usage as CodexUsage,
  RunResult,
  ThreadItem,
  ThreadOptions,
  TurnOptions,
} from "@openai/codex-sdk";
import type { AgentRequest } from "@techery/weft-core";
import { describe, expect, it, vi } from "vitest";
import { type CodexLike, type CodexThreadLike, createCodexProvider, renderTranscript } from "../src/index.ts";

// ---------------------------------------------------------------------------
// Fakes — no CLI, no session, no network.
// ---------------------------------------------------------------------------

interface ThreadSpec {
  id: string | null;
  reply: RunResult;
}

class FakeThread implements CodexThreadLike {
  readonly prompts: string[] = [];
  readonly turnOptions: Array<TurnOptions | undefined> = [];

  constructor(
    readonly id: string | null,
    private readonly reply: RunResult,
    private readonly onRun?: () => void,
  ) {}

  async run(input: string, options?: TurnOptions): Promise<RunResult> {
    this.prompts.push(input);
    this.turnOptions.push(options);
    this.onRun?.();
    return this.reply;
  }
}

class FakeCodex implements CodexLike {
  readonly threads: FakeThread[] = [];
  readonly startOptions: Array<ThreadOptions | undefined> = [];
  readonly resumes: Array<{ id: string; options: ThreadOptions | undefined }> = [];

  constructor(
    private readonly specs: ThreadSpec[],
    private readonly onRun?: () => void,
  ) {}

  startThread(options?: ThreadOptions): CodexThreadLike {
    this.startOptions.push(options);
    return this.take();
  }

  resumeThread(id: string, options?: ThreadOptions): CodexThreadLike {
    this.resumes.push({ id, options });
    return this.take();
  }

  /** Threads are handed out in order; the last spec repeats if more are asked for. */
  private take(): FakeThread {
    const spec = this.specs[Math.min(this.threads.length, this.specs.length - 1)];
    const thread = new FakeThread(spec?.id ?? null, spec?.reply ?? turn("{}"), this.onRun);
    this.threads.push(thread);
    return thread;
  }
}

function turn(finalResponse: string, extra: Partial<RunResult> = {}): RunResult {
  return { items: [], finalResponse, usage: null, ...extra };
}

function usage(over: Partial<CodexUsage> = {}): CodexUsage {
  return {
    input_tokens: 0,
    cached_input_tokens: 0,
    cache_write_input_tokens: 0,
    output_tokens: 0,
    reasoning_output_tokens: 0,
    ...over,
  };
}

const SCHEMA = { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] };

/** {@link SCHEMA} as the adapter sends it: OpenAI's strict structured-output dialect. */
const STRICT_SCHEMA = { ...SCHEMA, additionalProperties: false };

function request(over: Partial<AgentRequest> = {}): AgentRequest {
  return {
    prompt: "Find correctness bugs in src/auth.ts",
    cwd: "/repo/worktree",
    schema: SCHEMA,
    label: "Find/agent#1",
    tools: { allowEdits: true },
    hitl: {
      onPermission: async () => ({ behavior: "allow" as const }),
      onAsk: async () => ({}),
    },
    ...over,
  };
}

function control(signal: AbortSignal = new AbortController().signal): { signal: AbortSignal } {
  return { signal };
}

// ---------------------------------------------------------------------------

describe("createCodexProvider", () => {
  it("is pure at construction and declares native structured output", () => {
    // No `codex` passed: this must not reach for a credential, a CLI, or a socket.
    const provider = createCodexProvider();
    expect(provider.id).toBe("codex");
    expect(provider.capabilities()).toEqual({
      structured: "native",
      permissionHook: false,
      sessionResume: true,
      reportsUsd: false,
    });
    expect(createCodexProvider({ id: "codex-alt" }).id).toBe("codex-alt");
  });

  it("parses the final response into a structured output and reports the thread id", async () => {
    const codex = new FakeCodex([{ id: "thread-7f3a", reply: turn('{"ok":true,"findings":[]}') }]);
    const provider = createCodexProvider({ codex });

    const result = await provider.run(request(), control());

    expect(result.output).toEqual({ ok: true, findings: [] });
    expect(result.sessionId).toBe("thread-7f3a");
    // Post-hoc scope: the engine's worktree diff is the authority on touched files.
    expect(result.filesTouched).toEqual([]);
  });

  it("adapts the wire schema to OpenAI's strict dialect before sending it", async () => {
    // Without this the API answers 400 invalid_json_schema and the step never runs:
    // `additionalProperties` is required to be present and false on every object, and
    // every property must be listed in `required` — including ones the engine's wire
    // schema leaves out because they carry a Zod default.
    const codex = new FakeCodex([{ id: "t1", reply: turn('{"ok":true}') }]);
    const provider = createCodexProvider({ codex });

    await provider.run(
      request({
        schema: {
          type: "object",
          properties: {
            summary: { type: "string" },
            modules: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  id: { type: "string" },
                  dependsOn: { type: "array", items: { type: "string" }, default: [] },
                },
                required: ["id"],
              },
            },
          },
          required: ["summary", "modules"],
        },
      }),
      control(),
    );

    const sent = codex.threads[0]?.turnOptions[0]?.outputSchema as Record<string, any>;
    expect(sent.additionalProperties).toBe(false);
    expect(sent.required).toEqual(["summary", "modules"]);

    const item = sent.properties.modules.items;
    expect(item.additionalProperties).toBe(false);
    // `dependsOn` had a default and was therefore absent from `required`.
    expect(item.required).toEqual(["id", "dependsOn"]);
    // Adapting must not mutate the engine's schema in place.
    expect(item.properties.dependsOn.default).toEqual([]);
  });

  it("leaves a non-object schema alone", async () => {
    const codex = new FakeCodex([{ id: "t1", reply: turn('"hi"') }]);
    const provider = createCodexProvider({ codex });

    await provider.run(request({ schema: { type: "string" } }), control());

    expect(codex.threads[0]?.turnOptions[0]?.outputSchema).toEqual({ type: "string" });
  });

  it("maps Codex usage onto the engine's shape and leaves pricing to the engine", async () => {
    const codex = new FakeCodex([
      {
        id: "t1",
        reply: turn("{}", {
          usage: usage({ input_tokens: 1200, cached_input_tokens: 800, output_tokens: 340 }),
        }),
      },
    ]);

    const result = await createCodexProvider({ codex }).run(request(), control());

    expect(result.usage).toEqual({ input: 1200, output: 340, cacheRead: 800 });
    expect(result.usage.usd).toBeUndefined();
  });

  it("reads a null usage block as zeros and omits an empty cache read", async () => {
    const codex = new FakeCodex([{ id: "t1", reply: turn("{}") }]);

    const result = await createCodexProvider({ codex }).run(request(), control());

    expect(result.usage).toEqual({ input: 0, output: 0 });
    expect("cacheRead" in result.usage).toBe(false);
  });

  it("passes the step schema through as outputSchema and pins the thread options", async () => {
    const codex = new FakeCodex([{ id: "t1", reply: turn("{}") }]);

    await createCodexProvider({ codex }).run(
      request({ model: "gpt-5-codex", effort: "high", timeoutMs: 60_000 }),
      control(),
    );

    expect(codex.startOptions[0]).toEqual({
      workingDirectory: "/repo/worktree",
      sandboxMode: "workspace-write",
      skipGitRepoCheck: true,
      approvalPolicy: "never",
      model: "gpt-5-codex",
      modelReasoningEffort: "high",
    });
    const opts = codex.threads[0]?.turnOptions[0];
    expect(opts?.outputSchema).toEqual(STRICT_SCHEMA);
    expect(opts?.signal).toBeInstanceOf(AbortSignal);
  });

  it("releases a chunked long-deadline timer once the turn completes", async () => {
    vi.useFakeTimers();
    try {
      const codex = new FakeCodex([{ id: "t1", reply: turn("{}") }]);
      const before = vi.getTimerCount();
      // 30 days outlives Node's timer ceiling, so the deadline arms in chunks;
      // a SUCCESSFUL turn used to leave the live chunk (and the request it
      // closes over) pinned until day 30 — one leak per completed call.
      await createCodexProvider({ codex }).run(request({ timeoutMs: 30 * 86_400_000 }), control());
      expect(vi.getTimerCount()).toBe(before);
    } finally {
      vi.useRealTimers();
    }
  });

  it("reserves the configured JSON output for the final message", async () => {
    const codex = new FakeCodex([{ id: "t1", reply: turn("{}") }]);

    await createCodexProvider({ codex }).run(request(), control());

    const prompt = codex.threads[0]?.prompts[0] ?? "";
    expect(prompt.startsWith("Find correctness bugs in src/auth.ts")).toBe(true);
    expect(prompt).toContain("## Output");
    expect(prompt).toContain("Do not emit the required JSON while you are still working");
    expect(prompt).toContain("Only when all work is complete");
    expect(prompt).not.toContain(JSON.stringify(SCHEMA));
  });

  it("gives a read-only step the strictest sandbox mode", async () => {
    const codex = new FakeCodex([{ id: "t1", reply: turn("{}") }]);

    await createCodexProvider({ codex }).run(request({ tools: { allowEdits: false } }), control());

    expect(codex.startOptions[0]?.sandboxMode).toBe("read-only");
  });

  it("maps Codex-specific step options without allowing a sandbox widening", async () => {
    const codex = new FakeCodex([{ id: "t1", reply: turn("{}") }]);
    const provider = createCodexProvider({ codex });

    await provider.run(
      request({
        providerOptions: {
          sandboxMode: "read-only",
          networkAccess: false,
          webSearch: "cached",
        },
      }),
      control(),
    );

    expect(codex.startOptions[0]).toMatchObject({
      sandboxMode: "read-only",
      networkAccessEnabled: false,
      webSearchMode: "cached",
    });
    await expect(
      provider.run(
        request({ tools: { allowEdits: false }, providerOptions: { sandboxMode: "workspace-write" } }),
        control(),
      ),
    ).rejects.toThrow(/cannot widen a read-only Weft step/);
    expect(() => provider.validateOptions?.({ approvalPolicy: "on-request" })).toThrow(
      /unknown provider option/,
    );
  });

  it.each([
    { allowEdits: false, parent: ":read-only" },
    { allowEdits: true, parent: ":workspace" },
  ])("denies protected task roots with a $parent permission profile", async ({ allowEdits, parent }) => {
    const created: CodexOptions[] = [];
    const codex = new FakeCodex([{ id: "t1", reply: turn('{"ok":true}') }]);
    const provider = createCodexProvider({
      codexFactory: (options) => {
        created.push(options);
        return codex;
      },
    });

    await provider.run(
      request({
        tools: { allowEdits },
        protectedPaths: ["/var/weft/tasks", "/repo/.weft/tasks", "/repo/.weft/tasks"],
        taskContext: {
          workflowId: "review",
          workflowName: "review",
          runId: "run-1",
          step: "review",
          provider: "codex",
          mode: allowEdits ? "write" : "read",
        },
      }),
      control(),
    );

    expect(created).toEqual([
      {
        configOverrides: [
          'default_permissions="weft_task_boundary"',
          `permissions.weft_task_boundary.extends=${JSON.stringify(parent)}`,
          'permissions.weft_task_boundary.filesystem={"/repo/.weft/tasks"="deny","/var/weft/tasks"="deny"}',
        ],
      },
    ]);
    expect(codex.startOptions[0]).not.toHaveProperty("sandboxMode");
    expect(codex.startOptions[0]).toMatchObject({
      workingDirectory: "/repo/worktree",
      approvalPolicy: "never",
    });
  });

  it("reuses the same protected client when repairing its session", async () => {
    const created: CodexOptions[] = [];
    const codex = new FakeCodex([
      { id: "t1", reply: turn("invalid") },
      { id: "t1", reply: turn('{"ok":true}') },
    ]);
    const provider = createCodexProvider({
      codexFactory: (options) => {
        created.push(options);
        return codex;
      },
    });
    const req = request({ protectedPaths: ["/repo/.weft/tasks"] });

    const first = await provider.run(req, control());
    await provider.repair(first.sessionId, req, [{ path: "ok", message: "required" }], control());

    expect(created).toHaveLength(1);
    expect(codex.resumes).toHaveLength(1);
  });

  it("fails closed when protected paths are relative or a shared client's profile is unknown", async () => {
    const codex = new FakeCodex([{ id: "t1", reply: turn("{}") }]);
    const provider = createCodexProvider({ codex });

    await expect(provider.run(request({ protectedPaths: [".weft/tasks"] }), control())).rejects.toThrow(
      /protected path must be absolute/,
    );
    await expect(provider.run(request({ protectedPaths: ["/repo/.weft/tasks"] }), control())).rejects.toThrow(
      /protected paths require codexFactory/,
    );
    expect(codex.threads).toHaveLength(0);
  });

  it("returns the raw string when the final response will not parse", async () => {
    const codex = new FakeCodex([{ id: "t1", reply: turn("I could not find anything conclusive.") }]);

    const result = await createCodexProvider({ codex }).run(request(), control());

    // The engine schema-fails this and repair gets a turn; the work is not thrown away.
    expect(result.output).toBe("I could not find anything conclusive.");
  });

  it("unwraps a fenced JSON block", async () => {
    const codex = new FakeCodex([{ id: "t1", reply: turn('```json\n{"ok":true}\n```') }]);

    const result = await createCodexProvider({ codex }).run(request(), control());

    expect(result.output).toEqual({ ok: true });
  });

  it("renders the turn's items into a transcript", async () => {
    const items: ThreadItem[] = [
      { id: "i0", type: "reasoning", text: "  check the token check  " },
      {
        id: "i1",
        type: "command_execution",
        command: "rg TODO",
        aggregated_output: "",
        exit_code: 0,
        status: "completed",
      },
      {
        id: "i2",
        type: "file_change",
        changes: [{ path: "src/auth.ts", kind: "update" }],
        status: "completed",
      },
      { id: "i3", type: "agent_message", text: '{"ok":false}' },
      { id: "i4", type: "agent_message", text: '{"ok":true}' },
      { id: "i5", type: "agent_message", text: "   " },
    ];
    const codex = new FakeCodex([{ id: "t1", reply: turn('{"ok":true}', { items }) }]);

    const result = await createCodexProvider({ codex }).run(request(), control());

    expect(result.transcript).toBe(
      [
        "reasoning: check the token check",
        "exec (exit 0): rg TODO",
        "files (completed): update src/auth.ts",
        'assistant: {"ok":false}',
        'assistant (final): {"ok":true}',
      ].join("\n"),
    );
  });

  it("repairs by resuming the session with the issues listed", async () => {
    const codex = new FakeCodex([
      { id: "t1", reply: turn("nope") },
      { id: "t1", reply: turn('{"ok":true}') },
    ]);
    const provider = createCodexProvider({ codex });
    const req = request();

    const first = await provider.run(req, control());
    const repaired = await provider.repair(
      first.sessionId,
      req,
      [{ path: "ok", message: "Invalid input: expected boolean" }],
      control(),
    );

    expect(codex.resumes).toEqual([
      { id: "t1", options: expect.objectContaining({ workingDirectory: "/repo/worktree" }) },
    ]);
    const prompt = codex.threads[1]?.prompts[0] ?? "";
    expect(prompt).toContain("did not validate against the required schema");
    expect(prompt).toContain("- ok: Invalid input: expected boolean");
    expect(prompt).toContain("Produce the corrected JSON object only");
    expect(codex.threads[1]?.turnOptions[0]?.outputSchema).toEqual(STRICT_SCHEMA);
    expect(repaired.output).toEqual({ ok: true });
  });

  it("repairs with a fresh thread when there is no session to resume", async () => {
    const codex = new FakeCodex([{ id: "t1", reply: turn('{"ok":true}') }]);

    const result = await createCodexProvider({ codex }).repair(
      undefined,
      request(),
      [{ path: "", message: "Invalid input: expected object" }],
      control(),
    );

    expect(codex.resumes).toEqual([]);
    expect(codex.startOptions).toHaveLength(1);
    // A fresh run, so it carries the full prompt rather than the repair one.
    expect(codex.threads[0]?.prompts[0]).toContain("Find correctness bugs in src/auth.ts");
    expect(result.output).toEqual({ ok: true });
  });

  it("throws on an already-aborted signal without touching the SDK", async () => {
    const codex = new FakeCodex([{ id: "t1", reply: turn("{}") }]);
    const controller = new AbortController();
    controller.abort();

    await expect(createCodexProvider({ codex }).run(request(), control(controller.signal))).rejects.toThrow(
      "aborted",
    );
    await expect(
      createCodexProvider({ codex }).repair("t1", request(), [], control(controller.signal)),
    ).rejects.toThrow("aborted");
    expect(codex.startOptions).toEqual([]);
    expect(codex.resumes).toEqual([]);
  });

  it("throws when the run is cancelled while the turn is in flight", async () => {
    const controller = new AbortController();
    const codex = new FakeCodex([{ id: "t1", reply: turn('{"ok":true}') }], () => controller.abort());

    await expect(createCodexProvider({ codex }).run(request(), control(controller.signal))).rejects.toThrow(
      "aborted",
    );
  });

  it("omits the session id when the thread never reported one", async () => {
    const codex = new FakeCodex([{ id: null, reply: turn('{"ok":true}') }]);

    const result = await createCodexProvider({ codex }).run(request(), control());

    expect(result.sessionId).toBeUndefined();
  });
});

describe("renderTranscript", () => {
  it("renders every item kind and skips unknown ones", () => {
    const items = [
      { id: "a", type: "mcp_tool_call", server: "weft", tool: "run", arguments: {}, status: "completed" },
      { id: "b", type: "web_search", query: "zod 4 json schema" },
      {
        id: "c",
        type: "todo_list",
        items: [
          { text: "read", completed: true },
          { text: "fix", completed: false },
        ],
      },
      { id: "d", type: "error", message: "sandbox denied write" },
      {
        id: "e",
        type: "command_execution",
        command: "pnpm test",
        aggregated_output: "",
        status: "in_progress",
      },
      { id: "f", type: "future_item_kind" },
    ] as unknown as ThreadItem[];

    expect(renderTranscript(items)).toBe(
      [
        "mcp (completed): weft.run",
        "search: zod 4 json schema",
        "todo: 1/2",
        "error: sandbox denied write",
        "exec (in_progress): pnpm test",
      ].join("\n"),
    );
  });

  it("marks only the last agent message matching the captured final response", () => {
    const items: ThreadItem[] = [
      { id: "a", type: "agent_message", text: '{"ok":true}' },
      { id: "b", type: "reasoning", text: "verify it" },
      { id: "c", type: "agent_message", text: '{"ok":true}' },
    ];

    expect(renderTranscript(items, '{"ok":true}')).toBe(
      ['assistant: {"ok":true}', "reasoning: verify it", 'assistant (final): {"ok":true}'].join("\n"),
    );
  });

  it("renders an absent or empty item list as an empty string", () => {
    expect(renderTranscript(undefined)).toBe("");
    expect(renderTranscript([])).toBe("");
  });
});
