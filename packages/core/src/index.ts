/**
 * @techery/weft-core — the Weft engine: scheduler, replayer, journal model, budget,
 * HITL broker, projections. Hosts (CLI, MCP, daemon) are thin shells over Engine.
 */

// Types that appear in @techery/weft-core's own public surface (AgentProvider, events),
// re-exported so adapter packages need no second workspace dependency.
export type { Effort, Risk, SchemaIssue, Usage, WriteScope } from "@techery/weft-sdk";
export type { BudgetLimits } from "./budget.ts";
export { Budget } from "./budget.ts";
export { canonicalJson, hashStep, sha256Hex } from "./canonical.ts";
export type {
  ApprovalMode,
  ApprovalPolicy,
  EngineConfig,
  EngineConfigInput,
  EngineLimits,
  ModelPrice,
  ProviderConfig,
} from "./config.ts";
export {
  DEFAULT_EFFORT,
  DEFAULT_MODEL,
  DEFAULT_PRICES,
  defaultConcurrency,
  priceFor,
  resolveConfig,
} from "./config.ts";
export { integrationBaseCommit, treeHash } from "./ctx.ts";
export type {
  EngineOptions,
  ResumeOptions,
  RunHandle,
  RunOutcome,
  StartOptions,
  WorkflowRegistry,
} from "./engine.ts";
export { Engine } from "./engine.ts";
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
export type { TestHooks } from "./hooks.ts";
export type { WireSchema } from "./jsonschema.ts";
export { jsonUnsafeAt, structuralCheck, toWireSchema, unwrapWireValue, wrapWireValue } from "./jsonschema.ts";
export { mapWithConcurrency, Semaphore } from "./limiter.ts";
export type { CheckState, HumanState, RunState, StepState, TreeNode, TreePhase } from "./projections.ts";
export { reduceState, renderReport, renderTree } from "./projections.ts";
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
export { ProviderRegistry } from "./provider.ts";
export type { CompletedEntry, HumanEntry, ReuseMode, ScheduledEntry, SignalEntry } from "./replay.ts";
export { OrderedDelivery, ReplayIndex } from "./replay.ts";
export type { PendingRequest } from "./runtime.ts";
export type {
  BlobMeta,
  BlobRef,
  BlobStore,
  JournalStore,
  Projections,
  RunLease,
  RunListFilter,
  RunSummary,
} from "./stores.ts";
export {
  BlobCorruptError,
  BlobMissingError,
  isBlobBeyondRepair,
  MemoryBlobStore,
  MemoryJournalStore,
} from "./stores.ts";
