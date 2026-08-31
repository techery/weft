import { z } from "zod";

import {
  type ArtifactInvocation,
  type CheckInvocation,
  type CheckSuiteDefinitionMembers,
  type CheckSuiteInvocation,
  type CheckWaiverAuthorizationInvocation,
  type DefinedAgentInvocation,
  type DeliveryAuthorizeInvocation,
  type DeliveryPrepareInvocation,
  type DeliveryRunInvocation,
  type DetailedObserverInvocation,
  type DetailedWorkflowRunInvocation,
  type GoalDefinitionResults,
  type GoalEvaluationInvocation,
  type InlineAgentInvocation,
  internalEngine,
  type ObserverInvocation,
  type OperationAuthorizeInvocation,
  type OperationInvocation,
  type OperationPrepareInvocation,
  type OperationRecoveryInvocation,
  type OperationRecoveryPrepareInvocation,
  type PathPolicyInvocation,
  type PromptRenderInvocation,
  type ProtectedOperationInvocation,
  type RecipeInvocation,
  type RecoverableOperationExecutionInvocation,
  type RecoverableOperationRegistrationInvocation,
  type ReviewInvocation,
  type TaskContractInvocation,
  type TriggerAdmissionInvocation,
  type UiRenderInvocation,
  type UiRequestInvocation,
  type WorkflowRunInvocation,
} from "../core/internal-engine.ts";
import {
  type AgentOutcome,
  type AgentResult,
  type AnyDefinedAgentCall,
  type CheckResultOf,
  type CheckSuiteResult,
  type CheckWaiverRef,
  type DeliveryAuthorizationRef,
  type DeliveryReceipt,
  defineAgent,
  defineArtifact,
  defineCheck,
  defineCheckSuite,
  defineDelivery,
  defineGoal,
  defineObserver,
  defineOperation,
  definePathPolicy,
  definePrompt,
  defineRecipe,
  defineResultView,
  defineReview,
  defineTaskContract,
  defineTrigger,
  defineUiView,
  defineWorkflow,
  type FailedCheckResultOf,
  type GoalInvocation,
  type GoalResult,
  type InlineAgentCall,
  type MetadataArtifactRef,
  type OperationAttemptRef,
  type OperationAttemptResult,
  type OperationAuthorizationRef,
  type OperationCandidateRef,
  type OperationRecoveryCandidateRef,
  type OperationRecoveryResult,
  type OperationRecoveryState,
  type PatchAgentResult,
  type PromotionCandidateRef,
  type RecoverableOperationReceipt,
  type ReviewResult,
  type TriggerAdmissionResult,
  type WorkflowRunReceipt,
  type WorkspaceSnapshotRef,
  type WorkspaceWriteAgentResult,
  type WriteScope,
} from "../core/index.ts";

declare function expectType<T>(value: T): void;

const ExampleInput = z.object({ task: z.string() });
const ExampleOutput = z.object({ summary: z.string() });
const ExampleAnswer = z.object({ approved: z.boolean() });
const ExampleExtensions = z.object({ ticket: z.string() });
const ExampleState = z.object({ done: z.boolean(), summary: z.string() });

type ExampleInputValue = z.infer<typeof ExampleInput>;
type ExampleOutputValue = z.infer<typeof ExampleOutput>;
type ExampleAnswerValue = z.infer<typeof ExampleAnswer>;
type ExampleExtensionsValue = z.infer<typeof ExampleExtensions>;

const promptNode = definePrompt({
  name: "internal-prompt",
  input: ExampleInput,
  render: ({ task }) => `Complete ${task}`,
});

const agentNode = defineAgent({
  name: "internal-agent",
  prompt: promptNode,
  schema: ExampleOutput,
});

const pathPolicyNode = definePathPolicy({
  name: "internal-writer-paths",
  description: "Restricts the internal writer proof to source and test paths.",
  revision: "v1",
  roots: ["src", "test"],
  deny: ["**/*.secret"],
  grantTtl: "5m",
});

const checkNode = defineCheck({
  name: "internal-check",
  revision: "v1",
  policy: "required",
  waiver: {
    mode: "eligible",
    binding: "internal.check-waiver.authorize",
    action: "Waive the internal compile-time check",
    risk: "medium",
    maxTtl: "1h",
  },
  input: ExampleInput,
  command: ({ task }) => ["test", "-n", task],
});

const suiteNode = defineCheckSuite({
  name: "internal-suite",
  input: ExampleInput,
  checks: (input, use) => ({ check: use(checkNode, input) }),
});

const goalNode = defineGoal({ name: "internal-goal", check: suiteNode });

const recipeNode = defineRecipe({
  name: "internal-recipe",
  input: ExampleInput,
  output: ExampleOutput,
  run: async (_ctx, { task }) => ({ summary: task }),
});

const inputViewNode = defineUiView({
  id: "internal-input-view",
  props: ExampleInput,
  answer: ExampleAnswer,
  component: ({ propose }) => propose({ approved: true }),
});

const resultViewNode = defineResultView({
  id: "internal-result-view",
  props: ExampleOutput,
  component: ({ props }) => props.summary,
});

const taskContractNode = defineTaskContract({
  schema: ExampleExtensions,
});

const artifactNode = defineArtifact({
  name: "internal-artifact",
  mediaType: "text/plain",
  content: z.string(),
  metadata: ExampleInput,
});

const operationNode = defineOperation({
  name: "internal-operation",
  input: ExampleInput,
  output: ExampleOutput,
  authorization: { mode: "none" },
  run: async ({ task }) => ({ summary: task }),
});

const protectedOperationNode = defineOperation({
  name: "internal-protected-operation",
  input: ExampleInput,
  output: ExampleOutput,
  capabilities: ["network", "integration:internal-publisher"],
  defaults: { timeout: "2m", attempts: 1 },
  authorization: {
    mode: "required",
    action: "publish the internal example",
    risk: "high",
    timeout: "1h",
  },
  binding: "internal.example.publish",
});

const cancellationOperationNode = defineOperation({
  name: "internal-operation-cancel",
  input: ExampleInput,
  output: ExampleOutput,
  capabilities: ["network", "integration:internal-publisher"],
  defaults: { timeout: "1m", attempts: 1 },
  authorization: { mode: "none" },
  binding: "internal.example.cancel",
});

const compensationOperationNode = defineOperation({
  name: "internal-operation-compensate",
  input: ExampleInput,
  output: ExampleOutput,
  capabilities: ["network", "integration:internal-publisher"],
  defaults: { timeout: "2m", attempts: 1 },
  authorization: {
    mode: "required",
    action: "compensate the internal example",
    risk: "high",
  },
  binding: "internal.example.compensate",
});

const observerNode = defineObserver({
  name: "internal-observer",
  input: ExampleInput,
  state: ExampleState,
  output: ExampleOutput,
  source: {
    kind: "signal",
    binding: "internal.observer.signal",
    signal: ({ task }) => `internal:${task}`,
    trust: { minimum: "authenticated", authorities: ["internal-host"] },
  },
  defaults: { timeout: "1h" },
  complete: (state) => (state.done ? { summary: state.summary } : null),
});

const workflowNode = defineWorkflow(
  { id: "internal-workflow", input: ExampleInput, output: ExampleOutput },
  async (_ctx, { task }) => ({ summary: task }),
);

const InternalTriggerEvent = ExampleInput.extend({ deliveryId: z.string() });

const triggerNode = defineTrigger({
  name: "internal-trigger",
  revision: "v1",
  source: { binding: "internal.trigger.event" },
  event: InternalTriggerEvent,
  workflow: workflowNode,
  eventId: ({ deliveryId }) => deliveryId,
  dedupeKey: ({ deliveryId }) => deliveryId,
  map: ({ task }) => ({ task }),
});

const ReviewFinding = z.object({ message: z.string() });

const reviewNode = defineReview({
  name: "internal-review",
  input: ExampleInput,
  finding: ReviewFinding,
  evaluate: async (_ctx, { task }) => ({
    assessments: [
      {
        finding: { message: task },
        disposition: "advisory" as const,
        sources: ["internal"],
        rationale: "Compile-time review invocation proof",
      },
    ],
  }),
  accept: ({ assessments }) => assessments.every(({ disposition }) => disposition !== "blocking"),
});

const deliveryNode = defineDelivery({
  name: "internal-delivery",
  binding: "internal.delivery.execute",
  input: ExampleInput,
  output: ExampleOutput,
  capabilities: ["workspace:read"],
  defaults: {
    authorization: { action: "deliver internal example", risk: "high" },
  },
});

interface ExampleAgentCall extends AnyDefinedAgentCall {
  agent: typeof agentNode;
  input: ExampleInputValue;
  write: WriteScope<typeof pathPolicyNode>;
  failure: "return";
}

interface ExampleGoalAgentCall extends AnyDefinedAgentCall {
  agent: typeof agentNode;
  input: ExampleInputValue;
  write: WriteScope<typeof pathPolicyNode>;
  goal: GoalInvocation<typeof goalNode>;
}

/** Why: Proves inline calls enter the same node-backed executor without first declaring a reusable role. Use: Bind this exact call through the internal context adapter. */
type ExampleInlineAgentCall = InlineAgentCall<typeof ExampleOutput> & {
  readonly key: "inline-agent";
  readonly prompt: "Summarize the internal example";
  readonly schema: typeof ExampleOutput;
};

declare const promptInvocation: PromptRenderInvocation<typeof promptNode>;
declare const agentInvocation: DefinedAgentInvocation<ExampleAgentCall, false>;
declare const workspaceAgentInvocation: DefinedAgentInvocation<ExampleGoalAgentCall, true>;
declare const inlineAgentInvocation: InlineAgentInvocation<ExampleInlineAgentCall, false>;
declare const recipeInvocation: RecipeInvocation<typeof recipeNode>;
declare const checkInvocation: CheckInvocation<typeof checkNode>;
declare const checkFailure: FailedCheckResultOf<typeof checkNode, WorkspaceSnapshotRef>;
declare const checkWaiverInvocation: CheckWaiverAuthorizationInvocation<
  typeof checkNode,
  typeof checkFailure.candidate
>;
declare const suiteInvocation: CheckSuiteInvocation<typeof suiteNode>;
declare const goalInvocation: GoalEvaluationInvocation<typeof goalNode>;
declare const inputViewInvocation: UiRequestInvocation<typeof inputViewNode>;
declare const resultViewInvocation: UiRenderInvocation<typeof resultViewNode>;
declare const taskContractInvocation: TaskContractInvocation<typeof taskContractNode>;
declare const triggerInvocation: TriggerAdmissionInvocation<typeof triggerNode>;
declare const artifactInvocation: ArtifactInvocation<typeof artifactNode>;
declare const pathPolicyInvocation: PathPolicyInvocation<typeof pathPolicyNode>;
declare const operationInvocation: OperationInvocation<typeof operationNode>;
type ExampleOperationCandidate = OperationCandidateRef<typeof protectedOperationNode, ExampleInputValue>;
declare const operationPrepareInvocation: OperationPrepareInvocation<
  typeof protectedOperationNode,
  ExampleInputValue
>;
declare const operationAuthorizeInvocation: OperationAuthorizeInvocation<
  typeof protectedOperationNode,
  ExampleOperationCandidate
>;
declare const protectedOperationInvocation: ProtectedOperationInvocation<
  typeof protectedOperationNode,
  ExampleOperationCandidate
>;
type InternalRecoveryState = OperationRecoveryState<
  typeof cancellationOperationNode,
  ExampleInputValue,
  "internal-cancel-v1",
  typeof compensationOperationNode,
  ExampleInputValue
>;
type InternalOperationAttempt = OperationAttemptRef<
  typeof protectedOperationNode,
  ExampleOperationCandidate,
  "internal-primary-v1",
  InternalRecoveryState
>;
type InternalOperationReceipt = RecoverableOperationReceipt<InternalOperationAttempt>;
type InternalRecoveryCandidate = OperationRecoveryCandidateRef<InternalOperationReceipt>;
declare const recoverableRegistrationInvocation: RecoverableOperationRegistrationInvocation<InternalOperationAttempt>;
declare const recoverableExecutionInvocation: RecoverableOperationExecutionInvocation<InternalOperationAttempt>;
declare const recoveryPrepareInvocation: OperationRecoveryPrepareInvocation<InternalOperationReceipt>;
declare const recoveryInvocation: OperationRecoveryInvocation<
  InternalOperationReceipt,
  InternalRecoveryCandidate,
  "internal-compensation-v1"
>;
declare const observerInvocation: ObserverInvocation<typeof observerNode>;
declare const detailedObserverInvocation: DetailedObserverInvocation<typeof observerNode>;
declare const workflowInvocation: WorkflowRunInvocation<typeof workflowNode>;
declare const detailedWorkflowInvocation: DetailedWorkflowRunInvocation<typeof workflowNode>;
declare const reviewInvocation: ReviewInvocation<typeof reviewNode>;

type ExamplePromotionCandidate = PromotionCandidateRef<typeof deliveryNode>;
declare const deliveryPrepareInvocation: DeliveryPrepareInvocation<typeof deliveryNode>;
declare const deliveryAuthorizeInvocation: DeliveryAuthorizeInvocation<
  typeof deliveryNode,
  ExamplePromotionCandidate
>;
declare const deliveryRunInvocation: DeliveryRunInvocation<typeof deliveryNode, ExamplePromotionCandidate>;

type ExampleSuiteResult = CheckSuiteResult<CheckSuiteDefinitionMembers<typeof suiteNode>>;
type ExampleGoalResult = GoalResult<GoalDefinitionResults<typeof goalNode>>;

expectType<Promise<string>>(internalEngine.execute(promptInvocation));
expectType<Promise<AgentOutcome<ExampleOutputValue, undefined, PatchAgentResult<ExampleOutputValue>>>>(
  internalEngine.execute(agentInvocation),
);
expectType<Promise<WorkspaceWriteAgentResult<ExampleOutputValue, ExampleGoalResult>>>(
  internalEngine.execute(workspaceAgentInvocation),
);
expectType<Promise<AgentResult<ExampleOutputValue>>>(internalEngine.execute(inlineAgentInvocation));
expectType<Promise<ExampleOutputValue>>(internalEngine.execute(recipeInvocation));
expectType<Promise<CheckResultOf<typeof checkNode>>>(internalEngine.execute(checkInvocation));
expectType<Promise<CheckWaiverRef<typeof checkNode, WorkspaceSnapshotRef>>>(
  internalEngine.execute(checkWaiverInvocation),
);
expectType<Promise<ExampleSuiteResult>>(internalEngine.execute(suiteInvocation));
expectType<Promise<ExampleGoalResult>>(internalEngine.execute(goalInvocation));
expectType<Promise<ExampleAnswerValue>>(internalEngine.execute(inputViewInvocation));
expectType<Promise<void>>(internalEngine.execute(resultViewInvocation));
expectType<Promise<ExampleExtensionsValue>>(internalEngine.execute(taskContractInvocation));
expectType<Promise<TriggerAdmissionResult<typeof triggerNode>>>(internalEngine.execute(triggerInvocation));
expectType<Promise<MetadataArtifactRef<string, ExampleInputValue>>>(
  internalEngine.execute(artifactInvocation),
);
expectType<Promise<WriteScope<typeof pathPolicyNode>>>(internalEngine.execute(pathPolicyInvocation));
expectType<Promise<ExampleOutputValue>>(internalEngine.execute(operationInvocation));
expectType<Promise<ExampleOperationCandidate>>(internalEngine.execute(operationPrepareInvocation));
expectType<Promise<OperationAuthorizationRef<typeof protectedOperationNode, ExampleOperationCandidate>>>(
  internalEngine.execute(operationAuthorizeInvocation),
);
expectType<Promise<ExampleOutputValue>>(internalEngine.execute(protectedOperationInvocation));
expectType<Promise<InternalOperationAttempt>>(internalEngine.execute(recoverableRegistrationInvocation));
expectType<Promise<OperationAttemptResult<InternalOperationAttempt>>>(
  internalEngine.execute(recoverableExecutionInvocation),
);
expectType<Promise<InternalRecoveryCandidate>>(internalEngine.execute(recoveryPrepareInvocation));
expectType<
  Promise<
    OperationRecoveryResult<InternalOperationReceipt, InternalRecoveryCandidate, "internal-compensation-v1">
  >
>(internalEngine.execute(recoveryInvocation));
expectType<Promise<ExampleOutputValue>>(internalEngine.execute(observerInvocation));
expectType<Promise<ExampleOutputValue>>(
  internalEngine.execute(detailedObserverInvocation).then(({ output }) => output),
);
expectType<Promise<ExampleOutputValue>>(internalEngine.execute(workflowInvocation));
expectType<Promise<WorkflowRunReceipt<typeof workflowNode>>>(
  internalEngine.execute(detailedWorkflowInvocation),
);
expectType<Promise<ReviewResult<z.infer<typeof ReviewFinding>>>>(internalEngine.execute(reviewInvocation));
expectType<Promise<ExamplePromotionCandidate>>(internalEngine.execute(deliveryPrepareInvocation));
expectType<Promise<DeliveryAuthorizationRef<typeof deliveryNode, ExamplePromotionCandidate>>>(
  internalEngine.execute(deliveryAuthorizeInvocation),
);
expectType<Promise<DeliveryReceipt<typeof deliveryNode, ExamplePromotionCandidate>>>(
  internalEngine.execute(deliveryRunInvocation),
);
