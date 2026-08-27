import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Options } from "@anthropic-ai/claude-agent-sdk";
import type { AgentRequest, PermissionDecision, PermissionRequest } from "@techery/weft-core";
import { describe, expect, test } from "vitest";
import {
  createClaudeProvider,
  MCP_SERVER_NAME,
  type QueryFn,
  READ_ONLY_MESSAGE,
  STRUCTURED_OUTPUT_TOOL,
} from "../src/index.ts";
import { GIT_READ_WRAPPER, isRiskyCommand, mutatesSharedGitMetadata } from "../src/tools.ts";

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
  inputSchema: { safeParse(value: unknown): { success: boolean } };
  handler: (args: unknown, extra: unknown) => Promise<unknown>;
} {
  const entry = options.mcpServers?.[MCP_SERVER_NAME] as
    | {
        instance?: {
          _registeredTools?: Record<
            string,
            {
              description: string;
              inputSchema: { safeParse(value: unknown): { success: boolean } };
              handler: (a: unknown, e: unknown) => Promise<unknown>;
            }
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
      if (script.emit) {
        // The sdk-mcp server validates arguments against the declared shape BEFORE it
        // dispatches, so the harness must too. Calling the handler directly let tests
        // assert behaviour for payloads production rejects at the boundary — two of them
        // contradicted each other for exactly that reason.
        const registered = registeredTool(options);
        if (registered.inputSchema.safeParse({ result: script.emit.payload }).success) {
          await registered.handler({ result: script.emit.payload }, {});
        }
      }
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

  test("maps Claude-specific permission mode and rejects unknown mechanics", async () => {
    const { fn, calls } = fakeQuery([{ emit: { payload: { verdict: "ok" } }, messages: [resultMessage()] }]);
    const provider = createClaudeProvider({ queryFn: fn });

    await provider.run(request({ providerOptions: { permissionMode: "dontAsk" } }), control());

    expect(calls[0]?.options.permissionMode).toBe("dontAsk");
    expect(() => provider.validateOptions?.({ sandboxMode: "workspace-write" })).toThrow(
      /unknown provider option/,
    );
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
      "find . -maxdepth 0 -fls smuggled.txt", // find's f-actions WRITE to a named file
      "xargs rm",
      "env bash -c 'touch changed'", // a launcher smuggles any command
      "sort -o clobbered input.txt", // an allow-listed reader with a write flag
      "sort -oclobbered input.txt", // ...in its ATTACHED spelling
      "sort -ro clobbered input.txt", // ...clustered: the trailing o still takes a file
      "sort --output=clobbered input.txt",
      "uniq input.txt clobbered", // the second positional IS uniq's output file
      "uniq - clobbered", // stdin in, still a written output
      "git diff --output=clobbered", // a "read" git subcommand writing a file
      `git grep --open-files-in-pager='sh -c "touch pwn"' needle`, // grep EXECUTES its pager
      "git grep -O'touch pwn' needle", // ...attached spelling
      "git grep -iO needle", // ...clustered; bare -O still runs the default pager
      "rg --pre touch pattern src", // ripgrep EXECUTES the preprocessor on every file
      "rg --pre=touch pattern src",
      "GIT_EXTERNAL_DIFF=touch git diff --ext-diff", // git EXECUTES the helper the env names
      "git diff --ext-diff",
      "git show --textconv HEAD", // textconv filters are external commands too
      "git show --textc HEAD", // ...and git accepts unambiguous long-option abbreviations
      "git cat-file --filters HEAD:README.md", // runs the path's clean/smudge commands
      "git cat-file --fi HEAD:README.md", // ...abbreviated down to --fi it still filters
      "git diff --out=clobbered", // abbreviation of --output writes a file all the same
      "GIT_PAGER=touch git log", // a GIT_* override on a "read" exists to steer helpers
      "GNUPGHOME=. git log --show-signature", // hands the commit to gpg --verify, which WRITES a keyring
      "git show --show-signature HEAD",
      "git log --show-si", // git accepts unambiguous long-option abbreviations here too
      "PATH=. diff -l a.txt b.txt", // -l/--paginate EXECUTES `pr` from the supplied PATH
      "diff --paginate a.txt b.txt",
      "diff --pag a.txt b.txt", // GNU getopt accepts unambiguous abbreviations
      "diff -ul a.txt b.txt", // clustered short spelling still paginates
      "PATH=. grep todo src/a.ts", // a PATH override resolves ANY reader to ./grep
      "LD_PRELOAD=./x.so cat f.txt", // loader overrides run injected code
      "./cat f.txt", // a path-qualified reader is whatever the REPO put there
      "/repo/bin/grep todo src/a.ts",
      "scripts/sort input.txt",
      "git reflog expire --expire=now --all", // reflog's mutating forms destroy recovery history
      "git reflog delete HEAD@{1}",
      "xxd input.bin clobbered.txt", // xxd's SECOND positional is an output file
      "tree -o clobbered.txt src", // tree -o sends the listing to a FILE
      "file -C -m magic", // file -C WRITES a compiled magic.mgc
      "file --compile -m magic",
      "date -s '2020-01-01'", // date -s sets the SYSTEM clock (root containers)
      "sort --o clobbered input.txt", // GNU sort abbreviates --output too
      "sort -S 10K --compress-program=./helper data.txt", // sort EXECUTES the compressor on its temp files
      "sort --comp gzip data.txt", // ...and GNU getopt abbreviates it down to --co
      "find . -e'x'ec touch changed \\;", // bash concatenates the quoted split back to -exec
      'find . -e"x"ec touch changed \\;',
      "find . -exe\\c touch changed \\;", // ...and a backslash spelling resolves the same way
      "find . -exe{c,c} touch changed \\;", // brace expansion forges options too
      "git diff --out'put'=clobbered", // quoted splits of screened long options
      "sort -'o' clobbered input.txt",
      "find . -e*ec touch changed \\;", // a glob can expand to a repo file named "-exec"
      "git diff --ou\\\nt=clobbered", // backslash-newline continuation reassembles --out
      'git diff "--ou\\\nt=clobbered"', // ...and continuations join inside double quotes too
      "printf -v PATH .", // printf -v ASSIGNS a shell variable — here, where readers resolve
      "printf -vPATH . ; cat f.txt", // attached spelling, steering the next reader in the chain
    ]) {
      expect(await ask(options, "Bash", { command }), command).toEqual({
        behavior: "deny",
        message: READ_ONLY_MESSAGE,
      });
    }

    // Read-only git commands come back allowed WRAPPED: repository config can
    // attach executable diff/textconv drivers to plain diff/log/show.
    const allowedGitRead = async (command: string) => {
      const decision = await ask(options, "Bash", { command });
      expect(decision.behavior, command).toBe("allow");
      const updated = (decision as { updatedInput?: { command?: string } }).updatedInput;
      expect(updated?.command?.endsWith(command), command).toBe(true);
      expect(updated?.command, command).toContain("--no-ext-diff --no-textconv");
      // A pathname-valued core.fsmonitor is a HOOK any worktree scan executes.
      expect(updated?.command, command).toContain("-c core.fsmonitor=false");
      // The optional index refresh is a WRITE to .git/index a read must skip.
      expect(updated?.command, command).toContain("GIT_OPTIONAL_LOCKS=0");
    };
    expect(await ask(options, "Read", { file_path: `${CWD}/src/a.ts` })).toEqual({ behavior: "allow" });
    expect(await ask(options, "Bash", { command: "rg -n 'todo' src 2>&1" })).toEqual({ behavior: "allow" });
    expect(
      await ask(options, "Bash", {
        command: "weft --cwd '/repo' task --workflow 'review' --json list",
      }),
    ).toMatchObject({ behavior: "deny" });
    expect(await ask(options, "Bash", { command: "weft run review" })).toMatchObject({ behavior: "deny" });
    expect(await ask(options, "Bash", { command: "weft task list" })).toMatchObject({ behavior: "deny" });
    await allowedGitRead("git log --oneline | head -5 && git diff");
    expect(await ask(options, "Bash", { command: "find src -name '*.ts'" })).toEqual({ behavior: "allow" });
    await allowedGitRead("git cat-file -p HEAD:README.md");
    await allowedGitRead("git grep --extended-regexp 'todo.+fix' src");
    await allowedGitRead("git log --first-parent --oneline");
    await allowedGitRead("git reflog show HEAD");
    expect(await ask(options, "Bash", { command: "xxd input.bin" })).toEqual({ behavior: "allow" });
    expect(await ask(options, "Bash", { command: "tree -L 2 -a src" })).toEqual({ behavior: "allow" });
    expect(await ask(options, "Bash", { command: "file src/a.ts" })).toEqual({ behavior: "allow" });
    expect(await ask(options, "Bash", { command: "date -u" })).toEqual({ behavior: "allow" });
    expect(await ask(options, "Bash", { command: "diff -u a.txt b.txt" })).toEqual({ behavior: "allow" });
    expect(await ask(options, "Bash", { command: "grep 'end$' src/a.ts" })).toEqual({ behavior: "allow" });
    expect(await ask(options, "Bash", { command: 'grep -c "plain text" notes.md' })).toEqual({
      behavior: "allow",
    });
    expect(await ask(options, "Bash", { command: "find . -name '*.ts' \\( -size +1k \\)" })).toEqual({
      behavior: "allow",
    });
    expect(await ask(options, "Bash", { command: "sort -u -r input.txt | head" })).toEqual({
      behavior: "allow",
    });
    expect(await ask(options, "Bash", { command: "sort --check input.txt" })).toEqual({
      behavior: "allow",
    });
    expect(await ask(options, "Bash", { command: "sort input.txt | uniq -c" })).toEqual({
      behavior: "allow",
    });
    expect(await ask(options, "Bash", { command: "uniq input.txt" })).toEqual({ behavior: "allow" });
    // Plain printf stays a reader; a line continuation joins like bash joins.
    expect(await ask(options, "Bash", { command: "printf 'x\\n' one two" })).toEqual({ behavior: "allow" });
    expect(await ask(options, "Bash", { command: "ca\\\nt notes.txt" })).toEqual({ behavior: "allow" });
    expect(await ask(options, "Grep", { pattern: "todo" })).toEqual({ behavior: "allow" });
  });

  test("the terminating tool is never gated, even read-only", async () => {
    const options = await gateContext(request({ tools: { allowEdits: false } }));
    expect(await ask(options, `mcp__${MCP_SERVER_NAME}__${STRUCTURED_OUTPUT_TOOL}`, { result: {} })).toEqual({
      behavior: "allow",
    });
  });

  test("a protected sandbox isolates task storage without disabling the write shell", async () => {
    const taskRoot = `${CWD}/.weft/tasks`;
    const options = await gateContext(
      request({
        tools: { allowEdits: true },
        writeScope: { paths: ["src/**"], mode: "warn" },
        protectedPaths: [taskRoot],
        taskContext: {
          workflowId: "review",
          workflowName: "review",
          runId: "run-1",
          step: "review",
          provider: "claude",
          mode: "write",
        },
      }),
    );

    expect(options.sandbox).toEqual({
      enabled: true,
      failIfUnavailable: true,
      autoAllowBashIfSandboxed: false,
      allowUnsandboxedCommands: false,
      filesystem: { denyRead: [taskRoot], denyWrite: [taskRoot] },
    });
    for (const command of [
      "pnpm test",
      "pnpm exec tsc --noEmit",
      "pnpm exec biome format --write src",
      "node scripts/generate.mjs",
    ]) {
      expect(await ask(options, "Bash", { command }), command).toEqual({ behavior: "allow" });
    }
    expect(await ask(options, "Bash", { command: "rg -n 'TODO' src" })).toEqual({ behavior: "allow" });
    expect(
      await ask(options, "Edit", { file_path: `${CWD}/.weft/tasks/review/task-deadbeef.json` }),
    ).toMatchObject({ behavior: "deny", message: expect.stringContaining("engine-owned") });
    expect(await ask(options, "Edit", { path: `${CWD}/src/unknown.ts` })).toMatchObject({
      behavior: "deny",
      message: expect.stringContaining("could not be verified"),
    });
  });

  test("the protected sandbox hides task storage from read-only task agents", async () => {
    const taskRoot = `${CWD}/.weft/tasks`;
    const options = await gateContext(
      request({
        tools: { allowEdits: false },
        protectedPaths: [taskRoot],
        taskContext: {
          workflowId: "review",
          workflowName: "review",
          runId: "run-1",
          step: "review",
          provider: "claude",
          mode: "read",
        },
      }),
    );

    expect(options.sandbox).toEqual({
      enabled: true,
      failIfUnavailable: true,
      autoAllowBashIfSandboxed: false,
      allowUnsandboxedCommands: false,
      filesystem: { denyRead: [taskRoot], denyWrite: [taskRoot] },
    });
  });

  test("task hosts without a protected path retain the fail-closed shell fallback", async () => {
    const options = await gateContext(
      request({
        tools: { allowEdits: true },
        taskContext: {
          workflowId: "review",
          workflowName: "review",
          runId: "run-1",
          step: "review",
          provider: "claude",
          mode: "write",
        },
      }),
    );
    expect(await ask(options, "Bash", { command: "pnpm test" })).toMatchObject({
      behavior: "deny",
      message: expect.stringContaining("did not expose a protected storage path"),
    });
  });

  test("relative protected paths fail closed before starting the SDK query", async () => {
    await expect(
      gateContext(
        request({
          protectedPaths: [".weft/tasks"],
          taskContext: {
            workflowId: "review",
            workflowName: "review",
            runId: "run-1",
            step: "review",
            provider: "claude",
            mode: "write",
          },
        }),
      ),
    ).rejects.toThrow(/protected path must be absolute/);
  });

  test("task-aware warn scopes deny edits through symlinks outside the worktree", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "weft-task-gate-"));
    const outside = await mkdtemp(join(tmpdir(), "weft-task-store-"));
    await mkdir(join(cwd, "src"));
    await symlink(outside, join(cwd, "src", "task-link"), "dir");
    try {
      const options = await gateContext(
        request({
          cwd,
          tools: { allowEdits: true },
          writeScope: { paths: ["src/**"], mode: "warn" },
          taskContext: {
            workflowId: "review",
            workflowName: "review",
            runId: "run-1",
            step: "review",
            provider: "claude",
            mode: "write",
          },
        }),
      );
      expect(
        await ask(options, "Edit", { file_path: join(cwd, "src", "task-link", "review", "task.json") }),
      ).toMatchObject({ behavior: "deny", message: expect.stringContaining("engine-owned") });
      expect(await ask(options, "Edit", { file_path: join(cwd, "src", "ordinary.ts") })).toEqual({
        behavior: "allow",
      });
    } finally {
      await rm(cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
      await rm(outside, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
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

  test("git commands are wrapped under a WRITE scope too, not just a read-only step", async () => {
    // The read gate wrapped git so a repository-configured diff/textconv driver could
    // not execute. A strict WRITE scope let the same command through unwrapped, making
    // the stronger boundary the weaker one.
    const options = await gateContext(
      request({ tools: { allowEdits: true }, writeScope: { paths: ["src/**"], mode: "strict" } }),
    );
    const decision = await ask(options, "Bash", { command: "git diff HEAD" });
    expect(decision.behavior).toBe("allow");
    expect((decision as { updatedInput?: { command?: string } }).updatedInput?.command).toContain(
      "--no-ext-diff",
    );
  });

  test("a strict scope denies an edit whose target it cannot determine", async () => {
    // Fail-open here meant the boundary stopped enforcing the moment an edit tool's
    // input shape changed upstream -- silently, and with nothing in the record.
    const strict = await gateContext(
      request({ tools: { allowEdits: true }, writeScope: { paths: ["src/**"], mode: "strict" } }),
    );
    expect((await ask(strict, "Edit", { unexpected_field: "x" })).behavior).toBe("deny");

    // `warn` still lands it; the post-hoc patch capture is what flags it there.
    const warn = await gateContext(
      request({ tools: { allowEdits: true }, writeScope: { paths: ["src/**"], mode: "warn" } }),
    );
    expect((await ask(warn, "Edit", { unexpected_field: "x" })).behavior).toBe("allow");
  });

  test("the live gate honours `!` exclusions, like the post-hoc check", async () => {
    // Both used to compile their own picomatch matcher, and picomatch's array semantics
    // report src/auth/secret.ts as a MATCH here -- so the exclusion the author wrote did
    // nothing at the one point where it could still prevent the edit.
    const options = await gateContext(
      request({
        tools: { allowEdits: true },
        writeScope: { paths: ["src/auth/**", "!src/auth/secret.ts"], mode: "strict" },
      }),
    );

    expect(await ask(options, "Edit", { file_path: `${CWD}/src/auth/login.ts` })).toEqual({
      behavior: "allow",
    });
    const denial = await ask(options, "Edit", { file_path: `${CWD}/src/auth/secret.ts` });
    expect(denial.behavior).toBe("deny");
  });

  test("a scope of only exclusions grants nothing, not everything", async () => {
    const options = await gateContext(
      request({
        tools: { allowEdits: true },
        writeScope: { paths: ["!secrets/**"], mode: "strict" },
      }),
    );
    expect((await ask(options, "Edit", { file_path: `${CWD}/anything.ts` })).behavior).toBe("deny");
    expect((await ask(options, "Edit", { file_path: `${CWD}/secrets/key.pem` })).behavior).toBe("deny");
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

    expect(await ask(options, "Bash", { command: "git push origin main" })).toMatchObject({
      behavior: "allow",
    });
    // Global git options must not smuggle a push past the broker.
    expect(await ask(options, "Bash", { command: "git -C . push origin HEAD:main" })).toMatchObject({
      behavior: "allow",
    });
    expect(await ask(options, "Bash", { command: "npm publish --access public" })).toEqual({
      behavior: "deny",
      message: "release needs a human",
    });
    // An alias defined on the command line expands inside git, out of this
    // screen's sight — any such invocation goes to approval conservatively.
    expect(await ask(options, "Bash", { command: "git -c alias.ship=push ship origin main" })).toMatchObject({
      behavior: "allow",
    });
    // Quoting must not smuggle a push past the broker: the shell resolves
    // `git p'u'sh` to `git push` before git ever sees it.
    expect(await ask(options, "Bash", { command: "git p'u'sh origin main" })).toMatchObject({
      behavior: "allow",
    });
    expect(await ask(options, "Bash", { command: 'git "push" origin main' })).toMatchObject({
      behavior: "allow",
    });
    expect(await ask(options, "Bash", { command: "git -C . 'pu'sh origin HEAD:main" })).toMatchObject({
      behavior: "allow",
    });
    // Ordinary commands never reach the broker.
    expect(await ask(options, "Bash", { command: "pnpm test" })).toEqual({ behavior: "allow" });
    expect(await ask(options, "Bash", { command: "git commit -m x" })).toMatchObject({ behavior: "allow" });

    expect(seen).toHaveLength(7);
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

  test("a strict write scope denies shared git metadata mutations (codex review round 57, PR #1)", async () => {
    const options = await gateContext(
      request({ tools: { allowEdits: true }, writeScope: { paths: ["src/**"], mode: "strict" } }),
    );
    // A linked worktree's `git config` writes the INTEGRATION repository's
    // shared .git/config: no path in the command, nothing for patch capture to
    // see, and the planted value outlives the step.
    for (const command of [
      "git config weft.marker changed",
      "git config core.fsmonitor ./hook.sh",
      "git config user.email x", // deny-by-default: even the read spelling is refused
      "git con'fig' weft.marker changed", // quoting resolves before git sees its words
      "git -C . config weft.marker changed",
      "git remote add mirror ./elsewhere", // remotes live in the same shared config
      "git gc --prune=now", // prunes SHARED objects other steps still reference
      "git worktree prune",
      "git update-ref refs/heads/main HEAD",
      "git reflog expire --all",
      "echo ok && git config weft.marker changed", // any segment in a chain counts
      // Shared REFS are repository metadata too: a branch, tag, note, stash
      // entry, or remote-tracking ref created from the worktree lands in the
      // integration repository, invisible to patch capture and cleanup.
      "git branch leaked",
      "git checkout -b leaked",
      "git switch -c leaked",
      "git tag leaked",
      "git stash", // moves the step's OWN changes out of patch capture's sight
      "git notes add -m x",
      "git fetch origin",
      "git pull origin main",
      // Wrappers re-execute their tail: the metadata screen must see through
      // them, not just the segment's first word.
      "command git branch leaked",
      "env git branch leaked",
      "sh -c 'git branch leaked'",
      "nice -n 10 git config weft.marker changed",
      "nohup git fetch origin",
    ]) {
      const denial = await ask(options, "Bash", { command });
      expect(denial.behavior, command).toBe("deny");
    }
    // Worktree-local git stays available to a write agent.
    expect(await ask(options, "Bash", { command: "git status" })).toMatchObject({ behavior: "allow" });
    expect(await ask(options, "Bash", { command: "git add src/a.ts" })).toMatchObject({ behavior: "allow" });
    expect(await ask(options, "Bash", { command: "git diff HEAD" })).toMatchObject({ behavior: "allow" });
    expect(mutatesSharedGitMetadata("git commit -m config")).toBe(false); // an ARGUMENT named config is fine
  });

  test("the read wrapper suppresses a core.fsmonitor hook (codex review round 57, PR #1)", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "weft-fsmon-"));
    try {
      const git = (...args: string[]) => execFileSync("git", args, { cwd });
      git("init", "-q");
      git("config", "user.email", "t@t");
      git("config", "user.name", "t");
      await writeFile(join(cwd, "a.txt"), "x\n");
      git("add", "-A");
      git("commit", "-qm", "init");
      const marker = join(cwd, "fsmonitor-ran");
      await writeFile(join(cwd, "hook.sh"), `#!/bin/sh\ntouch ${marker}\necho /\n`, { mode: 0o755 });
      git("config", "core.fsmonitor", "./hook.sh");
      // The vector is real: an UNWRAPPED status executes the configured hook.
      execFileSync("bash", ["-c", "git status"], { cwd, stdio: "ignore" });
      expect(existsSync(marker)).toBe(true);
      await rm(marker, { force: true });
      // Wrapped the way the read gate rewrites every git command, it must not.
      execFileSync("bash", ["-c", `${GIT_READ_WRAPPER}git status && git diff && git ls-files`], {
        cwd,
        stdio: "ignore",
      });
      expect(existsSync(marker)).toBe(false);
      // blame runs .gitattributes textconv by DEFAULT (it has no ext-diff
      // path): the wrapper's blame branch must disable it too.
      await writeFile(join(cwd, ".gitattributes"), "*.txt diff=evil\n");
      const tcMarker = join(cwd, "textconv-ran");
      execFileSync("git", ["config", "diff.evil.textconv", `touch ${tcMarker} && cat`], { cwd });
      execFileSync("bash", ["-c", "git blame a.txt"], { cwd, stdio: "ignore" });
      expect(existsSync(tcMarker)).toBe(true);
      await rm(tcMarker, { force: true });
      execFileSync("bash", ["-c", `${GIT_READ_WRAPPER}git blame a.txt`], { cwd, stdio: "ignore" });
      expect(existsSync(tcMarker)).toBe(false);
      // The optional index refresh is a WRITE: after a tracked file's stat
      // info changes, a plain `git status` rewrites .git/index — the wrapped
      // one (GIT_OPTIONAL_LOCKS=0) must leave it untouched.
      // Only the direction that is guaranteed is asserted. The index refresh is
      // OPTIONAL — git documents it as an optimisation it may skip — so "an unwrapped
      // status rewrites .git/index" is not a property git offers, and asserting it made
      // this test fail about one run in six for a reason unrelated to the wrapper. What
      // the wrapper promises is the other direction, and that holds every time.
      const shifted = new Date(Date.now() - 60_000);
      await utimes(join(cwd, "a.txt"), shifted, shifted);
      const index = join(cwd, ".git", "index");
      const before = (await stat(index)).mtimeMs;
      execFileSync("bash", ["-c", `${GIT_READ_WRAPPER}git status`], { cwd, stdio: "ignore" });
      expect((await stat(index)).mtimeMs).toBe(before);
    } finally {
      await rm(cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  test("a strict write scope denies COMPUTED destinations outright", async () => {
    const options = await gateContext(
      request({ tools: { allowEdits: true }, writeScope: { paths: ["src/**"], mode: "strict" } }),
    );
    // A token the shell computes at run time can become a destination no
    // lexical screen sees — here the integration repository's own config.
    for (const command of [
      'd=$(git rev-parse --git-common-dir); printf x > "$d/config"',
      'printf x > "`git rev-parse --git-common-dir`/config"',
      "cat notes.txt > $DEST",
      "tee >(sh) < notes.txt",
    ]) {
      const denial = await ask(options, "Bash", { command });
      expect(denial.behavior, command).toBe("deny");
    }
  });

  test("a strict write scope brokers every writable command (codex review round 63, PR #1)", async () => {
    const seen: PermissionRequest[] = [];
    let verdict: PermissionDecision = { behavior: "deny", message: "not in this step" };
    const decide = async (req: PermissionRequest) => {
      seen.push(req);
      return verdict;
    };
    const options = await gateContext(
      request({
        tools: { allowEdits: true },
        writeScope: { paths: ["src/**"], mode: "strict" },
        hitl: { onPermission: decide, onAsk: async () => ({}) },
      }),
    );
    // No lexical screen can bound a destination computed INSIDE the program —
    // this writes /tmp/weft-marker with no slash-after-separator, no `..`, and
    // no expansion token in sight. Strict Bash is deny-by-default: everything
    // that can write goes to the broker at high risk.
    const computed = `python -c 'open(chr(47)+"tmp/weft-marker","w").write("x")'`;
    expect((await ask(options, "Bash", { command: computed })).behavior).toBe("deny");
    expect(await ask(options, "Bash", { command: "pnpm build" })).toEqual({
      behavior: "deny",
      message: "not in this step",
    });
    expect(seen).toHaveLength(2);
    expect(seen.every((r) => r.risk === "high")).toBe(true);
    // Approval — a human, or the policy's whitelist — lets the build run.
    verdict = { behavior: "allow" };
    expect(await ask(options, "Bash", { command: "pnpm build" })).toEqual({ behavior: "allow" });
    expect(seen).toHaveLength(3);
    // Provably read-only commands stay unbrokered.
    expect(await ask(options, "Bash", { command: "cat notes.txt" })).toEqual({ behavior: "allow" });
    expect(seen).toHaveLength(3);
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

  test("a `..` segment after a symlink cannot smuggle an edit out of the worktree", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "weft-gate-"));
    const outside = await mkdtemp(join(tmpdir(), "weft-outside-"));
    await mkdir(join(cwd, "sub"));
    await symlink(outside, join(cwd, "sub", "esc"), "dir");
    try {
      const options = await gateContext(
        request({ cwd, tools: { allowEdits: true }, writeScope: { paths: ["**"], mode: "strict" } }),
      );
      // Deliberately NOT join(): join() collapses the `..` lexically, which is exactly
      // what resolvesOutsideWorktree used to do — erasing the symlink from the probe.
      // POSIX resolves left to right, so this lands in the OUTSIDE directory's parent.
      const edit = await ask(options, "Edit", {
        file_path: `${cwd}/sub/esc/../stolen`,
        old_string: "a",
        new_string: "b",
      });
      expect(edit.behavior).toBe("deny");
      // The traversal-free spelling of an in-tree file stays allowed.
      expect(
        (await ask(options, "Edit", { file_path: `${cwd}/sub/notes.txt`, old_string: "a", new_string: "b" }))
          .behavior,
      ).toBe("allow");
    } finally {
      await rm(cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
      await rm(outside, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  test("the engine-owned task store is screened on the normalized path, not the raw argument", async () => {
    const options = await gateContext(
      request({
        tools: { allowEdits: true },
        writeScope: { paths: ["**"], mode: "warn" },
        protectedPaths: [`${CWD}/.weft/tasks`],
        taskContext: {
          workflowId: "review",
          workflowName: "review",
          runId: "run-1",
          step: "review",
          provider: "claude",
          mode: "write",
        },
      }),
    );
    // Every spelling of the same file is the same write.
    for (const spelling of [
      `${CWD}/.weft/tasks/review/task-deadbeef.json`,
      `${CWD}/.weft/foo/../tasks/review/task-deadbeef.json`,
      `${CWD}/.weft//tasks/review/task-deadbeef.json`,
    ]) {
      expect(await ask(options, "Edit", { file_path: spelling }), spelling).toMatchObject({
        behavior: "deny",
      });
    }
  });

  test("a strict scope denies an absolute destination ATTACHED to its redirection", async () => {
    const brokered: PermissionRequest[] = [];
    const options = await gateContext(
      request({
        tools: { allowEdits: true },
        writeScope: { paths: ["**"], mode: "strict" },
        hitl: {
          onPermission: async (r: PermissionRequest) => {
            brokered.push(r);
            return { behavior: "allow" } as PermissionDecision;
          },
          onAsk: async () => ({}),
        },
      }),
    );
    // The spaced form was already denied; the attached forms are the same write.
    for (const command of [
      "printf x > /etc/cron.d/pwn",
      "printf x >/etc/cron.d/pwn",
      "printf x >>/etc/cron.d/pwn",
      "printf x 2>/etc/cron.d/pwn",
    ]) {
      expect((await ask(options, "Bash", { command })).behavior, command).toBe("deny");
    }
    // Denied up front, never handed to the approval broker.
    expect(brokered).toHaveLength(0);
    // A URL is not a filesystem destination and must still pass the screen.
    expect((await ask(options, "Bash", { command: "curl -s http://example.com/p" })).behavior).not.toBe(
      "deny",
    );
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

  test("declares result as an object, so the model does not stringify its answer", async () => {
    // With `result` left untyped the model serializes its answer to a JSON *string*
    // and every step dies as "expected object, received string". The engine's wire
    // schema is always object-rooted, so an object is the honest declaration.
    const { fn, calls } = fakeQuery([{ emit: { payload: { ok: true } }, messages: [resultMessage()] }]);
    const provider = createClaudeProvider({ queryFn: fn });
    await provider.run(request(), control());

    const options = calls[0]?.options as Options;
    const { inputSchema } = registeredTool(options);
    expect(inputSchema.safeParse({ result: { ok: true } }).success).toBe(true);
    expect(inputSchema.safeParse({ result: '{"ok":true}' }).success).toBe(false);
  });

  test("a stringified result is refused at the tool boundary, not silently accepted", async () => {
    // `capturedValue` can parse a JSON string, but nothing in production hands it one:
    // the declared object shape is validated before the handler runs, so the model gets
    // an in-band tool error naming the problem and retries. The suite used to assert
    // BOTH that the string is rejected by inputSchema and that it round-trips through
    // the handler — true only because the harness called the handler directly.
    const { fn } = fakeQuery([
      {
        emit: { payload: '{"ok":true,"n":3}' as unknown as Record<string, unknown> },
        messages: [resultMessage()],
      },
    ]);
    const provider = createClaudeProvider({ queryFn: fn });

    await expect(provider.run(request(), control())).rejects.toThrow(/without calling structured_output/);
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

describe("usage on failure (codex review round 16, PR #1)", () => {
  test("a step that never produced structured output still reports its spend on the error", async () => {
    const { fn } = fakeQuery([
      {
        messages: [
          assistantText("hmm"),
          resultMessage({
            subtype: "error_max_turns",
            usage: { input_tokens: 700, output_tokens: 300 },
            total_cost_usd: 0.001,
          }),
        ],
      },
      // The finalize turn ALSO yields nothing — both turns were paid for.
      {
        messages: [
          resultMessage({ usage: { input_tokens: 100, output_tokens: 50 }, total_cost_usd: 0.0005 }),
        ],
      },
    ]);
    const provider = createClaudeProvider({ queryFn: fn });
    await expect(provider.run(request({ onMaxTurns: "finalize" }), control())).rejects.toMatchObject({
      usage: { input: 800, output: 350 },
    });
  });
});

describe("long step timeouts", () => {
  test("a 30-day timeout does not abort the agent almost immediately", async () => {
    // Node clamps a single timer past 2^31-1ms to ~1ms; the old direct
    // setTimeout aborted this 50ms turn long before it could answer.
    const fn = ((params: { prompt: string; options?: Options }) => {
      return (async function* stream(): AsyncGenerator<unknown, void> {
        await new Promise((r) => setTimeout(r, 50));
        if (params.options?.abortController?.signal.aborted) {
          throw new Error("aborted by the clamped timer");
        }
        await registeredTool(params.options ?? {}).handler({ result: { verdict: "patient" } }, {});
        yield resultMessage();
      })();
    }) as unknown as QueryFn;
    const provider = createClaudeProvider({ queryFn: fn });
    const result = await provider.run(request({ timeoutMs: 2_147_483_647 + 86_400_000 }), control());
    expect(result.output).toEqual({ verdict: "patient" });
  });
});

describe("risky classification of dynamic commands", () => {
  test("a publishing action assembled by expansion routes to the broker", () => {
    // The shell resolves these into `git push …` AFTER the textual screen ran.
    expect(isRiskyCommand('op=push; git "$op" origin HEAD:main')).toBe(true);
    expect(isRiskyCommand("git $CMD origin main")).toBe(true);
    expect(isRiskyCommand("$PUBLISH --now")).toBe(true);
    expect(isRiskyCommand("`printf git` push origin main")).toBe(true);
    expect(isRiskyCommand("eval git push origin main")).toBe(true);
    // Backslash escapes resolve the same way quotes do: `git p\ush` IS a push.
    expect(isRiskyCommand("git p\\ush origin main")).toBe(true);
    expect(isRiskyCommand("git -C . pu\\sh origin main")).toBe(true);
    // Backslash-NEWLINE is a line continuation: bash deletes the pair, so
    // `git pu\<NL>sh` reassembles into one `push` word, not two segments.
    expect(isRiskyCommand("git pu\\\nsh origin main")).toBe(true);
    expect(isRiskyCommand("git -C . pu\\\nsh origin main")).toBe(true);
    expect(isRiskyCommand("git sta\\\ntus")).toBe(false);
    // --config-env loads an alias from the ENVIRONMENT — the -c escape hatch
    // in another spelling, abbreviations included.
    expect(isRiskyCommand("SHIP=push git --config-env=alias.ship=SHIP ship origin main")).toBe(true);
    expect(isRiskyCommand("SHIP=push git --config-env alias.ship=SHIP ship origin main")).toBe(true);
    expect(isRiskyCommand("SHIP=push git --c=alias.s=SHIP s origin main")).toBe(true);
    expect(isRiskyCommand("git --config-env=user.name=NAME status")).toBe(false);
    // send-pack and http-push are the PLUMBING spellings of a push.
    expect(isRiskyCommand("git send-pack git@example.com:org/repo.git HEAD:main")).toBe(true);
    expect(isRiskyCommand("git -C . send-pack host:repo HEAD:main")).toBe(true);
    // A subcommand git does not ship may be a CONFIGURED alias — with
    // alias.ship=push already in the repo config, `git ship` publishes with no
    // "push" in sight. Conservative approval, wrappers included.
    expect(isRiskyCommand("git ship origin HEAD:main")).toBe(true);
    expect(isRiskyCommand("command git ship origin HEAD:main")).toBe(true);
    // Known non-publishing subcommands stay un-gated.
    expect(isRiskyCommand("git ls-remote origin")).toBe(false);
    expect(isRiskyCommand("git submodule update --init")).toBe(false);
    // Provably static commands stay un-gated: expansions in ARGUMENTS are fine.
    expect(isRiskyCommand("echo $HOME")).toBe(false);
    expect(isRiskyCommand("git status")).toBe(false);
    expect(isRiskyCommand("git log --grep=$PATTERN")).toBe(false);
  });
});
