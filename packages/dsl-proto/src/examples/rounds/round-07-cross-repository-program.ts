import { z } from "zod";

import {
  type Ctx,
  defineAgent,
  defineArtifact,
  defineCheck,
  defineOperation,
  definePathPolicy,
  definePrompt,
  defineWorkflow,
  type Settled,
  type WorkflowNode,
} from "../../core/index.ts";

/** Why: Makes the intended inference boundaries visible in this typechecked example. Use: Assert exact workflow-node and workspace-write behavior. */
declare function expectType<Type>(value: Type): void;

const ProgramNodeIdSchema = z.enum(["contracts", "api", "sdk", "app"]);

/** Why: Names the closed dependency graph for one coordinated program. Use: Correlate child results and determine release order. */
type ProgramNodeId = z.infer<typeof ProgramNodeIdSchema>;

const programNodeOrder = ["contracts", "api", "sdk", "app"] as const satisfies readonly ProgramNodeId[];

const VerificationCommandSchema = z.tuple([z.string().min(1)]).rest(z.string());

const RepositoryTargetSchema = z
  .object({
    repository: z.string().min(1),
    packageName: z.string().min(1),
    baseRef: z.string().min(1),
    branch: z.string().min(1),
    allowedPaths: z.array(z.string().min(1)).min(1).max(64),
    verificationCommand: VerificationCommandSchema,
  })
  .strict();

/** Why: Names a repository/package and the exact workspace request a child owns. Use: Supply one independently host-bound child workflow. */
type RepositoryTarget = z.infer<typeof RepositoryTargetSchema>;

const BudgetEvidenceSchema = z
  .object({
    limitTokens: z.number().int().positive(),
    spentTokens: z.number().int().nonnegative(),
    remainingTokens: z.number().int().nonnegative().nullable(),
  })
  .strict();

const EvidenceHandoffSchema = z
  .object({
    programId: z.string().min(1),
    nodeId: ProgramNodeIdSchema,
    repository: z.string().min(1),
    packageName: z.string().min(1),
    workspaceId: z.string().min(1),
    generation: z.number().int().nonnegative(),
    treeHash: z.string().min(1),
    evidenceRef: z.string().min(1),
    evidenceSha256: z.string().min(1),
    checkAttestationRef: z.string().min(1),
    dependencyEvidenceRefs: z.array(z.string().min(1)).max(3),
  })
  .strict();

/** Why: Serializes only an immutable pointer across a workflow schema boundary. Use: Pass it downstream only after the host resolver revalidates storage, snapshot, and repository binding. */
type EvidenceHandoff = z.infer<typeof EvidenceHandoffSchema>;

const ChildReadyOutputSchema = z
  .object({
    status: z.literal("ready"),
    programId: z.string().min(1),
    nodeId: ProgramNodeIdSchema,
    repository: z.string().min(1),
    packageName: z.string().min(1),
    summary: z.string().min(1),
    publicContractDigest: z.string().min(1),
    changedFiles: z.array(z.string().min(1)),
    handoff: EvidenceHandoffSchema,
    budget: BudgetEvidenceSchema,
  })
  .strict();

const ChildBlockedOutputSchema = z
  .object({
    status: z.literal("blocked"),
    programId: z.string().min(1),
    nodeId: ProgramNodeIdSchema,
    repository: z.string().min(1),
    packageName: z.string().min(1),
    reason: z.string().min(1),
    evidenceRef: z.string().min(1),
    budget: BudgetEvidenceSchema,
  })
  .strict();

const ChildOutputSchema = z.discriminatedUnion("status", [ChildReadyOutputSchema, ChildBlockedOutputSchema]);

/** Why: Preserves a child-local verification failure without turning the whole parent into an exception. Use: Narrow before accepting a handoff. */
type ChildOutput = z.infer<typeof ChildOutputSchema>;

const ChildInputBaseSchema = z
  .object({
    programId: z.string().min(1),
    objective: z.string().min(1),
    target: RepositoryTargetSchema,
    budgetTokens: z.number().int().positive(),
  })
  .strict();

const ContractsChildInputSchema = ChildInputBaseSchema.extend({
  nodeId: z.literal("contracts"),
  dependencies: z.tuple([]),
});

const ApiChildInputSchema = ChildInputBaseSchema.extend({
  nodeId: z.literal("api"),
  dependencies: z.tuple([EvidenceHandoffSchema]),
});

const SdkChildInputSchema = ChildInputBaseSchema.extend({
  nodeId: z.literal("sdk"),
  dependencies: z.tuple([EvidenceHandoffSchema]),
});

const AppChildInputSchema = ChildInputBaseSchema.extend({
  nodeId: z.literal("app"),
  dependencies: z.tuple([EvidenceHandoffSchema, EvidenceHandoffSchema]),
});

const ChildInputSchema = z.discriminatedUnion("nodeId", [
  ContractsChildInputSchema,
  ApiChildInputSchema,
  SdkChildInputSchema,
  AppChildInputSchema,
]);

/** Why: Gives the common child implementation a closed topology-aware input. Use: Render and execute one repository-local coding assignment. */
type ChildInput = z.infer<typeof ChildInputSchema>;

const repositoryWriterPaths = definePathPolicy({
  name: "cross-repository-program-writer-paths",
  description:
    "Canonicalizes each repository child's proposed paths inside its independently owned workspace.",
  revision: "v1",
  roots: ["."],
  deny: [".git/**", ".weft/**"],
  grantTtl: "2h",
});

const childPrompt = definePrompt({
  name: "cross-repository-child-prompt",
  input: ChildInputSchema,
  render: (input) => [
    `Implement the ${input.nodeId} part of program ${input.programId} in package ${input.target.packageName}.`,
    `Objective: ${input.objective}`,
    `Stay within the supplied write scope and preserve dependency contract digests.`,
    `Validated dependency evidence: ${JSON.stringify(input.dependencies)}`,
  ],
});

const ChildAgentOutputSchema = z
  .object({
    summary: z.string().min(1),
    publicContractDigest: z.string().min(1),
  })
  .strict();

const repositoryWriter = defineAgent({
  name: "cross-repository-program-writer",
  description: "Implements one bounded package change in the child workflow's own workspace.",
  prompt: childPrompt,
  schema: ChildAgentOutputSchema,
  defaults: { maxTurns: 20, timeout: "40m", repair: 1 },
});

const RepositoryVerificationInputSchema = z.object({ command: VerificationCommandSchema }).strict();

const repositoryVerification = defineCheck({
  name: "cross-repository-program-verification",
  description:
    "Runs the repository-specific required verification command on the exact child workspace candidate.",
  input: RepositoryVerificationInputSchema,
  command: ({ command }) => command,
  policy: "required",
  waiver: { mode: "never" },
  defaults: { timeout: "30m" },
});

const ChildEvidenceContentSchema = z
  .object({
    programId: z.string().min(1),
    nodeId: ProgramNodeIdSchema,
    repository: z.string().min(1),
    packageName: z.string().min(1),
    dependencyEvidenceRefs: z.array(z.string().min(1)).max(3),
    summary: z.string().min(1),
    publicContractDigest: z.string().min(1),
    changedFiles: z.array(z.string().min(1)),
    checkStatus: z.enum(["pass", "fail"]),
    checkDisposition: z.enum(["executed", "trusted"]),
    checkAttestationRef: z.string().min(1),
    workspaceId: z.string().min(1),
    generation: z.number().int().nonnegative(),
    treeHash: z.string().min(1),
    budget: BudgetEvidenceSchema,
  })
  .strict();

const childEvidenceArtifact = defineArtifact({
  name: "cross-repository-child-evidence",
  mediaType: "application/json",
  extension: "json",
  content: ChildEvidenceContentSchema,
});

function requireDependency(
  dependency: EvidenceHandoff,
  input: ChildInput,
  expectedNodeId: ProgramNodeId,
): void {
  if (dependency.programId !== input.programId || dependency.nodeId !== expectedNodeId) {
    throw new Error(`Mismatched ${expectedNodeId} dependency for ${input.nodeId}`);
  }
}

function requireChildDependencies(input: ChildInput): void {
  switch (input.nodeId) {
    case "contracts":
      return;
    case "api":
    case "sdk":
      requireDependency(input.dependencies[0], input, "contracts");
      return;
    case "app":
      requireDependency(input.dependencies[0], input, "api");
      requireDependency(input.dependencies[1], input, "sdk");
  }
}

async function runRepositoryChild(ctx: Ctx<unknown, unknown, true>, input: ChildInput): Promise<ChildOutput> {
  requireChildDependencies(input);
  const scope = await ctx.paths.resolve(
    repositoryWriterPaths,
    { proposedPaths: input.target.allowedPaths },
    { key: "writer-paths", label: `Resolve ${input.nodeId} writer paths` },
  );
  const implementation = await ctx.agent(repositoryWriter, input, {
    key: "implement",
    write: scope,
  });
  expectType<undefined>(implementation.patch);

  const verification = await ctx.check(
    repositoryVerification,
    { command: input.target.verificationCommand },
    { key: "verify", policy: "required" },
  );
  const budget = {
    limitTokens: input.budgetTokens,
    spentTokens: ctx.budget.spent.tokens,
    remainingTokens: ctx.budget.remaining.tokens,
  };
  const dependencyEvidenceRefs = input.dependencies.map(({ evidenceRef }) => evidenceRef);
  const evidence = await ctx.artifact(
    childEvidenceArtifact,
    {
      content: {
        programId: input.programId,
        nodeId: input.nodeId,
        repository: input.target.repository,
        packageName: input.target.packageName,
        dependencyEvidenceRefs,
        summary: implementation.value.summary,
        publicContractDigest: implementation.value.publicContractDigest,
        changedFiles: [...implementation.files],
        checkStatus: verification.status,
        checkDisposition: verification.disposition,
        checkAttestationRef: verification.attestation.ref,
        workspaceId: verification.candidate.workspaceId,
        generation: verification.candidate.generation,
        treeHash: verification.candidate.treeHash,
        budget,
      },
    },
    {
      key: "evidence",
      label: `Capture ${input.nodeId} evidence`,
      candidate: verification.candidate,
      sources: [verification.attestation],
    },
  );

  if (verification.status === "fail") {
    return {
      status: "blocked",
      programId: input.programId,
      nodeId: input.nodeId,
      repository: input.target.repository,
      packageName: input.target.packageName,
      reason: verification.summary ?? verification.evidence ?? "Required verification failed",
      evidenceRef: evidence.ref,
      budget,
    };
  }

  return {
    status: "ready",
    programId: input.programId,
    nodeId: input.nodeId,
    repository: input.target.repository,
    packageName: input.target.packageName,
    summary: implementation.value.summary,
    publicContractDigest: implementation.value.publicContractDigest,
    changedFiles: [...implementation.files],
    handoff: {
      programId: input.programId,
      nodeId: input.nodeId,
      repository: input.target.repository,
      packageName: input.target.packageName,
      workspaceId: verification.candidate.workspaceId,
      generation: verification.candidate.generation,
      treeHash: verification.candidate.treeHash,
      evidenceRef: evidence.ref,
      evidenceSha256: evidence.sha256,
      checkAttestationRef: verification.attestation.ref,
      dependencyEvidenceRefs,
    },
    budget,
  };
}

// Each stable host binding selects and authorizes a saved project. The input repository is only a declared
// identity that the host verifies against that binding; it cannot redirect checkout selection.
const contractsRepositoryWorkflow = defineWorkflow(
  {
    id: "cross-repository-program-contracts-v1",
    name: "Implement cross-repository contracts",
    input: ContractsChildInputSchema,
    output: ChildOutputSchema,
    workspace: ({ input }) => ({
      branch: input.target.branch,
      from: input.target.baseRef,
      target: { binding: "program.contracts-repository", repository: input.target.repository },
    }),
  },
  runRepositoryChild,
);

const apiRepositoryWorkflow = defineWorkflow(
  {
    id: "cross-repository-program-api-v1",
    name: "Implement cross-repository API",
    input: ApiChildInputSchema,
    output: ChildOutputSchema,
    workspace: ({ input }) => ({
      branch: input.target.branch,
      from: input.target.baseRef,
      target: { binding: "program.api-repository", repository: input.target.repository },
    }),
  },
  runRepositoryChild,
);

const sdkRepositoryWorkflow = defineWorkflow(
  {
    id: "cross-repository-program-sdk-v1",
    name: "Implement cross-repository SDK",
    input: SdkChildInputSchema,
    output: ChildOutputSchema,
    workspace: ({ input }) => ({
      branch: input.target.branch,
      from: input.target.baseRef,
      target: { binding: "program.sdk-repository", repository: input.target.repository },
    }),
  },
  runRepositoryChild,
);

const appRepositoryWorkflow = defineWorkflow(
  {
    id: "cross-repository-program-app-v1",
    name: "Implement cross-repository app",
    input: AppChildInputSchema,
    output: ChildOutputSchema,
    workspace: ({ input }) => ({
      branch: input.target.branch,
      from: input.target.baseRef,
      target: { binding: "program.app-repository", repository: input.target.repository },
    }),
  },
  runRepositoryChild,
);

/** Why: Gives graph inspection a small common projection while concrete constants retain exact invocation types. Use: Render topology; do not dynamically dispatch its widened `definition` field. */
interface ProgramCatalogEntry {
  readonly nodeId: ProgramNodeId;
  readonly repositoryRole: "schema" | "service" | "library" | "consumer";
  readonly dependencies: readonly ProgramNodeId[];
  readonly definition: WorkflowNode<"weft.workflow">;
}

const programCatalog = {
  contracts: {
    nodeId: "contracts",
    repositoryRole: "schema",
    dependencies: [],
    definition: contractsRepositoryWorkflow,
  },
  api: {
    nodeId: "api",
    repositoryRole: "service",
    dependencies: ["contracts"],
    definition: apiRepositoryWorkflow,
  },
  sdk: {
    nodeId: "sdk",
    repositoryRole: "library",
    dependencies: ["contracts"],
    definition: sdkRepositoryWorkflow,
  },
  app: {
    nodeId: "app",
    repositoryRole: "consumer",
    dependencies: ["api", "sdk"],
    definition: appRepositoryWorkflow,
  },
} as const satisfies Record<ProgramNodeId, ProgramCatalogEntry>;

const EvidenceExpectationSchema = z
  .object({
    nodeId: ProgramNodeIdSchema,
    repository: z.string().min(1),
    packageName: z.string().min(1),
    dependencyEvidenceRefs: z.array(z.string().min(1)).max(3),
  })
  .strict();

const EvidenceRejectionSchema = z.object({ nodeId: ProgramNodeIdSchema, reason: z.string().min(1) }).strict();

const ResolveEvidenceInputSchema = z
  .object({
    programId: z.string().min(1),
    expected: z.array(EvidenceExpectationSchema).min(1).max(4),
    handoffs: z.array(EvidenceHandoffSchema).min(1).max(4),
  })
  .strict();

const ResolveEvidenceOutputSchema = z
  .object({
    programId: z.string().min(1),
    accepted: z.array(EvidenceHandoffSchema).max(4),
    rejected: z.array(EvidenceRejectionSchema).max(4),
    resolvedAt: z.string().min(1),
  })
  .strict();

const resolveProgramEvidence = defineOperation({
  name: "resolve-cross-repository-program-evidence",
  description:
    "Re-resolves artifact digests, exact workspace snapshots, required checks, dependency refs, and definition-to-repository host bindings.",
  input: ResolveEvidenceInputSchema,
  output: ResolveEvidenceOutputSchema,
  binding: "program.evidence-resolver",
  capabilities: ["workspace:read", "integration:artifact-store"],
  authorization: { mode: "none" },
  defaults: { timeout: "2m", attempts: 3 },
});

const ProgramFailureSchema = z
  .object({
    nodeId: ProgramNodeIdSchema,
    kind: z.enum(["child-error", "child-blocked", "dependency-blocked", "evidence-rejected"]),
    reason: z.string().min(1),
    evidenceRef: z.string().min(1).nullable(),
  })
  .strict();

/** Why: Keeps failed, rejected, and deliberately skipped lanes in the aggregate result. Use: Explain why readiness is blocked without discarding successful siblings. */
type ProgramFailure = z.infer<typeof ProgramFailureSchema>;

const AggregateReviewInputSchema = z
  .object({
    programId: z.string().min(1),
    objective: z.string().min(1),
    topology: z.array(
      z.object({
        nodeId: ProgramNodeIdSchema,
        dependencies: z.array(ProgramNodeIdSchema),
        repositoryRole: z.enum(["schema", "service", "library", "consumer"]),
      }),
    ),
    verifiedEvidence: z.array(EvidenceHandoffSchema).max(4),
    failures: z.array(ProgramFailureSchema).max(8),
  })
  .strict();

/** Why: Names the final review request assembled from host-revalidated child evidence. Use: Prevent the reviewer from seeing unaccepted handoffs as release proof. */
type AggregateReviewInput = z.infer<typeof AggregateReviewInputSchema>;

const AggregateReviewOutputSchema = z
  .object({
    decision: z.enum(["ready", "blocked"]),
    summary: z.string().min(1),
    findings: z.array(z.string().min(1)).max(16),
    releaseOrder: z.array(ProgramNodeIdSchema).max(4),
  })
  .strict();

/** Why: Names a reviewer verdict separately from deterministic readiness gates. Use: Require both before release. */
type AggregateReviewOutput = z.infer<typeof AggregateReviewOutputSchema>;

const aggregateReviewPrompt = definePrompt({
  name: "cross-repository-aggregate-review-prompt",
  input: AggregateReviewInputSchema,
  render: (input) => [
    `Review cross-repository program ${input.programId} for release readiness.`,
    `Objective: ${input.objective}`,
    `Topology: ${JSON.stringify(input.topology)}`,
    `Host-verified child evidence: ${JSON.stringify(input.verifiedEvidence)}`,
    `Partial failures: ${JSON.stringify(input.failures)}`,
    "Return ready only when every dependency is verified and release order respects the topology.",
  ],
});

const aggregateReviewer = defineAgent({
  name: "cross-repository-program-reviewer",
  description: "Performs a read-only aggregate compatibility and release-readiness review.",
  prompt: aggregateReviewPrompt,
  schema: AggregateReviewOutputSchema,
  defaults: { maxTurns: 12, timeout: "20m", repair: 1 },
});

const ProgramBudgetSchema = z
  .object({
    programTokens: z.number().int().positive(),
    contractsTokens: z.number().int().positive(),
    apiTokens: z.number().int().positive(),
    sdkTokens: z.number().int().positive(),
    appTokens: z.number().int().positive(),
    reviewTokens: z.number().int().positive(),
  })
  .strict();

const ProgramInputSchema = z
  .object({
    programId: z.string().min(1),
    objective: z.string().min(1),
    contracts: RepositoryTargetSchema,
    api: RepositoryTargetSchema,
    sdk: RepositoryTargetSchema,
    app: RepositoryTargetSchema,
    budget: ProgramBudgetSchema,
  })
  .strict();

/** Why: Names the validated top-level program request. Use: Correlate child calls and allocate fixed budgets. */
type ProgramInput = z.infer<typeof ProgramInputSchema>;

const ProgramEvidenceContentSchema = z
  .object({
    programId: z.string().min(1),
    objective: z.string().min(1),
    requestedRepositories: z.array(z.string().min(1)).length(4),
    verifiedEvidence: z.array(EvidenceHandoffSchema).max(4),
    failures: z.array(ProgramFailureSchema).max(8),
    review: AggregateReviewOutputSchema,
    releaseReady: z.boolean(),
  })
  .strict();

const programEvidenceArtifact = defineArtifact({
  name: "cross-repository-program-evidence",
  mediaType: "application/json",
  extension: "json",
  content: ProgramEvidenceContentSchema,
});

const ProgramReadyOutputSchema = z
  .object({
    status: z.literal("ready"),
    programId: z.string().min(1),
    evidenceRef: z.string().min(1),
    verifiedNodes: z.array(ProgramNodeIdSchema).length(4),
    releaseOrder: z.array(ProgramNodeIdSchema).length(4),
    review: AggregateReviewOutputSchema,
  })
  .strict();

const ProgramBlockedOutputSchema = z
  .object({
    status: z.literal("blocked"),
    programId: z.string().min(1),
    evidenceRef: z.string().min(1),
    verifiedNodes: z.array(ProgramNodeIdSchema).max(4),
    failures: z.array(ProgramFailureSchema).min(1).max(8),
    review: AggregateReviewOutputSchema,
  })
  .strict();

const ProgramOutputSchema = z.discriminatedUnion("status", [
  ProgramReadyOutputSchema,
  ProgramBlockedOutputSchema,
]);

/** Why: Names the final schema-validated result of the parent program. Use: Distinguish release readiness from useful partial progress. */
type ProgramOutput = z.infer<typeof ProgramOutputSchema>;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Child workflow failed without a typed error";
}

function requireProgramBudget(input: ProgramInput, remainingTokens: number | null): void {
  const allocated =
    input.budget.contractsTokens +
    input.budget.apiTokens +
    input.budget.sdkTokens +
    input.budget.appTokens +
    input.budget.reviewTokens;
  if (allocated > input.budget.programTokens)
    throw new Error("Child and review budgets exceed program budget");
  if (remainingTokens !== null && input.budget.programTokens > remainingTokens) {
    throw new Error("Requested program budget exceeds the current run budget");
  }
}

function requireDistinctTargets(input: ProgramInput): void {
  const repositories = [
    input.contracts.repository,
    input.api.repository,
    input.sdk.repository,
    input.app.repository,
  ];
  const packages = [
    input.contracts.packageName,
    input.api.packageName,
    input.sdk.packageName,
    input.app.packageName,
  ];
  if (new Set(repositories).size !== repositories.length)
    throw new Error("Program repositories must be distinct");
  if (new Set(packages).size !== packages.length) throw new Error("Program packages must be distinct");
}

function childFailure(output: ChildOutput): ProgramFailure | null {
  return output.status === "blocked"
    ? {
        nodeId: output.nodeId,
        kind: "child-blocked",
        reason: output.reason,
        evidenceRef: output.evidenceRef,
      }
    : null;
}

function requireChildCorrelation(
  output: ChildOutput,
  programId: string,
  nodeId: ProgramNodeId,
  target: RepositoryTarget,
): void {
  if (
    output.programId !== programId ||
    output.nodeId !== nodeId ||
    output.repository !== target.repository ||
    output.packageName !== target.packageName
  ) {
    throw new Error(`Child output correlation failed for ${nodeId}`);
  }
}

/** Why: Names the host-verification request projection used between dependency layers. Use: Re-resolve one or more child handoffs before downstream launch. */
interface EvidenceResolutionRequest {
  readonly nodeId: ProgramNodeId;
  readonly target: RepositoryTarget;
  readonly handoff: EvidenceHandoff;
}

async function resolveEvidenceLayer(
  ctx: Ctx,
  programId: string,
  layer: readonly EvidenceResolutionRequest[],
  key: string,
): Promise<z.infer<typeof ResolveEvidenceOutputSchema>> {
  const resolved = await ctx.operation(
    resolveProgramEvidence,
    {
      programId,
      expected: layer.map(({ nodeId, target, handoff }) => ({
        nodeId,
        repository: target.repository,
        packageName: target.packageName,
        dependencyEvidenceRefs: handoff.dependencyEvidenceRefs,
      })),
      handoffs: layer.map(({ handoff }) => handoff),
    },
    { key, label: `Resolve ${key} evidence` },
  );
  if (resolved.programId !== programId) throw new Error("Evidence resolver returned another program");
  return resolved;
}

function acceptedHandoff(
  resolution: z.infer<typeof ResolveEvidenceOutputSchema>,
  nodeId: ProgramNodeId,
): EvidenceHandoff | null {
  const accepted = resolution.accepted.filter((handoff) => handoff.nodeId === nodeId);
  return accepted.length === 1 ? (accepted[0] ?? null) : null;
}

function recordResolutionFailures(
  failures: ProgramFailure[],
  resolution: z.infer<typeof ResolveEvidenceOutputSchema>,
  expected: readonly ProgramNodeId[],
): void {
  for (const nodeId of expected) {
    if (acceptedHandoff(resolution, nodeId) !== null) continue;
    const rejected = resolution.rejected.find((entry) => entry.nodeId === nodeId);
    failures.push({
      nodeId,
      kind: "evidence-rejected",
      reason: rejected?.reason ?? "Host did not uniquely accept this child evidence",
      evidenceRef: null,
    });
  }
}

function settledChild(
  settled: Settled<ChildOutput> | undefined,
  nodeId: ProgramNodeId,
  programId: string,
  target: RepositoryTarget,
  failures: ProgramFailure[],
): ChildOutput | null {
  if (settled === undefined || !settled.ok) {
    failures.push({
      nodeId,
      kind: "child-error",
      reason: settled === undefined ? "Parallel lane returned no result" : errorMessage(settled.error),
      evidenceRef: null,
    });
    return null;
  }
  requireChildCorrelation(settled.value, programId, nodeId, target);
  const failure = childFailure(settled.value);
  if (failure !== null) failures.push(failure);
  return settled.value;
}

function sameReleaseOrder(order: readonly ProgramNodeId[]): boolean {
  return (
    order.length === programNodeOrder.length &&
    order.every((nodeId, index) => nodeId === programNodeOrder[index])
  );
}

const crossRepositoryProgramWorkflow = defineWorkflow(
  {
    id: "cross-repository-program-v1",
    name: "Coordinate a cross-repository coding program",
    description:
      "Runs repository-owned child workflows in dependency order and gates aggregate readiness on re-resolved evidence.",
    input: ProgramInputSchema,
    output: ProgramOutputSchema,
  },
  async (ctx, input): Promise<ProgramOutput> => {
    requireProgramBudget(input, ctx.budget.remaining.tokens);
    requireDistinctTargets(input);
    const failures: ProgramFailure[] = [];
    const verified = new Map<ProgramNodeId, EvidenceHandoff>();

    let contractsOutput: ChildOutput | null = null;
    try {
      contractsOutput = await ctx.workflow(
        contractsRepositoryWorkflow,
        {
          programId: input.programId,
          objective: input.objective,
          nodeId: "contracts",
          target: input.contracts,
          dependencies: [],
          budgetTokens: input.budget.contractsTokens,
        },
        { key: "contracts", label: "Implement contracts", budget: { tokens: input.budget.contractsTokens } },
      );
      requireChildCorrelation(contractsOutput, input.programId, "contracts", input.contracts);
      const failure = childFailure(contractsOutput);
      if (failure !== null) failures.push(failure);
    } catch (error) {
      failures.push({
        nodeId: "contracts",
        kind: "child-error",
        reason: errorMessage(error),
        evidenceRef: null,
      });
    }

    if (contractsOutput?.status === "ready") {
      const contractsResolution = await resolveEvidenceLayer(
        ctx,
        input.programId,
        [{ nodeId: "contracts", target: input.contracts, handoff: contractsOutput.handoff }],
        "contracts",
      );
      recordResolutionFailures(failures, contractsResolution, ["contracts"]);
      const handoff = acceptedHandoff(contractsResolution, "contracts");
      if (handoff !== null) verified.set("contracts", handoff);
    }

    const contractsHandoff = verified.get("contracts");
    if (contractsHandoff === undefined) {
      failures.push(
        {
          nodeId: "api",
          kind: "dependency-blocked",
          reason: "Contracts evidence was not host-verified",
          evidenceRef: null,
        },
        {
          nodeId: "sdk",
          kind: "dependency-blocked",
          reason: "Contracts evidence was not host-verified",
          evidenceRef: null,
        },
        {
          nodeId: "app",
          kind: "dependency-blocked",
          reason: "API and SDK cannot run without contracts evidence",
          evidenceRef: null,
        },
      );
    } else {
      const childRuns: ReadonlyArray<{
        key: "api" | "sdk";
        run: (childCtx: typeof ctx) => Promise<ChildOutput>;
      }> = [
        {
          key: "api",
          run: (childCtx) =>
            childCtx.workflow(
              apiRepositoryWorkflow,
              {
                programId: input.programId,
                objective: input.objective,
                nodeId: "api",
                target: input.api,
                dependencies: [contractsHandoff],
                budgetTokens: input.budget.apiTokens,
              },
              { key: "api", label: "Implement API", budget: { tokens: input.budget.apiTokens } },
            ),
        },
        {
          key: "sdk",
          run: (childCtx) =>
            childCtx.workflow(
              sdkRepositoryWorkflow,
              {
                programId: input.programId,
                objective: input.objective,
                nodeId: "sdk",
                target: input.sdk,
                dependencies: [contractsHandoff],
                budgetTokens: input.budget.sdkTokens,
              },
              { key: "sdk", label: "Implement SDK", budget: { tokens: input.budget.sdkTokens } },
            ),
        },
      ];
      const parallelChildren = await ctx.parallel.settled(
        childRuns,
        (child, lane) => child.run(lane.ctx),
        { key: "api-sdk", keyOf: (child) => child.key, concurrency: 2 },
      );
      const apiOutput = settledChild(parallelChildren[0], "api", input.programId, input.api, failures);
      const sdkOutput = settledChild(parallelChildren[1], "sdk", input.programId, input.sdk, failures);
      const readyLayer: EvidenceResolutionRequest[] = [];
      if (apiOutput?.status === "ready") {
        readyLayer.push({ nodeId: "api", target: input.api, handoff: apiOutput.handoff });
      }
      if (sdkOutput?.status === "ready") {
        readyLayer.push({ nodeId: "sdk", target: input.sdk, handoff: sdkOutput.handoff });
      }
      if (readyLayer.length > 0) {
        const layerResolution = await resolveEvidenceLayer(ctx, input.programId, readyLayer, "api-sdk");
        recordResolutionFailures(
          failures,
          layerResolution,
          readyLayer.map(({ nodeId }) => nodeId),
        );
        for (const nodeId of ["api", "sdk"] as const) {
          const handoff = acceptedHandoff(layerResolution, nodeId);
          if (handoff !== null) verified.set(nodeId, handoff);
        }
      }

      const apiHandoff = verified.get("api");
      const sdkHandoff = verified.get("sdk");
      if (apiHandoff === undefined || sdkHandoff === undefined) {
        failures.push({
          nodeId: "app",
          kind: "dependency-blocked",
          reason: "App requires host-verified API and SDK evidence",
          evidenceRef: null,
        });
      } else {
        try {
          const appOutput = await ctx.workflow(
            appRepositoryWorkflow,
            {
              programId: input.programId,
              objective: input.objective,
              nodeId: "app",
              target: input.app,
              dependencies: [apiHandoff, sdkHandoff],
              budgetTokens: input.budget.appTokens,
            },
            { key: "app", label: "Implement app", budget: { tokens: input.budget.appTokens } },
          );
          requireChildCorrelation(appOutput, input.programId, "app", input.app);
          const failure = childFailure(appOutput);
          if (failure !== null) failures.push(failure);
          if (appOutput.status === "ready") {
            const appResolution = await resolveEvidenceLayer(
              ctx,
              input.programId,
              [{ nodeId: "app", target: input.app, handoff: appOutput.handoff }],
              "app",
            );
            recordResolutionFailures(failures, appResolution, ["app"]);
            const handoff = acceptedHandoff(appResolution, "app");
            if (handoff !== null) verified.set("app", handoff);
          }
        } catch (error) {
          failures.push({
            nodeId: "app",
            kind: "child-error",
            reason: errorMessage(error),
            evidenceRef: null,
          });
        }
      }
    }

    const verifiedEvidence = programNodeOrder.flatMap((nodeId) => {
      const handoff = verified.get(nodeId);
      return handoff === undefined ? [] : [handoff];
    });
    const uniqueWorkspaces = new Set(verifiedEvidence.map(({ workspaceId }) => workspaceId)).size;
    if (uniqueWorkspaces !== verifiedEvidence.length) {
      failures.push({
        nodeId: "app",
        kind: "evidence-rejected",
        reason: "Two child results claim the same workspace identity",
        evidenceRef: null,
      });
    }

    const reviewInput: AggregateReviewInput = {
      programId: input.programId,
      objective: input.objective,
      topology: programNodeOrder.map((nodeId) => ({
        nodeId,
        dependencies: [...programCatalog[nodeId].dependencies],
        repositoryRole: programCatalog[nodeId].repositoryRole,
      })),
      verifiedEvidence,
      failures,
    };
    const reviewScope = ctx.scope({ budget: { tokens: input.budget.reviewTokens } });
    const reviewed = await reviewScope.agent(aggregateReviewer, reviewInput, {
      key: "aggregate-review",
      failure: "return",
    });
    const review: AggregateReviewOutput = reviewed.ok
      ? reviewed.result.value
      : {
          decision: "blocked",
          summary: "Aggregate reviewer did not return a schema-valid result",
          findings: ["Manual aggregate compatibility review is required"],
          releaseOrder: [],
        };
    const releaseReady =
      failures.length === 0 &&
      verifiedEvidence.length === programNodeOrder.length &&
      uniqueWorkspaces === programNodeOrder.length &&
      review.decision === "ready" &&
      sameReleaseOrder(review.releaseOrder);
    if (!releaseReady && failures.length === 0) {
      failures.push({
        nodeId: "app",
        kind: "evidence-rejected",
        reason: "Aggregate review or release order did not satisfy deterministic readiness gates",
        evidenceRef: null,
      });
    }

    const programEvidence = await ctx.artifact(
      programEvidenceArtifact,
      {
        content: {
          programId: input.programId,
          objective: input.objective,
          requestedRepositories: [
            input.contracts.repository,
            input.api.repository,
            input.sdk.repository,
            input.app.repository,
          ],
          verifiedEvidence,
          failures,
          review,
          releaseReady,
        },
      },
      { key: "program-evidence", label: `Capture ${input.programId} aggregate evidence` },
    );

    if (releaseReady) {
      return {
        status: "ready",
        programId: input.programId,
        evidenceRef: programEvidence.ref,
        verifiedNodes: [...programNodeOrder],
        releaseOrder: [...programNodeOrder],
        review,
      };
    }
    return {
      status: "blocked",
      programId: input.programId,
      evidenceRef: programEvidence.ref,
      verifiedNodes: verifiedEvidence.map(({ nodeId }) => nodeId),
      failures,
      review,
    };
  },
);

expectType<WorkflowNode<"weft.workflow">>(crossRepositoryProgramWorkflow);
expectType<WorkflowNode<"weft.workflow">>(programCatalog.contracts.definition);

// DX findings (maximum three):
// 1. Soundness: nominal check/artifact evidence cannot cross a generic Zod workflow output. Structural handoffs need
//    a host operation to re-resolve their digests and exact workspace snapshots before each dependent child launches.
// 2. Convenience: a typed `defineProgram`/module catalog could retain exact heterogeneous child types while declaring
//    host project bindings, dependency edges, budgets, and evidence handoffs; ordinary TypeScript retains types only
//    while callers dispatch each concrete definition explicitly.
