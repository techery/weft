/**
 * @weft/core — the Weft engine: scheduler, replayer, journal model, budget,
 * HITL broker, projections. Hosts (CLI, MCP, daemon) are thin shells over Engine.
 */
export { Engine } from "./engine.ts";
export type {
  EngineOptions,
  ResumeOptions,
  RunHandle,
  RunOutcome,
  StartOptions,
  WorkflowRegistry,
} from "./engine.ts";

export { resolveConfig, defaultConcurrency, priceFor, DEFAULT_MODEL, DEFAULT_EFFORT, DEFAULT_PRICES } from "./config.ts";
export type {
  ApprovalMode,
  ApprovalPolicy,
  EngineConfig,
  EngineConfigInput,
  EngineLimits,
  ModelPrice,
  ProviderConfig,
} from "./config.ts";

export type {
  BlobRefJson,
  HumanAnsweredEvent,
  HumanKind,
  HumanRequestEvent,
  JournalEvent,
  JournalRecord,
  RunStatus,
  StepKind,
} from "./events.ts";
export { isBlobRef, TERMINAL_STATUSES } from "./events.ts";

export { canonicalJson, hashStep, sha256Hex } from "./canonical.ts";

export { MemoryBlobStore, MemoryJournalStore } from "./stores.ts";
export type {
  BlobMeta,
  BlobRef,
  BlobStore,
  JournalStore,
  Projections,
  RunListFilter,
  RunSummary,
} from "./stores.ts";

export { ProviderRegistry } from "./provider.ts";
export type {
  AgentProvider,
  AgentRequest,
  AgentResult,
  PermissionDecision,
  PermissionRequest,
  ProviderCapabilities,
  ProviderHitl,
  RunControl,
  ToolPolicy,
} from "./provider.ts";

export { Budget } from "./budget.ts";
export type { BudgetLimits } from "./budget.ts";

export { Semaphore, mapWithConcurrency } from "./limiter.ts";

export { structuralCheck, toWireSchema, unwrapWireValue, wrapWireValue } from "./jsonschema.ts";
export type { WireSchema } from "./jsonschema.ts";

export { ReplayIndex, OrderedDelivery } from "./replay.ts";
export type { CompletedEntry, HumanEntry, ReuseMode, ScheduledEntry, SignalEntry } from "./replay.ts";

export { reduceState, renderReport, renderTree } from "./projections.ts";
export type { CheckState, HumanState, RunState, StepState, TreeNode, TreePhase } from "./projections.ts";

export type { PendingRequest } from "./runtime.ts";
export type { TestHooks } from "./hooks.ts";
export { treeHash } from "./ctx.ts";
