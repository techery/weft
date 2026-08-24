/**
 * The default client path. Every test in codex.test.ts injects a fake through the DI
 * seam, so this file is the only place `new Codex()` is reached at all: the SDK module
 * is mocked here so that constructing the real class — which goes looking for a CLI
 * binary and a credential — is counted rather than attempted. The count is the whole
 * point: it proves construction is deferred to the first turn and then memoized.
 */
import type { Codex as CodexClass, RunResult, ThreadOptions } from "@openai/codex-sdk";
import type { AgentRequest } from "@techery/weft-core";
import { beforeEach, describe, expect, it, vi } from "vitest";

const sdk = vi.hoisted(() => {
  const state = { constructed: 0, started: [] as unknown[], resumed: [] as string[] };
  const thread = () => ({
    id: "thread-default",
    run: async () => ({ items: [], finalResponse: '{"ok":true}', usage: null }) as RunResult,
  });
  class FakeCodex {
    constructor() {
      state.constructed++;
    }
    startThread(options?: unknown) {
      state.started.push(options);
      return thread();
    }
    resumeThread(id: string, _options?: unknown) {
      state.resumed.push(id);
      return thread();
    }
  }
  return { state, FakeCodex };
});

vi.mock("@openai/codex-sdk", () => ({ Codex: sdk.FakeCodex as unknown as typeof CodexClass }));

const { createCodexProvider } = await import("../src/index.ts");

function request(): AgentRequest {
  return {
    prompt: "Summarize the failing test",
    cwd: "/repo",
    schema: { type: "object" },
    label: "Triage/agent#1",
    tools: { allowEdits: false },
    hitl: { onPermission: async () => ({ behavior: "allow" as const }), onAsk: async () => ({}) },
  };
}

function control(): { signal: AbortSignal } {
  return { signal: new AbortController().signal };
}

beforeEach(() => {
  sdk.state.constructed = 0;
  sdk.state.started.length = 0;
  sdk.state.resumed.length = 0;
});

describe("the default SDK client", () => {
  it("is not built until a turn actually runs", async () => {
    const provider = createCodexProvider();

    // Registering a provider must stay free: hosts build every adapter at startup,
    // including the ones a given run never routes a step to.
    expect(sdk.state.constructed).toBe(0);

    const result = await provider.run(request(), control());

    expect(sdk.state.constructed).toBe(1);
    expect(result.output).toEqual({ ok: true });
    expect(result.sessionId).toBe("thread-default");
    expect(sdk.state.started[0]).toMatchObject({ workingDirectory: "/repo", sandboxMode: "read-only" });
  });

  it("is built once and reused across turns", async () => {
    const provider = createCodexProvider();

    const first = await provider.run(request(), control());
    await provider.repair(
      first.sessionId,
      request(),
      [{ path: "ok", message: "expected boolean" }],
      control(),
    );

    expect(sdk.state.constructed).toBe(1);
    expect(sdk.state.resumed).toEqual(["thread-default"]);
  });

  it("is skipped entirely when a client is injected", async () => {
    const injected = {
      startThread: () => ({
        id: "injected",
        run: async () => ({ items: [], finalResponse: "{}", usage: null }) as RunResult,
      }),
      resumeThread: (_id: string, _options?: ThreadOptions) => {
        throw new Error("unreachable");
      },
    };

    await createCodexProvider({ codex: injected }).run(request(), control());

    expect(sdk.state.constructed).toBe(0);
  });
});
