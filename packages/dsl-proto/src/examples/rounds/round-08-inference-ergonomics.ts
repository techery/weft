import {
  type CheckDefinition,
  type CheckResultOf,
  type CheckSuiteDefinition,
  type CheckSuiteMembers,
  type CheckSuiteUse,
  type Ctx,
  defineCheck,
  defineCheckSuite,
  defineOperation,
  defineWorkflow,
  type EvidenceRef,
  type InferWorkflowInput,
  type OperationAttemptCompensationOf,
  type OperationAttemptIdempotencyOf,
  type OperationAttemptPrimaryOf,
  type OperationCandidateRef,
  type OperationInputOf,
  type OperationOutputOf,
  type PromotionEvidence,
  type ProtectedOperationDefinition,
  type ProtectedOperationExecution,
  type SubjectAttestation,
  type WorkflowDefinition,
  type WorkflowNode,
  type WorkflowRunReceipt,
  type WorkspaceSnapshotRef,
  z,
} from "../../index.ts";

/** Why: Makes positive and negative compile-time assertions readable without runtime behavior. Use: Pass inferred helper results to it throughout this file. */
declare function expectType<Type>(value: Type): void;

// ---------------------------------------------------------------------------
// Eligible checks and callback contextual typing
// ---------------------------------------------------------------------------

const ReleaseCheckInputSchema = z.object({
  releaseId: z.string().min(1),
  emergency: z.boolean(),
});

const eligibleReleaseFreeze = defineCheck({
  name: "round-08-ergonomics-release-freeze",
  revision: "freeze-v8",
  policy: "required",
  waiver: {
    mode: "eligible",
    binding: "policy.check-waiver",
    action: "Waive one exact release freeze failure",
    risk: "high",
    maxTtl: "20m",
  },
  input: ReleaseCheckInputSchema,
  run: (input, context) => {
    expectType<string>(input.releaseId);
    expectType<boolean>(input.emergency);
    expectType<AbortSignal>(context.signal);
    return input.emergency;
  },
});

expectType<"round-08-ergonomics-release-freeze">(eligibleReleaseFreeze.name);
expectType<"freeze-v8">(eligibleReleaseFreeze.revision);
expectType<"policy.check-waiver">(eligibleReleaseFreeze.waiver.binding);

defineCheck({
  name: "round-08-invalid-eligible-check",
  // @ts-expect-error Eligible checks require an exact revision.
  revision: undefined,
  policy: "required",
  waiver: {
    mode: "eligible",
    binding: "policy.check-waiver",
    action: "Invalid fixture",
    risk: "low",
    maxTtl: "5m",
  },
  input: ReleaseCheckInputSchema,
  run: () => true,
});

// ---------------------------------------------------------------------------
// Tuple and map check suites
// ---------------------------------------------------------------------------

const formattingCheck = defineCheck({
  name: "round-08-ergonomics-format",
  command: ["pnpm", "exec", "biome", "check", "."],
  policy: "required",
  waiver: { mode: "never" },
});

const declarationsCheck = defineCheck({
  name: "round-08-ergonomics-declarations",
  command: ["pnpm", "exec", "tsc", "--noEmit"],
  policy: "required",
  waiver: { mode: "never" },
});

/** Why: Preserves a static check tuple rather than widening it to an array. Use: Feed the result directly to defineCheckSuite. */
function checkTuple<const Checks extends readonly CheckDefinition<void, string, any, any, any>[]>(
  ...checks: Checks
): Checks {
  return checks;
}

const staticQualitySuite = defineCheckSuite({
  name: "round-08-ergonomics-static-quality",
  checks: checkTuple(formattingCheck, declarationsCheck),
  concurrency: 2,
});

const IntegrityInputSchema = z.object({ digest: z.string().min(1) });
const artifactIntegrity = defineCheck({
  name: "round-08-ergonomics-integrity",
  input: IntegrityInputSchema,
  policy: "required",
  waiver: { mode: "never" },
  run: (input, context) => {
    expectType<string>(input.digest);
    expectType<AbortSignal>(context.signal);
    return input.digest.startsWith("sha256:");
  },
});

const ReleaseQualityInputSchema = z.object({
  releaseId: z.string().min(1),
  emergency: z.boolean(),
  digest: z.string().min(1),
});

/** Why: Preserves semantic member keys and each member's exact definition/input pair. Use: Return it from schema-suite callbacks. */
function checkMap<const Members extends CheckSuiteMembers>(members: Members): Members {
  return members;
}

const mappedQualitySuite = defineCheckSuite({
  name: "round-08-ergonomics-mapped-quality",
  input: ReleaseQualityInputSchema,
  checks: (input, use) => {
    expectType<string>(input.releaseId);
    expectType<boolean>(input.emergency);
    expectType<CheckSuiteUse>(use);
    return checkMap({
      freeze: use(eligibleReleaseFreeze, {
        releaseId: input.releaseId,
        emergency: input.emergency,
      }),
      integrity: use(artifactIntegrity, { digest: input.digest }),
    });
  },
  concurrency: 2,
});

/** Why: Extracts exact result-member keys from a suite for helper assertions. Use: Replace it with a public core helper if suite metaprogramming becomes common. */
type CheckSuiteMembersOf<Suite> =
  Suite extends CheckSuiteDefinition<any, infer Members, any> ? Members : never;

type StaticQualityMembers = CheckSuiteMembersOf<typeof staticQualitySuite>;
type MappedQualityMembers = CheckSuiteMembersOf<typeof mappedQualitySuite>;

expectType<keyof StaticQualityMembers>(formattingCheck.name);
expectType<"freeze" | "integrity">(null as unknown as keyof MappedQualityMembers);

/** Why: Exercises tuple/map result inference through the callable check API. Use: Typecheck only; the host executes the commands. */
async function exerciseCheckSuites(ctx: Ctx): Promise<void> {
  const staticResult = await ctx.check(staticQualitySuite, { keyPrefix: "static-quality" });
  expectType<CheckResultOf<typeof formattingCheck>>(staticResult.results[formattingCheck.name]);
  // @ts-expect-error Static tuple members do not invent arbitrary result keys.
  expectType<CheckResultOf<typeof formattingCheck>>(staticResult.results.missing);

  const mappedResult = await ctx.check(
    mappedQualitySuite,
    { releaseId: "release-8", emergency: true, digest: "sha256:abc" },
    { keyPrefix: "mapped-quality" },
  );
  expectType<CheckResultOf<typeof eligibleReleaseFreeze>>(mappedResult.results.freeze);
  expectType<CheckResultOf<typeof artifactIntegrity>>(mappedResult.results.integrity);
}

expectType<(ctx: Ctx) => Promise<void>>(exerciseCheckSuites);

// ---------------------------------------------------------------------------
// Protected and recoverable operation inference
// ---------------------------------------------------------------------------

const publishCandidate = defineOperation({
  name: "round-08-ergonomics-publish",
  input: z.object({ releaseId: z.string().min(1), repository: z.string().min(1) }),
  output: z.object({ releaseId: z.string().min(1), remoteId: z.string().min(1) }),
  binding: "release.publish",
  capabilities: ["network", "integration:code-host"],
  authorization: { mode: "required", action: "Publish one release candidate", risk: "high" },
});

const cancelPublication = defineOperation({
  name: "round-08-ergonomics-cancel-publish",
  input: z.object({ attemptRef: z.string().min(1), idempotencyKey: z.string().min(1) }),
  output: z.object({ cancelled: z.boolean() }),
  binding: "release.cancel",
  capabilities: ["network", "integration:code-host"],
  authorization: { mode: "none" },
});

const withdrawPublication = defineOperation({
  name: "round-08-ergonomics-withdraw",
  input: z.object({ remoteId: z.string().min(1) }),
  output: z.object({ withdrawn: z.boolean() }),
  binding: "release.withdraw",
  capabilities: ["network", "integration:code-host"],
  authorization: { mode: "required", action: "Withdraw one publication", risk: "high" },
});

const deletePreview = defineOperation({
  name: "round-08-ergonomics-delete-preview",
  input: z.object({ previewId: z.string().min(1) }),
  output: z.object({ deleted: z.boolean() }),
  binding: "preview.delete",
  capabilities: ["network"],
  authorization: { mode: "required", action: "Delete one preview", risk: "medium" },
});

/** Why: Names the exact candidate/authority pair returned by a generic helper. Use: Keep protected execution nominal without call-site generic annotations. */
type PreparedProtectedOperation<
  Definition extends ProtectedOperationDefinition,
  Input extends OperationInputOf<Definition>,
> = ProtectedOperationExecution<Definition, OperationCandidateRef<Definition, Input>>;

/** Why: Packages the required prepare/authorize ceremony while preserving definition and input inference. Use: Call with ordinary values; never supply explicit generic arguments. */
async function prepareProtectedOperation<
  Definition extends ProtectedOperationDefinition,
  Input extends OperationInputOf<Definition>,
>(
  ctx: Ctx,
  definition: Definition,
  input: Input,
  key: string,
): Promise<PreparedProtectedOperation<Definition, Input>> {
  const candidate = await ctx.operation.prepare(definition, input, { key: `${key}:prepare` });
  const authorization = await ctx.operation.authorize(definition, candidate, {
    key: `${key}:authorize`,
  });
  return { candidate, authorization };
}

/** Why: Exercises protected execution and both recovery-plan mapper callbacks with inference only. Use: Typecheck operation state transitions and mismatch rejection. */
async function exerciseOperationInference(ctx: Ctx): Promise<void> {
  const execution = await prepareProtectedOperation(
    ctx,
    publishCandidate,
    { releaseId: "release-8", repository: "techery/weft" },
    "publish",
  );
  expectType<OperationCandidateRef<typeof publishCandidate>>(execution.candidate);

  const ordinaryOutput = await ctx.operation.execute(publishCandidate, execution, {
    key: "publish-once",
  });
  expectType<OperationOutputOf<typeof publishCandidate>>(ordinaryOutput);

  const attempt = await ctx.operation.recoverable(
    publishCandidate,
    execution,
    {
      cancellation: {
        operation: cancelPublication,
        map: (intent) => {
          expectType<string>(intent.ref);
          expectType<"publish:release-8">(intent.idempotencyKey);
          return { attemptRef: intent.ref, idempotencyKey: intent.idempotencyKey };
        },
        options: { key: "cancel-publish", idempotencyKey: "cancel:release-8" },
      },
      compensation: {
        operation: withdrawPublication,
        map: (receipt) => {
          expectType<string>(receipt.output.remoteId);
          return { remoteId: receipt.output.remoteId };
        },
      },
    },
    { key: "register-publish", idempotencyKey: "publish:release-8" },
  );

  expectType<typeof publishCandidate>(null as unknown as OperationAttemptPrimaryOf<typeof attempt>);
  expectType<typeof withdrawPublication>(null as unknown as OperationAttemptCompensationOf<typeof attempt>);
  expectType<"publish:release-8">(null as unknown as OperationAttemptIdempotencyOf<typeof attempt>);

  const result = await ctx.operation.executeRecoverable(publishCandidate, attempt);
  if (result.status === "succeeded") {
    expectType<string>(result.receipt.output.remoteId);
  }

  // @ts-expect-error The attempt's nominal primary definition cannot be replaced at dispatch.
  await ctx.operation.executeRecoverable(deletePreview, attempt);
}

expectType<(ctx: Ctx) => Promise<void>>(exerciseOperationInference);

// ---------------------------------------------------------------------------
// Detailed workflow calls through a heterogeneous registry
// ---------------------------------------------------------------------------

const InspectInputSchema = z.object({ repository: z.string().min(1) });
const InspectOutputSchema = z.object({
  kind: z.literal("inspection"),
  repository: z.string().min(1),
});

const inspectWorkflow = defineWorkflow(
  {
    id: "round-08-ergonomics-inspect",
    input: InspectInputSchema,
    output: InspectOutputSchema,
  },
  async (_ctx, input) => {
    expectType<string>(input.repository);
    return { kind: "inspection" as const, repository: input.repository };
  },
);

const BuildInputSchema = z.object({
  repository: z.string().min(1),
  baseRef: z.string().min(1),
  branch: z.string().min(1),
});
const BuildOutputSchema = z.object({
  kind: z.literal("candidate"),
  branch: z.string().min(1),
});

const buildWorkflow = defineWorkflow(
  {
    id: "round-08-ergonomics-build",
    input: BuildInputSchema,
    output: BuildOutputSchema,
    workspace: ({ input }) => ({ branch: input.branch, from: input.baseRef }),
  },
  async (ctx, input) => {
    expectType<string>(input.branch);
    expectType<string>(ctx.workspace.branch);
    return { kind: "candidate" as const, branch: ctx.workspace.branch };
  },
);

/** Why: Names the broad bound accepted by exact-definition workflow helpers. Use: Keep registry members concrete rather than storing only this erased type. */
type AnyWorkflowDefinition = WorkflowDefinition<any, any, any, any, any, any, any>;

const workflowRegistry = {
  inspect: inspectWorkflow,
  build: buildWorkflow,
} as const satisfies Record<string, AnyWorkflowDefinition>;

/** Why: Preserves one concrete workflow through a reusable detailed-call helper. Use: Prefer it when the caller already holds an exact narrowed definition. */
function runExactWorkflow<Definition extends AnyWorkflowDefinition>(
  ctx: Ctx,
  definition: Definition,
  input: InferWorkflowInput<Definition>,
  key: string,
): Promise<WorkflowRunReceipt<Definition>> {
  return ctx.workflow.detailed(definition, input, { key });
}

/** Why: Correlates heterogeneous registry inputs and receipt types with an explicit discriminant. Use: Narrow before calling workflow.detailed instead of indexing the registry with a generic union key. */
type RegisteredWorkflowInvocation =
  | {
      key: "inspect";
      input: InferWorkflowInput<(typeof workflowRegistry)["inspect"]>;
    }
  | {
      key: "build";
      input: InferWorkflowInput<(typeof workflowRegistry)["build"]>;
    };

/** Why: Keeps each heterogeneous receipt paired with the registry discriminator that selected its definition. Use: Narrow on key before consuming value or workspace provenance. */
type RegisteredWorkflowReceipt =
  | {
      key: "inspect";
      receipt: WorkflowRunReceipt<(typeof workflowRegistry)["inspect"]>;
    }
  | {
      key: "build";
      receipt: WorkflowRunReceipt<(typeof workflowRegistry)["build"]>;
    };

/** Why: Demonstrates the smallest sound heterogeneous-registry adapter. Use: Keep the switch exhaustive so input/output correlations never collapse into independent unions. */
async function runRegisteredWorkflow(
  ctx: Ctx,
  invocation: RegisteredWorkflowInvocation,
): Promise<RegisteredWorkflowReceipt> {
  switch (invocation.key) {
    case "inspect":
      return {
        key: "inspect",
        receipt: await ctx.workflow.detailed(workflowRegistry.inspect, invocation.input, {
          key: "registry:inspect",
        }),
      };
    case "build":
      return {
        key: "build",
        receipt: await ctx.workflow.detailed(workflowRegistry.build, invocation.input, {
          key: "registry:build",
        }),
      };
  }
}

/** Why: Exercises exact and heterogeneous detailed receipts without reconstructing child lineage. Use: Typecheck only. */
async function exerciseWorkflowRegistry(ctx: Ctx): Promise<void> {
  const exact = await runExactWorkflow(
    ctx,
    workflowRegistry.inspect,
    { repository: "techery/weft" },
    "exact-inspect",
  );
  expectType<"inspection">(exact.value.kind);
  expectType<string>(exact.childRunId);
  expectType<undefined>(exact.workspace);

  const registered = await runRegisteredWorkflow(ctx, {
    key: "build",
    input: { repository: "techery/weft", baseRef: "main", branch: "codex/round-8" },
  });
  if (registered.key === "build") {
    expectType<"candidate">(registered.receipt.value.kind);
    expectType<WorkspaceSnapshotRef>(registered.receipt.workspace);
  }

  await runRegisteredWorkflow(ctx, {
    key: "inspect",
    // @ts-expect-error Registry narrowing preserves the inspection input contract.
    input: { repository: 8 },
  });

  // @ts-expect-error Detailed evidence requires an exact nominal definition, not the legacy string lookup.
  await ctx.workflow.detailed("round-08-ergonomics-inspect", { repository: "techery/weft" });
}

expectType<(ctx: Ctx) => Promise<void>>(exerciseWorkflowRegistry);

// ---------------------------------------------------------------------------
// Subject-preserving evidence tuples
// ---------------------------------------------------------------------------

/** Why: Refines one nominal engine subject so evidence helpers can retain its exact type. Use: Compile-time fixture only. */
type CandidateSubject = WorkspaceSnapshotRef & {
  readonly workspaceId: "candidate-workspace";
  readonly generation: 8;
};

/** Why: Refines a different nominal subject for negative mixed-evidence assertions. Use: It must never enter CandidateSubject evidence tuples. */
type OtherSubject = WorkspaceSnapshotRef & {
  readonly workspaceId: "other-workspace";
  readonly generation: 9;
};

/** Why: Builds a reusable core promotion-evidence tuple before delivery preparation. Use: Preserve the subject inferred from the explicit anchor. */
function evidenceFor<Subject extends WorkspaceSnapshotRef>(
  _subject: Subject,
  first: SubjectAttestation<string, unknown, NoInfer<Subject>>,
  ...additional: SubjectAttestation<string, unknown, NoInfer<Subject>>[]
): PromotionEvidence<Subject> {
  return [first, ...additional];
}

/** Why: Recovers the exact subject carried by one evidence union. Use: Prove tuple helpers did not widen it to WorkspaceSnapshotRef. */
type EvidenceSubjectOf<Evidence> =
  Evidence extends EvidenceRef<string, unknown, infer Subject> ? Subject : never;

declare const candidateSubject: CandidateSubject;
declare const otherSubject: OtherSubject;
declare const candidateCheckEvidence: SubjectAttestation<"check", { status: "pass" }, CandidateSubject>;
declare const candidateReviewEvidence: SubjectAttestation<"review", { status: "accepted" }, CandidateSubject>;
declare const otherCheckEvidence: SubjectAttestation<"check", { status: "pass" }, OtherSubject>;

const candidateEvidence = evidenceFor(candidateSubject, candidateCheckEvidence, candidateReviewEvidence);
expectType<PromotionEvidence<CandidateSubject>>(candidateEvidence);
expectType<CandidateSubject>(null as unknown as EvidenceSubjectOf<(typeof candidateEvidence)[number]>);
expectType<PromotionEvidence<CandidateSubject>>(candidateEvidence);

evidenceFor(
  candidateSubject,
  candidateCheckEvidence,
  // @ts-expect-error Evidence for generation 9 cannot enter a generation-8 tuple.
  otherCheckEvidence,
);

expectType<OtherSubject>(otherSubject);

const structuralEvidence = {
  kind: "check" as const,
  ref: "forged",
  sha256: "forged",
  subject: candidateSubject,
  createdAt: "2026-08-29T12:00:00.000Z",
};
// @ts-expect-error Evidence-shaped data lacks the engine's nominal EvidenceRef brand.
expectType<SubjectAttestation<"check", unknown, CandidateSubject>>(structuralEvidence);

expectType<WorkflowNode<"weft.check">>(eligibleReleaseFreeze);
expectType<WorkflowNode<"weft.check-suite">>(mappedQualitySuite);
expectType<WorkflowNode<"weft.operation">>(publishCandidate);
expectType<WorkflowNode<"weft.workflow">>(buildWorkflow);

// Round 8 inference/DX findings, ranked (maximum five):
// 1. Eligible checks now retain their revision literal through direct `defineCheck` inference, eliminating the former
//    wrapper intersection and its unsafe conditional-config cast.
// 2. Detailed child receipts now derive workspace authority from an exact definition-owned mode: plain children expose
//    `undefined`, while workspace-owning children expose a nominal `WorkspaceSnapshotRef` without a defensive branch.
// 3. Heterogeneous workflow registries require a handwritten discriminated switch because generic indexed access loses
//    key/input/receipt correlation. Minimal fix: export a registry invocation/result mapped type or detailed dispatcher.
// 4. Exported recoverable-operation wrappers must restate the large attempt/recovery state type even though inline
//    inference is excellent. Minimal fix: export an `OperationAttemptFor<Execution, Recovery, Key>` derivation helper.
