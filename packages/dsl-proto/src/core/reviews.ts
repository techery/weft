/** Declaration-only exact-candidate review surface for the Weft DSL prototype. */

import type {
  AnySchema,
  DefinitionTypeCarrier,
  EvidenceRef,
  InferIn,
  InferOut,
  InputOf,
  OutputOf,
  PromotionProof,
  SubjectAttestation,
  WorkflowNode,
  WorkspaceSnapshotRef,
} from "./shared.ts";
import type { ReviewCtx } from "./workflow.ts";

// ---------------------------------------------------------------------------
// Reusable review policies
// ---------------------------------------------------------------------------

/**
 * Why: Separates findings that block promotion from advice and independently refuted claims.
 * Use: Assign it to every assessment returned by a review evaluator.
 */
export type ReviewDisposition = "blocking" | "advisory" | "refuted";

/**
 * Why: Preserves one validated finding together with its review disposition and supporting rationale.
 * Use: Return it from `ReviewConfig.evaluate`; the engine validates `finding` before applying acceptance policy.
 */
export interface ReviewAssessment<Finding> {
  finding: Finding;
  disposition: ReviewDisposition;
  sources: readonly string[];
  rationale: string;
}

/**
 * Why: Gives one review invocation a strategy-neutral aggregate for fan-out, deduplication, or refutation results.
 * Use: Return it from an evaluator regardless of how its reviewer lanes were implemented.
 */
export interface ReviewEvaluation<Finding> {
  assessments: readonly ReviewAssessment<Finding>[];
  summary?: string;
  sourceEvidence?: readonly EvidenceRef[];
}

/** Hidden type relationships carried by one reusable review definition. */
export interface ReviewTypes {
  readonly input: unknown;
  readonly parsedInput: unknown;
  readonly output: unknown;
  readonly rawOutput: unknown;
  readonly result: ReviewResult<unknown>;
}

/**
 * Why: Represents a reusable review strategy whose engine binding guarantees one unchanged workspace candidate.
 * Use: Create it with `defineReview`, then invoke it through `ctx.review` with an exact candidate.
 */
export interface ReviewDefinition<
  Types extends ReviewTypes = ReviewTypes,
  Name extends string = string,
> extends WorkflowNode<"weft.review">,
    DefinitionTypeCarrier<Types> {
  readonly kind: "weft.review";
  readonly name: Name;
  readonly description?: string;
  readonly input: AnySchema;
  readonly finding: AnySchema;
}

/** Exact hidden type relationships carried by one reusable review definition. */
export type ReviewTypesOf<Definition> =
  Definition extends ReviewDefinition<infer Types, any> ? Types : never;

/**
 * Why: Declares schemas, orchestration, and pure acceptance policy without freezing one reviewer topology.
 * Use: Keep reviewer fan-out and refutation inside `evaluate`; keep rework loops in the calling workflow.
 */
export interface ReviewConfig<
  InputSchema extends AnySchema,
  FindingSchema extends AnySchema,
  Name extends string = string,
> {
  name: Name;
  description?: string;
  input: InputSchema;
  finding: FindingSchema;
  evaluate: (
    ctx: ReviewCtx,
    input: InferOut<InputSchema>,
  ) => Promise<ReviewEvaluation<InferIn<FindingSchema>>> | ReviewEvaluation<InferIn<FindingSchema>>;
  accept: (evaluation: ReviewEvaluation<InferOut<FindingSchema>>) => boolean;
}

/**
 * Why: Declares one reusable review operation while leaving reviewer implementation inside ordinary typed orchestration.
 * Use: Define it at module scope and call it through `ctx.review(definition, input, { key, candidate })`.
 */
export declare function defineReview<
  InputSchema extends AnySchema,
  FindingSchema extends AnySchema,
  const Name extends string = string,
>(
  config: ReviewConfig<InputSchema, FindingSchema, Name>,
): ReviewDefinition<
  {
    input: InferIn<InputSchema>;
    parsedInput: InferOut<InputSchema>;
    output: InferOut<FindingSchema>;
    rawOutput: InferIn<FindingSchema>;
    result: ReviewResult<InferOut<FindingSchema>>;
  },
  Name
>;

/**
 * Why: Recovers the raw schema input accepted by a review definition.
 * Use: It supplies the input side of `ctx.review` and its internal invocation.
 */
export type ReviewInputOf<Definition> =
  Definition extends ReviewDefinition<any, any> ? InputOf<Definition> : never;

/**
 * Why: Recovers the validated finding carried by a review definition.
 * Use: It supplies the exact assessment and result types returned from `ctx.review`.
 */
export type ReviewFindingOf<Definition> =
  Definition extends ReviewDefinition<any, any> ? OutputOf<Definition> : never;

/**
 * Why: Recovers the exact definition-time review name for heterogeneous registries and audit projections.
 * Use: Apply it to a concrete `defineReview` result; broad legacy definitions continue to produce `string`.
 */
export type ReviewNameOf<Definition> =
  Definition extends ReviewDefinition<any, infer Name> ? Name : never;

/**
 * Why: Binds review execution to a durable key and one engine-minted workspace generation.
 * Use: Pass the candidate being reviewed; the host verifies it before and after evaluation and rejects drift.
 */
export interface ReviewInvocationOptions<Candidate extends WorkspaceSnapshotRef = WorkspaceSnapshotRef> {
  key: string;
  label?: string;
  candidate: Candidate;
}

/**
 * Why: Carries exact-candidate findings and evidence shared by accepted and rework review branches.
 * Use: Narrow `ReviewResult.status` before accessing its promotion proof or remediation findings.
 */
export interface ReviewResultBase<Finding, Candidate extends WorkspaceSnapshotRef = WorkspaceSnapshotRef> {
  readonly candidate: Candidate;
  readonly summary?: string;
  readonly sourceEvidence: readonly EvidenceRef[];
  readonly assessments: readonly ReviewAssessment<Finding>[];
  readonly blocking: readonly Finding[];
  readonly advisory: readonly Finding[];
  readonly refuted: readonly Finding[];
  readonly evidence: string;
  readonly attestation: SubjectAttestation<"review", ReviewEvaluation<Finding>, Candidate>;
}

/**
 * Why: Mints positive promotion proof only after the review's acceptance policy succeeds for one exact candidate.
 * Use: Narrow `status === "accepted"`, then pass `proof` to verified delivery.
 */
export interface AcceptedReviewResult<Finding, Candidate extends WorkspaceSnapshotRef = WorkspaceSnapshotRef>
  extends ReviewResultBase<Finding, Candidate> {
  readonly status: "accepted";
  readonly proof: PromotionProof<"review", Candidate>;
}

/**
 * Why: Retains rework findings as evidence without allowing a negative verdict to authorize promotion.
 * Use: Narrow `status === "rework"`, feed `blocking` findings into remediation, and review a new generation.
 */
export interface ReworkReviewResult<Finding, Candidate extends WorkspaceSnapshotRef = WorkspaceSnapshotRef>
  extends ReviewResultBase<Finding, Candidate> {
  readonly status: "rework";
  readonly proof?: never;
}

/**
 * Why: Returns an exhaustive review verdict whose positive proof exists only on the accepted branch.
 * Use: Receive it from `ctx.review` and narrow on `status` before promotion or rework.
 */
export type ReviewResult<Finding, Candidate extends WorkspaceSnapshotRef = WorkspaceSnapshotRef> =
  | AcceptedReviewResult<Finding, Candidate>
  | ReworkReviewResult<Finding, Candidate>;

/**
 * Why: Exposes exact-candidate reusable review without making rework or delivery implicit.
 * Use: Call it once per candidate generation and explicitly decide whether and how to rework the result.
 */
export type ReviewFn = <
  Definition extends ReviewDefinition<any, any>,
  Candidate extends WorkspaceSnapshotRef,
>(
  definition: Definition,
  input: ReviewInputOf<Definition>,
  options: ReviewInvocationOptions<Candidate>,
) => Promise<ReviewResult<ReviewFindingOf<Definition>, Candidate>>;
