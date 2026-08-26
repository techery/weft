/**
 * The provider contract (C7): Claude Agent SDK, Codex SDK, and the mock all sit
 * behind this interface. The engine owns validation, repair policy, budget, and
 * journaling; a provider owns one session with one vendor's agent.
 */
import type {
  AnySchema,
  Effort,
  Risk,
  SchemaIssue,
  Usage,
  WorkflowTaskCreateInput,
  WorkflowTaskSelector,
  WorkflowTaskUpdateInput,
  WriteScope,
} from "@techery/weft-sdk";

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

/** Mutations an agent may request as part of its structured, journaled result. */
export type AgentTaskOperation =
  | {
      op: "create";
      title: string;
      description: string;
      status?: "todo" | "in_progress" | "blocked" | "done" | "cancelled";
      priority?: "low" | "medium" | "high" | "critical";
      tags?: string[];
      dependencies?: string[];
      relatedFiles?: string[];
      acceptanceCriteria?: string[];
      extensions?: unknown;
    }
  | {
      op: "update";
      id: string;
      title?: string;
      description?: string;
      status?: "todo" | "in_progress" | "blocked" | "done" | "cancelled";
      priority?: "low" | "medium" | "high" | "critical";
      tags?: string[];
      dependencies?: string[];
      relatedFiles?: string[];
      acceptanceCriteria?: string[];
      resetAcceptance?: boolean;
      extensions?: unknown;
      ifRevision?: number;
    }
  | { op: "note"; id: string; text: string; ifRevision?: number }
  | { op: "criterion"; id: string; criterionId: string; met: boolean; ifRevision?: number }
  | {
      op: "upsert";
      dedupeKey: string;
      create: WorkflowTaskCreateInput;
      update?: WorkflowTaskUpdateInput;
      note?: string;
    };

export interface AgentTaskContext {
  workflowId: string;
  workflowName: string;
  runId: string;
  step: string;
  provider: string;
  source?: "agent" | "workflow";
  mode?: "read" | "write";
  selector?: WorkflowTaskSelector;
  /** Stable fingerprint for the exact extension schema bound to this run. */
  schemaBinding?: string;
  schemaVersion?: number;
  /** Exact records exposed by the journaled observation; mutation authority cannot exceed them. */
  visibleTaskIds?: string[];
  visibleDedupeKeys?: string[];
}

/** Engine-owned task boundary. Providers can request operations but never receive storage authority. */
export interface AgentTaskTrackerHost {
  /** Host-owned paths providers must protect from agent writes; never journaled or shown to the model. */
  protectedPaths?: readonly string[];
  /** Bind the runtime definition before any snapshot or mutation (also covers path/stdin workflows). */
  prepare?(
    workflow: { id: string; name: string },
    extensionSchema: AnySchema | undefined,
    options?: {
      schemaVersion?: number;
      migrate?: (extensions: unknown, fromVersion: number) => unknown | Promise<unknown>;
      /** Stable workflow-definition identity used when JSON Schema is lossy or unavailable. */
      identity?: string;
      /** Dry replay binds validators in memory but must not mutate the namespace. */
      persist?: boolean;
    },
  ): Promise<string | undefined>;
  snapshot(context: AgentTaskContext): Promise<unknown>;
  schema(context: AgentTaskContext): Promise<unknown>;
  /** Read-only semantic preflight used before an agent result is journaled as complete. */
  validateBatch?(context: AgentTaskContext, operations: AgentTaskOperation[]): Promise<void>;
  applyBatch(context: AgentTaskContext, batchId: string, operations: AgentTaskOperation[]): Promise<void>;
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
  /** Engine-owned host paths provider isolation must keep read-only; adapters may also hide reads. */
  protectedPaths?: readonly string[];
  /**
   * Engine-issued workflow-task capability for this step. Task mutations flow
   * only through the structured result envelope.
   */
  taskContext?: AgentTaskContext;
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
  /** True when run() reports usage.usd itself; false means pricing config is the only cost source. */
  reportsUsd: boolean;
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
