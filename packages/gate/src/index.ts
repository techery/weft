/**
 * @techery/weft-gate — the gate every workflow passes through before it runs: AST rules over the
 * source, an esbuild bundle that inlines the relative imports and content-hashes the
 * result, and a sandboxed loader that turns that bundle into a `WorkflowDefinition`.
 *
 * ```ts
 * const { def, hash } = await loadWorkflow({ entry: ".weft/workflows/review.ts" });
 * const registry = createWorkflowRegistry({ dir: ".weft/workflows" }); // Engine's registry
 * ```
 */

export type { BundleOptions, BundleResult } from "./bundle.ts";
export { bundleWorkflow } from "./bundle.ts";
export type { InstantiateOptions, LoadedWorkflow, LoadOptions } from "./load.ts";
export { instantiateBundle, loadWorkflow } from "./load.ts";
export type {
  FileWorkflowRegistry,
  RegistryLoadResult,
  RegistryOptions,
  WorkflowInspection,
  WorkflowLoadIssue,
  WorkflowListEntry,
  WorkflowRegistry,
} from "./registry.ts";
export { createWorkflowRegistry } from "./registry.ts";
export type { GateDiagnostic, GateRule } from "./rules.ts";
export { checkSource, DEFAULT_ALLOW_BARE, formatDiagnostics, GateError } from "./rules.ts";
