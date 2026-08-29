import {
  type ArtifactRefOf,
  defineAgent,
  defineArtifact,
  defineOperation,
  definePathPolicy,
  definePrompt,
  defineWorkflow,
  type HumanReviewResult,
  type OperationAuthorizationRef,
  type OperationCandidateRef,
  type OperationInputOf,
  type WorkflowNode,
  type WriteScope,
  z,
} from "../../index.ts";

/** Why: Makes compile-time authority assertions visible in this typechecked example. Use: Pass inferred values to it without adding a runtime test helper. */
declare function expectType<T>(value: T): void;

const AuthorityWorkflowInput = z.object({
  requestToken: z.string().min(1),
});

const ArtifactPointer = z.object({
  ref: z.string().min(1),
  sha256: z.string().min(1),
});

const WorkspaceSubject = z.object({
  workspaceId: z.string().min(1),
  generation: z.number().int().nonnegative(),
  treeHash: z.string().min(1),
});

const ChangeRequest = z.object({
  requestId: z.string().min(1),
  repository: z.string().min(1),
  title: z.string().min(1),
  acceptanceCriteria: z.array(z.string().min(1)).min(1),
  policyRef: z.string().min(1),
});

const resolveChangeRequest = defineOperation({
  name: "resolve-authority-test-change-request",
  description:
    "Resolves host-owned request facts and the repository policy revision without exposing policy internals.",
  input: AuthorityWorkflowInput,
  output: ChangeRequest,
  binding: "policy.change-request.resolve",
  capabilities: ["workspace:read", "integration:policy"],
  authorization: { mode: "none" },
  defaults: { timeout: "1m", attempts: 2 },
});

const ProposedExternalOperation = z.object({
  kind: z.literal("publish-api-schema"),
  registry: z.string().min(1),
  subject: z.string().min(1),
  schemaPath: z.string().min(1),
  compatibility: z.literal("backward"),
});

const ChangeProposal = z.object({
  summary: z.string().min(1),
  proposedPaths: z.array(z.string().min(1)).min(1),
  externalOperation: ProposedExternalOperation,
  verificationCommands: z.array(z.string().min(1)).min(1),
  rationale: z.string().min(1),
});

/** Why: Names untrusted model advice so it cannot be confused in prose with a host authorization. Use: Review and submit it to policy; never treat it as a grant. */
type ChangeProposalValue = z.infer<typeof ChangeProposal>;

const reviewedChangePaths = definePathPolicy({
  name: "round-04-reviewed-change-paths",
  description:
    "Canonicalizes reviewed coding paths inside package and documentation roots while denying sensitive state.",
  revision: "round-04-v1",
  roots: ["packages", "docs"],
  deny: ["**/.git/**", "**/node_modules/**", "**/.env*", "**/*secret*"],
  grantTtl: "30m",
});

const ProposalInput = z.object({
  request: ChangeRequest,
});

const proposalPrompt = definePrompt({
  name: "propose-authority-bounded-change",
  input: ProposalInput,
  render: ({ request }) => [
    `Plan ${request.requestId}: ${request.title}.`,
    `Acceptance criteria:\n${request.acceptanceCriteria.map((criterion) => `- ${criterion}`).join("\n")}`,
    "Propose paths and one API-schema registry publication, but do not edit files or claim either action is authorized.",
  ],
});

const changePlanner = defineAgent({
  name: "authority-test-planner",
  description: "Produces read-only path and external-effect proposals with no authority to execute them.",
  prompt: proposalPrompt,
  schema: ChangeProposal,
  defaults: {
    provider: {
      id: "codex",
      effort: "high",
      options: { sandboxMode: "read-only", networkAccess: false, webSearch: "disabled" },
    },
    maxTurns: 12,
    timeout: "15m",
  },
});

const ProposalMetadata = z.object({
  requestId: z.string().min(1),
  policyRef: z.string().min(1),
  workflowRunId: z.string().min(1),
});

const proposalArtifact = defineArtifact({
  name: "authority-test-change-proposal",
  mediaType: "application/json",
  extension: ".json",
  content: ChangeProposal,
  metadata: ProposalMetadata,
});

/** Why: Names the immutable proposal bytes a reviewer actually saw. Use: Bind approval and host policy evaluation to this exact reference and digest. */
type ProposalArtifactRef = ArtifactRefOf<typeof proposalArtifact>;

const ProposalReviewAnswer = z.discriminatedUnion("decision", [
  z.object({ decision: z.literal("approve"), note: z.string() }),
  z.object({ decision: z.literal("reject"), note: z.string().min(1) }),
]);

/** Why: Names the typed answer returned while reviewing one exact proposal artifact. Use: Narrow it before asking host policy to authorize anything. */
type ProposalReviewAnswerValue = z.infer<typeof ProposalReviewAnswer>;

const ApprovedProposalReview = z.object({
  decision: z.literal("approve"),
  proposal: ArtifactPointer,
  reviewerId: z.string().min(1),
  submittedAt: z.string().min(1),
});

/** Why: Carries an attributable positive review bound to exact proposal bytes. Use: Submit it to the host authorizer as evidence, not as authority by itself. */
type ApprovedProposalReviewValue = z.infer<typeof ApprovedProposalReview>;

/** Why: Rejects a copied approval for different bytes before host policy is consulted. Use: Call only after the reject branch has returned. */
function requireApprovedProposalReview(
  review: HumanReviewResult<ProposalReviewAnswerValue, ProposalArtifactRef>,
  proposal: ProposalArtifactRef,
): ApprovedProposalReviewValue {
  if (review.answer.decision !== "approve") throw new Error(review.answer.note);
  if (review.subject.ref !== proposal.ref || review.subject.sha256 !== proposal.sha256) {
    throw new Error("Review did not approve the exact proposal artifact");
  }
  return {
    decision: "approve",
    proposal: { ref: proposal.ref, sha256: proposal.sha256 },
    reviewerId: review.reviewer.id,
    submittedAt: review.submittedAt,
  };
}

const ImplementationInput = z.object({
  request: ChangeRequest,
  proposal: ChangeProposal,
  authorizedPaths: z.array(z.string().min(1)).min(1),
});

const ImplementationResult = z.object({
  summary: z.string().min(1),
  changedFiles: z.array(z.string().min(1)).min(1),
  verification: z.array(z.string().min(1)),
});

const implementationPrompt = definePrompt({
  name: "implement-authorized-change",
  input: ImplementationInput,
  render: ({ request, proposal, authorizedPaths }) => [
    `Implement ${request.requestId}: ${proposal.summary}.`,
    `The engine-enforced write scope permits only:\n${authorizedPaths.map((path) => `- ${path}`).join("\n")}`,
    "Do not publish, use the network, commit, or edit outside the engine-enforced strict scope.",
  ],
});

const changeImplementer = defineAgent({
  name: "authority-test-implementer",
  description: "Edits only after host policy has reduced a reviewed proposal to a strict write grant.",
  prompt: implementationPrompt,
  schema: ImplementationResult,
  defaults: {
    provider: {
      id: "codex",
      effort: "high",
      options: { sandboxMode: "workspace-write", networkAccess: false, webSearch: "disabled" },
    },
    maxTurns: 20,
    timeout: "30m",
    repair: 1,
  },
});

const PublishSchemaInput = z.object({
  request: ProposedExternalOperation,
  schemaSha256: z.string().min(1),
  proposal: ArtifactPointer,
  review: ApprovedProposalReview,
  subject: WorkspaceSubject,
  changedFiles: z.array(z.string().min(1)).min(1),
});

const PublishSchemaResult = z.object({
  authorizationRef: z.string().min(1),
  publicationId: z.string().min(1),
  schemaSha256: z.string().min(1),
  url: z.string().url(),
});

const publishApiSchema = defineOperation({
  name: "publish-authorized-api-schema",
  description:
    "Consumes candidate-specific engine authorization before publishing one reviewed schema digest.",
  input: PublishSchemaInput,
  output: PublishSchemaResult,
  binding: "registry.api-schema.publish",
  capabilities: ["workspace:read", "network", "integration:schema-registry"],
  authorization: {
    mode: "required",
    action: "publish a reviewed API schema from the current workspace generation",
    risk: "high",
    timeout: "24h",
  },
  defaults: { timeout: "2m", attempts: 1 },
});

const AuthorityWorkflowOutput = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("rejected"),
    requestId: z.string().min(1),
    proposal: ArtifactPointer,
    reason: z.string().min(1),
  }),
  z.object({
    status: z.literal("executed"),
    requestId: z.string().min(1),
    proposal: ArtifactPointer,
    changedFiles: z.array(z.string().min(1)).min(1),
    publication: PublishSchemaResult,
  }),
]);

/** Why: Keeps every early-denial and success return narrowed to the durable output union. Use: Annotate the workflow body so literal statuses do not widen across async branches. */
type AuthorityWorkflowOutputValue = z.infer<typeof AuthorityWorkflowOutput>;

/** Why: Pressure-tests whether model advice can be kept distinct from path and operation authority. Use: Launch with a host-issued request token. */
const authorityBoundariesWorkflow = defineWorkflow(
  {
    id: "round-04-authority-boundaries",
    name: "Authority-bounded coding and external operation",
    description:
      "Reviews agent advice, asks host policy for exact write scope, then separately authorizes one external effect.",
    input: AuthorityWorkflowInput,
    output: AuthorityWorkflowOutput,
    workspace: true,
  },
  async (ctx, input): Promise<AuthorityWorkflowOutputValue> => {
    const request = await ctx.operation(resolveChangeRequest, input, {
      key: "resolve-change-request",
    });
    if (request.policyRef !== reviewedChangePaths.revision) {
      throw new Error("Change request does not target the workflow's fixed path-policy revision");
    }
    const planned = await ctx.agent({ key: "propose-change", agent: changePlanner, input: { request } });
    if (!planned.value.proposedPaths.includes(planned.value.externalOperation.schemaPath)) {
      throw new Error("The schema selected for publication must be part of the reviewed path proposal");
    }

    const proposal = await ctx.artifact(
      proposalArtifact,
      {
        content: planned.value,
        metadata: { requestId: request.requestId, policyRef: request.policyRef, workflowRunId: ctx.run.id },
      },
      { key: "capture-change-proposal" },
    );
    const review = await ctx.human.review({
      key: "review-change-proposal",
      question: "Approve submitting this exact proposal to repository policy for bounded execution?",
      subject: proposal,
      schema: ProposalReviewAnswer,
      timeout: "24h",
      onTimeout: "deny",
    });
    if (review.answer.decision === "reject") {
      return {
        status: "rejected",
        requestId: request.requestId,
        proposal: { ref: proposal.ref, sha256: proposal.sha256 },
        reason: review.answer.note,
      };
    }

    const approvedReview = requireApprovedProposalReview(review, proposal);
    const writeScope = await ctx.paths.resolve(
      reviewedChangePaths,
      { proposedPaths: planned.value.proposedPaths },
      { key: "resolve-reviewed-write-scope", label: `Resolve paths for ${request.requestId}` },
    );
    expectType<WriteScope<typeof reviewedChangePaths>>(writeScope);
    if (!writeScope.paths.includes(planned.value.externalOperation.schemaPath)) {
      throw new Error("Canonical write scope does not include the reviewed schema path");
    }

    const implementation = await ctx.agent({
      key: "implement-authorized-plan",
      agent: changeImplementer,
      input: { request, proposal: planned.value, authorizedPaths: [...writeScope.paths] },
      write: writeScope,
    });
    const schemaFile = await ctx.fs.read(planned.value.externalOperation.schemaPath);
    const subject = {
      workspaceId: ctx.workspace.id,
      generation: ctx.workspace.generation,
      treeHash: ctx.workspace.tree,
    };
    const publicationCandidate = await ctx.operation.prepare(
      publishApiSchema,
      {
        request: planned.value.externalOperation,
        schemaSha256: schemaFile.sha256,
        proposal: { ref: proposal.ref, sha256: proposal.sha256 },
        review: approvedReview,
        subject,
        changedFiles: implementation.files,
      },
      {
        key: "prepare-api-schema-publication",
        label: `Prepare ${planned.value.externalOperation.subject}`,
      },
    );
    const publicationAuthorization = await ctx.operation.authorize(publishApiSchema, publicationCandidate, {
      key: "authorize-api-schema-publication",
      label: `Authorize ${planned.value.externalOperation.subject}`,
      detail: `Publish ${planned.value.externalOperation.subject} from ${planned.value.externalOperation.schemaPath} at ${subject.treeHash}.`,
      timeout: "24h",
    });
    const publication = await ctx.operation.execute(
      publishApiSchema,
      { candidate: publicationCandidate, authorization: publicationAuthorization },
      { key: "execute-api-schema-publication", attempts: 1 },
    );
    if (
      publication.authorizationRef !== publicationAuthorization.ref ||
      publication.schemaSha256 !== schemaFile.sha256
    ) {
      throw new Error("External operation receipt does not match its consumed authorization");
    }

    return {
      status: "executed",
      requestId: request.requestId,
      proposal: { ref: proposal.ref, sha256: proposal.sha256 },
      changedFiles: implementation.files,
      publication,
    };
  },
);

declare const agentProposal: ChangeProposalValue;
declare const preparedPublication: OperationCandidateRef<typeof publishApiSchema>;
type PublishAuthorization = OperationAuthorizationRef<typeof publishApiSchema, typeof preparedPublication>;
declare const fabricatedAuthorization: {
  readonly ref: string;
  readonly candidateRef: string;
  readonly operation: string;
  readonly definitionDigest: string;
  readonly inputDigest: string;
  readonly action: string;
  readonly risk: "high";
  readonly approvedBy: "human";
  readonly approvedAt: string;
};

// @ts-expect-error Model-selected string paths lack the engine-minted grant required by WriteScope.
expectType<WriteScope<typeof reviewedChangePaths>>({ paths: agentProposal.proposedPaths, mode: "strict" });
// @ts-expect-error A structurally complete-looking object lacks nominal candidate-bound operation authority.
expectType<PublishAuthorization>(fabricatedAuthorization);
// @ts-expect-error The proposed external request is not the complete input frozen for publication.
expectType<OperationInputOf<typeof publishApiSchema>>(agentProposal.externalOperation);

expectType<WorkflowNode<"weft.workflow">>(authorityBoundariesWorkflow);

// Round 4 reimplementation: the reviewed proposal remains advice until `ctx.paths.resolve` mints a nominal,
// generation-bound write scope. Publication separately freezes exact bytes, obtains candidate-specific nominal
// authority, and executes through the protected path; neither an ordinary path array nor a grant-shaped object
// can cross those boundaries.
