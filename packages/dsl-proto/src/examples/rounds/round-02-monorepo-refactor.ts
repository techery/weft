import { z } from "zod";

import {
  type CheckResultOf,
  defineAgent,
  defineCheck,
  defineCheckSuite,
  defineOperation,
  definePathPolicy,
  definePrompt,
  defineWorkflow,
  type InferWorkflowOutput,
  type OperationInputOf,
  type OperationOutputOf,
  type PatchAgentResult,
  type PatchRef,
  type WorkflowNode,
} from "../../core/index.ts";

/**
 * Why: Makes compile-time assertions readable without adding runtime behavior to the declaration prototype.
 * Use: Pass an inferred expression to prove that composition retained its exact public type.
 */
declare function expectType<Type>(value: Type): void;

const ApiRefactorInputSchema = z.object({
  symbol: z.string().min(1),
  newSignature: z.string().min(1),
  migrationRules: z.array(z.string().min(1)).min(1),
  baseRef: z.string().min(1).default("main"),
  packageScope: z.array(z.string().min(1)).optional(),
});

const monorepoRefactorWritePolicy = definePathPolicy({
  name: "round-02-monorepo-refactor-writes",
  description:
    "Limits package edits and composed capture to canonical repository paths discovered for this run.",
  revision: "v1",
  roots: ["."],
  deny: [".git/**", ".weft/**"],
  grantTtl: "2h",
});

const ApiTargetSchema = z.object({
  packageName: z.string().min(1),
  packagePath: z.string().min(1),
  role: z.enum(["provider", "consumer"]),
  dependencyLevel: z.number().int().nonnegative(),
  files: z.array(z.string().min(1)).min(1),
  verificationCommand: z.tuple([z.string().min(1)]).rest(z.string()),
});

const ApiDiscoveryInputSchema = z.object({
  symbol: z.string().min(1),
  baseRef: z.string().min(1),
  packageScope: z.array(z.string().min(1)),
});

const ApiDiscoveryOutputSchema = z.object({
  symbol: z.string().min(1),
  providerPackage: z.string().min(1),
  declarationFile: z.string().min(1),
  currentSignature: z.string().min(1),
  targets: z.array(ApiTargetSchema).min(1),
});

const PackageRefactorInputSchema = z.object({
  target: ApiTargetSchema,
  symbol: z.string().min(1),
  currentSignature: z.string().min(1),
  newSignature: z.string().min(1),
  migrationRules: z.array(z.string().min(1)).min(1),
});

const PackageEditOutputSchema = z.object({
  packageName: z.string().min(1),
  summary: z.string().min(1),
  changedFiles: z.array(z.string().min(1)).min(1),
  testsUpdated: z.array(z.string().min(1)),
  compatibilityNotes: z.array(z.string().min(1)),
});

const PackageVerificationInputSchema = z.object({
  packageName: z.string().min(1),
  verificationCommand: z.tuple([z.string().min(1)]).rest(z.string()),
});

const ApiContractCheckInputSchema = z.object({
  symbol: z.string().min(1),
  expectedSignature: z.string().min(1),
});

const PackageVerificationOutputSchema = z.object({
  packageName: z.string().min(1),
  dependencyLevel: z.number().int().nonnegative(),
  passed: z.boolean(),
});

const ApiRefactorOutputSchema = z.object({
  symbol: z.string().min(1),
  providerPackage: z.string().min(1),
  editedPackages: z.array(z.string().min(1)).min(1),
  sourcePatchCount: z.number().int().positive(),
  candidatePatch: z.object({
    ref: z.string().min(1),
    key: z.string().min(1),
    files: z.array(z.string().min(1)).min(1),
    baseTree: z.string().min(1),
  }),
  verification: z.array(PackageVerificationOutputSchema).min(1),
  contractPassed: z.literal(true),
  integration: z.object({
    merged: z.array(z.string()),
    conflicts: z.array(z.string()),
    quarantined: z.array(z.string()),
    skipped: z.array(z.string()),
  }),
});

/**
 * Why: Names the validated workflow request shared by pipeline construction and every edit lane.
 * Use: Pass it to `toPackageWorkItem` after workflow input validation.
 */
type ApiRefactorInput = z.infer<typeof ApiRefactorInputSchema>;

/**
 * Why: Names one repository-grounded package target instead of trusting a model-generated path.
 * Use: Carry it from discovery through pipeline keys, write scopes, integration, and verification.
 */
type ApiTarget = z.infer<typeof ApiTargetSchema>;

/**
 * Why: Derives the discovery request from the operation node rather than repeating its schema shape.
 * Use: Construct this value immediately before invoking the host-bound discovery operation.
 */
type ApiDiscoveryInput = OperationInputOf<typeof discoverApiGraph>;

/**
 * Why: Derives the validated discovery result from the operation node for downstream composition.
 * Use: Keep pipeline helpers coupled to the node contract when discovery evolves.
 */
type ApiDiscoveryOutput = OperationOutputOf<typeof discoverApiGraph>;

/**
 * Why: Names the schema-validated domain output inside each writer's operational patch envelope.
 * Use: Assert exact `ctx.parallel.all` inference for detached package edits.
 */
type PackageEditOutput = z.infer<typeof PackageEditOutputSchema>;

/**
 * Why: Keeps a target, agent input, and untrusted path proposal together through the pipeline.
 * Use: Resolve each proposal into a nominal scope immediately before invoking its independent writer.
 */
interface PackageWorkItem {
  target: ApiTarget;
  input: z.input<typeof PackageRefactorInputSchema>;
  writePaths: string[];
}

/**
 * Why: Records one package's ordered candidate-workspace verification result.
 * Use: Return it from `ctx.sequence` and include it in the workflow's typed handoff.
 */
type PackageVerificationOutput = z.infer<typeof PackageVerificationOutputSchema>;

/**
 * Why: Names the candidate workspace result before its verified patch is promoted to the parent run.
 * Use: Return it from `ctx.workspace.with` so verification evidence remains attached to the captured patch.
 */
interface CandidateResult {
  patch: PatchRef;
  verification: PackageVerificationOutput[];
  contract: CheckResultOf<typeof apiContractCheck>;
}

const discoverApiGraph = defineOperation({
  name: "discover-monorepo-api-graph",
  description:
    "Finds the defining package and all in-scope consumers at an exact Git base, returning topological package order.",
  input: ApiDiscoveryInputSchema,
  output: ApiDiscoveryOutputSchema,
  binding: "repository.api-graph.discover",
  capabilities: ["filesystem:read", "git:read", "process"],
  defaults: { timeout: "5m", attempts: 2 },
  authorization: { mode: "none" },
});

const packageRefactorPrompt = definePrompt({
  name: "refactor-one-monorepo-package",
  input: PackageRefactorInputSchema,
  render: ({ target, symbol, currentSignature, newSignature, migrationRules }) => [
    `Refactor ${target.packageName} as the ${target.role} of ${symbol}.`,
    `Current contract: ${currentSignature}`,
    `Required contract: ${newSignature}`,
    `Repository-grounded files: ${target.files.join(", ")}`,
    `Migration rules:\n${migrationRules.map((rule) => `- ${rule}`).join("\n")}`,
    "Change only this package, update focused tests, and do not commit or integrate the patch.",
  ],
});

const packageRefactorAgent = defineAgent({
  name: "monorepo-package-api-refactorer",
  description: "Edits one package in isolation so independent package patches can be reviewed and composed.",
  prompt: packageRefactorPrompt,
  schema: PackageEditOutputSchema,
  defaults: {
    maxTurns: 20,
    timeout: "30m",
    repair: 1,
    provider: {
      id: "codex",
      model: "gpt-5.6-sol",
      effort: "high",
      options: { sandboxMode: "workspace-write", networkAccess: false, webSearch: "disabled" },
    },
  },
});

const packageTypecheck = defineCheck({
  name: "refactored-package-typecheck",
  description: "Typechecks one package against the fully composed candidate workspace.",
  input: PackageVerificationInputSchema,
  command: ({ packageName }) => ["pnpm", "--filter", packageName, "typecheck"],
  policy: "required",
  defaults: { timeout: "10m" },
});

const packageTests = defineCheck({
  name: "refactored-package-tests",
  description: "Runs the repository-discovered verification command for one affected package.",
  input: PackageVerificationInputSchema,
  command: ({ verificationCommand }) => verificationCommand,
  policy: "required",
  defaults: { timeout: "20m" },
});

const packageQuality = defineCheckSuite({
  name: "refactored-package-quality",
  description: "Keeps package typecheck and focused tests independently visible in dependency order.",
  input: PackageVerificationInputSchema,
  checks: (input, use) => ({
    typecheck: use(packageTypecheck, input),
    tests: use(packageTests, input),
  }),
  concurrency: 2,
});

const apiContractCheck = defineCheck({
  name: "composed-api-contract",
  description: "Verifies the exported API after all provider and consumer patches have been composed.",
  input: ApiContractCheckInputSchema,
  command: ({ symbol, expectedSignature }) => [
    "pnpm",
    "exec",
    "weft-api-contract",
    "--symbol",
    symbol,
    "--expect",
    expectedSignature,
  ],
  policy: "required",
  defaults: { timeout: "10m" },
});

/**
 * Why: Rejects malformed discovery order before parallel patches are produced from a false dependency graph.
 * Use: Call it once on the schema-validated discovery result before building work items.
 */
function assertTopologicalTargets(discovery: ApiDiscoveryOutput): void {
  const packageNames = new Set<string>();
  let previousLevel = -1;
  let providerCount = 0;

  for (const target of discovery.targets) {
    if (packageNames.has(target.packageName)) {
      throw new Error(`Discovery returned duplicate package ${target.packageName}`);
    }
    if (target.dependencyLevel < previousLevel) {
      throw new Error("Discovery targets are not ordered by dependency level");
    }
    if (target.role === "provider") providerCount += 1;
    packageNames.add(target.packageName);
    previousLevel = target.dependencyLevel;
  }

  if (providerCount !== 1 || !packageNames.has(discovery.providerPackage)) {
    throw new Error("Discovery must return exactly one provider package in its target graph");
  }
}

/**
 * Why: Applies optional user scope without allowing the defining package to be accidentally excluded.
 * Use: Pass it to the pipeline filter while retaining all provider work.
 */
function shouldRefactorTarget(target: ApiTarget, input: ApiRefactorInput): boolean {
  return (
    target.role === "provider" ||
    input.packageScope === undefined ||
    input.packageScope.includes(target.packageName)
  );
}

/**
 * Why: Converts trusted discovery data into one named unit of model input and exact write authority.
 * Use: Map discovery targets through it before bounded parallel execution.
 */
function toPackageWorkItem(
  target: ApiTarget,
  input: ApiRefactorInput,
  discovery: ApiDiscoveryOutput,
): PackageWorkItem {
  return {
    target,
    input: {
      target,
      symbol: input.symbol,
      currentSignature: discovery.currentSignature,
      newSignature: input.newSignature,
      migrationRules: input.migrationRules,
    },
    writePaths: [`${target.packagePath}/**`],
  };
}

/**
 * Why: Prevents a writer's claimed or captured files from escaping its repository-grounded package boundary.
 * Use: Check every successful fan-out result before any patch reaches the candidate workspace.
 */
function assertBoundedEdit(item: PackageWorkItem, edit: PatchAgentResult<PackageEditOutput>): void {
  if (edit.value.packageName !== item.target.packageName) {
    throw new Error(`Writer returned the wrong package: ${edit.value.packageName}`);
  }

  const packagePrefix = `${item.target.packagePath}/`;
  const escapedFile = edit.files.find((file) => !file.startsWith(packagePrefix));
  if (escapedFile !== undefined) {
    throw new Error(`Writer changed ${escapedFile} outside ${item.target.packageName}`);
  }
}

/**
 * Why: Demonstrates a graph-driven API refactor without allowing concurrent writers to share a mutable tree.
 * Use: Launch it with a symbol and target signature; it returns one verified, integrated patch handoff.
 */
const monorepoApiRefactorWorkflow = defineWorkflow(
  {
    id: "round-02-monorepo-api-refactor",
    name: "Monorepo API refactor",
    description:
      "Discovers an API graph, edits packages independently, composes them in a candidate workspace, and verifies in dependency order.",
    input: ApiRefactorInputSchema,
    output: ApiRefactorOutputSchema,
  },
  async (ctx, input) => {
    const discoveryInput: ApiDiscoveryInput = {
      symbol: input.symbol,
      baseRef: input.baseRef,
      packageScope: input.packageScope ?? [],
    };
    const discovery = await ctx.operation(discoverApiGraph, discoveryInput, {
      key: "discover-api-graph",
      label: `Discover ${input.symbol} provider and consumers`,
    });
    expectType<ApiDiscoveryOutput>(discovery);
    assertTopologicalTargets(discovery);

    const workItems = await ctx
      .pipeline(discovery.targets)
      .filter((target) => shouldRefactorTarget(target, input))
      .map((target): PackageWorkItem => toPackageWorkItem(target, input, discovery))
      .mapEffect("require-write-paths", (workItem): PackageWorkItem => {
        if (workItem.writePaths.length === 0) throw new Error("A writer lane has no proposed paths");
        return workItem;
      })
      .all({
        key: "prepare-package-work",
        keyOf: (target) => target.packageName,
        concurrency: 8,
      });
    expectType<PackageWorkItem[]>(workItems);

    const edits = await ctx.parallel.all(
      workItems,
      async (workItem) => {
        const writeScope = await ctx.paths.resolve(
          monorepoRefactorWritePolicy,
          { proposedPaths: workItem.writePaths },
          {
            key: `resolve-write:${workItem.target.packageName}`,
            label: `Resolve ${workItem.target.packageName} write paths`,
          },
        );
        return ctx.agent(packageRefactorAgent, workItem.input, {
          key: `edit:${workItem.target.packageName}`,
          label: `Refactor ${workItem.target.packageName}`,
          write: writeScope,
        });
      },
      {
        key: "package-edits",
        keyOf: (workItem) => workItem.target.packageName,
        concurrency: 6,
      },
    );
    expectType<PatchAgentResult<PackageEditOutput>[]>(edits);

    edits.forEach((edit, index) => {
      const workItem = workItems[index];
      if (workItem === undefined) throw new Error(`Writer result ${index} has no matching work item`);
      assertBoundedEdit(workItem, edit);
    });

    const candidate = await ctx.workspace.with(
      { key: "composed-candidate", from: input.baseRef },
      async (candidateCtx): Promise<CandidateResult> => {
        await candidateCtx.apply(
          edits.map((edit) => edit.patch),
          { key: "apply-package-edits", order: "sequential", onConflict: "fail" },
        );

        const verification = await candidateCtx.sequence(
          workItems,
          {
            key: "verify-packages",
            keyOf: (workItem) => workItem.target.packageName,
            labelOf: (workItem) => `dependency-level-${workItem.target.dependencyLevel}`,
          },
          async (workItem, scope): Promise<PackageVerificationOutput> => {
            const quality = await scope.ctx.check(
              packageQuality,
              {
                packageName: workItem.target.packageName,
                verificationCommand: workItem.target.verificationCommand,
              },
              { key: scope.key("quality"), concurrency: 2 },
            );
            if (!quality.passed) {
              throw new Error(`Candidate verification failed for ${workItem.target.packageName}`);
            }
            return {
              packageName: workItem.target.packageName,
              dependencyLevel: workItem.target.dependencyLevel,
              passed: quality.passed,
            };
          },
        );
        expectType<PackageVerificationOutput[]>(verification);

        const contract = await candidateCtx.check(
          apiContractCheck,
          { symbol: input.symbol, expectedSignature: input.newSignature },
          { key: "final-api-contract" },
        );
        if (contract.status !== "pass") {
          throw new Error(`The composed candidate does not expose ${input.newSignature}`);
        }

        const captureScope = await candidateCtx.paths.resolve(
          monorepoRefactorWritePolicy,
          { proposedPaths: [...new Set(workItems.flatMap((workItem) => workItem.writePaths))] },
          { key: "resolve-candidate-capture", label: "Resolve composed candidate paths" },
        );
        const patch = await candidateCtx.capture({ key: "capture-composed-candidate", scope: captureScope });
        return { patch, verification, contract };
      },
    );

    const integration = await ctx.integrate([candidate.patch], {
      key: "integrate-composed-candidate",
      order: "sequential",
      onConflict: "fail",
    });

    return {
      symbol: input.symbol,
      providerPackage: discovery.providerPackage,
      editedPackages: edits.map((edit) => edit.value.packageName),
      sourcePatchCount: edits.length,
      candidatePatch: {
        ref: candidate.patch.ref,
        key: candidate.patch.key,
        files: [...candidate.patch.files],
        baseTree: candidate.patch.baseTree,
      },
      verification: candidate.verification,
      contractPassed: true as const,
      integration,
    };
  },
);

const refactorWorkflowNodes = [
  discoverApiGraph,
  packageRefactorPrompt,
  packageRefactorAgent,
  packageTypecheck,
  packageTests,
  packageQuality,
  apiContractCheck,
  monorepoApiRefactorWorkflow,
] as const satisfies readonly WorkflowNode[];

/**
 * Why: Derives the exact node-kind union from the heterogeneous definition registry.
 * Use: Prove that common `WorkflowNode` identity preserves each concrete definition's discriminant.
 */
type RefactorWorkflowNodeKind = (typeof refactorWorkflowNodes)[number]["kind"];

/**
 * Why: Derives the workflow's validated handoff type directly from its definition node.
 * Use: Consumers can follow output-schema changes without repeating the result shape.
 */
type ApiRefactorResult = InferWorkflowOutput<typeof monorepoApiRefactorWorkflow>;

declare const inferredApiRefactorResult: ApiRefactorResult;

expectType<readonly WorkflowNode<RefactorWorkflowNodeKind>[]>(refactorWorkflowNodes);
expectType<WorkflowNode<"weft.workflow">>(monorepoApiRefactorWorkflow);
expectType<z.output<typeof ApiRefactorOutputSchema>>(inferredApiRefactorResult);
