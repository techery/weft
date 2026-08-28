import {
  type ArtifactInvocation,
  type CheckInvocation,
  type CheckSuiteDefinitionMembers,
  type CheckSuiteInvocation,
  type DefinedAgentInvocation,
  type GoalDefinitionResults,
  type GoalEvaluationInvocation,
  internalEngine,
  type ObserverInvocation,
  type OperationInvocation,
  type PromptRenderInvocation,
  type RecipeInvocation,
  type TaskContractInvocation,
  type UiRenderInvocation,
  type UiRequestInvocation,
  type WorkflowRunInvocation,
} from "../core/internal-engine.ts";
import {
  type AnyDefinedAgentCall,
  type CheckResultOf,
  type CheckSuiteResult,
  defineAgent,
  defineArtifact,
  defineCheck,
  defineCheckSuite,
  defineGoal,
  defineObserver,
  defineOperation,
  definePrompt,
  defineRecipe,
  defineResultView,
  defineTaskContract,
  defineUiView,
  defineWorkflow,
  type GoalInvocation,
  type GoalResult,
  type MetadataArtifactRef,
  type PatchAgentResult,
  type WorkspaceWriteAgentResult,
  type WriteScope,
  z,
} from "../index.ts";

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

const checkNode = defineCheck({
  name: "internal-check",
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
  revision: "internal-v1",
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
  run: async ({ task }) => ({ summary: task }),
});

const observerNode = defineObserver({
  name: "internal-observer",
  input: ExampleInput,
  state: ExampleState,
  output: ExampleOutput,
  source: {
    kind: "signal",
    signal: ({ task }) => `internal:${task}`,
  },
  defaults: { timeout: "1h" },
  complete: (state) => (state.done ? { summary: state.summary } : null),
});

const workflowNode = defineWorkflow(
  { id: "internal-workflow", input: ExampleInput, output: ExampleOutput },
  async (_ctx, { task }) => ({ summary: task }),
);

interface ExampleAgentCall extends AnyDefinedAgentCall {
  agent: typeof agentNode;
  input: ExampleInputValue;
  write: WriteScope;
  onError: "null";
}

interface ExampleGoalAgentCall extends AnyDefinedAgentCall {
  agent: typeof agentNode;
  input: ExampleInputValue;
  write: WriteScope;
  goal: GoalInvocation<typeof goalNode>;
}

declare const promptInvocation: PromptRenderInvocation<typeof promptNode>;
declare const agentInvocation: DefinedAgentInvocation<ExampleAgentCall, false>;
declare const workspaceAgentInvocation: DefinedAgentInvocation<ExampleGoalAgentCall, true>;
declare const recipeInvocation: RecipeInvocation<typeof recipeNode>;
declare const checkInvocation: CheckInvocation<typeof checkNode>;
declare const suiteInvocation: CheckSuiteInvocation<typeof suiteNode>;
declare const goalInvocation: GoalEvaluationInvocation<typeof goalNode>;
declare const inputViewInvocation: UiRequestInvocation<typeof inputViewNode>;
declare const resultViewInvocation: UiRenderInvocation<typeof resultViewNode>;
declare const taskContractInvocation: TaskContractInvocation<typeof taskContractNode>;
declare const artifactInvocation: ArtifactInvocation<typeof artifactNode>;
declare const operationInvocation: OperationInvocation<typeof operationNode>;
declare const observerInvocation: ObserverInvocation<typeof observerNode>;
declare const workflowInvocation: WorkflowRunInvocation<typeof workflowNode>;

type ExampleSuiteResult = CheckSuiteResult<CheckSuiteDefinitionMembers<typeof suiteNode>>;
type ExampleGoalResult = GoalResult<GoalDefinitionResults<typeof goalNode>>;

expectType<Promise<string>>(internalEngine.execute(promptInvocation));
expectType<Promise<PatchAgentResult<ExampleOutputValue> | null>>(internalEngine.execute(agentInvocation));
expectType<Promise<WorkspaceWriteAgentResult<ExampleOutputValue, ExampleGoalResult>>>(
  internalEngine.execute(workspaceAgentInvocation),
);
expectType<Promise<ExampleOutputValue>>(internalEngine.execute(recipeInvocation));
expectType<Promise<CheckResultOf<typeof checkNode>>>(internalEngine.execute(checkInvocation));
expectType<Promise<ExampleSuiteResult>>(internalEngine.execute(suiteInvocation));
expectType<Promise<ExampleGoalResult>>(internalEngine.execute(goalInvocation));
expectType<Promise<ExampleAnswerValue>>(internalEngine.execute(inputViewInvocation));
expectType<Promise<void>>(internalEngine.execute(resultViewInvocation));
expectType<Promise<ExampleExtensionsValue>>(internalEngine.execute(taskContractInvocation));
expectType<Promise<MetadataArtifactRef<string, ExampleInputValue>>>(
  internalEngine.execute(artifactInvocation),
);
expectType<Promise<ExampleOutputValue>>(internalEngine.execute(operationInvocation));
expectType<Promise<ExampleOutputValue>>(internalEngine.execute(observerInvocation));
expectType<Promise<ExampleOutputValue>>(internalEngine.execute(workflowInvocation));
