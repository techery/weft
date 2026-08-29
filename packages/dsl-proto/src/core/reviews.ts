/** Declaration-only exact-subject review surface for the Weft DSL prototype. */

import type {
  AnySchema,
  EvidenceRef,
  InferIn,
  InferOut,
  SubjectAttestation,
  WorkflowNode,
  WorkspaceSubject,
} from "./shared.ts";
import type { Ctx } from "./workflow.ts";

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

/**
 * Why: Represents a reusable review strategy whose engine binding guarantees one unchanged workspace subject.
 * Use: Create it with `defineReview`, then invoke it through `ctx.review` with an exact subject.
 */
export interface ReviewDefinition<
  Input = unknown,
  Finding = unknown,
  ParsedInput = Input,
  RawFinding = Finding,
  Name extends string = string,
> extends WorkflowNode<"weft.review"> {
  readonly kind: "weft.review";
  readonly name: Name;
  readonly description?: string;
  readonly input: AnySchema;
  readonly finding: AnySchema;
  readonly evaluate: (
    ctx: Ctx<any, any, any>,
    input: ParsedInput,
  ) => Promise<ReviewEvaluation<RawFinding>> | ReviewEvaluation<RawFinding>;
  readonly accept: (evaluation: ReviewEvaluation<Finding>) => boolean;
  readonly __input?: Input;
  readonly __finding?: Finding;
}

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
    ctx: Ctx<any, any, any>,
    input: InferOut<InputSchema>,
  ) => Promise<ReviewEvaluation<InferIn<FindingSchema>>> | ReviewEvaluation<InferIn<FindingSchema>>;
  accept: (evaluation: ReviewEvaluation<InferOut<FindingSchema>>) => boolean;
}

/**
 * Why: Declares one reusable review operation while leaving reviewer implementation inside ordinary typed orchestration.
 * Use: Define it at module scope and call it through `ctx.review(definition, input, { key, subject })`.
 */
export declare function defineReview<
  InputSchema extends AnySchema,
  FindingSchema extends AnySchema,
  const Name extends string = string,
>(
  config: ReviewConfig<InputSchema, FindingSchema, Name>,
): ReviewDefinition<
  InferIn<InputSchema>,
  InferOut<FindingSchema>,
  InferOut<InputSchema>,
  InferIn<FindingSchema>,
  Name
>;

/**
 * Why: Recovers the raw schema input accepted by a review definition.
 * Use: It supplies the input side of `ctx.review` and its internal invocation.
 */
export type ReviewInputOf<Definition> =
  Definition extends ReviewDefinition<infer Input, any, any, any, any> ? Input : never;

/**
 * Why: Recovers the validated finding carried by a review definition.
 * Use: It supplies the exact assessment and result types returned from `ctx.review`.
 */
export type ReviewFindingOf<Definition> =
  Definition extends ReviewDefinition<any, infer Finding, any, any, any> ? Finding : never;

/**
 * Why: Recovers the exact definition-time review name for heterogeneous registries and audit projections.
 * Use: Apply it to a concrete `defineReview` result; broad legacy definitions continue to produce `string`.
 */
export type ReviewNameOf<Definition> =
  Definition extends ReviewDefinition<any, any, any, any, infer Name> ? Name : never;

/**
 * Why: Binds review execution to a durable key and one engine-minted workspace generation.
 * Use: Pass the current workspace, check, goal, or candidate subject; the engine rejects drift during evaluation.
 */
export interface ReviewInvocationOptions<Subject extends WorkspaceSubject = WorkspaceSubject> {
  key: string;
  label?: string;
  subject: Subject;
}

/**
 * Why: Returns a typed review verdict whose evidence cannot be detached from the generation that was reviewed.
 * Use: Branch on `status`, feed `blocking` findings into rework, and pass `attestation` into promotion preparation.
 */
export interface ReviewResult<Finding, Subject extends WorkspaceSubject = WorkspaceSubject> {
  status: "accepted" | "rework";
  subject: Subject;
  summary?: string;
  sourceEvidence: readonly EvidenceRef[];
  assessments: readonly ReviewAssessment<Finding>[];
  blocking: readonly Finding[];
  advisory: readonly Finding[];
  refuted: readonly Finding[];
  evidence: string;
  attestation: SubjectAttestation<"review", ReviewEvaluation<Finding>, Subject>;
}

/**
 * Why: Exposes exact-subject reusable review without making rework or delivery implicit.
 * Use: Call it once per candidate generation and explicitly decide whether and how to rework the result.
 */
export type ReviewFn = <
  Definition extends ReviewDefinition<any, any, any, any, any>,
  Subject extends WorkspaceSubject,
>(
  definition: Definition,
  input: ReviewInputOf<Definition>,
  options: ReviewInvocationOptions<Subject>,
) => Promise<ReviewResult<ReviewFindingOf<Definition>, Subject>>;
