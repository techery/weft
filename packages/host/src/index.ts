/**
 * @weft/host — the assembly layer between the engine and the surfaces people use.
 * Config loading, store + registry + provider wiring, ref resolution, budget parsing:
 * everything `@weft/cli`, `@weft/mcp`, and `@weft/daemon` would otherwise each reinvent,
 * so those stay shells over `weft.engine`.
 *
 * ```ts
 * import { createWeft, resolveWorkflow, parseBudget } from "@weft/host";
 *
 * const weft = await createWeft({ cwd: process.cwd() });
 * const { def, hash } = await resolveWorkflow(weft, "review");
 * const run = await weft.engine.start(def, {
 *   input: { base: "main" },
 *   cwd: weft.cwd,
 *   defHash: hash,
 *   budget: parseBudget("500k"),
 * });
 * ```
 */

export type { ParsedBudget } from "./budget.ts";
export { parseBudget } from "./budget.ts";
export type { WeftConfig } from "./config.ts";
export { CONFIG_FILE, configPath, loadConfig, WEFT_DIR } from "./config.ts";
export type { CreateWeftOptions, ResolvedWorkflow, Weft } from "./weft.ts";
export {
  createWeft,
  INDEX_FILE,
  inlineDefOf,
  isWorkflowPathRef,
  persistedDefOf,
  persistInlineScript,
  persistWorkflowRef,
  resolveWorkflow,
} from "./weft.ts";

// --- re-exported for hosts, so a host depends on @weft/host and little else -----------

export type {
  AgentProvider,
  EngineConfig,
  EngineConfigInput,
  EngineOptions,
  JournalEvent,
  JournalRecord,
  PendingRequest,
  ResumeOptions,
  RunHandle,
  RunListFilter,
  RunOutcome,
  RunState,
  RunStatus,
  RunSummary,
  StartOptions,
  StepState,
  TreeNode,
  WorkflowRegistry,
} from "@weft/core";
export { Engine, ProviderRegistry, reduceState, renderReport, renderTree } from "@weft/core";
export type {
  BundleOptions,
  BundleResult,
  FileWorkflowRegistry,
  GateDiagnostic,
  GateRule,
  LoadedWorkflow,
  LoadOptions,
  RegistryLoadResult,
  WorkflowListEntry,
} from "@weft/gate";
export {
  bundleWorkflow,
  checkSource,
  DEFAULT_ALLOW_BARE,
  formatDiagnostics,
  GateError,
  loadWorkflow,
} from "@weft/gate";
/** Types only: `node:sqlite` is loaded the first time a host calls `weft.reindex()`. */
export type {
  IndexedRun,
  RunIndex,
  RunIndexOptions,
  RunIndexStats,
  RunSearchQuery,
} from "@weft/index-sqlite";
export type { MockAgentBuilder, MockRequest, MockResponder, MockRuleOptions } from "@weft/provider-mock";
export { mock } from "@weft/provider-mock";
export type { WorkflowDefinition } from "@weft/sdk";
export { StepError } from "@weft/sdk";
export type { FsStores } from "@weft/store-fs";
export { createFsStores } from "@weft/store-fs";
