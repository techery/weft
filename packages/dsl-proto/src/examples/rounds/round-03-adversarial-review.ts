import {
  type ArtifactRefOf,
  defineAgent,
  defineArtifact,
  defineCheck,
  defineCheckSuite,
  defineGoal,
  definePathPolicy,
  definePrompt,
  defineRecipe,
  defineWorkflow,
  type Provider,
  type WorkspaceSnapshotRef,
  z,
} from "../../index.ts";

// This round models review as a reusable recipe over an immutable workspace
// subject. Only the outer workflow can mutate the workflow-owned workspace.

const WorkspaceSubjectSchema = z.object({
  workspaceId: z.string().min(1),
  generation: z.number().int().nonnegative(),
  treeHash: z.string().min(1),
});

const adversarialReviewWritePolicy = definePathPolicy({
  name: "round-03-adversarial-review-writes",
  description: "Restricts each implementation round to canonical caller-proposed repository paths.",
  revision: "v1",
  roots: ["."],
  deny: [".git/**", ".weft/**"],
  grantTtl: "2h",
});

/**
 * Why: Gives schemas and deterministic guards a serializable view of the engine-minted workspace subject.
 * Use: Bind every reviewer, refuter, decision, and evidence artifact to one exact tree generation.
 */
type WorkspaceSubjectValue = z.infer<typeof WorkspaceSubjectSchema>;

const ReviewTargetSchema = z.object({
  branch: z.string().min(1),
  base: z.string().min(1),
  head: z.string().min(1),
  subject: WorkspaceSubjectSchema,
});

/**
 * Why: Prevents a review result from floating independently of the branch, commit, and tree it evaluated.
 * Use: Pass the same target through review input, result, artifact content, and post-review freshness checks.
 */
type ReviewTargetValue = z.infer<typeof ReviewTargetSchema>;

const ReviewLensSchema = z.enum(["correctness", "security", "testability"]);

/**
 * Why: Restricts review coverage to known perspectives that can be checked deterministically.
 * Use: Name reviewer lanes and acceptance-policy requirements.
 */
type ReviewLensValue = z.infer<typeof ReviewLensSchema>;

const FindingSeveritySchema = z.enum(["low", "medium", "high", "critical"]);

/**
 * Why: Gives the acceptance policy a closed severity vocabulary.
 * Use: Decide which non-refuted findings block another implementation round.
 */
type FindingSeverityValue = z.infer<typeof FindingSeveritySchema>;

const FileFindingLocationSchema = z.object({
  kind: z.literal("file"),
  path: z.string().min(1),
  line: z.number().int().positive().optional(),
});

const RepositoryFindingLocationSchema = z.object({
  kind: z.literal("repository"),
  area: z.string().min(1),
});

const FindingLocationSchema = z.discriminatedUnion("kind", [
  FileFindingLocationSchema,
  RepositoryFindingLocationSchema,
]);

const ReviewFindingSchema = z.object({
  id: z.string().min(1),
  category: z.enum(["behavior", "security", "reliability", "tests", "maintainability"]),
  severity: FindingSeveritySchema,
  blocking: z.boolean(),
  title: z.string().min(1),
  claim: z.string().min(1),
  evidence: z.string().min(1),
  remediation: z.string().min(1),
  location: FindingLocationSchema,
});

/**
 * Why: Carries a review observation as validated domain data rather than prose embedded in orchestration.
 * Use: Preserve it unchanged through candidate collection, clustering, refutation, rework, and evidence capture.
 */
type ReviewFindingValue = z.infer<typeof ReviewFindingSchema>;

const ReviewerInputSchema = z.object({
  target: ReviewTargetSchema,
  lens: ReviewLensSchema,
  acceptanceCriteria: z.array(z.string().min(1)).min(1),
});

const ReviewerResultSchema = z.object({
  lens: ReviewLensSchema,
  summary: z.string().min(1),
  findings: z.array(ReviewFindingSchema),
});

/**
 * Why: Keeps one reviewer's complete typed output independently inspectable.
 * Use: Require exactly one result for every configured lens before deduplication.
 */
type ReviewerResultValue = z.infer<typeof ReviewerResultSchema>;

const CandidateFindingSchema = z.object({
  sourceId: z.string().min(1),
  lens: ReviewLensSchema,
  finding: ReviewFindingSchema,
});

/**
 * Why: Adds collision-resistant orchestration identity without asking agents to coordinate finding IDs.
 * Use: Build `lens:id` source IDs before the deduplicator partitions the raw candidates.
 */
type CandidateFindingValue = z.infer<typeof CandidateFindingSchema>;

const DeduplicationInputSchema = z.object({
  target: ReviewTargetSchema,
  candidates: z.array(CandidateFindingSchema).min(1),
});

const FindingClusterProposalSchema = z.object({
  canonicalSourceId: z.string().min(1),
  sourceIds: z.array(z.string().min(1)).min(1),
  rationale: z.string().min(1),
});

/**
 * Why: Lets a model propose semantic equivalence while keeping membership mechanically auditable.
 * Use: Validate that proposals form an exact partition and reference an original canonical finding.
 */
type FindingClusterProposalValue = z.infer<typeof FindingClusterProposalSchema>;

const DeduplicationResultSchema = z.object({
  clusters: z.array(FindingClusterProposalSchema),
});

const FindingClusterSchema = z.object({
  canonicalSourceId: z.string().min(1),
  canonical: ReviewFindingSchema,
  sourceIds: z.array(z.string().min(1)).min(1),
  sourceLenses: z.array(ReviewLensSchema).min(1),
  rationale: z.string().min(1),
});

/**
 * Why: Materializes an agent-proposed cluster using only original, schema-validated findings.
 * Use: Give refuters one canonical claim plus all independent sources that reported it.
 */
type FindingClusterValue = z.infer<typeof FindingClusterSchema>;

const RefutationInputSchema = z.object({
  target: ReviewTargetSchema,
  acceptanceCriteria: z.array(z.string().min(1)).min(1),
  cluster: FindingClusterSchema,
});

const RefutationResultSchema = z.object({
  canonicalSourceId: z.string().min(1),
  disposition: z.enum(["confirmed", "refuted", "uncertain"]),
  confidence: z.number().min(0).max(1),
  reason: z.string().min(1),
  evidence: z.string().min(1),
});

/**
 * Why: Separates adversarial challenge from the original reviewers' claims.
 * Use: Clear a policy-blocking finding only when an independent refuter rejects it with enough confidence.
 */
type RefutationResultValue = z.infer<typeof RefutationResultSchema>;

const ReviewAcceptancePolicySchema = z.object({
  maxRounds: z.number().int().min(1).max(5),
  requiredLenses: z.array(ReviewLensSchema).min(1),
  blockingSeverities: z.array(FindingSeveritySchema).min(1),
  minimumRefutationConfidenceToClear: z.number().min(0).max(1),
  failClosed: z.literal(true),
});

/**
 * Why: Makes review acceptance deterministic, bounded, and visible as evidence instead of leaving it to a model.
 * Use: Configure required coverage, blocking severity, refutation strength, and the maximum rework rounds.
 */
type ReviewAcceptancePolicyValue = z.infer<typeof ReviewAcceptancePolicySchema>;

const ReviewDecisionSchema = z.object({
  status: z.enum(["accepted", "rework"]),
  blockingCanonicalSourceIds: z.array(z.string().min(1)),
  advisoryCanonicalSourceIds: z.array(z.string().min(1)),
  reasons: z.array(z.string().min(1)),
});

/**
 * Why: Records the deterministic consequence of the configured acceptance policy.
 * Use: Stop on acceptance or pass the blocking items into the next bounded implementation round.
 */
type ReviewDecisionValue = z.infer<typeof ReviewDecisionSchema>;

const BlockingFindingSchema = z.object({
  canonicalSourceId: z.string().min(1),
  finding: ReviewFindingSchema,
});

/**
 * Why: Preserves the accepted cluster identity when a canonical finding becomes rework input.
 * Use: Require the implementation agent to acknowledge every blocker without depending on local finding IDs.
 */
type BlockingFindingValue = z.infer<typeof BlockingFindingSchema>;

const ArtifactPointerSchema = z.object({
  ref: z.string().min(1),
  sha256: z.string().min(1),
});

/**
 * Why: Keeps immutable evidence identity compact in workflow output while preserving content integrity.
 * Use: Return each round's artifact reference and digest to downstream reporting or delivery workflows.
 */
type ArtifactPointerValue = z.infer<typeof ArtifactPointerSchema>;

const ReviewRoundInputSchema = z.object({
  round: z.number().int().positive(),
  target: ReviewTargetSchema,
  acceptanceCriteria: z.array(z.string().min(1)).min(1),
  policy: ReviewAcceptancePolicySchema,
});

const ReviewRoundOutputSchema = z.object({
  target: ReviewTargetSchema,
  decision: ReviewDecisionSchema,
  blocking: z.array(BlockingFindingSchema),
  evidence: ArtifactPointerSchema,
});

const ReviewRoundEvidenceSchema = z.object({
  round: z.number().int().positive(),
  target: ReviewTargetSchema,
  acceptanceCriteria: z.array(z.string().min(1)).min(1),
  policy: ReviewAcceptancePolicySchema,
  reviews: z.array(ReviewerResultSchema),
  candidates: z.array(CandidateFindingSchema),
  clusters: z.array(FindingClusterSchema),
  refutations: z.array(RefutationResultSchema),
  decision: ReviewDecisionSchema,
});

const ReviewRoundEvidenceMetadataSchema = z.object({
  runId: z.string().min(1),
  branch: z.string().min(1),
  head: z.string().min(1),
  subject: WorkspaceSubjectSchema,
  recordedAt: z.number(),
});

const reviewRoundEvidence = defineArtifact({
  name: "adversarial-review-round",
  mediaType: "application/json",
  extension: ".json",
  content: ReviewRoundEvidenceSchema,
  metadata: ReviewRoundEvidenceMetadataSchema,
});

/**
 * Why: Names the exact artifact reference returned by the review recipe for compile-time verification.
 * Use: Ensure evidence pointers are derived from the artifact definition rather than reconstructed manually.
 */
type ReviewRoundEvidenceRef = ArtifactRefOf<typeof reviewRoundEvidence>;

/**
 * Why: Makes declaration-only type assertions visible without introducing executable test support.
 * Use: Pass inferred DSL values to prove that definitions preserve exact result types.
 */
declare function expectType<T>(value: T): void;

const reviewerPrompt = definePrompt({
  name: "adversarial-code-review",
  input: ReviewerInputSchema,
  render: ({ target, lens, acceptanceCriteria }) => [
    `Review only ${target.head} on ${target.branch} using the ${lens} lens.`,
    `The exact engine-observed tree is ${target.subject.treeHash} at generation ${target.subject.generation}.`,
    `Compare against ${target.base}. Do not edit files or review a newer workspace state.`,
    `Acceptance criteria:\n${acceptanceCriteria.map((criterion) => `- ${criterion}`).join("\n")}`,
    "Return only repository-supported findings with precise evidence and a stable local ID.",
  ],
});

const codeReviewer = defineAgent({
  name: "adversarial-code-reviewer",
  description: "Inspects one immutable candidate through one narrow review lens without write authority.",
  prompt: reviewerPrompt,
  schema: ReviewerResultSchema,
  defaults: { maxTurns: 12, timeout: "20m" },
});

const deduplicatorPrompt = definePrompt({
  name: "deduplicate-review-findings",
  input: DeduplicationInputSchema,
  render: ({ target, candidates }) => [
    `Partition ${candidates.length} findings for exact tree ${target.subject.treeHash}.`,
    "Every sourceId must occur exactly once. Do not add, remove, merge unrelated, or rewrite findings.",
    "Choose canonicalSourceId from its own cluster and group only claims with the same cause and remedy.",
    JSON.stringify(candidates),
  ],
});

const findingDeduplicator = defineAgent({
  name: "review-finding-deduplicator",
  description: "Proposes semantic clusters whose exact membership is checked by deterministic workflow code.",
  prompt: deduplicatorPrompt,
  schema: DeduplicationResultSchema,
  defaults: {
    provider: {
      id: "codex",
      effort: "high",
      options: { sandboxMode: "read-only", networkAccess: false, webSearch: "disabled" },
    },
    maxTurns: 8,
    timeout: "10m",
  },
});

const refuterPrompt = definePrompt({
  name: "refute-clustered-review-finding",
  input: RefutationInputSchema,
  render: ({ target, acceptanceCriteria, cluster }) => [
    `Try to disprove ${cluster.canonicalSourceId} against exact tree ${target.subject.treeHash}.`,
    `Claim: ${cluster.canonical.claim}`,
    `Reported by: ${cluster.sourceLenses.join(", ")}`,
    `Acceptance criteria:\n${acceptanceCriteria.map((criterion) => `- ${criterion}`).join("\n")}`,
    "Use repository evidence. Return uncertain instead of guessing; never edit the workspace.",
  ],
});

const findingRefuter = defineAgent({
  name: "adversarial-finding-refuter",
  description: "Challenges one canonical finding with a provider independent from its canonical reviewer.",
  prompt: refuterPrompt,
  schema: RefutationResultSchema,
  defaults: { maxTurns: 10, timeout: "15m" },
});

const codexReadOnlyProvider = {
  id: "codex",
  model: "gpt-5.6-sol",
  effort: "high",
  options: { sandboxMode: "read-only", networkAccess: false, webSearch: "disabled" },
} satisfies Provider;

const claudeReadOnlyProvider = {
  id: "claude",
  model: "sonnet",
  effort: "high",
  options: { permissionMode: "dontAsk" },
} satisfies Provider;

/**
 * Why: Couples a required perspective to stable replay identity and a concrete read-only provider route.
 * Use: Fan all lanes over the same review target and reject missing or mislabeled results.
 */
interface ReviewLane {
  key: string;
  lens: ReviewLensValue;
  provider: Provider;
}

const reviewLanes = [
  { key: "correctness", lens: "correctness", provider: claudeReadOnlyProvider },
  { key: "security", lens: "security", provider: codexReadOnlyProvider },
  { key: "testability", lens: "testability", provider: claudeReadOnlyProvider },
] satisfies readonly ReviewLane[];

const reviewPolicy = {
  maxRounds: 3,
  requiredLenses: ["correctness", "security", "testability"],
  blockingSeverities: ["high", "critical"],
  minimumRefutationConfidenceToClear: 0.85,
  failClosed: true,
} satisfies ReviewAcceptancePolicyValue;

/**
 * Why: Converts the nominal engine subject into schema-backed evidence without pretending workflows can mint it.
 * Use: Snapshot `ctx.workspace.subject` immediately after each candidate commit.
 */
function serializeSubject(subject: WorkspaceSnapshotRef): WorkspaceSubjectValue {
  return {
    workspaceId: subject.workspaceId,
    generation: subject.generation,
    treeHash: subject.treeHash,
  };
}

/**
 * Why: Ensures policy coverage and configured reviewer lanes cannot silently drift apart.
 * Use: Validate a reusable review invocation before launching any expensive reviewer sessions.
 */
function assertConfiguredCoverage(policy: ReviewAcceptancePolicyValue): void {
  const configured = new Set(reviewLanes.map((lane) => lane.lens));
  const required = new Set(policy.requiredLenses);
  if (configured.size !== reviewLanes.length || required.size !== policy.requiredLenses.length) {
    throw new Error("Review lenses must be unique");
  }
  if (configured.size !== required.size || [...configured].some((lens) => !required.has(lens))) {
    throw new Error("Acceptance policy must require exactly the configured review lenses");
  }
}

/**
 * Why: Rejects a reviewer that reports under another lane's identity or omits required coverage.
 * Use: Check settled reviewer values before treating their findings as candidates.
 */
function assertReviewCoverage(
  reviews: readonly ReviewerResultValue[],
  requiredLenses: readonly ReviewLensValue[],
): void {
  const seen = new Set<ReviewLensValue>();
  for (const review of reviews) {
    if (seen.has(review.lens)) throw new Error(`Duplicate review result for ${review.lens}`);
    seen.add(review.lens);
  }
  const missing = requiredLenses.find((lens) => !seen.has(lens));
  if (missing !== undefined) throw new Error(`Missing required ${missing} review`);
}

/**
 * Why: Names raw findings globally without trusting model-generated IDs to be unique across reviewers.
 * Use: Convert reviewer results before asking the semantic deduplicator to partition them.
 */
function collectCandidates(reviews: readonly ReviewerResultValue[]): CandidateFindingValue[] {
  const candidates: CandidateFindingValue[] = [];
  const sourceIds = new Set<string>();

  for (const review of reviews) {
    for (const finding of review.findings) {
      const sourceId = `${review.lens}:${finding.id}`;
      if (sourceIds.has(sourceId)) throw new Error(`Duplicate finding ID ${sourceId}`);
      sourceIds.add(sourceId);
      candidates.push({ sourceId, lens: review.lens, finding });
    }
  }

  return candidates;
}

/**
 * Why: Prevents the model-assisted deduplication step from dropping, inventing, or multiply assigning findings.
 * Use: Turn an exact partition proposal into clusters that retain original finding values.
 */
function materializeClusters(
  candidates: readonly CandidateFindingValue[],
  proposals: readonly FindingClusterProposalValue[],
): FindingClusterValue[] {
  const candidateById = new Map(candidates.map((candidate) => [candidate.sourceId, candidate]));
  const assigned = new Set<string>();

  const clusters = proposals.map((proposal): FindingClusterValue => {
    if (!proposal.sourceIds.includes(proposal.canonicalSourceId)) {
      throw new Error(`Canonical source ${proposal.canonicalSourceId} is not in its cluster`);
    }

    const members = proposal.sourceIds.map((sourceId) => {
      const candidate = candidateById.get(sourceId);
      if (candidate === undefined) throw new Error(`Deduplicator invented source ${sourceId}`);
      if (assigned.has(sourceId)) throw new Error(`Deduplicator assigned ${sourceId} more than once`);
      assigned.add(sourceId);
      return candidate;
    });
    const canonical = candidateById.get(proposal.canonicalSourceId);
    if (canonical === undefined) {
      throw new Error(`Deduplicator invented canonical source ${proposal.canonicalSourceId}`);
    }

    return {
      canonicalSourceId: proposal.canonicalSourceId,
      canonical: canonical.finding,
      sourceIds: proposal.sourceIds,
      sourceLenses: [...new Set(members.map((member) => member.lens))],
      rationale: proposal.rationale,
    };
  });

  const omitted = candidates.find((candidate) => !assigned.has(candidate.sourceId));
  if (omitted !== undefined) throw new Error(`Deduplicator omitted source ${omitted.sourceId}`);
  return clusters;
}

/**
 * Why: Keeps the challenge model independent from the provider that supplied the canonical claim.
 * Use: Route Codex findings to Claude and Claude findings to Codex for refutation.
 */
function refutationProviderFor(cluster: FindingClusterValue): Provider {
  const canonicalLens = cluster.canonicalSourceId.split(":", 1)[0];
  const lane = reviewLanes.find((candidate) => candidate.lens === canonicalLens);
  if (lane === undefined) throw new Error(`Unknown canonical review lane ${canonicalLens}`);
  return lane.provider.id === "codex" ? claudeReadOnlyProvider : codexReadOnlyProvider;
}

/**
 * Why: Applies the acceptance policy without allowing a reviewer, deduplicator, or refuter to accept its own work.
 * Use: Clear a blocking claim only after a high-confidence refutation; uncertainty remains fail-closed.
 */
function evaluateReview(
  policy: ReviewAcceptancePolicyValue,
  clusters: readonly FindingClusterValue[],
  refutations: readonly RefutationResultValue[],
): ReviewDecisionValue {
  const refutationById = new Map<string, RefutationResultValue>();
  for (const refutation of refutations) {
    if (refutationById.has(refutation.canonicalSourceId)) {
      throw new Error(`Duplicate refutation for ${refutation.canonicalSourceId}`);
    }
    refutationById.set(refutation.canonicalSourceId, refutation);
  }

  const blockingSeverities = new Set<FindingSeverityValue>(policy.blockingSeverities);
  const blockingCanonicalSourceIds: string[] = [];
  const advisoryCanonicalSourceIds: string[] = [];
  const reasons: string[] = [];

  for (const cluster of clusters) {
    const refutation = refutationById.get(cluster.canonicalSourceId);
    if (refutation === undefined) throw new Error(`Missing refutation for ${cluster.canonicalSourceId}`);
    const policyBlocking = isPolicyBlocking(cluster.canonical, blockingSeverities);
    const confidentlyCleared =
      refutation.disposition === "refuted" &&
      refutation.confidence >= policy.minimumRefutationConfidenceToClear;

    if (policyBlocking && !confidentlyCleared) {
      blockingCanonicalSourceIds.push(cluster.canonicalSourceId);
      reasons.push(`${cluster.canonicalSourceId} remains blocking: ${refutation.reason}`);
    } else {
      advisoryCanonicalSourceIds.push(cluster.canonicalSourceId);
    }
  }

  if (refutationById.size !== clusters.length) {
    throw new Error("Refutation output contains a finding outside the materialized clusters");
  }

  return {
    status: blockingCanonicalSourceIds.length === 0 ? "accepted" : "rework",
    blockingCanonicalSourceIds,
    advisoryCanonicalSourceIds,
    reasons,
  };
}

/**
 * Why: Keeps severity policy separate from adversarial evidence and model-authored blocking labels.
 * Use: Determine whether a canonical typed finding needs a confident refutation before it can be cleared.
 */
function isPolicyBlocking(
  finding: ReviewFindingValue,
  blockingSeverities: ReadonlySet<FindingSeverityValue>,
): boolean {
  return finding.blocking || blockingSeverities.has(finding.severity);
}

/**
 * Why: Carries only canonical policy blockers into the next writer invocation.
 * Use: Convert decision IDs back to their original typed findings after acceptance evaluation.
 */
function collectBlockingFindings(
  decision: ReviewDecisionValue,
  clusters: readonly FindingClusterValue[],
): BlockingFindingValue[] {
  const clusterById = new Map(clusters.map((cluster) => [cluster.canonicalSourceId, cluster]));
  return decision.blockingCanonicalSourceIds.map((canonicalSourceId) => {
    const cluster = clusterById.get(canonicalSourceId);
    if (cluster === undefined) throw new Error(`Decision references unknown cluster ${canonicalSourceId}`);
    return { canonicalSourceId, finding: cluster.canonical };
  });
}

/**
 * Why: Detects any workspace movement between snapshot capture and acceptance of review evidence.
 * Use: Run after the review recipe and before an accepted result can leave the workflow.
 */
function assertTargetStillCurrent(
  target: ReviewTargetValue,
  subject: WorkspaceSnapshotRef,
  branch: string,
  head: string,
): void {
  if (
    target.branch !== branch ||
    target.head !== head ||
    target.subject.workspaceId !== subject.workspaceId ||
    target.subject.generation !== subject.generation ||
    target.subject.treeHash !== subject.treeHash
  ) {
    throw new Error("Workspace changed while adversarial review was in progress");
  }
}

const adversarialReviewRound = defineRecipe({
  name: "adversarial-review-round",
  description:
    "Runs complete multi-lens review, exact deduplication, independent refutation, and acceptance.",
  input: ReviewRoundInputSchema,
  output: ReviewRoundOutputSchema,
  run: async (ctx, input) => {
    assertConfiguredCoverage(input.policy);

    const reviews = ctx.all(
      await ctx.parallel(
        reviewLanes,
        async (lane): Promise<ReviewerResultValue> => {
          const review = await ctx.agent({
            key: `review:${input.round}:${lane.key}`,
            agent: codeReviewer,
            input: {
              target: input.target,
              lens: lane.lens,
              acceptanceCriteria: input.acceptanceCriteria,
            },
            provider: lane.provider,
            providerRequirements: { structured: "native" },
          });
          if (review.value.lens !== lane.lens) {
            throw new Error(`${lane.lens} reviewer returned ${review.value.lens} output`);
          }
          return review.value;
        },
        {
          key: `reviews:${input.round}`,
          keyOf: (lane) => lane.key,
          concurrency: reviewLanes.length,
          errors: "throw",
        },
      ),
    );
    assertReviewCoverage(reviews, input.policy.requiredLenses);
    const candidates = collectCandidates(reviews);

    let proposals: FindingClusterProposalValue[] = [];
    if (candidates.length > 0) {
      const deduplication = await ctx.agent({
        key: `deduplicate:${input.round}`,
        agent: findingDeduplicator,
        input: { target: input.target, candidates },
        providerRequirements: { structured: "native" },
      });
      proposals = deduplication.value.clusters;
    }
    const clusters = materializeClusters(candidates, proposals);

    const refutations = ctx.all(
      await ctx.parallel(
        clusters,
        async (cluster): Promise<RefutationResultValue> => {
          const refutation = await ctx.agent({
            key: `refute:${input.round}:${cluster.canonicalSourceId}`,
            agent: findingRefuter,
            input: {
              target: input.target,
              acceptanceCriteria: input.acceptanceCriteria,
              cluster,
            },
            provider: refutationProviderFor(cluster),
            providerRequirements: { structured: "native" },
          });
          if (refutation.value.canonicalSourceId !== cluster.canonicalSourceId) {
            throw new Error(`Refuter changed canonical identity ${cluster.canonicalSourceId}`);
          }
          return refutation.value;
        },
        {
          key: `refutations:${input.round}`,
          keyOf: (cluster) => cluster.canonicalSourceId,
          concurrency: 4,
          errors: "throw",
        },
      ),
    );

    const decision = evaluateReview(input.policy, clusters, refutations);
    const blocking = collectBlockingFindings(decision, clusters);
    const recordedAt = await ctx.now();
    const evidence = await ctx.artifact(
      reviewRoundEvidence,
      {
        content: {
          round: input.round,
          target: input.target,
          acceptanceCriteria: input.acceptanceCriteria,
          policy: input.policy,
          reviews,
          candidates,
          clusters,
          refutations,
          decision,
        },
        metadata: {
          runId: ctx.run.id,
          branch: input.target.branch,
          head: input.target.head,
          subject: input.target.subject,
          recordedAt,
        },
      },
      { key: `review-evidence:${input.round}`, label: `Adversarial review round ${input.round}` },
    );
    expectType<ReviewRoundEvidenceRef>(evidence);

    return {
      target: input.target,
      decision,
      blocking,
      evidence: { ref: evidence.ref, sha256: evidence.sha256 },
    };
  },
});

const ImplementationInputSchema = z.object({
  mode: z.enum(["initial", "rework"]),
  round: z.number().int().positive(),
  ticket: z.string().min(1),
  title: z.string().min(1),
  acceptanceCriteria: z.array(z.string().min(1)).min(1),
  allowedPaths: z.array(z.string().min(1)).min(1),
  blockers: z.array(BlockingFindingSchema),
});

const ImplementationResultSchema = z.object({
  summary: z.string().min(1),
  addressedCanonicalSourceIds: z.array(z.string().min(1)),
  testsAddedOrUpdated: z.array(z.string()),
  residualRisks: z.array(z.string()),
});

const implementationPrompt = definePrompt({
  name: "implement-adversarially-reviewed-change",
  input: ImplementationInputSchema,
  render: ({ mode, ticket, title, acceptanceCriteria, allowedPaths, blockers }) => [
    `${mode === "initial" ? "Implement" : "Rework"} ${ticket}: ${title}.`,
    `Authorized paths:\n${allowedPaths.map((path) => `- ${path}`).join("\n")}`,
    `Acceptance criteria:\n${acceptanceCriteria.map((criterion) => `- ${criterion}`).join("\n")}`,
    blockers.length === 0
      ? "This is the initial implementation. Add focused regression coverage."
      : `Resolve every confirmed blocker:\n${blockers
          .map((blocker) => `- ${blocker.canonicalSourceId}: ${blocker.finding.claim}`)
          .join("\n")}`,
    "Do not commit, publish, weaken checks, or edit outside the strict write scope.",
  ],
});

const implementationAgent = defineAgent({
  name: "bounded-review-rework-implementer",
  description: "Implements or reworks only policy-confirmed findings inside a workflow-owned workspace.",
  prompt: implementationPrompt,
  schema: ImplementationResultSchema,
  defaults: {
    provider: {
      id: "codex",
      model: "gpt-5.6-sol",
      effort: "high",
      options: { sandboxMode: "workspace-write", networkAccess: false, webSearch: "disabled" },
    },
    maxTurns: 24,
    timeout: "40m",
    repair: 1,
  },
});

const CandidateQualityInputSchema = z.object({
  packageFilter: z.string().min(1),
});

const candidateTypecheck = defineCheck({
  name: "adversarial-review-typecheck",
  description: "Typechecks the exact candidate workspace before model review.",
  input: CandidateQualityInputSchema,
  command: ({ packageFilter }) => ["pnpm", "--filter", packageFilter, "typecheck"],
  policy: "required",
  defaults: { timeout: "10m" },
});

const candidateTests = defineCheck({
  name: "adversarial-review-tests",
  description: "Runs focused package tests on the exact candidate workspace before model review.",
  input: CandidateQualityInputSchema,
  command: ({ packageFilter }) => ["pnpm", "--filter", packageFilter, "test"],
  policy: "required",
  defaults: { timeout: "20m" },
});

const candidateQuality = defineCheckSuite({
  name: "adversarial-review-candidate-quality",
  input: CandidateQualityInputSchema,
  checks: (input, use) => ({
    typecheck: use(candidateTypecheck, input),
    tests: use(candidateTests, input),
  }),
  concurrency: 2,
});

const candidateGoal = defineGoal({
  name: "adversarial-review-candidate-ready",
  check: candidateQuality,
  defaults: { attempts: 2 },
});

/**
 * Why: Rejects a rework response that silently ignores a policy blocker even though later review remains authoritative.
 * Use: Check the writer's acknowledgement before committing and launching a fresh independent review.
 */
function assertBlockersAcknowledged(
  blockers: readonly BlockingFindingValue[],
  addressedCanonicalSourceIds: readonly string[],
): void {
  const addressed = new Set(addressedCanonicalSourceIds);
  const missing = blockers.find((blocker) => !addressed.has(blocker.canonicalSourceId));
  if (missing !== undefined) {
    throw new Error(`Implementation did not address ${missing.canonicalSourceId}`);
  }
}

const WorkflowInputSchema = z.object({
  ticket: z.string().min(1),
  title: z.string().min(1),
  base: z.string().min(1),
  branch: z.string().min(1),
  packageFilter: z.string().min(1),
  allowedPaths: z.array(z.string().min(1)).min(1),
  acceptanceCriteria: z.array(z.string().min(1)).min(1),
});

const WorkflowOutputSchema = z.object({
  branch: z.string().min(1),
  head: z.string().min(1),
  subject: WorkspaceSubjectSchema,
  rounds: z.number().int().positive(),
  changedFiles: z.array(z.string().min(1)),
  reviewEvidence: z.array(ArtifactPointerSchema).min(1),
});

/**
 * Why: Demonstrates reusable adversarial review without adding a dedicated review primitive to the current DSL.
 * Use: Launch it for a bounded coding change that must satisfy deterministic policy on an exact workspace snapshot.
 */
defineWorkflow(
  {
    id: "round-03-adversarial-review",
    name: "Adversarial review with bounded rework",
    description:
      "Implements, verifies, reviews through independent lenses, refutes findings, and reworks at most three times.",
    input: WorkflowInputSchema,
    output: WorkflowOutputSchema,
    workspace: ({ input }) => ({ branch: input.branch, from: input.base }),
  },
  async (ctx, input) => {
    const reviewEvidence: ArtifactPointerValue[] = [];
    const changedFiles = new Set<string>();
    let blockers: BlockingFindingValue[] = [];

    for (let round = 1; round <= reviewPolicy.maxRounds; round += 1) {
      const implementation = await ctx.phase(`Implementation round ${round}`, async (phase) => {
        const writeScope = await phase.paths.resolve(
          adversarialReviewWritePolicy,
          { proposedPaths: input.allowedPaths },
          { key: `resolve-implementation-write-paths:${round}` },
        );
        return phase.agent({
          key: `implementation:${round}`,
          label: round === 1 ? `Implement ${input.ticket}` : `Resolve review round ${round - 1}`,
          agent: implementationAgent,
          input: {
            mode: round === 1 ? "initial" : "rework",
            round,
            ticket: input.ticket,
            title: input.title,
            acceptanceCriteria: input.acceptanceCriteria,
            allowedPaths: input.allowedPaths,
            blockers,
          },
          write: writeScope,
          goal: {
            definition: candidateGoal,
            input: { packageFilter: input.packageFilter },
            attempts: 2,
          },
        });
      });
      assertBlockersAcknowledged(blockers, implementation.value.addressedCanonicalSourceIds);
      if (implementation.files.length === 0) {
        throw new Error(`Implementation round ${round} produced no reviewable changes`);
      }
      for (const file of implementation.files) changedFiles.add(file);

      await ctx.git.add({ paths: implementation.files });
      const commit = await ctx.git.commit({
        message: round === 1 ? `feat: ${input.title}` : `fix: address review round ${round - 1}`,
        paths: implementation.files,
      });
      const target: ReviewTargetValue = {
        branch: ctx.workspace.branch,
        base: input.base,
        head: commit.sha,
        subject: serializeSubject(ctx.workspace.subject),
      };

      const review = await ctx.phase(`Adversarial review round ${round}`, (phase) =>
        phase.recipe(adversarialReviewRound, {
          round,
          target,
          acceptanceCriteria: input.acceptanceCriteria,
          policy: reviewPolicy,
        }),
      );
      reviewEvidence.push(review.evidence);

      const currentHead = await ctx.git.head();
      assertTargetStillCurrent(review.target, ctx.workspace.subject, ctx.workspace.branch, currentHead.sha);
      if (review.decision.status === "accepted") {
        await ctx.note({
          kind: "claim",
          text: `Accepted ${currentHead.sha} after ${round} adversarial review round(s).`,
          evidence: review.evidence.ref,
        });
        return {
          branch: ctx.workspace.branch,
          head: currentHead.sha,
          subject: serializeSubject(ctx.workspace.subject),
          rounds: round,
          changedFiles: [...changedFiles],
          reviewEvidence,
        };
      }

      blockers = review.blocking;
      if (round === reviewPolicy.maxRounds) {
        await ctx.note({
          kind: "risk",
          text: `Stopped with ${blockers.length} policy blocker(s) after ${round} rounds.`,
          evidence: review.evidence.ref,
        });
        throw new Error("Adversarial review did not accept the candidate within the rework bound");
      }
    }

    throw new Error("Review loop exhausted without an acceptance decision");
  },
);
