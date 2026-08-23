import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Options } from "@anthropic-ai/claude-agent-sdk";
import type { AgentRequest, PermissionDecision, PermissionRequest } from "@weft/core";
import { describe, expect, test } from "vitest";
import {
  createClaudeProvider,
  MCP_SERVER_NAME,
  type QueryFn,
  READ_ONLY_MESSAGE,
  STRUCTURED_OUTPUT_TOOL,
} from "../src/index.ts";

const SESSION = "sess-abc-123";
const CWD = "/work/repo";
const SCHEMA = { type: "object", properties: { verdict: { type: "string" } }, required: ["verdict"] };

// ---------------------------------------------------------------------------
// Fake SDK: no network, no credentials, no subprocess.
// ---------------------------------------------------------------------------

interface Decision {
  behavior: string;
  message?: string;
}

interface Call {
  prompt: string;
  options: Options;
  /** Decisions the gate returned for the tool calls this stream pushed through it. */
  decisions: Decision[];
}

/** One scripted query() stream. `emit` boxes the payload so `undefined` stays meaningful. */
interface TurnScript {
  /** Tool calls the fake pushes through `options.canUseTool`, the way the SDK does. */
  gate?: Array<{ tool: string; input: Record<string, unknown> }>;
  emit?: { payload: unknown };
  messages?: unknown[];
}

/** The sdk-mcp server keeps its tools on a live McpServer instance; dig ours back out. */
function registeredTool(options: Options): {
  description: string;
  handler: (args: unknown, extra: unknown) => Promise<unknown>;
} {
  const entry = options.mcpServers?.[MCP_SERVER_NAME] as
    | {
        instance?: {
          _registeredTools?: Record<
            string,
            { description: string; handler: (a: unknown, e: unknown) => Promise<unknown> }
          >;
        };
      }
    | undefined;
  const found = entry?.instance?._registeredTools?.[STRUCTURED_OUTPUT_TOOL];
  if (!found) throw new Error(`${STRUCTURED_OUTPUT_TOOL} was not registered on the sdk-mcp server`);
  return found;
}

async function ask(options: Options, tool: string, input: Record<string, unknown>): Promise<Decision> {
  const gate = options.canUseTool;
  if (!gate) throw new Error("provider did not install a canUseTool gate");
  const decision = await gate(tool, input, {
    signal: new AbortController().signal,
    toolUseID: "tu1",
    requestId: "rq1",
  });
  if (!decision) throw new Error("gate returned null");
  return decision as Decision;
}

function fakeQuery(scripts: TurnScript[]): { fn: QueryFn; calls: Call[] } {
  const calls: Call[] = [];
  let index = 0;
  const fn = (params: { prompt: string; options?: Options }): AsyncGenerator<unknown, void> => {
    const options = params.options ?? {};
    const call: Call = { prompt: params.prompt, options, decisions: [] };
    calls.push(call);
    const script = scripts[Math.min(index, scripts.length - 1)] ?? {};
    index++;
    return (async function* stream(): AsyncGenerator<unknown, void> {
      for (const attempt of script.gate ?? [])
        call.decisions.push(await ask(options, attempt.tool, attempt.input));
      if (script.emit) await registeredTool(options).handler({ result: script.emit.payload }, {});
      for (const message of script.messages ?? []) yield message;
    })();
  };
  // The real Query is an AsyncGenerator plus a dozen control methods we never touch.
  return { fn: fn as unknown as QueryFn, calls };
}

function assistantText(text: string): unknown {
  return {
    type: "assistant",
    session_id: SESSION,
    uuid: "msg-1",
    parent_tool_use_id: null,
    message: {
      id: "m1",
      type: "message",
      role: "assistant",
      model: "claude-opus-5",
      content: [{ type: "text", text }],
    },
  };
}

function assistantToolUse(name: string, input: Record<string, unknown>): unknown {
  return {
    type: "assistant",
    session_id: SESSION,
    uuid: "msg-2",
    parent_tool_use_id: null,
    message: {
      id: "m2",
      type: "message",
      role: "assistant",
      model: "claude-opus-5",
      content: [{ type: "tool_use", id: "tu1", name, input }],
    },
  };
}

function resultMessage(over: Record<string, unknown> = {}): unknown {
  return {
    type: "result",
    subtype: "success",
    duration_ms: 1200,
    duration_api_ms: 900,
    is_error: false,
    num_turns: 3,
    result: "done",
    stop_reason: "end_turn",
    total_cost_usd: 0.0125,
    usage: { input_tokens: 1200, output_tokens: 340, cache_read_input_tokens: 800 },
    modelUsage: {},
    permission_denials: [],
    uuid: "res-1",
    session_id: SESSION,
    ...over,
  };
}

const allowAll = async (): Promise<PermissionDecision> => ({ behavior: "allow" });

function request(over: Partial<AgentRequest> = {}): AgentRequest {
  return {
    prompt: "Review the auth module.",
    cwd: CWD,
    schema: SCHEMA,
    label: "Review/agent#1",
    maxTurns: 12,
    onMaxTurns: "finalize",
    tools: { allowEdits: false },
    hitl: { onPermission: allowAll, onAsk: async () => ({}) },
    ...over,
  };
}

function control(signal: AbortSignal = new AbortController().signal): { signal: AbortSignal } {
  return { signal };
}

/** Run one silent-but-successful stream just to get at the gate the provider installed. */
async function gateContext(req: AgentRequest): Promise<Options> {
  const { fn, calls } = fakeQuery([{ emit: { payload: { verdict: "ok" } }, messages: [resultMessage()] }]);
  await createClaudeProvider({ queryFn: fn }).run(req, control());
  const options = calls[0]?.options;
  if (!options) throw new Error("no query() call recorded");
  return options;
}

// ---------------------------------------------------------------------------

describe("createClaudeProvider", () => {
  test("construction is inert and advertises tool-based structured output", () => {
    const provider = createClaudeProvider();
    expect(provider.id).toBe("claude");
    expect(provider.capabilities()).toEqual({
      structured: "tool",
      permissionHook: true,
      sessionResume: true,
      reportsUsd: true,
    });
    expect(createClaudeProvider({ id: "claude-fast" }).id).toBe("claude-fast");
  });

  test("run() sends the Output contract and returns the tool payload as output", async () => {
    const payload = { verdict: "ship it" };
    const { fn, calls } = fakeQuery([
      { emit: { payload }, messages: [assistantText("Looking at auth…"), resultMessage()] },
    ]);
    const provider = createClaudeProvider({ queryFn: fn });

    const result = await provider.run(request({ model: "claude-opus-5", effort: "high" }), control());

    expect(calls).toHaveLength(1);
    const call = calls[0];
    if (!call) throw new Error("no call recorded");
    expect(call.prompt).toContain("Review the auth module.");
    expect(call.prompt).toContain("## Output");
    expect(call.prompt).toContain(STRUCTURED_OUTPUT_TOOL);
    expect(call.prompt).toContain(JSON.stringify(SCHEMA));
    expect(call.options.cwd).toBe(CWD);
    expect(call.options.model).toBe("claude-opus-5");
    expect(call.options.effort).toBe("high");
    expect(call.options.maxTurns).toBe(12);
    expect(call.options.permissionMode).toBe("default");
    expect(call.options.resume).toBeUndefined();
    expect(registeredTool(call.options).description).toContain(JSON.stringify(SCHEMA));

    expect(result.output).toEqual(payload);
    expect(result.usage).toEqual({ input: 1200, output: 340, cacheRead: 800, usd: 0.0125 });
    expect(result.sessionId).toBe(SESSION);
    expect(result.transcript).toContain("assistant: Looking at auth…");
    expect(result.transcript).toContain("result: success");
    expect(result.filesTouched).toEqual([]);
  });

  test("run() reports tool names in the transcript and allowed edits in filesTouched", async () => {
    const { fn } = fakeQuery([
      {
        gate: [
          { tool: "Edit", input: { file_path: `${CWD}/src/auth/login.ts` } },
          { tool: "Edit", input: { file_path: `${CWD}/src/auth/login.ts` } },
          { tool: "Read", input: { file_path: `${CWD}/src/auth/token.ts` } },
        ],
        emit: { payload: { verdict: "ok" } },
        messages: [assistantToolUse("Edit", { file_path: `${CWD}/src/auth/login.ts` }), resultMessage()],
      },
    ]);
    const provider = createClaudeProvider({ queryFn: fn });

    const result = await provider.run(
      request({ tools: { allowEdits: true }, writeScope: { paths: ["src/auth/**"], mode: "warn" } }),
      control(),
    );

    expect(result.transcript).toContain("assistant → tool: Edit");
    // Deduped, workspace-relative, reads excluded.
    expect(result.filesTouched).toEqual(["src/auth/login.ts"]);
  });

  test("usage falls back to zeros when the result message carries none", async () => {
    const { fn } = fakeQuery([
      {
        emit: { payload: { verdict: "ok" } },
        messages: [resultMessage({ usage: {}, total_cost_usd: null })],
      },
    ]);
    const result = await createClaudeProvider({ queryFn: fn }).run(request(), control());
    expect(result.usage).toEqual({ input: 0, output: 0 });
  });
});

describe("the tool gate", () => {
  test("a read-only step denies edit tools and shell writes but allows reads", async () => {
    const options = await gateContext(request({ tools: { allowEdits: false } }));

    for (const tool of ["Edit", "Write", "MultiEdit", "NotebookEdit"]) {
      expect(
        await ask(options, tool, { file_path: `${CWD}/src/a.ts`, notebook_path: `${CWD}/a.ipynb` }),
      ).toEqual({
        behavior: "deny",
        message: READ_ONLY_MESSAGE,
      });
    }

    for (const command of [
      "rm -rf build",
      "echo hi > out.txt",
      "mv a b",
      "sed -i 's/a/b/' f.ts",
      "mkdir -p dist",
      "cat f | tee g",
      "truncate -s 0 log",
    ]) {
      expect(await ask(options, "Bash", { command })).toEqual({
        behavior: "deny",
        message: READ_ONLY_MESSAGE,
      });
    }

    // Deny-by-default: mutations no write-pattern blocklist would ever catch.
    for (const command of [
      "git checkout -- src/a.ts",
      "npm install",
      "chmod +x tool.sh",
      `python -c 'open("f","w").write("x")'`,
      "ls $(echo anything)",
      "find src -name '*.tmp' -delete",
      "xargs rm",
      "env bash -c 'touch changed'", // a launcher smuggles any command
      "sort -o clobbered input.txt", // an allow-listed reader with a write flag
      "sort -oclobbered input.txt", // ...in its ATTACHED spelling
      "sort -ro clobbered input.txt", // ...clustered: the trailing o still takes a file
      "sort --output=clobbered input.txt",
      "uniq input.txt clobbered", // the second positional IS uniq's output file
      "uniq - clobbered", // stdin in, still a written output
    ]) {
      expect(await ask(options, "Bash", { command }), command).toEqual({
        behavior: "deny",
        message: READ_ONLY_MESSAGE,
      });
    }

    expect(await ask(options, "Read", { file_path: `${CWD}/src/a.ts` })).toEqual({ behavior: "allow" });
    expect(await ask(options, "Bash", { command: "rg -n 'todo' src 2>&1" })).toEqual({ behavior: "allow" });
    expect(await ask(options, "Bash", { command: "git log --oneline | head -5 && git diff" })).toEqual({
      behavior: "allow",
    });
    expect(await ask(options, "Bash", { command: "find src -name '*.ts'" })).toEqual({ behavior: "allow" });
    expect(await ask(options, "Bash", { command: "sort -u -r input.txt | head" })).toEqual({
      behavior: "allow",
    });
    expect(await ask(options, "Bash", { command: "sort input.txt | uniq -c" })).toEqual({
      behavior: "allow",
    });
    expect(await ask(options, "Bash", { command: "uniq input.txt" })).toEqual({ behavior: "allow" });
    expect(await ask(options, "Grep", { pattern: "todo" })).toEqual({ behavior: "allow" });
  });

  test("the terminating tool is never gated, even read-only", async () => {
    const options = await gateContext(request({ tools: { allowEdits: false } }));
    expect(await ask(options, `mcp__${MCP_SERVER_NAME}__${STRUCTURED_OUTPUT_TOOL}`, { result: {} })).toEqual({
      behavior: "allow",
    });
  });

  test("strict write scope denies out-of-scope edits and allows scope plus also", async () => {
    const options = await gateContext(
      request({
        tools: { allowEdits: true },
        writeScope: { paths: ["src/auth/**"], also: ["pnpm-lock.yaml"], mode: "strict" },
      }),
    );

    expect(await ask(options, "Edit", { file_path: `${CWD}/src/auth/login.ts` })).toEqual({
      behavior: "allow",
    });
    expect(await ask(options, "Write", { file_path: "pnpm-lock.yaml" })).toEqual({ behavior: "allow" });

    const denial = await ask(options, "Edit", { file_path: `${CWD}/src/billing/charge.ts` });
    expect(denial.behavior).toBe("deny");
    expect(denial.message).toContain("src/billing/charge.ts");
    expect(denial.message).toContain("write scope");
    // Escaping the tree is out of scope too.
    expect((await ask(options, "Edit", { file_path: "/etc/hosts" })).behavior).toBe("deny");
  });

  test("warn write scope lets an out-of-scope edit land for the post-hoc check to flag", async () => {
    const options = await gateContext(
      request({ tools: { allowEdits: true }, writeScope: { paths: ["src/auth/**"], mode: "warn" } }),
    );
    expect(await ask(options, "Edit", { file_path: `${CWD}/src/billing/charge.ts` })).toEqual({
      behavior: "allow",
    });
  });

  test("push/publish/deploy commands go to the HITL broker at risk high", async () => {
    const seen: PermissionRequest[] = [];
    const decide = async (req: PermissionRequest): Promise<PermissionDecision> => {
      seen.push(req);
      return String((req.input as { command?: unknown }).command).includes("npm publish")
        ? { behavior: "deny", message: "release needs a human" }
        : { behavior: "allow" };
    };
    const options = await gateContext(
      request({ tools: { allowEdits: true }, hitl: { onPermission: decide, onAsk: async () => ({}) } }),
    );

    expect(await ask(options, "Bash", { command: "git push origin main" })).toEqual({ behavior: "allow" });
    // Global git options must not smuggle a push past the broker.
    expect(await ask(options, "Bash", { command: "git -C . push origin HEAD:main" })).toEqual({
      behavior: "allow",
    });
    expect(await ask(options, "Bash", { command: "npm publish --access public" })).toEqual({
      behavior: "deny",
      message: "release needs a human",
    });
    // Quoting must not smuggle a push past the broker: the shell resolves
    // `git p'u'sh` to `git push` before git ever sees it.
    expect(await ask(options, "Bash", { command: "git p'u'sh origin main" })).toEqual({
      behavior: "allow",
    });
    expect(await ask(options, "Bash", { command: 'git "push" origin main' })).toEqual({
      behavior: "allow",
    });
    expect(await ask(options, "Bash", { command: "git -C . 'pu'sh origin HEAD:main" })).toEqual({
      behavior: "allow",
    });
    // Ordinary commands never reach the broker.
    expect(await ask(options, "Bash", { command: "pnpm test" })).toEqual({ behavior: "allow" });
    expect(await ask(options, "Bash", { command: "git commit -m x" })).toEqual({ behavior: "allow" });

    expect(seen).toHaveLength(6);
    expect(seen.every((r) => r.risk === "high")).toBe(true);
    expect(seen[0]?.tool).toBe("Bash");
  });

  test("a strict write scope denies shell writes aimed outside the worktree", async () => {
    const options = await gateContext(
      request({ tools: { allowEdits: true }, writeScope: { paths: ["src/**"], mode: "strict" } }),
    );
    // Patch capture sees only the worktree: an absolute/home-anchored write escapes it.
    for (const command of [
      `printf x > "$HOME/.config/tool"`,
      "cp secrets.txt /tmp/exfil.txt",
      "touch ~/marker",
      // Relative traversal escapes just as surely as an absolute path.
      "printf x > ../../outside",
      "cp secrets.txt ../sibling.txt",
      "mv notes.txt ..",
      // Writers isWriteCommand cannot recognize still get the boundary check.
      `python -c 'open("/tmp/out","w").write("x")'`,
      "unknown-tool --config /etc/passwd",
    ]) {
      const denial = await ask(options, "Bash", { command });
      expect(denial.behavior, command).toBe("deny");
    }
    // Traversal-free relative writes land in the worktree, get captured, and stay allowed.
    expect(await ask(options, "Bash", { command: "printf x > notes.txt" })).toEqual({ behavior: "allow" });
    expect(await ask(options, "Bash", { command: "printf x > sub/dir/notes.txt" })).toEqual({
      behavior: "allow",
    });
    expect(await ask(options, "Bash", { command: "pnpm test > /dev/null 2>&1" })).toEqual({
      behavior: "allow",
    });
  });

  test("a strict write scope denies writes through a symlink that escapes the worktree", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "weft-gate-"));
    const outside = await mkdtemp(join(tmpdir(), "weft-outside-"));
    await symlink(join(outside, "target"), join(cwd, "link"));
    await mkdir(join(cwd, "sub"));
    await symlink(outside, join(cwd, "sub", "esc"), "dir");
    try {
      const options = await gateContext(
        request({ cwd, tools: { allowEdits: true }, writeScope: { paths: ["**"], mode: "strict" } }),
      );
      // Lexically in-tree (no absolute path, no ..) — physically outside.
      expect((await ask(options, "Bash", { command: "printf x > link" })).behavior).toBe("deny");
      expect((await ask(options, "Bash", { command: "cp notes.txt sub/esc/stolen" })).behavior).toBe("deny");
      // The Edit tool goes through the same resolution.
      const edit = await ask(options, "Edit", {
        file_path: join(cwd, "link"),
        old_string: "a",
        new_string: "b",
      });
      expect(edit.behavior).toBe("deny");
      // Ordinary relative writes — including files that do not exist yet — stay allowed.
      expect(await ask(options, "Bash", { command: "printf x > notes.txt" })).toEqual({
        behavior: "allow",
      });
      expect(await ask(options, "Bash", { command: "printf x > sub/notes.txt" })).toEqual({
        behavior: "allow",
      });
    } finally {
      await rm(cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
      await rm(outside, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  test("tools.deny removes a tool outright", async () => {
    const options = await gateContext(request({ tools: { allowEdits: true, deny: ["WebFetch"] } }));
    const denial = await ask(options, "WebFetch", { url: "https://example.com" });
    expect(denial.behavior).toBe("deny");
    expect(denial.message).toContain("WebFetch");
  });
});

describe("finalize, repair and abort", () => {
  test("a silent stream is finalized by one resumed turn", async () => {
    const { fn, calls } = fakeQuery([
      {
        messages: [
          assistantText("I think it is fine."),
          resultMessage({
            subtype: "error_max_turns",
            usage: { input_tokens: 900, output_tokens: 100 },
            total_cost_usd: 0,
          }),
        ],
      },
      {
        emit: { payload: { verdict: "fine" } },
        messages: [resultMessage({ total_cost_usd: 0.002, usage: { input_tokens: 100, output_tokens: 20 } })],
      },
    ]);
    const provider = createClaudeProvider({ queryFn: fn });

    const result = await provider.run(request({ onMaxTurns: "finalize" }), control());

    expect(calls).toHaveLength(2);
    expect(calls[1]?.prompt).toBe(
      `Call ${STRUCTURED_OUTPUT_TOOL} now with your best final answer matching the schema.`,
    );
    expect(calls[1]?.options.resume).toBe(SESSION);
    expect(result.output).toEqual({ verdict: "fine" });
    // Usage adds up across both turns of the same step.
    expect(result.usage.input).toBe(1000);
    expect(result.usage.output).toBe(120);
    expect(result.usage.usd).toBeCloseTo(0.002, 6);
    expect(result.transcript).toContain("result: error_max_turns");
  });

  test("onMaxTurns fail does not spend a second turn", async () => {
    const { fn, calls } = fakeQuery([{ messages: [resultMessage({ subtype: "error_max_turns" })] }]);
    const provider = createClaudeProvider({ queryFn: fn });
    await expect(provider.run(request({ onMaxTurns: "fail" }), control())).rejects.toThrow(
      /without calling structured_output/,
    );
    expect(calls).toHaveLength(1);
  });

  test("a finalize turn that stays silent still fails the step", async () => {
    const { fn, calls } = fakeQuery([{ messages: [resultMessage({ subtype: "error_max_turns" })] }]);
    const provider = createClaudeProvider({ queryFn: fn });
    await expect(provider.run(request({ onMaxTurns: "finalize" }), control())).rejects.toThrow(
      /without calling structured_output/,
    );
    expect(calls).toHaveLength(2);
  });

  test("repair() resumes the session with the validation issues", async () => {
    const { fn, calls } = fakeQuery([
      { emit: { payload: { verdict: "corrected" } }, messages: [resultMessage()] },
    ]);
    const provider = createClaudeProvider({ queryFn: fn });

    const result = await provider.repair(
      SESSION,
      request(),
      [
        { path: "verdict", message: "expected string, got number" },
        { path: "", message: "unrecognized key: extra" },
      ],
      control(),
    );

    expect(calls).toHaveLength(1);
    const prompt = calls[0]?.prompt ?? "";
    expect(prompt).toContain("- verdict: expected string, got number");
    expect(prompt).toContain("- (root): unrecognized key: extra");
    expect(prompt).toContain(`Call ${STRUCTURED_OUTPUT_TOOL} again with a corrected object`);
    expect(prompt).toContain(JSON.stringify(SCHEMA));
    expect(calls[0]?.options.resume).toBe(SESSION);
    expect(result.output).toEqual({ verdict: "corrected" });
  });

  test("repair() without a session id starts a fresh run", async () => {
    const { fn, calls } = fakeQuery([
      { emit: { payload: { verdict: "fresh" } }, messages: [resultMessage()] },
    ]);
    const provider = createClaudeProvider({ queryFn: fn });

    const result = await provider.repair(
      undefined,
      request(),
      [{ path: "verdict", message: "required" }],
      control(),
    );

    expect(calls[0]?.options.resume).toBeUndefined();
    expect(calls[0]?.prompt).toContain("## Output");
    expect(result.output).toEqual({ verdict: "fresh" });
  });

  test("an already-aborted control signal reaches the SDK abort controller", async () => {
    const { fn, calls } = fakeQuery([{ emit: { payload: { verdict: "ok" } }, messages: [resultMessage()] }]);
    const provider = createClaudeProvider({ queryFn: fn });
    const ac = new AbortController();
    ac.abort(new Error("run cancelled"));

    await provider.run(request(), control(ac.signal));

    const controller = calls[0]?.options.abortController;
    if (!controller) throw new Error("provider did not pass an abortController to the SDK");
    expect(controller.signal.aborted).toBe(true);
    expect((controller.signal.reason as Error).message).toBe("run cancelled");
  });

  test("the abort listener is torn down with the stream", async () => {
    const { fn, calls } = fakeQuery([{ emit: { payload: { verdict: "ok" } }, messages: [resultMessage()] }]);
    const provider = createClaudeProvider({ queryFn: fn });
    const ac = new AbortController();

    await provider.run(request(), control(ac.signal));
    const controller = calls[0]?.options.abortController;
    expect(controller?.signal.aborted).toBe(false);

    ac.abort(new Error("too late"));
    expect(controller?.signal.aborted).toBe(false);
  });
});
