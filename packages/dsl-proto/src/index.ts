/** Declaration-only prototype of the intended Weft authoring DSL. */
export { z } from "zod";

// Definition builders -------------------------------------------------------

export { bindGoal, defineAgent } from "./core/agent.ts";
export { defineArtifact } from "./core/artifacts.ts";
export { defineCheck, defineCheckSuite } from "./core/checks.ts";
export { defineContextSource } from "./core/context-sources.ts";
export { defineDelivery } from "./core/deliveries.ts";
export { defineGoal } from "./core/goals.ts";
export { defineResultView, defineUiView } from "./core/human.ts";
export { defineObserver } from "./core/observers.ts";
export { defineOperation, withRecovery } from "./core/operations.ts";
export { definePathPolicy } from "./core/path-policies.ts";
export { defineProcedure } from "./core/procedures.ts";
export { defineReview } from "./core/reviews.ts";
export { definePrompt, prompt, renderPrompt, renderPromptDefinition } from "./core/shared.ts";
export { defineTaskContract } from "./core/tasks.ts";
export { defineTrigger } from "./core/triggers.ts";
export { defineWorkflow } from "./core/workflow.ts";

// Shared authoring contracts ------------------------------------------------

export type {
  AgentDefinition,
  AgentFailure,
  AgentOutcome,
  AgentResult,
  AgentTool,
  PatchRef,
  Usage,
} from "./core/agent.ts";
export type {
  ArtifactDefinition,
  ArtifactRefBase,
  ArtifactRefOf,
  ContentOnlyArtifactRef,
  MetadataArtifactRef,
} from "./core/artifacts.ts";
export type {
  CheckCommand,
  CheckDefinition,
  CheckResult,
  CheckSuiteDefinition,
  CheckSuiteResult,
  CheckWaiverRef,
  WaiverEligibleCheckDefinition,
} from "./core/checks.ts";
export type { ParallelLaneContext, ParallelOptions } from "./core/composition.ts";

export type {
  ContextSnapshot,
  ContextSnapshotOf,
  ContextSourceDefinition,
} from "./core/context-sources.ts";

export type { DeliveryDefinition, DeliveryReceipt } from "./core/deliveries.ts";
export type { GoalDefinition, GoalResult } from "./core/goals.ts";

export type {
  HumanConfirmationResult,
  HumanReviewResult,
  UiViewRef,
} from "./core/human.ts";

export type {
  DetailedObserverResult,
  ObserverDefinition,
  ObserverProvenance,
} from "./core/observers.ts";

export type {
  OperationCapability,
  OperationDefinition,
  RecoverableOperationDefinition,
  RecoverableOperationRunResult,
} from "./core/operations.ts";

export type { PathGrantRef, PathPolicyDefinition, WriteScope } from "./core/path-policies.ts";
export type {
  AnyProcedureDefinition,
  ProcedureDefinition,
  ProcedureInputOf,
  ProcedureOptions,
  ProcedureOutputOf,
  ProcedureReceipt,
} from "./core/procedures.ts";
export type { ReviewDefinition, ReviewResult } from "./core/reviews.ts";
export type {
  AnySchema,
  Duration,
  InputOf,
  OutputOf,
  Provider,
  ResultOf,
  Risk,
  WorkflowNode,
  WorkspaceSnapshotRef,
} from "./core/shared.ts";
export type { TaskContract, WorkflowTaskSnapshot, WorkflowTaskStatus } from "./core/tasks.ts";
export type { TriggerAdmissionResult, TriggerDefinition, WorkflowAdmission } from "./core/triggers.ts";
export type {
  ReviewCtx,
  WorkflowCancellation,
  WorkflowContract,
  WorkflowCtx,
  WorkflowDefinition,
  WorkflowRunReceipt,
  WorkspaceCtx,
} from "./core/workflow.ts";
export type { IntegrationLedger, PolicyDecisionResult } from "./core/workspace.ts";
