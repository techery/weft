import { z } from "zod";

import type {
  AnyWorkflowInvocation,
  ArtifactInvocation,
  CheckInvocation,
  CheckSuiteInvocation,
  ContextSourceInvocation,
  DefinedAgentInvocation,
  DeliveryPrepareInvocation,
  GoalEvaluationInvocation,
  ObserverInvocation,
  OperationInvocation,
  PathPolicyInvocation,
  PromptRenderInvocation,
  RecipeInvocation,
  ReviewInvocation,
  TaskContractInvocation,
  TriggerAdmissionInvocation,
  UiRequestInvocation,
  WorkflowInvocationInput,
  WorkflowInvocationKind,
  WorkflowInvocationOutput,
  WorkflowRunInvocation,
} from "../../core/internal-engine.ts";
import {
  type AnyDefinedAgentCall,
  type ArtifactCaptureInputOf,
  type ArtifactRefOf,
  type CheckResultOf,
  type ContextSnapshotOf,
  type ContextSourceInputOf,
  type DetailedObserverResult,
  type DeliveryInputOf,
  defineAgent,
  defineArtifact,
  defineCheck,
  defineCheckSuite,
  defineContextSource,
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
  type InferWorkflowInput,
  type InferWorkflowOutput,
  type ObserverInputOf,
  type ObserverOutputOf,
  type OperationInputOf,
  type OperationOutputOf,
  type ReviewFindingOf,
  type ReviewInputOf,
  type TriggerInputOf,
  type TriggerOutputOf,
  type WorkflowInputSchemaOf,
  type WorkflowNode,
  type WorkflowNodeKind,
  type WorkflowOutputSchemaOf,
} from "../../core/index.ts";

/** Why: Makes bidirectional type assertions visible without runtime behavior. Use: Pass exact nodes, invocations, schemas, and results to it. */
declare function expectType<Type>(value: Type): void;

const ExampleInput = z.object({ task: z.string().min(1) }).strict();
const ExampleOutput = z.object({ summary: z.string().min(1) }).strict();
const ExampleState = z.object({ done: z.boolean(), summary: z.string() }).strict();
const ExampleAnswer = z.object({ approved: z.boolean() }).strict();
const ExampleFinding = z.object({ message: z.string().min(1) }).strict();
const ExampleExtensions = z.object({ ticket: z.string().min(1) }).strict();

/** Why: Names the validated common input used across representative node definitions. Use: Compare public helper and internal invocation inference. */
type ExampleInputValue = z.infer<typeof ExampleInput>;

/** Why: Names the validated common output used across representative node definitions. Use: Confirm results stay exact outside erased unions. */
type ExampleOutputValue = z.infer<typeof ExampleOutput>;

const promptNode = definePrompt({
  name: "round-08-union-prompt",
  input: ExampleInput,
  render: ({ task }) => `Complete ${task}`,
});

const agentNode = defineAgent({
  name: "round-08-union-agent",
  prompt: promptNode,
  schema: ExampleOutput,
});

const artifactNode = defineArtifact({
  name: "round-08-union-artifact",
  mediaType: "application/json",
  content: ExampleOutput,
  metadata: ExampleInput,
});

const checkNode = defineCheck({
  name: "round-08-union-check",
  revision: "check-v1",
  policy: "required",
  waiver: {
    mode: "eligible",
    binding: "policy.check-waiver",
    action: "Waive the union fixture check",
    risk: "medium",
    maxTtl: "15m",
  },
  input: ExampleInput,
  command: ({ task }) => ["test", "-n", task],
});

const checkSuiteNode = defineCheckSuite({
  name: "round-08-union-suite",
  input: ExampleInput,
  checks: (input, use) => ({ fixture: use(checkNode, input) }),
});

const contextSourceNode = defineContextSource({
  name: "round-08-union-context",
  input: ExampleInput,
  output: ExampleOutput,
  binding: "repository.context",
  freshness: { maxAge: "5m", stale: "reject" },
  trust: { minimum: "authenticated", authorities: ["repository-host"] },
});

const deliveryNode = defineDelivery({
  name: "round-08-union-delivery",
  binding: "repository.publish",
  input: ExampleInput,
  output: ExampleOutput,
  capabilities: ["network"],
  defaults: {
    authorization: { action: "Publish the union fixture", risk: "high" },
  },
});

const goalNode = defineGoal({ name: "round-08-union-goal", check: checkSuiteNode });

const observerNode = defineObserver({
  name: "round-08-union-observer",
  input: ExampleInput,
  state: ExampleState,
  output: ExampleOutput,
  source: {
    kind: "signal",
    binding: "repository.signal",
    signal: ({ task }) => `round-08:${task}`,
    trust: { minimum: "authenticated", authorities: ["repository-host"] },
  },
  defaults: { timeout: "1h" },
  complete: (state) => (state.done ? { summary: state.summary } : null),
});

const operationNode = defineOperation({
  name: "round-08-union-operation",
  input: ExampleInput,
  output: ExampleOutput,
  binding: "repository.read",
  capabilities: ["workspace:read"],
  authorization: { mode: "none" },
});

const protectedOperationNode = defineOperation({
  name: "round-08-union-protected-operation",
  input: ExampleInput,
  output: ExampleOutput,
  binding: "repository.write",
  capabilities: ["workspace:write"],
  authorization: { mode: "required", action: "Write union fixture", risk: "high" },
});

const pathPolicyNode = definePathPolicy({
  name: "round-08-union-paths",
  revision: "paths-v1",
  roots: ["packages"],
  deny: ["**/dist/**"],
  grantTtl: "30m",
});

const recipeNode = defineRecipe({
  name: "round-08-union-recipe",
  input: ExampleInput,
  output: ExampleOutput,
  run: async (_ctx, input) => ({ summary: input.task }),
});

const reviewNode = defineReview({
  name: "round-08-union-review",
  input: ExampleInput,
  finding: ExampleFinding,
  evaluate: (_ctx, input) => ({
    assessments: [
      {
        finding: { message: input.task },
        disposition: "advisory" as const,
        sources: ["fixture"],
        rationale: "Union typing fixture",
      },
    ],
  }),
  accept: ({ assessments }) => assessments.every(({ disposition }) => disposition !== "blocking"),
});

const taskContractNode = defineTaskContract({
  schema: ExampleExtensions,
});

const inputViewNode = defineUiView({
  id: "round-08-union-input-view",
  revision: "view-v1",
  props: ExampleInput,
  answer: ExampleAnswer,
  component: ({ propose }) => propose({ approved: true }),
});

const resultViewNode = defineResultView({
  id: "round-08-union-result-view",
  revision: "view-v1",
  props: ExampleOutput,
  component: ({ props }) => props.summary,
});

const workflowNode = defineWorkflow(
  {
    id: "round-08-union-workflow",
    name: "Round 8 union workflow",
    input: ExampleInput,
    output: ExampleOutput,
  },
  async (_ctx, input): Promise<ExampleOutputValue> => ({ summary: input.task }),
);

const TriggerEvent = ExampleInput.extend({ deliveryId: z.string().min(1) }).strict();

const triggerNode = defineTrigger({
  name: "round-08-union-trigger",
  revision: "trigger-v1",
  source: { binding: "repository.event" },
  event: TriggerEvent,
  workflow: workflowNode,
  eventId: ({ deliveryId }) => deliveryId,
  dedupeKey: ({ deliveryId }) => deliveryId,
  map: ({ task }) => ({ task }),
});

// ---------------------------------------------------------------------------
// Exhaustive public node registry and kind-based inspection
// ---------------------------------------------------------------------------

const workflowNodeRegistry = {
  "weft.agent": agentNode,
  "weft.artifact": artifactNode,
  "weft.check": checkNode,
  "weft.check-suite": checkSuiteNode,
  "weft.context-source": contextSourceNode,
  "weft.delivery": deliveryNode,
  "weft.goal": goalNode,
  "weft.observer": observerNode,
  "weft.operation": operationNode,
  "weft.path-policy": pathPolicyNode,
  "weft.prompt": promptNode,
  "weft.recipe": recipeNode,
  "weft.review": reviewNode,
  "weft.task-contract": taskContractNode,
  "weft.trigger": triggerNode,
  "weft.ui-view": inputViewNode,
  "weft.workflow": workflowNode,
} as const satisfies { readonly [Kind in WorkflowNodeKind]: WorkflowNode<Kind> };

/** Why: Recovers the concrete registered definition for one public node kind. Use: Inspect heterogeneous nodes without widening their exact definition type. */
type RegisteredNode<Kind extends WorkflowNodeKind> = (typeof workflowNodeRegistry)[Kind];

/** Why: Forms the exact heterogeneous definition union from the registry. Use: Drive distributive metadata and invocation tooling. */
type RegisteredNodeUnion = RegisteredNode<WorkflowNodeKind>;

/** Why: Reads one definition through the closed kind index while preserving its concrete type. Use: Prefer it to searching an untyped node array. */
function nodeFor<Kind extends WorkflowNodeKind>(kind: Kind): RegisteredNode<Kind> {
  return workflowNodeRegistry[kind];
}

declare const publicNodeKind: WorkflowNodeKind;
declare const registeredNodeKind: keyof typeof workflowNodeRegistry;
expectType<keyof typeof workflowNodeRegistry>(publicNodeKind);
expectType<WorkflowNodeKind>(registeredNodeKind);
expectType<typeof triggerNode>(nodeFor("weft.trigger"));
expectType<typeof workflowNode>(nodeFor("weft.workflow"));
expectType<WorkflowNode<"weft.operation">>(protectedOperationNode);
expectType<WorkflowNode<"weft.ui-view">>(resultViewNode);

const inspectedTrigger = nodeFor("weft.trigger");
// @ts-expect-error Kind-based lookup cannot return an observer when the key selects a trigger.
expectType<typeof observerNode>(inspectedTrigger);

const structuralNode = { kind: "weft.recipe" as const };
// @ts-expect-error A public kind discriminator without the nominal definition brand is not a WorkflowNode.
expectType<WorkflowNode<"weft.recipe">>(structuralNode);

// @ts-expect-error Unknown public kinds cannot index the exhaustive node registry.
nodeFor("weft.catalog");

// ---------------------------------------------------------------------------
// Definition identity and revision metadata
// ---------------------------------------------------------------------------

/** Why: Extracts name metadata distributively from exact definitions. Use: Measure which `define*` APIs retain literal identities. */
type DefinitionNameOf<Node> = Node extends { readonly name: infer Name extends string } ? Name : never;

/** Why: Extracts ID metadata distributively from exact definitions. Use: Cover UI definitions separately from name-bearing definitions. */
type DefinitionIdOf<Node> = Node extends { readonly id: infer Id extends string } ? Id : never;

/** Why: Extracts revision metadata distributively from exact definitions. Use: Measure which `define*` APIs retain literal revisions. */
type DefinitionRevisionOf<Node> = Node extends { readonly revision: infer Revision extends string }
  ? Revision
  : never;

declare const triggerName: DefinitionNameOf<typeof triggerNode>;
declare const triggerRevision: DefinitionRevisionOf<typeof triggerNode>;
declare const pathName: DefinitionNameOf<typeof pathPolicyNode>;
declare const pathRevision: DefinitionRevisionOf<typeof pathPolicyNode>;
declare const contextName: DefinitionNameOf<typeof contextSourceNode>;
declare const observerName: DefinitionNameOf<typeof observerNode>;
declare const checkName: DefinitionNameOf<typeof checkNode>;
declare const checkRevision: DefinitionRevisionOf<typeof checkNode>;
declare const viewId: DefinitionIdOf<typeof inputViewNode>;
expectType<"round-08-union-trigger">(triggerName);
expectType<"trigger-v1">(triggerRevision);
expectType<"round-08-union-paths">(pathName);
expectType<"paths-v1">(pathRevision);
expectType<"round-08-union-context">(contextName);
expectType<"round-08-union-observer">(observerName);
expectType<"round-08-union-check">(checkName);
expectType<"check-v1">(checkRevision);
expectType<string>(viewId);
expectType<"round-08-union-input-view">(viewId);
expectType<"round-08-union-agent">(agentNode.name);
expectType<"round-08-union-prompt">(promptNode.name);
expectType<"round-08-union-recipe">(recipeNode.name);

/** Why: Collects every name-bearing definition identity in the heterogeneous registry. Use: Prove the registry forms one closed literal union. */
type RegisteredDefinitionName = DefinitionNameOf<RegisteredNodeUnion>;

declare const registeredDefinitionName: RegisteredDefinitionName;
expectType<string>(registeredDefinitionName);
expectType<
  | "round-08-union-agent"
  | "round-08-union-artifact"
  | "round-08-union-check"
  | "round-08-union-suite"
  | "round-08-union-trigger"
  | "round-08-union-context"
  | "round-08-union-delivery"
  | "round-08-union-goal"
  | "round-08-union-paths"
  | "round-08-union-observer"
  | "round-08-union-operation"
  | "round-08-union-prompt"
  | "round-08-union-recipe"
  | "round-08-union-review"
>(registeredDefinitionName);

// ---------------------------------------------------------------------------
// Exact node-to-primary-invocation input and output extraction
// ---------------------------------------------------------------------------

/** Why: Supplies the representative agent call needed to bind its primary internal invocation. Use: Keep the agent's exact input and schema output. */
interface RegistryAgentCall extends AnyDefinedAgentCall {
  agent: typeof agentNode;
  input: ExampleInputValue;
}

/** Why: Selects one representative invocation for each public node kind. Use: Extract exact primary input/output while acknowledging multi-operation node kinds separately. */
interface PrimaryInvocationByNodeKind {
  "weft.agent": DefinedAgentInvocation<RegistryAgentCall, false>;
  "weft.artifact": ArtifactInvocation<typeof artifactNode>;
  "weft.check": CheckInvocation<typeof checkNode>;
  "weft.check-suite": CheckSuiteInvocation<typeof checkSuiteNode>;
  "weft.context-source": ContextSourceInvocation<typeof contextSourceNode>;
  "weft.delivery": DeliveryPrepareInvocation<typeof deliveryNode>;
  "weft.goal": GoalEvaluationInvocation<typeof goalNode>;
  "weft.observer": ObserverInvocation<typeof observerNode>;
  "weft.operation": OperationInvocation<typeof operationNode>;
  "weft.path-policy": PathPolicyInvocation<typeof pathPolicyNode>;
  "weft.prompt": PromptRenderInvocation<typeof promptNode>;
  "weft.recipe": RecipeInvocation<typeof recipeNode>;
  "weft.review": ReviewInvocation<typeof reviewNode>;
  "weft.task-contract": TaskContractInvocation<typeof taskContractNode>;
  "weft.trigger": TriggerAdmissionInvocation<typeof triggerNode>;
  "weft.ui-view": UiRequestInvocation<typeof inputViewNode>;
  "weft.workflow": WorkflowRunInvocation<typeof workflowNode>;
}

/** Why: Extracts the exact input of a public node's representative internal invocation. Use: Build schema-aware inspectors without returning `unknown`. */
type PrimaryInvocationInput<Kind extends WorkflowNodeKind> = WorkflowInvocationInput<
  PrimaryInvocationByNodeKind[Kind]
>;

/** Why: Extracts the exact output of a public node's representative internal invocation. Use: Correlate inspection and execution tooling by kind. */
type PrimaryInvocationOutput<Kind extends WorkflowNodeKind> = WorkflowInvocationOutput<
  PrimaryInvocationByNodeKind[Kind]
>;

declare const primaryInvocationKind: keyof PrimaryInvocationByNodeKind;
expectType<keyof PrimaryInvocationByNodeKind>(publicNodeKind);
expectType<WorkflowNodeKind>(primaryInvocationKind);

declare const workflowInput: PrimaryInvocationInput<"weft.workflow">;
declare const workflowOutput: PrimaryInvocationOutput<"weft.workflow">;
declare const triggerInput: PrimaryInvocationInput<"weft.trigger">;
declare const triggerOutput: PrimaryInvocationOutput<"weft.trigger">;
declare const promptInput: PrimaryInvocationInput<"weft.prompt">;
declare const promptOutput: PrimaryInvocationOutput<"weft.prompt">;
declare const contextInput: PrimaryInvocationInput<"weft.context-source">;
declare const contextOutput: PrimaryInvocationOutput<"weft.context-source">;
expectType<InferWorkflowInput<typeof workflowNode>>(workflowInput);
expectType<InferWorkflowOutput<typeof workflowNode>>(workflowOutput);
expectType<TriggerInputOf<typeof triggerNode>>(triggerInput);
expectType<TriggerOutputOf<typeof triggerNode>>(triggerOutput);
expectType<ExampleInputValue>(promptInput);
expectType<string>(promptOutput);
expectType<ContextSourceInputOf<typeof contextSourceNode>>(contextInput);
expectType<ContextSnapshotOf<typeof contextSourceNode>>(contextOutput);

expectType<WorkflowInputSchemaOf<typeof workflowNode>>(ExampleInput);
expectType<typeof ExampleInput>(workflowNode.meta.input);
expectType<WorkflowOutputSchemaOf<typeof workflowNode>>(ExampleOutput);
expectType<typeof ExampleOutput>(workflowNode.meta.output);
expectType<ArtifactCaptureInputOf<typeof artifactNode>>({
  content: { summary: "captured" },
  metadata: { task: "inspect" },
});
declare const artifactOutput: PrimaryInvocationOutput<"weft.artifact">;
expectType<ArtifactRefOf<typeof artifactNode>>(artifactOutput);
expectType<OperationInputOf<typeof operationNode>>({ task: "read" });
declare const operationOutput: PrimaryInvocationOutput<"weft.operation">;
expectType<OperationOutputOf<typeof operationNode>>(operationOutput);
expectType<ObserverInputOf<typeof observerNode>>({ task: "observe" });
declare const observerOutput: PrimaryInvocationOutput<"weft.observer">;
expectType<ObserverOutputOf<typeof observerNode>>(observerOutput);
declare const detailedSignalObservation: DetailedObserverResult<typeof observerNode>;
expectType<"authenticated" | "authoritative">(detailedSignalObservation.provenance.trust.level);
expectType<"repository-host">(detailedSignalObservation.provenance.trust.authority);
expectType<ReviewInputOf<typeof reviewNode>>({ task: "review" });

/** Why: Extracts one exact finding from the representative review result without indexing a possibly empty array value. Use: Prove review output helper correlation. */
type PrimaryReviewFinding = PrimaryInvocationOutput<"weft.review">["assessments"][number]["finding"];

declare const primaryReviewFinding: PrimaryReviewFinding;
expectType<ReviewFindingOf<typeof reviewNode>>(primaryReviewFinding);
expectType<DeliveryInputOf<typeof deliveryNode>>({ task: "deliver" });
declare const checkOutput: PrimaryInvocationOutput<"weft.check">;
expectType<CheckResultOf<typeof checkNode>>(checkOutput);

// @ts-expect-error Workflow output cannot substitute for the workflow's raw launch input.
expectType<PrimaryInvocationInput<"weft.workflow">>({ summary: "wrong side" });
// @ts-expect-error Prompt rendering produces text, not the agent's structured output schema.
expectType<ExampleOutputValue>(promptOutput);

// ---------------------------------------------------------------------------
// Closed internal invocation union and exhaustive result mapping
// ---------------------------------------------------------------------------

/** Why: Selects the erased internal invocation member for one exact operation kind. Use: Derive closed dispatcher input/output maps. */
type InvocationByKind<Kind extends WorkflowInvocationKind> = Extract<
  AnyWorkflowInvocation,
  { readonly kind: Kind }
>;

/** Why: Names one kind-correlated internal result envelope. Use: Keep dispatcher results discriminated after generic execution. */
interface InternalInvocationResult<Kind extends WorkflowInvocationKind, Output> {
  readonly kind: Kind;
  readonly output: Output;
}

/** Why: Derives the erased union member's promised output for one invocation kind. Use: Parameterize exhaustive result mappers. */
type InternalInvocationOutput<Kind extends WorkflowInvocationKind> = WorkflowInvocationOutput<
  InvocationByKind<Kind>
>;

/** Why: Couples one internal invocation kind to its exact erased-union output. Use: Return it from the kind-specific mapper registry. */
type InternalInvocationResultOf<Kind extends WorkflowInvocationKind> = InternalInvocationResult<
  Kind,
  InternalInvocationOutput<Kind>
>;

/** Why: Names one kind-specific internal result mapper. Use: Make `prompt.render` remain string and `ui.render` remain void. */
type InternalResultMapper<Kind extends WorkflowInvocationKind> = (
  output: InternalInvocationOutput<Kind>,
) => InternalInvocationResultOf<Kind>;

/** Why: Requires one result mapper for every closed internal invocation kind. Use: Let additions fail compilation until dispatcher tooling handles them. */
type InternalResultMapperRegistry = {
  readonly [Kind in WorkflowInvocationKind]: InternalResultMapper<Kind>;
};

/** Why: Builds one kind-correlated mapper without casting through the erased invocation union. Use: Populate the exhaustive registry below. */
function resultMapper<const Kind extends WorkflowInvocationKind>(kind: Kind): InternalResultMapper<Kind> {
  return (output) => ({ kind, output });
}

const internalResultMappers = {
  "agent.run": resultMapper("agent.run"),
  "artifact.capture": resultMapper("artifact.capture"),
  "check.run": resultMapper("check.run"),
  "check.authorize": resultMapper("check.authorize"),
  "check-suite.run": resultMapper("check-suite.run"),
  "context.resolve": resultMapper("context.resolve"),
  "delivery.authorize": resultMapper("delivery.authorize"),
  "delivery.prepare": resultMapper("delivery.prepare"),
  "delivery.run": resultMapper("delivery.run"),
  "goal.evaluate": resultMapper("goal.evaluate"),
  "observer.wait": resultMapper("observer.wait"),
  "operation.authorize": resultMapper("operation.authorize"),
  "operation.prepare": resultMapper("operation.prepare"),
  "operation.recoverable.register": resultMapper("operation.recoverable.register"),
  "operation.recoverable.run": resultMapper("operation.recoverable.run"),
  "operation.recovery.prepare": resultMapper("operation.recovery.prepare"),
  "operation.recovery.run": resultMapper("operation.recovery.run"),
  "operation.run": resultMapper("operation.run"),
  "path-policy.resolve": resultMapper("path-policy.resolve"),
  "prompt.render": resultMapper("prompt.render"),
  "recipe.run": resultMapper("recipe.run"),
  "review.run": resultMapper("review.run"),
  "task-contract.apply": resultMapper("task-contract.apply"),
  "trigger.admit": resultMapper("trigger.admit"),
  "ui.request": resultMapper("ui.request"),
  "ui.render": resultMapper("ui.render"),
  "workflow.run": resultMapper("workflow.run"),
} as const satisfies InternalResultMapperRegistry;

declare const publicInvocationKind: WorkflowInvocationKind;
declare const unionInvocationKind: AnyWorkflowInvocation["kind"];
declare const mappedInvocationKind: keyof typeof internalResultMappers;
expectType<AnyWorkflowInvocation["kind"]>(publicInvocationKind);
expectType<WorkflowInvocationKind>(unionInvocationKind);
expectType<WorkflowInvocationKind>(mappedInvocationKind);
expectType<keyof typeof internalResultMappers>(publicInvocationKind);

const renderedPromptResult = internalResultMappers["prompt.render"]("Rendered prompt");
const renderedUiResult = internalResultMappers["ui.render"](undefined);
expectType<InternalInvocationResult<"prompt.render", string>>(renderedPromptResult);
expectType<InternalInvocationResult<"ui.render", void>>(renderedUiResult);
// @ts-expect-error Prompt rendering's erased internal result is still exactly string.
internalResultMappers["prompt.render"]({ summary: "not text" });

// @ts-expect-error Unknown invocation kinds cannot enter the closed internal mapper registry.
const unknownInvocationKind: WorkflowInvocationKind = "catalog.inspect";
expectType<WorkflowInvocationKind>(unknownInvocationKind);

const incompleteResultMappers = {
  "prompt.render": resultMapper("prompt.render"),
};
// @ts-expect-error An internal dispatcher map must cover all 27 current invocation kinds.
expectType<InternalResultMapperRegistry>(incompleteResultMappers);

// Round 8 node-union findings (maximum five):
// 1. All public `define*` results tested here satisfy nominal `WorkflowNode`; the mapped registry proves all 17 kinds
//    are present, and kind lookup retains each exact definition rather than returning a broad node union.
// 2. `AnyWorkflowInvocation["kind"]` exactly matches all 27 `WorkflowInvocationKind` members, and a mapped result
//    registry provides a compact compile-time exhaustiveness tripwire for future engine operations.
// 3. Every name- or ID-bearing definition in the registry now retains its declared literal identity, so generic tooling
//    can form closed identity unions without casts; semantic revisions remain independently inspectable where modeled.
// 4. The erased internal union necessarily yields `unknown` for most operation results; exact I/O is available only
//    from specialized invocation types, while `prompt.render` remains `string` and `ui.render` remains `void`.
// 5. Public node kind to invocation kind is intentionally one-to-many for operations, deliveries, UI, checks, and
//    workflows; tooling should inspect invocation kinds for execution and node kinds only for definition discovery.
