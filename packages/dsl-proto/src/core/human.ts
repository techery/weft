/** Declaration-only human surface for the Weft DSL prototype. */
import type { ArtifactRefBase } from "./artifacts.ts";
import type {
  AnySchema,
  DefinitionTypeCarrier,
  Duration,
  InferIn,
  InferOut,
  WorkflowNode,
} from "./shared.ts";

// ---------------------------------------------------------------------------
// Human interaction and custom UI
// ---------------------------------------------------------------------------

/** Human timeout policy. */
export interface HumanTimeoutDefault<T> {
  default: T;
}

/** Human timeout policy. */
export type HumanTimeoutPolicy<T> = "deny" | "escalate" | HumanTimeoutDefault<T>;

/** Reviewer identity. */
export interface ReviewerIdentity {
  id: string;
  displayName?: string;
}

/** Human review file subject. */
export interface HumanReviewFileSubject {
  kind: "file";
  path: string;
  mode?: "view" | "edit";
}

/**
 * Why: Requires inline artifact content instead of accepting an empty artifact-shaped review subject.
 * Use: Select it when review material is supplied directly rather than through a workspace path.
 */
export interface HumanReviewArtifactContentSubject {
  kind: "artifact";
  content: string;
  path?: never;
  mediaType?: string;
  label?: string;
}

/**
 * Why: Requires a concrete artifact path instead of accepting an empty artifact-shaped review subject.
 * Use: Select it when the engine should snapshot review material from a workspace path.
 */
export interface HumanReviewArtifactPathSubject {
  kind: "artifact";
  path: string;
  content?: never;
  mediaType?: string;
  label?: string;
}

/**
 * Why: Makes content-backed and path-backed artifact review subjects explicit and mutually exclusive.
 * Use: Pass exactly one material source to human review subjects and attachments.
 */
export type HumanReviewArtifactSubject =
  | HumanReviewArtifactContentSubject
  | HumanReviewArtifactPathSubject;

/** Human review subject. */
export type HumanReviewSubject =
  | HumanReviewFileSubject
  | HumanReviewArtifactSubject
  | ArtifactRefBase<unknown>;
/** Human review attachment. */
export type HumanReviewAttachment = HumanReviewArtifactSubject | ArtifactRefBase<unknown>;

/** Reviewed subject. */
export interface ReviewedFileSubject {
  kind: "file";
  path: string;
  ref: string;
  beforeSha256: string;
  afterSha256: string;
  applied: boolean;
}

/** Reviewed artifact subject. */
export interface ReviewedArtifactSubject {
  kind: "artifact";
  ref: string;
  sha256: string;
  applied: false;
}

/** Reviewed subject. */
export type ReviewedSubject = ReviewedFileSubject | ReviewedArtifactSubject;

/**
 * Why: Preserves an exact immutable artifact reference through review while mapping path/content requests to engine snapshots.
 * Use: Derive the `HumanReviewResult.subject` type from the subject passed to `ctx.human.review`.
 */
export type ReviewedSubjectOf<Subject> =
  Subject extends ArtifactRefBase<unknown>
    ? Subject
    : Subject extends HumanReviewFileSubject
      ? ReviewedFileSubject
      : Subject extends HumanReviewArtifactSubject
        ? ReviewedArtifactSubject
        : never;

/**
 * Why: Keeps a review decision attributable and bound to the exact file or artifact generation observed.
 * Use: Read it from `ctx.human.review` or a human-review goal component.
 */
export interface HumanReviewResult<T, Subject = ReviewedSubject> {
  answer: T;
  reviewer: ReviewerIdentity;
  subject: Subject;
  submittedAt: string;
  waitedMs: number;
}

/** Human edit file result. */
export interface HumanEditFileResult {
  path: string;
  ref: string;
  beforeSha256: string;
  afterSha256: string;
  applied: boolean;
  editor: ReviewerIdentity;
  submittedAt: string;
  waitedMs: number;
}

/** Ui view ref. */
export interface UiViewRef<
  Props,
  Answer = never,
  Mode extends "input" | "display" = "input" | "display",
  Id extends string = string,
  Revision extends string = string,
> extends WorkflowNode<"weft.ui-view">,
    DefinitionTypeCarrier<{ props: Props; answer: Answer; mode: Mode }> {
  readonly kind: "weft.ui-view";
  readonly id: Id;
  readonly revision: Revision;
}

/** Input ui component props. */
export interface InputUiComponentProps<Props, Answer> {
  props: Props;
  propose(answer: Answer): void;
}

/** Result ui component props. */
export interface ResultUiComponentProps<Props> {
  props: Props;
}

/**
 * Why: Declares a schema-backed interactive view while leaving submission and validation under host control.
 * Use: Use it for a custom `human.ask` or `human.review` presentation.
 */
export interface UiViewConfig<
  PropsSchema extends AnySchema,
  AnswerSchema extends AnySchema,
  Id extends string = string,
  Revision extends string = string,
> {
  id: Id;
  revision?: Revision;
  props: PropsSchema;
  answer: AnswerSchema;
  component: (props: InputUiComponentProps<InferOut<PropsSchema>, InferIn<AnswerSchema>>) => unknown;
}

/**
 * Why: Declares a schema-backed interactive view while leaving submission and validation under host control.
 * Use: Use it for a custom `human.ask` or `human.review` presentation.
 */
export declare function defineUiView<
  PropsSchema extends AnySchema,
  AnswerSchema extends AnySchema,
  const Id extends string = string,
  const Revision extends string = string,
>(
  config: UiViewConfig<PropsSchema, AnswerSchema, Id, Revision>,
): UiViewRef<InferOut<PropsSchema>, InferIn<AnswerSchema>, "input", Id, Revision>;

/**
 * Why: Declares a schema-backed read-only presentation for completed workflow data.
 * Use: Pass the returned view to `ctx.ui.render` with validated props.
 */
export interface ResultViewConfig<
  PropsSchema extends AnySchema,
  Id extends string = string,
  Revision extends string = string,
> {
  id: Id;
  revision?: Revision;
  props: PropsSchema;
  component: (props: ResultUiComponentProps<InferOut<PropsSchema>>) => unknown;
}

/**
 * Why: Declares a schema-backed read-only presentation for completed workflow data.
 * Use: Pass the returned view to `ctx.ui.render` with validated props.
 */
export declare function defineResultView<
  PropsSchema extends AnySchema,
  const Id extends string = string,
  const Revision extends string = string,
>(
  config: ResultViewConfig<PropsSchema, Id, Revision>,
): UiViewRef<InferOut<PropsSchema>, never, "display", Id, Revision>;

/** Input ui binding. */
export interface InputUiBinding<Props, Answer> {
  view: UiViewRef<Props, Answer, "input">;
  props: Props;
}

/** Human ask options. */
export interface HumanAskOptions<S extends AnySchema, Props = never> {
  key: string;
  question: string;
  detail?: string;
  schema: S;
  timeout?: Duration;
  onTimeout?: HumanTimeoutPolicy<InferIn<S>>;
  ui?: InputUiBinding<Props, InferIn<S>>;
}

/** Denied approval default. */
export interface DeniedApprovalDefault {
  approved: false;
  note?: string;
}

/** Human approval timeout default. */
export interface HumanApprovalTimeoutDefault {
  default: DeniedApprovalDefault;
}

/** Human approve options. */
export interface HumanApproveOptions {
  key: string;
  action: string;
  detail?: string;
  timeout?: Duration;
  onTimeout?: "deny" | "escalate" | HumanApprovalTimeoutDefault;
}

/**
 * Why: Describes one durable human confirmation used for workflow branching without minting effect authority.
 * Use: Pass it to `ctx.human.confirm`; protected actions still require candidate-bound authorization.
 */
export interface HumanConfirmOptions {
  key: string;
  action: string;
  detail?: string;
  timeout?: Duration;
  onTimeout?: "deny" | "escalate" | HumanApprovalTimeoutDefault;
}

/** Human review options. */
export interface HumanReviewOptions<
  S extends AnySchema,
  Props = never,
  Subject extends HumanReviewSubject = HumanReviewSubject,
> {
  key: string;
  question?: string;
  subject: Subject;
  attachments?: HumanReviewAttachment[];
  schema: S;
  timeout?: Duration;
  onTimeout?: HumanTimeoutPolicy<InferIn<S>>;
  ui?: InputUiBinding<Props, InferIn<S>>;
}

/** Human edit file options. */
export interface HumanEditFileOptions {
  key: string;
  path: string;
  question?: string;
  timeout?: Duration;
  onTimeout?: "deny" | "escalate";
}

/**
 * Why: Separates typed questions, mandatory approvals, reviews, and edit-only interactions from policy gates.
 * Use: Access these operations through `ctx.human`.
 */
export interface HumanApi {
  ask<S extends AnySchema, Props = never>(opts: HumanAskOptions<S, Props>): Promise<InferOut<S>>;
  confirm(opts: HumanConfirmOptions): Promise<HumanConfirmationResult>;
  /** @deprecated Use `confirm`; a confirmation is a branching answer, not effect authority. */
  approve(opts: HumanApproveOptions): Promise<HumanApprovalResult>;
  review<S extends AnySchema, Props = never, Subject extends HumanReviewSubject = HumanReviewSubject>(
    opts: HumanReviewOptions<S, Props, Subject>,
  ): Promise<HumanReviewResult<InferOut<S>, ReviewedSubjectOf<Subject>>>;
  editFile(opts: HumanEditFileOptions): Promise<HumanEditFileResult>;
}

/** Human approval result. */
export interface HumanApprovalResult {
  approved: boolean;
  note?: string;
  reviewer: ReviewerIdentity;
}

/**
 * Why: Returns an attributable human branch answer without presenting it as reusable authorization.
 * Use: Branch on `confirmed`; operations, waivers, and deliveries require their own nominal references.
 */
export interface HumanConfirmationResult {
  readonly confirmed: boolean;
  readonly note?: string;
  readonly reviewer: ReviewerIdentity;
}

/** Ui render options. */
export interface UiRenderOptions<Props> {
  key: string;
  slot?: string;
  view: UiViewRef<Props, never, "display">;
  props: Props;
}

/** Ui api. */
export interface UiApi {
  render<Props>(opts: UiRenderOptions<Props>): Promise<void>;
}
