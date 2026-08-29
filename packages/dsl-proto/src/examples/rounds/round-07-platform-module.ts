import {
  type AgentDefinition,
  type CheckCommand,
  type CheckDefinition,
  type CheckExecutionResult,
  type CheckSuiteDefinition,
  type Duration,
  defineAgent,
  defineCheck,
  defineCheckSuite,
  definePathPolicy,
  definePrompt,
  defineReview,
  defineTaskContract,
  defineWorkflow,
  type NeverCheckWaiverPolicy,
  type PathPolicyDefinition,
  type PromptDefinition,
  type Provider,
  type ReviewDefinition,
  type ReviewEvaluation,
  type TaskContract,
  type WorkflowDefinition,
  type WorkflowNode,
  type WorkflowTaskSnapshot,
  type WorkflowTaskSummary,
  type WorkspaceSnapshotRef,
  z,
} from "../../index.ts";

/** Why: Makes compile-time contract assertions readable without introducing runtime behavior. Use: Pass exported module members to it at the end of this example. */
declare function expectType<Type>(value: Type): void;

const ModuleIdentitySchema = z.object({
  namespace: z.string().min(1),
  revision: z.string().min(1),
  displayName: z.string().min(1),
});

/** Why: Names one immutable factory specialization across child-run inputs and outputs. Use: Reject a child call routed to definitions from another module instance. */
interface ModuleIdentityValue {
  namespace: string;
  revision: string;
  displayName: string;
}

const PlatformChangeRequestSchema: z.ZodType<PlatformChangeRequestValue, PlatformChangeRequestValue> =
  z.object({
    requestId: z.string().min(1),
    repository: z.string().min(1),
    baseRef: z.string().min(1),
    branch: z.string().min(1),
    title: z.string().min(1),
    objective: z.string().min(1),
    acceptanceCriteria: z.array(z.string().min(1)).min(1),
    proposedPaths: z.array(z.string().min(1)).min(1),
  });

/** Why: Gives all three workflows the same validated coding request contract. Use: Pass it unchanged through planning and implementation child boundaries. */
interface PlatformChangeRequestValue {
  requestId: string;
  repository: string;
  baseRef: string;
  branch: string;
  title: string;
  objective: string;
  acceptanceCriteria: string[];
  proposedPaths: string[];
}

const PlatformPlanStepSchema = z.object({
  id: z.string().min(1),
  description: z.string().min(1),
  paths: z.array(z.string().min(1)).min(1),
  verification: z.array(z.string().min(1)).min(1),
});

const PlatformPlanSchema: z.ZodType<PlatformPlanValue, PlatformPlanValue> = z.object({
  summary: z.string().min(1),
  steps: z.array(PlatformPlanStepSchema).min(1),
  risks: z.array(z.string().min(1)),
});

/** Why: Names the schema-validated plan crossing from the read-only child to the workspace-owning child. Use: Treat it as advice until the writer receives a strict path scope. */
interface PlatformPlanValue {
  summary: string;
  steps: Array<{
    id: string;
    description: string;
    paths: string[];
    verification: string[];
  }>;
  risks: string[];
}

const PlanningAgentInputSchema: z.ZodType<PlanningAgentInputValue, PlanningAgentInputValue> = z.object({
  module: ModuleIdentitySchema,
  request: PlatformChangeRequestSchema,
});

/** Why: Keeps module specialization visible to the reusable planner prompt. Use: Prevent similarly named module instances from sharing hidden ambient configuration. */
interface PlanningAgentInputValue {
  module: ModuleIdentityValue;
  request: PlatformChangeRequestValue;
}

const ChildRunProvenanceSchema = z.object({
  module: ModuleIdentitySchema,
  role: z.enum(["planning", "implementation"]),
  workflowId: z.string().min(1),
  runId: z.string().min(1),
  parentRunId: z.string().min(1),
  taskDedupeKey: z.string().min(1),
  agent: z.object({
    definition: z.string().min(1),
    attempts: z.number().int().positive(),
    sessionId: z.string().min(1).nullable(),
  }),
});

/** Why: Names the serializable child-run correlation returned through workflow schemas. Use: Keep it for diagnostics, never as nominal proof that the engine launched the claimed parent-child edge. */
interface ChildRunProvenanceValue {
  module: ModuleIdentityValue;
  role: "planning" | "implementation";
  workflowId: string;
  runId: string;
  parentRunId: string;
  taskDedupeKey: string;
  agent: {
    definition: string;
    attempts: number;
    sessionId: string | null;
  };
}

const PlanningChildInputSchema: z.ZodType<PlanningChildInputValue, PlanningChildInputValue> = z.object({
  module: ModuleIdentitySchema,
  parentRunId: z.string().min(1),
  request: PlatformChangeRequestSchema,
});

/** Why: Gives the planning child a complete direct-launch contract. Use: The parent supplies its run ID as correlation while the child revalidates module identity. */
interface PlanningChildInputValue {
  module: ModuleIdentityValue;
  parentRunId: string;
  request: PlatformChangeRequestValue;
}

const PlanningChildOutputSchema: z.ZodType<PlanningChildOutputValue, PlanningChildOutputValue> = z.object({
  plan: PlatformPlanSchema,
  provenance: ChildRunProvenanceSchema.extend({ role: z.literal("planning") }),
});

/** Why: Preserves typed planning output and its diagnostic run correlation together. Use: Pass it whole into the implementation child. */
interface PlanningChildOutputValue {
  plan: PlatformPlanValue;
  provenance: ChildRunProvenanceValue & { role: "planning" };
}

const ImplementationAgentInputSchema: z.ZodType<
  ImplementationAgentInputValue,
  ImplementationAgentInputValue
> = z.object({
  module: ModuleIdentitySchema,
  request: PlatformChangeRequestSchema,
  plan: PlatformPlanSchema,
  planningRunId: z.string().min(1),
});

/** Why: Gives the writer only validated request, plan, and lineage hints. Use: Pair it with an engine-minted strict write scope at invocation time. */
interface ImplementationAgentInputValue {
  module: ModuleIdentityValue;
  request: PlatformChangeRequestValue;
  plan: PlatformPlanValue;
  planningRunId: string;
}

const ImplementationReportSchema: z.ZodType<ImplementationReportValue, ImplementationReportValue> = z.object({
  summary: z.string().min(1),
  changedFiles: z.array(z.string().min(1)).min(1),
  testsAddedOrUpdated: z.array(z.string().min(1)),
  residualRisks: z.array(z.string().min(1)),
});

/** Why: Names the writer's structured account before it is reconciled with engine-observed files. Use: Reject reports that omit or invent changed paths. */
interface ImplementationReportValue {
  summary: string;
  changedFiles: string[];
  testsAddedOrUpdated: string[];
  residualRisks: string[];
}

const ReviewFindingSchema: z.ZodType<ReviewFindingValue, ReviewFindingValue> = z.object({
  path: z.string().min(1),
  line: z.number().int().positive().optional(),
  severity: z.enum(["low", "medium", "high", "critical"]),
  claim: z.string().min(1),
  evidence: z.string().min(1),
  sources: z.array(z.string().min(1)).min(1),
});

/** Why: Names one model-proposed review finding before deterministic policy assigns its disposition. Use: Preserve source evidence through exact-subject review. */
interface ReviewFindingValue {
  path: string;
  line?: number | undefined;
  severity: "low" | "medium" | "high" | "critical";
  claim: string;
  evidence: string;
  sources: string[];
}

const ReviewReportSchema: z.ZodType<ReviewReportValue, ReviewReportValue> = z.object({
  summary: z.string().min(1),
  findings: z.array(ReviewFindingSchema),
});

/** Why: Names the reviewer agent's parsed report. Use: Convert it to a policy-owned ReviewEvaluation rather than trusting model-selected acceptance. */
interface ReviewReportValue {
  summary: string;
  findings: ReviewFindingValue[];
}

const CandidateReviewInputSchema: z.ZodType<CandidateReviewInputValue, CandidateReviewInputValue> = z.object({
  module: ModuleIdentitySchema,
  request: PlatformChangeRequestSchema,
  plan: PlatformPlanSchema,
  planningRunId: z.string().min(1),
  implementationSummary: z.string().min(1),
  changedFiles: z.array(z.string().min(1)).min(1),
  keyNamespace: z.string().min(1),
});

/** Why: Gives the reusable review definition all domain data plus an explicit nested key namespace. Use: Avoid hidden counters and evaluator-key collisions across invocations. */
interface CandidateReviewInputValue {
  module: ModuleIdentityValue;
  request: PlatformChangeRequestValue;
  plan: PlatformPlanValue;
  planningRunId: string;
  implementationSummary: string;
  changedFiles: string[];
  keyNamespace: string;
}

const WorkspaceProjectionSchema = z.object({
  workspaceId: z.string().min(1),
  generation: z.number().int().nonnegative(),
  treeHash: z.string().min(1),
});

/** Why: Names a serializable diagnostic projection of nominal workspace identity. Use: Return it across child schemas without ever passing it back into an authority-consuming API. */
interface WorkspaceProjectionValue {
  workspaceId: string;
  generation: number;
  treeHash: string;
}

const ImplementationChildInputSchema: z.ZodType<
  ImplementationChildInputValue,
  ImplementationChildInputValue
> = z.object({
  module: ModuleIdentitySchema,
  parentRunId: z.string().min(1),
  request: PlatformChangeRequestSchema,
  planning: PlanningChildOutputSchema,
});

/** Why: Keeps plan output and parent correlation explicit at the workspace-owning child boundary. Use: Revalidate both before any path grant or writer invocation. */
interface ImplementationChildInputValue {
  module: ModuleIdentityValue;
  parentRunId: string;
  request: PlatformChangeRequestValue;
  planning: PlanningChildOutputValue;
}

const ImplementationChildOutputSchema: z.ZodType<
  ImplementationChildOutputValue,
  ImplementationChildOutputValue
> = z.object({
  status: z.literal("accepted"),
  branch: z.string().min(1),
  head: z.string().min(1),
  changedFiles: z.array(z.string().min(1)).min(1),
  subject: WorkspaceProjectionSchema,
  checks: z.object({
    passed: z.literal(true),
    attestationRef: z.string().min(1),
  }),
  review: z.object({
    evidence: z.string().min(1),
    findings: z.array(
      z.object({
        path: z.string().min(1),
        line: z.number().int().positive().optional(),
        severity: z.enum(["low", "medium", "high", "critical"]),
        claim: z.string().min(1),
        evidence: z.string().min(1),
        sources: z.array(z.string().min(1)).min(1),
        disposition: z.enum(["blocking", "advisory", "refuted"]),
      }),
    ),
  }),
  provenance: ChildRunProvenanceSchema.extend({
    role: z.literal("implementation"),
    planningRunId: z.string().min(1),
  }),
});

/** Why: Names the accepted child result consumed by the plain parent. Use: Retain evidence references and workspace diagnostics without claiming parent-side mutation authority. */
interface ImplementationChildOutputValue {
  status: "accepted";
  branch: string;
  head: string;
  changedFiles: string[];
  subject: WorkspaceProjectionValue;
  checks: {
    passed: true;
    attestationRef: string;
  };
  review: {
    evidence: string;
    findings: Array<ReviewFindingValue & { disposition: "blocking" | "advisory" | "refuted" }>;
  };
  provenance: ChildRunProvenanceValue & {
    role: "implementation";
    planningRunId: string;
  };
}

const PlatformParentOutputSchema: z.ZodType<PlatformParentOutputValue, PlatformParentOutputValue> = z.object({
  status: z.literal("accepted"),
  module: ModuleIdentitySchema,
  requestId: z.string().min(1),
  parentRunId: z.string().min(1),
  planning: PlanningChildOutputSchema,
  implementation: ImplementationChildOutputSchema,
});

/** Why: Gives callers one validated aggregate while preserving both child results. Use: Inspect diagnostic provenance without reconstructing child-run or workspace authority. */
interface PlatformParentOutputValue {
  status: "accepted";
  module: ModuleIdentityValue;
  requestId: string;
  parentRunId: string;
  planning: PlanningChildOutputValue;
  implementation: ImplementationChildOutputValue;
}

const PlatformTaskStageSchema = z.enum([
  "orchestrating",
  "planning",
  "planned",
  "implementing",
  "reviewed",
  "complete",
]);

const PlatformTaskExtensionSchema: z.ZodType<PlatformTaskExtensionValue, PlatformTaskExtensionValue> =
  z.object({
    module: ModuleIdentitySchema,
    requestId: z.string().min(1),
    ownerRunId: z.string().min(1),
    parentRunId: z.string().min(1).nullable(),
    stage: PlatformTaskStageSchema,
    childRunIds: z.array(z.string().min(1)),
    workspace: WorkspaceProjectionSchema.nullable(),
    evidenceRefs: z.array(z.string().min(1)),
  });

/** Why: Names the domain-only task checkpoint shared by parent and child definitions. Use: Report progress while leaving replay, child lineage, and workspace authority with the engine journal. */
interface PlatformTaskExtensionValue {
  module: ModuleIdentityValue;
  requestId: string;
  ownerRunId: string;
  parentRunId: string | null;
  stage: "orchestrating" | "planning" | "planned" | "implementing" | "reviewed" | "complete";
  childRunIds: string[];
  workspace: WorkspaceProjectionValue | null;
  evidenceRefs: string[];
}

/** Why: Defines the immutable values that specialize one reusable coding-platform graph. Use: Construct multiple module instances without registries, counters, or mutable singleton state. */
export interface CodingPlatformModuleConfig<
  Namespace extends string = string,
  Revision extends string = string,
> {
  readonly namespace: Namespace;
  readonly revision: Revision;
  readonly displayName: string;
  readonly writeRoots: readonly [string, ...string[]];
  readonly deniedPaths: readonly string[];
  readonly pathGrantTtl: Duration;
  readonly quality: {
    readonly typecheck: CheckCommand;
    readonly tests: CheckCommand;
  };
  readonly providers: {
    readonly analysis: Provider;
    readonly writing: Provider;
  };
}

/** Why: Exposes a typed ordinary-TypeScript module boundary over all reusable definition nodes. Use: Import individual members or the grouped instance without adding a new executable DSL node. */
export interface CodingPlatformModule<Namespace extends string = string, Revision extends string = string> {
  readonly identity: Readonly<{
    namespace: Namespace;
    revision: Revision;
    displayName: string;
  }>;
  readonly prompts: Readonly<{
    planning: PromptDefinition<PlanningAgentInputValue, PlanningAgentInputValue>;
    implementation: PromptDefinition<ImplementationAgentInputValue, ImplementationAgentInputValue>;
    review: PromptDefinition<CandidateReviewInputValue, CandidateReviewInputValue>;
  }>;
  readonly agents: Readonly<{
    planner: AgentDefinition<PlanningAgentInputValue, typeof PlatformPlanSchema, PlanningAgentInputValue>;
    implementer: AgentDefinition<
      ImplementationAgentInputValue,
      typeof ImplementationReportSchema,
      ImplementationAgentInputValue
    >;
    reviewer: AgentDefinition<
      CandidateReviewInputValue,
      typeof ReviewReportSchema,
      CandidateReviewInputValue
    >;
  }>;
  readonly checks: Readonly<{
    typecheck: CheckDefinition<void, string, void, CheckExecutionResult, NeverCheckWaiverPolicy>;
    tests: CheckDefinition<void, string, void, CheckExecutionResult, NeverCheckWaiverPolicy>;
    quality: CheckSuiteDefinition<void>;
  }>;
  readonly paths: Readonly<{
    writes: PathPolicyDefinition<string, string>;
  }>;
  readonly reviews: Readonly<{
    candidate: ReviewDefinition<
      CandidateReviewInputValue,
      ReviewFindingValue,
      CandidateReviewInputValue,
      ReviewFindingValue
    >;
  }>;
  readonly tasks: TaskContract<typeof PlatformTaskExtensionSchema>;
  readonly workflows: Readonly<{
    planning: WorkflowDefinition<
      PlanningChildInputValue,
      PlanningChildOutputValue,
      PlatformTaskExtensionValue,
      PlanningChildInputValue,
      PlatformTaskExtensionValue
    >;
    implementation: WorkflowDefinition<
      ImplementationChildInputValue,
      ImplementationChildOutputValue,
      PlatformTaskExtensionValue,
      ImplementationChildInputValue,
      PlatformTaskExtensionValue
    >;
    parent: WorkflowDefinition<
      PlatformChangeRequestValue,
      PlatformParentOutputValue,
      PlatformTaskExtensionValue,
      PlatformChangeRequestValue,
      PlatformTaskExtensionValue
    >;
  }>;
}

/** Why: Projects nominal identity only for schema output and diagnostics. Use: Never pass the returned object where WorkspaceSnapshotRef authority is required. */
function projectWorkspace(subject: WorkspaceSnapshotRef): WorkspaceProjectionValue {
  return {
    workspaceId: subject.workspaceId,
    generation: subject.generation,
    treeHash: subject.treeHash,
  };
}

/** Why: Fails closed if verification or review drifted from the candidate generation. Use: Call after every exact-subject boundary in the implementation child. */
function requireSameWorkspace(
  actual: WorkspaceSnapshotRef,
  expected: WorkspaceSnapshotRef,
  label: string,
): void {
  if (
    actual.workspaceId !== expected.workspaceId ||
    actual.generation !== expected.generation ||
    actual.treeHash !== expected.treeHash
  ) {
    throw new Error(`${label} does not describe the implementation workspace generation`);
  }
}

/** Why: Rejects cross-specialization child input before it can influence tasks, paths, or agents. Use: Compare every child input identity with the definitions captured by its factory instance. */
function requireModuleIdentity(actual: ModuleIdentityValue, expected: ModuleIdentityValue): void {
  if (
    actual.namespace !== expected.namespace ||
    actual.revision !== expected.revision ||
    actual.displayName !== expected.displayName
  ) {
    throw new Error("Child workflow input belongs to another coding-platform module specialization");
  }
}

/** Why: Rejects model-planned paths that were not present in the validated caller proposal. Use: Keep the plan advisory and bounded before it reaches a writer prompt. */
function requireBoundedPlan(plan: PlatformPlanValue, request: PlatformChangeRequestValue): void {
  const allowed = new Set(request.proposedPaths);
  for (const step of plan.steps) {
    if (step.paths.some((path) => !allowed.has(path))) {
      throw new Error(`Plan step ${step.id} proposes a path outside the validated request`);
    }
  }
}

/** Why: Centralizes structural child-run correlation checks without treating them as nominal provenance. Use: Reject accidental cross-module or cross-parent output wiring at each child boundary. */
function requireChildCorrelation(
  provenance: ChildRunProvenanceValue,
  identity: ModuleIdentityValue,
  parentRunId: string,
): void {
  requireModuleIdentity(provenance.module, identity);
  if (provenance.parentRunId !== parentRunId) {
    throw new Error("Child output carries a different parent-run correlation");
  }
}

/** Why: Finds the one optimistic task projection created for a phase. Use: Update it only after checking dedupe identity and truncation. */
function requireSingleTask(
  snapshot: WorkflowTaskSnapshot<PlatformTaskExtensionValue>,
  dedupeKey: string,
): WorkflowTaskSummary<PlatformTaskExtensionValue> {
  if (snapshot.truncated) throw new Error(`Task observation for ${dedupeKey} was truncated`);
  const matches = snapshot.tasks.filter((task) => task.dedupeKey === dedupeKey);
  const task = matches[0];
  if (matches.length !== 1 || task === undefined) {
    throw new Error(`Expected exactly one task for ${dedupeKey}`);
  }
  return task;
}

/** Why: Cross-checks model-reported paths with engine-observed writes. Use: Reject invented, omitted, or duplicate changed-file claims before checks and review. */
function requireExactChangedFiles(
  observed: readonly string[],
  reported: ImplementationReportValue["changedFiles"],
): string[] {
  const observedFiles = [...new Set(observed)].sort();
  const reportedFiles = [...new Set(reported)].sort();
  if (
    observedFiles.length === 0 ||
    observedFiles.length !== reportedFiles.length ||
    observedFiles.some((path, index) => path !== reportedFiles[index])
  ) {
    throw new Error("Implementation report does not match engine-observed changed files");
  }
  return observedFiles;
}

/** Why: Assigns acceptance policy outside the reviewer model. Use: Convert high and critical findings into blockers and retain lower severities as advice. */
function evaluateReview(report: ReviewReportValue): ReviewEvaluation<ReviewFindingValue> {
  return {
    summary: report.summary,
    assessments: report.findings.map((finding) => ({
      finding,
      disposition: finding.severity === "high" || finding.severity === "critical" ? "blocking" : "advisory",
      sources: finding.sources,
      rationale: finding.evidence,
    })),
  };
}

/** Why: Creates one closed definition graph from an immutable configuration snapshot. Use: Instantiate it for each platform policy instead of mutating exported definitions or a global registry. */
export function createCodingPlatformModule<const Namespace extends string, const Revision extends string>(
  config: CodingPlatformModuleConfig<Namespace, Revision>,
): CodingPlatformModule<Namespace, Revision> {
  const identity = Object.freeze({
    namespace: config.namespace,
    revision: config.revision,
    displayName: config.displayName,
  });
  const [firstRoot, ...remainingRoots] = config.writeRoots;
  const writeRoots: readonly [string, ...string[]] = [firstRoot, ...remainingRoots];
  const deniedPaths = [...config.deniedPaths];
  const [typecheckExecutable, ...typecheckArguments] = config.quality.typecheck;
  const typecheckCommand: CheckCommand = [typecheckExecutable, ...typecheckArguments];
  const [testExecutable, ...testArguments] = config.quality.tests;
  const testCommand: CheckCommand = [testExecutable, ...testArguments];

  /** Why: Qualifies definition identities by immutable specialization. Use: Keep separately instantiated module graphs distinct in registries and inspection output. */
  const definitionName = (local: string): string => `${identity.namespace}.${identity.revision}.${local}`;

  /** Why: Creates deterministic replay keys without mutable counters. Use: Qualify every effect by module, phase, request, and local action. */
  const stepKey = (phase: string, requestId: string, local: string): string =>
    [identity.namespace, identity.revision, phase, requestId, local]
      .map((segment) => encodeURIComponent(segment))
      .join(":");

  /** Why: Separates task deduplication from journal step identity while retaining the same namespace. Use: Create one stable domain task per run-local phase. */
  const taskKey = (phase: string, requestId: string): string => stepKey(phase, requestId, "task");

  /** Why: Builds typed task checkpoints without leaking workspace brands through task storage. Use: Record only diagnostic projections and evidence references. */
  const taskExtension = (
    requestId: string,
    ownerRunId: string,
    parentRunId: string | null,
    stage: PlatformTaskExtensionValue["stage"],
    childRunIds: readonly string[] = [],
    workspace: WorkspaceProjectionValue | null = null,
    evidenceRefs: readonly string[] = [],
  ): PlatformTaskExtensionValue => ({
    module: identity,
    requestId,
    ownerRunId,
    parentRunId,
    stage,
    childRunIds: [...childRunIds],
    workspace,
    evidenceRefs: [...evidenceRefs],
  });

  const planningPrompt = definePrompt({
    name: definitionName("prompt.plan"),
    input: PlanningAgentInputSchema,
    render: ({ module, request }) => [
      `Plan ${request.requestId} for ${module.displayName} (${module.namespace}@${module.revision}).`,
      `Repository: ${request.repository}; base: ${request.baseRef}.`,
      `Objective: ${request.objective}`,
      `Candidate paths:\n${request.proposedPaths.map((path) => `- ${path}`).join("\n")}`,
      `Acceptance criteria:\n${request.acceptanceCriteria.map((criterion) => `- ${criterion}`).join("\n")}`,
      "Produce a bounded implementation plan. Do not edit files or claim that checks ran.",
    ],
  });

  const implementationPrompt = definePrompt({
    name: definitionName("prompt.implement"),
    input: ImplementationAgentInputSchema,
    render: ({ module, request, plan, planningRunId }) => [
      `Implement ${request.requestId} with ${module.displayName} (${module.namespace}@${module.revision}).`,
      `The plan came from child run correlation ${planningRunId}.`,
      `Objective: ${request.objective}`,
      `Plan: ${plan.summary}`,
      `Steps:\n${plan.steps.map((step) => `- ${step.id}: ${step.description}`).join("\n")}`,
      `Acceptance criteria:\n${request.acceptanceCriteria.map((criterion) => `- ${criterion}`).join("\n")}`,
      "Modify only the engine-authorized paths. Do not commit, publish, or claim verification success.",
    ],
  });

  const reviewPrompt = definePrompt({
    name: definitionName("prompt.review"),
    input: CandidateReviewInputSchema,
    render: ({ module, request, plan, planningRunId, implementationSummary, changedFiles }) => [
      `Review ${request.requestId} for ${module.displayName} (${module.namespace}@${module.revision}).`,
      `Planning child correlation: ${planningRunId}.`,
      `Objective: ${request.objective}`,
      `Plan: ${plan.summary}`,
      `Implementation summary: ${implementationSummary}`,
      `Engine-observed changed files:\n${changedFiles.map((path) => `- ${path}`).join("\n")}`,
      `Acceptance criteria:\n${request.acceptanceCriteria.map((criterion) => `- ${criterion}`).join("\n")}`,
      "Review the current workspace only. Cite repository evidence and do not modify files.",
    ],
  });

  const planner = defineAgent({
    name: definitionName("agent.planner"),
    description: `Produces read-only bounded plans for ${identity.displayName}.`,
    prompt: planningPrompt,
    schema: PlatformPlanSchema,
    defaults: {
      provider: config.providers.analysis,
      maxTurns: 12,
      timeout: "20m",
      repair: 1,
    },
  });

  const implementer = defineAgent({
    name: definitionName("agent.implementer"),
    description: `Implements one authorized plan inside a ${identity.displayName} workflow workspace.`,
    prompt: implementationPrompt,
    schema: ImplementationReportSchema,
    defaults: {
      provider: config.providers.writing,
      maxTurns: 24,
      timeout: "40m",
      repair: 1,
    },
  });

  const reviewer = defineAgent({
    name: definitionName("agent.reviewer"),
    description: `Reviews one exact ${identity.displayName} workspace generation without write authority.`,
    prompt: reviewPrompt,
    schema: ReviewReportSchema,
    defaults: {
      provider: config.providers.analysis,
      maxTurns: 12,
      timeout: "20m",
      repair: 1,
    },
  });

  const typecheck = defineCheck({
    name: definitionName("check.typecheck"),
    description: `Runs the specialized typecheck command for ${identity.displayName}.`,
    command: typecheckCommand,
    policy: "required",
    waiver: { mode: "never" },
    defaults: { timeout: "15m" },
  });

  const tests = defineCheck({
    name: definitionName("check.tests"),
    description: `Runs the specialized focused-test command for ${identity.displayName}.`,
    command: testCommand,
    policy: "required",
    waiver: { mode: "never" },
    defaults: { timeout: "20m" },
  });

  const quality = defineCheckSuite({
    name: definitionName("checks.required-quality"),
    description: `Preserves both required ${identity.displayName} check results on one exact subject.`,
    checks: [typecheck, tests] as const,
    concurrency: 2,
  });

  const writes = definePathPolicy({
    name: definitionName("paths.writer"),
    description: `Restricts ${identity.displayName} writers to immutable specialized roots and denies.`,
    revision: identity.revision,
    roots: writeRoots,
    deny: deniedPaths,
    grantTtl: config.pathGrantTtl,
  });

  const candidateReview = defineReview({
    name: definitionName("review.candidate"),
    description: `Binds ${identity.displayName} review findings to one engine-minted workspace generation.`,
    input: CandidateReviewInputSchema,
    finding: ReviewFindingSchema,
    evaluate: async (ctx, input) => {
      requireModuleIdentity(input.module, identity);
      const report = await ctx.agent({
        key: `${input.keyNamespace}:reviewer`,
        agent: reviewer,
        input,
      });
      return evaluateReview(report.value);
    },
    accept: ({ assessments }) => assessments.every(({ disposition }) => disposition !== "blocking"),
  });

  const tasks = defineTaskContract({
    schema: PlatformTaskExtensionSchema,
    revision: definitionName("tasks.v1"),
    version: 1,
    agentAccess: "read",
  });

  const planningWorkflowId = definitionName("workflow.plan");
  const planningWorkflow = defineWorkflow(
    {
      id: planningWorkflowId,
      name: `Plan a ${identity.displayName} change`,
      description: "Runs read-only planning in its own child run and returns a schema-validated plan.",
      input: PlanningChildInputSchema,
      output: PlanningChildOutputSchema,
      tasks,
    },
    async (ctx, input): Promise<PlanningChildOutputValue> => {
      requireModuleIdentity(input.module, identity);
      const dedupeKey = taskKey("planning", input.request.requestId);
      await ctx.tasks.upsert({
        key: stepKey("planning", input.request.requestId, "register-task"),
        dedupeKey,
        set: {
          title: `Plan ${input.request.title}`,
          description: input.request.objective,
          status: "in_progress",
          priority: "high",
          tags: [identity.namespace, "platform-planning"],
          relatedFiles: input.request.proposedPaths,
          acceptanceCriteria: input.request.acceptanceCriteria,
          extensions: taskExtension(input.request.requestId, ctx.run.id, input.parentRunId, "planning"),
        },
      });

      const result = await ctx.agent({
        key: stepKey("planning", input.request.requestId, "planner"),
        agent: planner,
        input: { module: identity, request: input.request },
        tasks: { mode: "read", dedupeKeys: [dedupeKey] },
      });
      requireBoundedPlan(result.value, input.request);

      const snapshot = await ctx.tasks.observe(
        { dedupeKeys: [dedupeKey], limit: 1 },
        { key: stepKey("planning", input.request.requestId, "observe-task") },
      );
      const task = requireSingleTask(snapshot, dedupeKey);
      await ctx.tasks.update(
        task.id,
        {
          status: "done",
          ifRevision: task.revision,
          extensions: taskExtension(input.request.requestId, ctx.run.id, input.parentRunId, "planned"),
        },
        { key: stepKey("planning", input.request.requestId, "complete-task") },
      );

      return {
        plan: result.value,
        provenance: {
          module: identity,
          role: "planning",
          workflowId: planningWorkflowId,
          runId: ctx.run.id,
          parentRunId: input.parentRunId,
          taskDedupeKey: dedupeKey,
          agent: {
            definition: planner.name,
            attempts: result.attempts,
            sessionId: result.sessionId ?? null,
          },
        },
      };
    },
  );

  const implementationWorkflowId = definitionName("workflow.implement");
  const implementationWorkflow = defineWorkflow(
    {
      id: implementationWorkflowId,
      name: `Implement and review a ${identity.displayName} change`,
      description:
        "Owns the candidate workspace, resolves strict write authority, verifies it, and completes exact-subject review.",
      input: ImplementationChildInputSchema,
      output: ImplementationChildOutputSchema,
      tasks,
      workspace: ({ input }) => ({ branch: input.request.branch, from: input.request.baseRef }),
    },
    async (ctx, input): Promise<ImplementationChildOutputValue> => {
      requireModuleIdentity(input.module, identity);
      requireChildCorrelation(input.planning.provenance, identity, input.parentRunId);
      requireBoundedPlan(input.planning.plan, input.request);

      const dedupeKey = taskKey("implementation", input.request.requestId);
      await ctx.tasks.upsert({
        key: stepKey("implementation", input.request.requestId, "register-task"),
        dedupeKey,
        set: {
          title: `Implement ${input.request.title}`,
          description: input.planning.plan.summary,
          status: "in_progress",
          priority: "high",
          tags: [identity.namespace, "platform-implementation"],
          relatedFiles: input.request.proposedPaths,
          acceptanceCriteria: input.request.acceptanceCriteria,
          extensions: taskExtension(
            input.request.requestId,
            ctx.run.id,
            input.parentRunId,
            "implementing",
            [input.planning.provenance.runId],
            projectWorkspace(ctx.workspace.subject),
          ),
        },
      });

      const writeScope = await ctx.paths.resolve(
        writes,
        { proposedPaths: input.request.proposedPaths },
        {
          key: stepKey("implementation", input.request.requestId, "resolve-write-scope"),
          label: `Resolve ${identity.displayName} writer paths`,
        },
      );
      const implementation = await ctx.agent({
        key: stepKey("implementation", input.request.requestId, "implementer"),
        agent: implementer,
        input: {
          module: identity,
          request: input.request,
          plan: input.planning.plan,
          planningRunId: input.planning.provenance.runId,
        },
        write: writeScope,
        tasks: { mode: "read", dedupeKeys: [dedupeKey] },
      });
      const changedFiles = requireExactChangedFiles(implementation.files, implementation.value.changedFiles);
      const candidateSubject = ctx.workspace.subject;

      const checkResults = await ctx.check(quality, {
        keyPrefix: stepKey("implementation", input.request.requestId, "quality"),
        policy: "required",
      });
      requireSameWorkspace(checkResults.subject, candidateSubject, "Required checks");
      if (!checkResults.passed) throw new Error("Required specialized checks failed");

      const review = await ctx.review(
        candidateReview,
        {
          module: identity,
          request: input.request,
          plan: input.planning.plan,
          planningRunId: input.planning.provenance.runId,
          implementationSummary: implementation.value.summary,
          changedFiles,
          keyNamespace: stepKey("implementation", input.request.requestId, "candidate-review"),
        },
        {
          key: stepKey("implementation", input.request.requestId, "review"),
          label: `Review ${input.request.requestId}`,
          subject: candidateSubject,
        },
      );
      requireSameWorkspace(review.subject, candidateSubject, "Candidate review");
      requireSameWorkspace(ctx.workspace.subject, candidateSubject, "Post-review workspace");
      if (review.status !== "accepted") throw new Error("Candidate requires rework");

      const snapshot = await ctx.tasks.observe(
        { dedupeKeys: [dedupeKey], limit: 1 },
        { key: stepKey("implementation", input.request.requestId, "observe-task") },
      );
      const task = requireSingleTask(snapshot, dedupeKey);
      await ctx.tasks.update(
        task.id,
        {
          status: "done",
          ifRevision: task.revision,
          extensions: taskExtension(
            input.request.requestId,
            ctx.run.id,
            input.parentRunId,
            "reviewed",
            [input.planning.provenance.runId],
            projectWorkspace(candidateSubject),
            [checkResults.attestation.ref, review.evidence],
          ),
        },
        { key: stepKey("implementation", input.request.requestId, "complete-task") },
      );

      const head = await ctx.git.head();
      return {
        status: "accepted",
        branch: ctx.workspace.branch,
        head: head.sha,
        changedFiles,
        subject: projectWorkspace(candidateSubject),
        checks: { passed: true, attestationRef: checkResults.attestation.ref },
        review: {
          evidence: review.evidence,
          findings: review.assessments.map(({ finding, disposition }) => ({
            ...finding,
            disposition,
          })),
        },
        provenance: {
          module: identity,
          role: "implementation",
          workflowId: implementationWorkflowId,
          runId: ctx.run.id,
          parentRunId: input.parentRunId,
          planningRunId: input.planning.provenance.runId,
          taskDedupeKey: dedupeKey,
          agent: {
            definition: implementer.name,
            attempts: implementation.attempts,
            sessionId: implementation.sessionId ?? null,
          },
        },
      };
    },
  );

  const parentWorkflowId = definitionName("workflow.parent");
  const parentWorkflow = defineWorkflow(
    {
      id: parentWorkflowId,
      name: `Coordinate a ${identity.displayName} coding change`,
      description:
        "Coordinates two isolated child runs while deliberately owning no mutable workspace itself.",
      input: PlatformChangeRequestSchema,
      output: PlatformParentOutputSchema,
      tasks,
    },
    async (ctx, request): Promise<PlatformParentOutputValue> => {
      const dedupeKey = taskKey("parent", request.requestId);
      await ctx.tasks.upsert({
        key: stepKey("parent", request.requestId, "register-task"),
        dedupeKey,
        set: {
          title: request.title,
          description: request.objective,
          status: "in_progress",
          priority: "high",
          tags: [identity.namespace, "platform-orchestration"],
          relatedFiles: request.proposedPaths,
          acceptanceCriteria: request.acceptanceCriteria,
          extensions: taskExtension(request.requestId, ctx.run.id, null, "orchestrating"),
        },
      });

      const planning = await ctx.workflow(
        planningWorkflow,
        { module: identity, parentRunId: ctx.run.id, request },
        {
          key: stepKey("parent", request.requestId, "planning-child"),
          label: `Plan ${request.requestId}`,
          budget: { fraction: 0.3 },
        },
      );
      requireChildCorrelation(planning.provenance, identity, ctx.run.id);

      const implementation = await ctx.workflow(
        implementationWorkflow,
        { module: identity, parentRunId: ctx.run.id, request, planning },
        {
          key: stepKey("parent", request.requestId, "implementation-child"),
          label: `Implement ${request.requestId}`,
          budget: { fraction: 0.7 },
        },
      );
      requireChildCorrelation(implementation.provenance, identity, ctx.run.id);
      if (implementation.provenance.planningRunId !== planning.provenance.runId) {
        throw new Error("Implementation child returned inconsistent run correlation");
      }

      const snapshot = await ctx.tasks.observe(
        { dedupeKeys: [dedupeKey], limit: 1 },
        { key: stepKey("parent", request.requestId, "observe-task") },
      );
      const task = requireSingleTask(snapshot, dedupeKey);
      await ctx.tasks.update(
        task.id,
        {
          status: "done",
          ifRevision: task.revision,
          extensions: taskExtension(
            request.requestId,
            ctx.run.id,
            null,
            "complete",
            [planning.provenance.runId, implementation.provenance.runId],
            implementation.subject,
            [implementation.checks.attestationRef, implementation.review.evidence],
          ),
        },
        { key: stepKey("parent", request.requestId, "complete-task") },
      );

      return {
        status: "accepted",
        module: identity,
        requestId: request.requestId,
        parentRunId: ctx.run.id,
        planning,
        implementation,
      };
    },
  );

  return Object.freeze({
    identity,
    prompts: Object.freeze({
      planning: planningPrompt,
      implementation: implementationPrompt,
      review: reviewPrompt,
    }),
    agents: Object.freeze({ planner, implementer, reviewer }),
    checks: Object.freeze({ typecheck, tests, quality }),
    paths: Object.freeze({ writes }),
    reviews: Object.freeze({ candidate: candidateReview }),
    tasks,
    workflows: Object.freeze({
      planning: planningWorkflow,
      implementation: implementationWorkflow,
      parent: parentWorkflow,
    }),
  });
}

/** Why: Provides one concrete package-policy specialization for registry and workflow examples. Use: Import the grouped object or its individually re-exported members below. */
export type Round07PlatformModule = CodingPlatformModule<"round-07.dsl-proto-platform", "v1">;

export const round07PlatformModule: Round07PlatformModule = createCodingPlatformModule({
  namespace: "round-07.dsl-proto-platform",
  revision: "v1",
  displayName: "DSL prototype platform",
  writeRoots: ["packages/dsl-proto/src"],
  deniedPaths: [".git/**", ".weft/**", "**/.env*", "**/node_modules/**", "**/dist/**"],
  pathGrantTtl: "2h",
  quality: {
    typecheck: ["pnpm", "--filter", "@techery/weft-dsl-proto", "typecheck"],
    tests: ["pnpm", "exec", "biome", "check", "packages/dsl-proto/src"],
  },
  providers: {
    analysis: {
      id: "codex",
      model: "gpt-5.6-sol",
      effort: "high",
      options: { sandboxMode: "read-only", networkAccess: false, webSearch: "disabled" },
    },
    writing: {
      id: "codex",
      model: "gpt-5.6-sol",
      effort: "high",
      options: { sandboxMode: "workspace-write", networkAccess: false, webSearch: "disabled" },
    },
  },
});

export const round07PlanningPrompt: Round07PlatformModule["prompts"]["planning"] =
  round07PlatformModule.prompts.planning;
export const round07ImplementationPrompt: Round07PlatformModule["prompts"]["implementation"] =
  round07PlatformModule.prompts.implementation;
export const round07ReviewPrompt: Round07PlatformModule["prompts"]["review"] =
  round07PlatformModule.prompts.review;
export const round07Planner: Round07PlatformModule["agents"]["planner"] =
  round07PlatformModule.agents.planner;
export const round07Implementer: Round07PlatformModule["agents"]["implementer"] =
  round07PlatformModule.agents.implementer;
export const round07Reviewer: Round07PlatformModule["agents"]["reviewer"] =
  round07PlatformModule.agents.reviewer;
export const round07Typecheck: Round07PlatformModule["checks"]["typecheck"] =
  round07PlatformModule.checks.typecheck;
export const round07Tests: Round07PlatformModule["checks"]["tests"] = round07PlatformModule.checks.tests;
export const round07Quality: Round07PlatformModule["checks"]["quality"] =
  round07PlatformModule.checks.quality;
export const round07WritePaths: Round07PlatformModule["paths"]["writes"] = round07PlatformModule.paths.writes;
export const round07CandidateReview: Round07PlatformModule["reviews"]["candidate"] =
  round07PlatformModule.reviews.candidate;
export const round07Tasks: Round07PlatformModule["tasks"] = round07PlatformModule.tasks;
export const round07PlanningWorkflow: Round07PlatformModule["workflows"]["planning"] =
  round07PlatformModule.workflows.planning;
export const round07ImplementationWorkflow: Round07PlatformModule["workflows"]["implementation"] =
  round07PlatformModule.workflows.implementation;
export const round07ParentWorkflow: Round07PlatformModule["workflows"]["parent"] =
  round07PlatformModule.workflows.parent;

expectType<WorkflowNode<"weft.prompt">>(round07PlanningPrompt);
expectType<WorkflowNode<"weft.agent">>(round07Implementer);
expectType<WorkflowNode<"weft.check">>(round07Typecheck);
expectType<WorkflowNode<"weft.check-suite">>(round07Quality);
expectType<WorkflowNode<"weft.path-policy">>(round07WritePaths);
expectType<WorkflowNode<"weft.review">>(round07CandidateReview);
expectType<WorkflowNode<"weft.task-contract">>(round07Tasks);
expectType<WorkflowNode<"weft.workflow">>(round07PlanningWorkflow);
expectType<WorkflowNode<"weft.workflow">>(round07ImplementationWorkflow);
expectType<WorkflowNode<"weft.workflow">>(round07ParentWorkflow);

// Round 7 DX findings (maximum three):
// 1. Solved: a pure typed factory plus ordinary exports provides reusable specialization, graph identity, and zero
//    mutable global state; `defineModule` is not warranted unless registry tooling later needs an inspectable manifest.
// 2. Soundness gap: `ctx.workflow` returns only schema output, so echoed parent IDs and projected child workspace
//    subjects are correlation, not engine proof. A `.detailed()` child result should mint invocation provenance and
//    retain the nominal child subject when a parent must authorize downstream work from it.
// 3. Ergonomic gap: definition factories and nested review evaluators must hand-thread key prefixes. A typed
//    `ctx.scope({ keyPrefix })` would remove repetitive string plumbing while preserving explicit child-run keys.
