/**
 * @weft/gate — the gate every workflow passes through before it runs: AST rules over the
 * source, an esbuild bundle that inlines the relative imports and content-hashes the
 * result, and a sandboxed loader that turns that bundle into a `WorkflowDefinition`.
 *
 * ```ts
 * const { def, hash } = await loadWorkflow({ entry: ".weft/workflows/review.ts" });
 * const registry = createWorkflowRegistry({ dir: ".weft/workflows" }); // Engine's registry
 * ```
 */
export { checkSource, DEFAULT_ALLOW_BARE, formatDiagnostics, GateError } from "./rules.ts";
export type { GateDiagnostic, GateRule } from "./rules.ts";

export { bundleWorkflow } from "./bundle.ts";
export type { BundleOptions, BundleResult } from "./bundle.ts";

export { loadWorkflow } from "./load.ts";
export type { LoadedWorkflow, LoadOptions } from "./load.ts";

export { createWorkflowRegistry } from "./registry.ts";
export type {
  FileWorkflowRegistry,
  RegistryLoadResult,
  RegistryOptions,
  WorkflowListEntry,
  WorkflowRegistry,
} from "./registry.ts";
