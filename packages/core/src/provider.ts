/**
 * The provider contract (C7): Claude Agent SDK, Codex SDK, and the mock all sit
 * behind this interface. The engine owns validation, repair policy, budget, and
 * journaling; a provider owns one session with one vendor's agent.
 */
import type { Effort, Risk, SchemaIssue, Usage, WriteScope } from "@weft/sdk";

export interface ToolPolicy {
  /** When false every edit tool is denied (read-only step). */
  allowEdits: boolean;
  /** Extra tools to deny outright (adapter-specific names). */
  deny?: string[];
}

export interface PermissionRequest {
  tool: string;
  input: unknown;
  risk?: Risk;
}

export type PermissionDecision = { behavior: "allow" } | { behavior: "deny"; message?: string };

/** Engine-side callbacks a provider uses to route in-agent asks to the HITL broker. */
export interface ProviderHitl {
  onPermission(req: PermissionRequest): Promise<PermissionDecision>;
  onAsk(question: string, schema?: unknown): Promise<unknown>;
}

export interface AgentRequest {
  prompt: string;
  cwd: string;
  /** JSON Schema for the structured output (already object-wrapped for primitives). */
  schema: unknown;
  label: string;
  /** The step's explicit key, when one was given (mock fixtures match on it). */
  key?: string;
  model?: string;
  effort?: Effort;
  maxTurns?: number;
  /** Milliseconds. */
  timeoutMs?: number;
  onMaxTurns?: "finalize" | "fail";
  /** Always populated by the engine; read-only steps get { allowEdits: false }. */
  tools: ToolPolicy;
  writeScope?: Required<Pick<WriteScope, "paths" | "mode">> & Pick<WriteScope, "also">;
  hitl: ProviderHitl;
}

export interface AgentResult {
  /** Raw structured output; the ENGINE validates it — provider output is never trusted. */
  output: unknown;
  usage: Usage;
  sessionId?: string;
  /** Full conversation transcript when available (journaled to the blob store). */
  transcript?: string;
  /** Files the agent touched, when the adapter can observe them. */
  filesTouched?: string[];
}

export interface RunControl {
  signal: AbortSignal;
}

export interface ProviderCapabilities {
  structured: "native" | "tool";
  permissionHook: boolean;
  sessionResume: boolean;
}

export interface AgentProvider {
  readonly id: string;
  capabilities(): ProviderCapabilities;
  run(req: AgentRequest, ctl: RunControl): Promise<AgentResult>;
  /** Re-prompt the same session with validation errors; absent sessions may re-run. */
  repair(
    sessionId: string | undefined,
    req: AgentRequest,
    errors: SchemaIssue[],
    ctl: RunControl,
  ): Promise<AgentResult>;
}

export class ProviderRegistry {
  private providers = new Map<string, AgentProvider>();

  register(provider: AgentProvider): this {
    this.providers.set(provider.id, provider);
    return this;
  }

  get(id: string): AgentProvider {
    const p = this.providers.get(id);
    if (!p) {
      const known = [...this.providers.keys()].join(", ") || "none";
      throw new Error(`unknown provider "${id}" (registered: ${known})`);
    }
    return p;
  }

  has(id: string): boolean {
    return this.providers.has(id);
  }

  ids(): string[] {
    return [...this.providers.keys()];
  }
}
