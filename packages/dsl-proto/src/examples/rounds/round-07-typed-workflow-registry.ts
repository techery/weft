import { z } from "zod";

import {
  type AnySchema,
  type Ctx,
  defineWorkflow,
  type InferWorkflowInput,
  type InferWorkflowOutput,
  type WorkflowIdOf,
  type WorkflowInputSchemaOf,
  type WorkflowNode,
  type WorkflowOutputSchemaOf,
} from "../../core/index.ts";

/** Why: Makes compile-time contract assertions visible without adding runtime behavior. Use: Pass inferred registry values to it in this typechecked example. */
declare function expectType<Type>(value: Type): void;

const TEST_REPAIR_V1 = "test-repair@v1";
const DEPENDENCY_UPGRADE_V1 = "dependency-upgrade@v1";
const DEPENDENCY_UPGRADE_V2 = "dependency-upgrade@v2";
const DOCUMENTATION_SYNC_V1 = "documentation-sync@v1";

const TestRepairInput = z
  .object({
    repository: z.string().min(1),
    baseRef: z.string().min(1),
    testFile: z.string().min(1),
    testName: z.string().min(1),
    failureDigest: z.string().min(1),
  })
  .strict();

const TestRepairOutput = z
  .object({
    kind: z.literal("test-repair"),
    revision: z.literal("v1"),
    repairId: z.string().min(1),
    testFile: z.string().min(1),
    verificationTarget: z.string().min(1),
  })
  .strict();

/** Why: Names the exact validated request for one targeted test repair. Use: Derive registry correlation from the workflow definition, not a parallel handwritten interface. */
type TestRepairInputValue = z.infer<typeof TestRepairInput>;

/** Why: Names the exact result of the v1 test-repair contract. Use: Prove exact-definition child calls do not widen their output. */
type TestRepairOutputValue = z.infer<typeof TestRepairOutput>;

const testRepairV1Workflow = defineWorkflow(
  {
    id: TEST_REPAIR_V1,
    name: "Targeted test repair v1",
    description: "Routes one reproducible test failure into a versioned targeted-repair contract.",
    input: TestRepairInput,
    output: TestRepairOutput,
  },
  async (ctx, input): Promise<TestRepairOutputValue> => {
    ctx.log(`Preparing a targeted repair for ${input.testName} at ${input.baseRef}`);
    return {
      kind: "test-repair",
      revision: "v1",
      repairId: await ctx.uuid({ key: "repair-id" }),
      testFile: input.testFile,
      verificationTarget: `${input.testFile}#${input.testName}`,
    };
  },
);

const DependencyUpgradeV1Input = z
  .object({
    repository: z.string().min(1),
    baseRef: z.string().min(1),
    manifestPath: z.string().min(1),
    dependency: z.string().min(1),
    targetVersion: z.string().min(1),
  })
  .strict();

const DependencyUpgradeV1Output = z
  .object({
    kind: z.literal("dependency-upgrade"),
    revision: z.literal("v1"),
    changeId: z.string().min(1),
    manifestPath: z.string().min(1),
    dependency: z.string().min(1),
    targetVersion: z.string().min(1),
    strategy: z.literal("manifest-only"),
  })
  .strict();

/** Why: Names the legacy single-manifest upgrade input. Use: Keep it intentionally incompatible with the workspace-aware v2 input. */
type DependencyUpgradeV1InputValue = z.infer<typeof DependencyUpgradeV1Input>;

/** Why: Names the legacy single-manifest upgrade result. Use: Retain its revision-specific output through the router. */
type DependencyUpgradeV1OutputValue = z.infer<typeof DependencyUpgradeV1Output>;

const dependencyUpgradeV1Workflow = defineWorkflow(
  {
    id: DEPENDENCY_UPGRADE_V1,
    name: "Dependency upgrade v1",
    description: "Plans one manifest-only dependency upgrade without workspace fan-out.",
    input: DependencyUpgradeV1Input,
    output: DependencyUpgradeV1Output,
  },
  async (ctx, input): Promise<DependencyUpgradeV1OutputValue> => {
    ctx.log(`Preparing ${input.dependency}@${input.targetVersion} in ${input.manifestPath}`);
    return {
      kind: "dependency-upgrade",
      revision: "v1",
      changeId: await ctx.uuid({ key: "change-id" }),
      manifestPath: input.manifestPath,
      dependency: input.dependency,
      targetVersion: input.targetVersion,
      strategy: "manifest-only",
    };
  },
);

const DependencyUpgradeV2Input = z
  .object({
    repository: z.string().min(1),
    baseRef: z.string().min(1),
    workspaceRoot: z.string().min(1),
    dependency: z.string().min(1),
    targetRange: z.string().min(1),
    packages: z.array(z.string().min(1)).min(1).max(64),
    updateLockfile: z.boolean(),
  })
  .strict();

const DependencyUpgradeV2Output = z
  .object({
    kind: z.literal("dependency-upgrade"),
    revision: z.literal("v2"),
    changeId: z.string().min(1),
    workspaceRoot: z.string().min(1),
    dependency: z.string().min(1),
    targetRange: z.string().min(1),
    affectedPackages: z.array(z.string().min(1)),
    lockfileUpdated: z.boolean(),
    strategy: z.literal("workspace-aware"),
  })
  .strict();

/** Why: Names the workspace-aware upgrade input introduced by revision v2. Use: Prevent callers from silently routing v1 payloads to the new contract. */
type DependencyUpgradeV2InputValue = z.infer<typeof DependencyUpgradeV2Input>;

/** Why: Names the workspace-aware upgrade result. Use: Preserve its v2-only fields after heterogeneous dispatch. */
type DependencyUpgradeV2OutputValue = z.infer<typeof DependencyUpgradeV2Output>;

const dependencyUpgradeV2Workflow = defineWorkflow(
  {
    id: DEPENDENCY_UPGRADE_V2,
    name: "Dependency upgrade v2",
    description: "Plans a workspace-aware dependency upgrade with explicit lockfile policy.",
    input: DependencyUpgradeV2Input,
    output: DependencyUpgradeV2Output,
  },
  async (ctx, input): Promise<DependencyUpgradeV2OutputValue> => {
    ctx.log(`Preparing workspace upgrade ${input.dependency}@${input.targetRange} at ${input.baseRef}`);
    return {
      kind: "dependency-upgrade",
      revision: "v2",
      changeId: await ctx.uuid({ key: "change-id" }),
      workspaceRoot: input.workspaceRoot,
      dependency: input.dependency,
      targetRange: input.targetRange,
      affectedPackages: input.packages,
      lockfileUpdated: input.updateLockfile,
      strategy: "workspace-aware",
    };
  },
);

const DocumentationSyncInput = z
  .object({
    repository: z.string().min(1),
    baseRef: z.string().min(1),
    sourcePaths: z.array(z.string().min(1)).min(1).max(32),
    documentationRoot: z.string().min(1),
    audience: z.enum(["contributors", "operators", "users"]),
  })
  .strict();

const DocumentationSyncOutput = z
  .object({
    kind: z.literal("documentation-sync"),
    revision: z.literal("v1"),
    syncId: z.string().min(1),
    documentationRoot: z.string().min(1),
    sourceCount: z.number().int().positive(),
    audience: z.enum(["contributors", "operators", "users"]),
  })
  .strict();

/** Why: Names the documentation workflow's many-source input. Use: Exercise a registry member unrelated to either repair or dependency shapes. */
type DocumentationSyncInputValue = z.infer<typeof DocumentationSyncInput>;

/** Why: Names the documentation workflow's distinct result. Use: Verify router responses remain discriminated by the selected workflow key. */
type DocumentationSyncOutputValue = z.infer<typeof DocumentationSyncOutput>;

const documentationSyncV1Workflow = defineWorkflow(
  {
    id: DOCUMENTATION_SYNC_V1,
    name: "Documentation sync v1",
    description: "Plans a bounded documentation synchronization from explicit source paths.",
    input: DocumentationSyncInput,
    output: DocumentationSyncOutput,
  },
  async (ctx, input): Promise<DocumentationSyncOutputValue> => {
    ctx.log(`Preparing ${input.audience} documentation from ${input.sourcePaths.length} source paths`);
    return {
      kind: "documentation-sync",
      revision: "v1",
      syncId: await ctx.uuid({ key: "sync-id" }),
      documentationRoot: input.documentationRoot,
      sourceCount: input.sourcePaths.length,
      audience: input.audience,
    };
  },
);

const codingWorkflowKeys = [
  TEST_REPAIR_V1,
  DEPENDENCY_UPGRADE_V1,
  DEPENDENCY_UPGRADE_V2,
  DOCUMENTATION_SYNC_V1,
] as const;

/** Why: Closes the dynamically selectable workflow namespace at compile time. Use: Reject unknown families and revisions before registry lookup. */
type CodingWorkflowKey = (typeof codingWorkflowKeys)[number];

/** Why: Names the minimum inspectable metadata shared by heterogeneous entries. Use: Constrain the ordinary TypeScript registry without erasing each concrete definition. */
interface CodingWorkflowRegistryEntry {
  readonly family: "test-repair" | "dependency-upgrade" | "documentation-sync";
  readonly revision: "v1" | "v2";
  readonly definition: WorkflowNode<"weft.workflow">;
}

const codingWorkflowRegistry = {
  [TEST_REPAIR_V1]: {
    family: "test-repair",
    revision: "v1",
    definition: testRepairV1Workflow,
  },
  [DEPENDENCY_UPGRADE_V1]: {
    family: "dependency-upgrade",
    revision: "v1",
    definition: dependencyUpgradeV1Workflow,
  },
  [DEPENDENCY_UPGRADE_V2]: {
    family: "dependency-upgrade",
    revision: "v2",
    definition: dependencyUpgradeV2Workflow,
  },
  [DOCUMENTATION_SYNC_V1]: {
    family: "documentation-sync",
    revision: "v1",
    definition: documentationSyncV1Workflow,
  },
} as const satisfies Record<CodingWorkflowKey, CodingWorkflowRegistryEntry>;

/** Why: Recovers the concrete definition at one closed registry key. Use: Derive its correlated input and output without a broad workflow union. */
type RegistryDefinition<Key extends CodingWorkflowKey> = (typeof codingWorkflowRegistry)[Key]["definition"];

/** Why: Derives the exact launch input for one registry key. Use: Keep selection and payload correlated in generic type utilities. */
type RegistryInput<Key extends CodingWorkflowKey> = InferWorkflowInput<RegistryDefinition<Key>>;

/** Why: Derives the exact result for one registry key. Use: Keep selection and child result correlated in router consumers. */
type RegistryOutput<Key extends CodingWorkflowKey> = InferWorkflowOutput<RegistryDefinition<Key>>;

/** Why: Derives the exact closed workflow-ID union from the registered definitions. Use: Inspect stable identities without repeating or widening them. */
type RegisteredWorkflowId = WorkflowIdOf<RegistryDefinition<CodingWorkflowKey>>;

/** Why: Recovers the exact input schema retained by one registered definition. Use: Construct runtime routing boundaries from the workflow contract itself. */
type RegistryInputSchema<Key extends CodingWorkflowKey> = WorkflowInputSchemaOf<RegistryDefinition<Key>>;

/** Why: Recovers the exact output schema retained by one registered definition. Use: Construct correlated response boundaries without repeating child schemas. */
type RegistryOutputSchema<Key extends CodingWorkflowKey> = WorkflowOutputSchemaOf<RegistryDefinition<Key>>;

/** Why: Produces the closed request union directly from the heterogeneous registry. Use: Compare the runtime Zod boundary against its type-derived contract. */
type DerivedRegistryRequest = {
  [Key in CodingWorkflowKey]: {
    workflow: Key;
    input: RegistryInput<Key>;
  };
}[CodingWorkflowKey];

/** Why: Produces the response union whose payload follows the selected key. Use: Prevent union-wide outputs from losing request/result correlation. */
type DerivedRegistryResponse = {
  [Key in CodingWorkflowKey]: {
    workflow: Key;
    output: RegistryOutput<Key>;
  };
}[CodingWorkflowKey];

const TypedRegistryRequest = z.discriminatedUnion("workflow", [
  z
    .object({
      workflow: z.literal(TEST_REPAIR_V1),
      input: codingWorkflowRegistry[TEST_REPAIR_V1].definition.meta.input,
    })
    .strict(),
  z
    .object({
      workflow: z.literal(DEPENDENCY_UPGRADE_V1),
      input: codingWorkflowRegistry[DEPENDENCY_UPGRADE_V1].definition.meta.input,
    })
    .strict(),
  z
    .object({
      workflow: z.literal(DEPENDENCY_UPGRADE_V2),
      input: codingWorkflowRegistry[DEPENDENCY_UPGRADE_V2].definition.meta.input,
    })
    .strict(),
  z
    .object({
      workflow: z.literal(DOCUMENTATION_SYNC_V1),
      input: codingWorkflowRegistry[DOCUMENTATION_SYNC_V1].definition.meta.input,
    })
    .strict(),
]);

const TypedRegistryResponse = z.discriminatedUnion("workflow", [
  z
    .object({
      workflow: z.literal(TEST_REPAIR_V1),
      output: codingWorkflowRegistry[TEST_REPAIR_V1].definition.meta.output,
    })
    .strict(),
  z
    .object({
      workflow: z.literal(DEPENDENCY_UPGRADE_V1),
      output: codingWorkflowRegistry[DEPENDENCY_UPGRADE_V1].definition.meta.output,
    })
    .strict(),
  z
    .object({
      workflow: z.literal(DEPENDENCY_UPGRADE_V2),
      output: codingWorkflowRegistry[DEPENDENCY_UPGRADE_V2].definition.meta.output,
    })
    .strict(),
  z
    .object({
      workflow: z.literal(DOCUMENTATION_SYNC_V1),
      output: codingWorkflowRegistry[DOCUMENTATION_SYNC_V1].definition.meta.output,
    })
    .strict(),
]);

/** Why: Names the validated closed request accepted by the router. Use: Exhaustively narrow it before calling any concrete child definition. */
type TypedRegistryRequestValue = z.infer<typeof TypedRegistryRequest>;

/** Why: Names the selected-key-correlated router output. Use: Preserve exact child results across the parent workflow boundary. */
type TypedRegistryResponseValue = z.infer<typeof TypedRegistryResponse>;

/** Why: Gives generic tooling a serializable view without exposing a launch-by-string capability. Use: List registered identities and node kinds for diagnostics or UI. */
interface CodingWorkflowInspection {
  readonly key: CodingWorkflowKey;
  readonly family: CodingWorkflowRegistryEntry["family"];
  readonly revision: CodingWorkflowRegistryEntry["revision"];
  readonly workflowId: RegisteredWorkflowId;
  readonly workflowName: string | undefined;
  readonly kind: "weft.workflow";
  readonly inputSchema: AnySchema;
  readonly outputSchema: AnySchema;
}

/** Why: Inspects the closed registry through its explicit key tuple instead of an unchecked `Object.keys` cast. Use: Render catalog metadata without widening launch contracts. */
function inspectCodingWorkflowRegistry(): ReadonlyArray<CodingWorkflowInspection> {
  return codingWorkflowKeys.map((key) => {
    const entry = codingWorkflowRegistry[key];
    const expectedKey = `${entry.family}@${entry.revision}`;
    if (key !== expectedKey) {
      throw new Error(`Registry key ${key} does not match ${expectedKey}`);
    }
    return {
      key,
      family: entry.family,
      revision: entry.revision,
      workflowId: entry.definition.meta.id,
      workflowName: entry.definition.meta.name,
      kind: entry.definition.kind,
      inputSchema: entry.definition.meta.input,
      outputSchema: entry.definition.meta.output,
    };
  });
}

/** Why: Proves unvalidated names cannot bypass exact workflow identity and input validation. Use: Keep this rejected call beside the sound exhaustive router. */
function dispatchByUnvalidatedName(ctx: Ctx, name: string, input: unknown): Promise<unknown> {
  // @ts-expect-error Dynamic strings must cross the validated exhaustive router before workflow invocation.
  return ctx.workflow(name, input, { key: "unvalidated-string-dispatch" });
}

/** Why: Proves the validated union was exhaustive if registry cases change. Use: Call it from the router's default branch after TypeScript narrowing. */
function assertNever(value: never): never {
  throw new Error(`Unhandled registry request: ${JSON.stringify(value)}`);
}

const typedWorkflowRegistryRouter = defineWorkflow(
  {
    id: "round-07-typed-workflow-registry-router",
    name: "Typed coding workflow registry router",
    description:
      "Validates a versioned heterogeneous request and dispatches it through exact workflow-definition overloads.",
    input: TypedRegistryRequest,
    output: TypedRegistryResponse,
  },
  async (ctx, request): Promise<TypedRegistryResponseValue> => {
    switch (request.workflow) {
      case TEST_REPAIR_V1: {
        const output = await ctx.workflow(codingWorkflowRegistry[TEST_REPAIR_V1].definition, request.input, {
          key: TEST_REPAIR_V1,
        });
        return { workflow: TEST_REPAIR_V1, output };
      }
      case DEPENDENCY_UPGRADE_V1: {
        const output = await ctx.workflow(
          codingWorkflowRegistry[DEPENDENCY_UPGRADE_V1].definition,
          request.input,
          { key: DEPENDENCY_UPGRADE_V1 },
        );
        return { workflow: DEPENDENCY_UPGRADE_V1, output };
      }
      case DEPENDENCY_UPGRADE_V2: {
        const output = await ctx.workflow(
          codingWorkflowRegistry[DEPENDENCY_UPGRADE_V2].definition,
          request.input,
          { key: DEPENDENCY_UPGRADE_V2 },
        );
        return { workflow: DEPENDENCY_UPGRADE_V2, output };
      }
      case DOCUMENTATION_SYNC_V1: {
        const output = await ctx.workflow(
          codingWorkflowRegistry[DOCUMENTATION_SYNC_V1].definition,
          request.input,
          { key: DOCUMENTATION_SYNC_V1 },
        );
        return { workflow: DOCUMENTATION_SYNC_V1, output };
      }
      default:
        return assertNever(request);
    }
  },
);

const registryInspection = inspectCodingWorkflowRegistry();
expectType<ReadonlyArray<CodingWorkflowInspection>>(registryInspection);
expectType<WorkflowNode<"weft.workflow">>(typedWorkflowRegistryRouter);

declare const validatedRequest: TypedRegistryRequestValue;
declare const derivedRequest: DerivedRegistryRequest;
expectType<DerivedRegistryRequest>(validatedRequest);
expectType<TypedRegistryRequestValue>(derivedRequest);

declare const validatedResponse: TypedRegistryResponseValue;
declare const derivedResponse: DerivedRegistryResponse;
expectType<DerivedRegistryResponse>(validatedResponse);
expectType<TypedRegistryResponseValue>(derivedResponse);

declare const testRepairInput: TestRepairInputValue;
declare const dependencyV1Input: DependencyUpgradeV1InputValue;
declare const dependencyV2Input: DependencyUpgradeV2InputValue;
declare const documentationInput: DocumentationSyncInputValue;
expectType<RegistryInput<typeof TEST_REPAIR_V1>>(testRepairInput);
expectType<RegistryInput<typeof DEPENDENCY_UPGRADE_V1>>(dependencyV1Input);
expectType<RegistryInput<typeof DEPENDENCY_UPGRADE_V2>>(dependencyV2Input);
expectType<RegistryInput<typeof DOCUMENTATION_SYNC_V1>>(documentationInput);

declare const testRepairOutput: RegistryOutput<typeof TEST_REPAIR_V1>;
declare const dependencyV1Output: RegistryOutput<typeof DEPENDENCY_UPGRADE_V1>;
declare const dependencyV2Output: RegistryOutput<typeof DEPENDENCY_UPGRADE_V2>;
declare const documentationOutput: RegistryOutput<typeof DOCUMENTATION_SYNC_V1>;
expectType<TestRepairOutputValue>(testRepairOutput);
expectType<DependencyUpgradeV1OutputValue>(dependencyV1Output);
expectType<DependencyUpgradeV2OutputValue>(dependencyV2Output);
expectType<DocumentationSyncOutputValue>(documentationOutput);

declare const testRepairInputSchema: RegistryInputSchema<typeof TEST_REPAIR_V1>;
declare const dependencyV2InputSchema: RegistryInputSchema<typeof DEPENDENCY_UPGRADE_V2>;
declare const testRepairOutputSchema: RegistryOutputSchema<typeof TEST_REPAIR_V1>;
declare const documentationOutputSchema: RegistryOutputSchema<typeof DOCUMENTATION_SYNC_V1>;
expectType<typeof TestRepairInput>(testRepairInputSchema);
expectType<RegistryInputSchema<typeof TEST_REPAIR_V1>>(TestRepairInput);
expectType<typeof DependencyUpgradeV2Input>(dependencyV2InputSchema);
expectType<RegistryInputSchema<typeof DEPENDENCY_UPGRADE_V2>>(DependencyUpgradeV2Input);
expectType<typeof TestRepairOutput>(testRepairOutputSchema);
expectType<RegistryOutputSchema<typeof TEST_REPAIR_V1>>(TestRepairOutput);
expectType<typeof DocumentationSyncOutput>(documentationOutputSchema);
expectType<RegistryOutputSchema<typeof DOCUMENTATION_SYNC_V1>>(DocumentationSyncOutput);

expectType<(ctx: Ctx, name: string, input: unknown) => Promise<unknown>>(dispatchByUnvalidatedName);
declare const stringDispatchResult: ReturnType<typeof dispatchByUnvalidatedName>;
expectType<Promise<unknown>>(stringDispatchResult);
// @ts-expect-error The string overload cannot claim the exact output of an uninspected workflow name.
expectType<Promise<TestRepairOutputValue>>(stringDispatchResult);

// @ts-expect-error Revision v3 is absent from the closed registry and validated request union.
const unknownRegistryKey: CodingWorkflowKey = "dependency-upgrade@v3";
expectType<CodingWorkflowKey>(unknownRegistryKey);

// @ts-expect-error The v2 workspace payload cannot be routed under the incompatible v1 manifest contract.
expectType<RegistryInput<typeof DEPENDENCY_UPGRADE_V1>>(dependencyV2Input);

expectType<TypedRegistryRequestValue>({
  workflow: TEST_REPAIR_V1,
  input: {
    repository: "techery/weft",
    baseRef: "main",
    testFile: "packages/runtime/test/router.test.ts",
    testName: "routes exact definitions",
    failureDigest: "sha256:failure",
  },
  // @ts-expect-error Strict request variants reject unknown launch fields at both type and runtime boundaries.
  unregisteredPolicyOverride: true,
});

expectType<WorkflowNode<"weft.workflow">>(testRepairV1Workflow);
expectType<WorkflowNode<"weft.workflow">>(dependencyUpgradeV1Workflow);
expectType<WorkflowNode<"weft.workflow">>(dependencyUpgradeV2Workflow);
expectType<WorkflowNode<"weft.workflow">>(documentationSyncV1Workflow);

// Round 7 DX findings (maximum three):
// 1. Exact schema metadata now makes each workflow definition the sole source for registry validation and inspection;
//    `WorkflowInputSchemaOf` and `WorkflowOutputSchemaOf` also retain the concrete schema type for generic tooling.
// 2. Exact-definition calls preserve input/output correlation, and unvalidated string dispatch is rejected;
//    the exhaustive switch remains the smallest sound dynamic router in ordinary TypeScript.
// 3. No workflow-module or catalog `WorkflowNode` is justified yet: this registry adds no host effect or runtime policy.
//    A pure catalog typing helper may be worthwhile only if repeated member construction becomes common.
