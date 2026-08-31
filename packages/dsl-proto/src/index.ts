/** Declaration-only prototype of the intended Weft authoring DSL. */
export { z } from "zod";

// Authoring builders -------------------------------------------------------

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
export { defineReview } from "./core/reviews.ts";
export { definePrompt, prompt, renderPrompt, renderPromptDefinition } from "./core/shared.ts";
export { defineTaskContract } from "./core/tasks.ts";
export { defineTrigger } from "./core/triggers.ts";
export { defineRecipe, defineWorkflow } from "./facade.ts";

// Definition inference and shared primitives ------------------------------

export type {
  AnySchema,
  BuiltInProvider,
  ClaudeProviderOptions,
  CodexProviderOptions,
  Duration,
  DynamicProvider,
  Effort,
  EvidenceRef,
  HostBinding,
  InferIn,
  InferOut,
  InputOf,
  OutputOf,
  ParsedInputOf,
  PromptDefinition,
  PromptHelpers,
  PromptPart,
  PromptSection,
  Provider,
  ProviderOptionRegistry,
  ProviderRequirements,
  RawOutputOf,
  ResultOf,
  Risk,
  Settled,
  SettledFailure,
  SettledSuccess,
  StandardSchemaV1,
  WorkspaceSnapshotRef,
} from "./core/shared.ts";

// Agents and recipes -------------------------------------------------------

export type {
  AgentCallOptions,
  AgentCallOptionsBase,
  AgentCallResult,
  AgentDefinition,
  AgentFailure,
  AgentFailureMode,
  AgentGoalResultOf,
  AgentNameOf,
  AgentOutcome,
  AgentOutputOf,
  AgentResult,
  AgentResultBase,
  AgentSuccessResult,
  AgentTool,
  AgentToolGrant,
  GoalBinding,
  GoalInputOf,
  InlineAgentDefinition,
  PatchAgentResult,
  PatchRef,
  RecipeDefinition,
  RecipeNameOf,
  Usage,
  WorkspaceWriteAgentResult,
} from "./core/agent.ts";

// Artifacts, checks, goals, and reviews -----------------------------------

export type {
  ArtifactCaptureInputOf,
  ArtifactDefinition,
  ArtifactNameOf,
  ArtifactRefBase,
  ArtifactRefOf,
  ContentOnlyArtifactRef,
  MetadataArtifactRef,
} from "./core/artifacts.ts";
export type {
  CheckCommand,
  CheckDefinition,
  CheckEvidence,
  CheckExecutionResult,
  CheckInputOf,
  CheckResult,
  CheckResultOf,
  CheckStatus,
  CheckSuiteDefinition,
  CheckSuiteMembersOf,
  CheckSuiteResult,
  CheckSuiteResults,
  CommandResult,
} from "./core/checks.ts";
export type {
  GoalAttempt,
  GoalDefinition,
  GoalNameOf,
  GoalResult,
} from "./core/goals.ts";
export type {
  AcceptedReviewResult,
  ReviewAssessment,
  ReviewDefinition,
  ReviewDisposition,
  ReviewFindingOf,
  ReviewInputOf,
  ReviewNameOf,
  ReviewResult,
  ReworkReviewResult,
} from "./core/reviews.ts";

// Context, observation, and human interaction -----------------------------

export type {
  ContextFreshnessMetadata,
  ContextFreshnessPolicy,
  ContextFreshnessStatus,
  ContextSnapshot,
  ContextSnapshotOf,
  ContextSourceDefinition,
  ContextSourceFreshnessOf,
  ContextSourceInputOf,
  ContextSourceNameOf,
  ContextSourceOutputOf,
  ContextSourceTrustOf,
  ContextTrustLevel,
  ContextTrustMetadata,
  ContextTrustPolicy,
} from "./core/context-sources.ts";
export type {
  DetailedObserverResult,
  ObserverDefinition,
  ObserverEndpointKind,
  ObserverInputOf,
  ObserverNameOf,
  ObserverOutputOf,
  ObserverProvenance,
  ObserverStrategy,
  ObserverSubject,
  ObserverTrustLevel,
  ObserverTrustMetadata,
  ObserverTrustMetadataOf,
  ObserverTrustPolicy,
} from "./core/observers.ts";
export type {
  HumanApprovalResult,
  HumanConfirmationResult,
  HumanEditFileResult,
  HumanReviewArtifactSubject,
  HumanReviewFileSubject,
  HumanReviewResult,
  HumanReviewSubject,
  ReviewedSubject,
  ReviewedSubjectOf,
  ReviewerIdentity,
  UiViewRef,
} from "./core/human.ts";

// Operations, deliveries, paths, and workspace ----------------------------

export type {
  OperationCapability,
  OperationDefinition,
  OperationInputOf,
  OperationNameOf,
  OperationOutputOf,
  RecoverableOperationDefinition,
  RecoverableOperationRunOptions,
  RecoverableOperationRunResult,
} from "./core/operations.ts";
export type {
  DeliveryDefinition,
  DeliveryInputOf,
  DeliveryOutputOf,
  DeliveryReceipt,
} from "./core/deliveries.ts";
export type {
  PathGrantRef,
  PathPolicyDefinition,
  WriteScope,
} from "./core/path-policies.ts";
export type { IntegrationLedger, PolicyDecisionResult } from "./core/workspace.ts";
export type {
  ActiveWorkspaceApi,
  CandidateWorkspaceContext,
  NestedWorkspaceApi,
} from "./facade.ts";

// Composition, durable tasks, triggers, and workflow contracts ------------

export type {
  ParallelFn,
  ParallelLaneContext,
  Pipeline,
  SequenceFn,
  SequenceItemContext,
} from "./facade.ts";
export type {
  AgentTaskAccess,
  TaskContract,
  WorkflowTaskCriterion,
  WorkflowTaskNote,
  WorkflowTaskPriority,
  WorkflowTaskSnapshot,
  WorkflowTaskStatus,
  WorkflowTaskSummary,
} from "./core/tasks.ts";
export type {
  TriggerAdmissionResult,
  TriggerDefinition,
  TriggerInputOf,
  TriggerOutputOf,
  TriggerRunProvenance,
  WorkflowAdmission,
} from "./core/triggers.ts";
export type {
  InferWorkflowInput,
  InferWorkflowOutput,
  ReviewCtx,
  WorkflowCancellation,
  WorkflowContract,
  WorkflowDefinition,
  WorkflowIdOf,
  WorkflowInputOf,
  WorkflowMetaView,
  WorkflowOutputOf,
  WorkflowRunReceipt,
} from "./core/workflow.ts";
export type { WorkflowCtx, WorkspaceCtx } from "./facade.ts";
