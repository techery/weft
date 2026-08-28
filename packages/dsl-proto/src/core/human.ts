/** Declaration-only human surface for the Weft DSL prototype. */
import type { AnySchema, Duration, InferIn, InferOut, WorkflowNode } from "./shared.ts";

// ---------------------------------------------------------------------------
// Human interaction and custom UI
// ---------------------------------------------------------------------------

/**
 * Why: Gives the human DSL an explicit human timeout policy contract instead of relying on untyped values.
 * Use: Import it when declaring, configuring, or consuming the corresponding human API.
 */
export interface HumanTimeoutDefault<T> {
  default: T;
}

/**
 * Why: Gives the human DSL an explicit human timeout policy contract instead of relying on untyped values.
 * Use: Import it when declaring, configuring, or consuming the corresponding human API.
 */
export type HumanTimeoutPolicy<T> = "deny" | "escalate" | HumanTimeoutDefault<T>;

/**
 * Why: Gives the human DSL an explicit reviewer identity contract instead of relying on untyped values.
 * Use: Import it when declaring, configuring, or consuming the corresponding human API.
 */
export interface ReviewerIdentity {
  id: string;
  displayName?: string;
}

/**
 * Why: Gives the human DSL an explicit human review file subject contract instead of relying on untyped values.
 * Use: Import it when declaring, configuring, or consuming the corresponding human API.
 */
export interface HumanReviewFileSubject {
  kind: "file";
  path: string;
  mode?: "view" | "edit";
}

/**
 * Why: Gives the human DSL an explicit human review artifact subject contract instead of relying on untyped values.
 * Use: Import it when declaring, configuring, or consuming the corresponding human API.
 */
export interface HumanReviewArtifactSubject {
  kind: "artifact";
  content?: string;
  path?: string;
  mediaType?: string;
  label?: string;
}

/**
 * Why: Gives the human DSL an explicit human review subject contract instead of relying on untyped values.
 * Use: Import it when declaring, configuring, or consuming the corresponding human API.
 */
export type HumanReviewSubject = HumanReviewFileSubject | HumanReviewArtifactSubject;
/**
 * Why: Gives the human DSL an explicit human review attachment contract instead of relying on untyped values.
 * Use: Import it when declaring, configuring, or consuming the corresponding human API.
 */
export type HumanReviewAttachment = HumanReviewArtifactSubject;

/**
 * Why: Gives the human DSL an explicit reviewed subject contract instead of relying on untyped values.
 * Use: Import it when declaring, configuring, or consuming the corresponding human API.
 */
export interface ReviewedFileSubject {
  kind: "file";
  path: string;
  ref: string;
  beforeSha256: string;
  afterSha256: string;
  applied: boolean;
}

/**
 * Why: Gives the human DSL an explicit reviewed artifact subject contract instead of relying on untyped values.
 * Use: Import it when declaring, configuring, or consuming the corresponding human API.
 */
export interface ReviewedArtifactSubject {
  kind: "artifact";
  ref: string;
  sha256: string;
  applied: false;
}

/**
 * Why: Gives the human DSL an explicit reviewed subject contract instead of relying on untyped values.
 * Use: Import it when declaring, configuring, or consuming the corresponding human API.
 */
export type ReviewedSubject = ReviewedFileSubject | ReviewedArtifactSubject;

/**
 * Why: Keeps a review decision attributable and bound to the exact file or artifact generation observed.
 * Use: Read it from `ctx.human.review` or a human-review goal component.
 */
export interface HumanReviewResult<T> {
  answer: T;
  reviewer: ReviewerIdentity;
  subject: ReviewedSubject;
  submittedAt: string;
  waitedMs: number;
}

/**
 * Why: Gives the human DSL an explicit human edit file result contract instead of relying on untyped values.
 * Use: Import it when declaring, configuring, or consuming the corresponding human API.
 */
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

/**
 * Why: Gives the human DSL an explicit ui view ref contract instead of relying on untyped values.
 * Use: Import it when declaring, configuring, or consuming the corresponding human API.
 */
export interface UiViewRef<Props, Answer = never, Mode extends "input" | "display" = "input" | "display">
  extends WorkflowNode<"weft.ui-view"> {
  readonly kind: "weft.ui-view";
  readonly id: string;
  readonly revision: string;
  readonly __props?: Props;
  readonly __answer?: Answer;
  readonly __mode?: Mode;
}

/**
 * Why: Gives the human DSL an explicit input ui component props contract instead of relying on untyped values.
 * Use: Import it when declaring, configuring, or consuming the corresponding human API.
 */
export interface InputUiComponentProps<Props, Answer> {
  props: Props;
  propose(answer: Answer): void;
}

/**
 * Why: Gives the human DSL an explicit result ui component props contract instead of relying on untyped values.
 * Use: Import it when declaring, configuring, or consuming the corresponding human API.
 */
export interface ResultUiComponentProps<Props> {
  props: Props;
}

/**
 * Why: Declares a schema-backed interactive view while leaving submission and validation under host control.
 * Use: Use it for a custom `human.ask` or `human.review` presentation.
 */
export interface UiViewConfig<PropsSchema extends AnySchema, AnswerSchema extends AnySchema> {
  id: string;
  revision?: string;
  props: PropsSchema;
  answer: AnswerSchema;
  component: (props: InputUiComponentProps<InferOut<PropsSchema>, InferIn<AnswerSchema>>) => unknown;
}

/**
 * Why: Declares a schema-backed interactive view while leaving submission and validation under host control.
 * Use: Use it for a custom `human.ask` or `human.review` presentation.
 */
export declare function defineUiView<PropsSchema extends AnySchema, AnswerSchema extends AnySchema>(
  config: UiViewConfig<PropsSchema, AnswerSchema>,
): UiViewRef<InferOut<PropsSchema>, InferIn<AnswerSchema>, "input">;

/**
 * Why: Declares a schema-backed read-only presentation for completed workflow data.
 * Use: Pass the returned view to `ctx.ui.render` with validated props.
 */
export interface ResultViewConfig<PropsSchema extends AnySchema> {
  id: string;
  revision?: string;
  props: PropsSchema;
  component: (props: ResultUiComponentProps<InferOut<PropsSchema>>) => unknown;
}

/**
 * Why: Declares a schema-backed read-only presentation for completed workflow data.
 * Use: Pass the returned view to `ctx.ui.render` with validated props.
 */
export declare function defineResultView<PropsSchema extends AnySchema>(
  config: ResultViewConfig<PropsSchema>,
): UiViewRef<InferOut<PropsSchema>, never, "display">;

/**
 * Why: Gives the human DSL an explicit input ui binding contract instead of relying on untyped values.
 * Use: Import it when declaring, configuring, or consuming the corresponding human API.
 */
export interface InputUiBinding<Props, Answer> {
  view: UiViewRef<Props, Answer, "input">;
  props: Props;
}

/**
 * Why: Gives the human DSL an explicit human ask options contract instead of relying on untyped values.
 * Use: Import it when declaring, configuring, or consuming the corresponding human API.
 */
export interface HumanAskOptions<S extends AnySchema, Props = never> {
  key?: string;
  question: string;
  detail?: string;
  schema: S;
  timeout?: Duration;
  onTimeout?: HumanTimeoutPolicy<InferIn<S>>;
  ui?: InputUiBinding<Props, InferIn<S>>;
}

/**
 * Why: Gives the human DSL an explicit denied approval default contract instead of relying on untyped values.
 * Use: Import it when declaring, configuring, or consuming the corresponding human API.
 */
export interface DeniedApprovalDefault {
  approved: false;
  note?: string;
}

/**
 * Why: Gives the human DSL an explicit human approval timeout default contract instead of relying on untyped values.
 * Use: Import it when declaring, configuring, or consuming the corresponding human API.
 */
export interface HumanApprovalTimeoutDefault {
  default: DeniedApprovalDefault;
}

/**
 * Why: Gives the human DSL an explicit human approve options contract instead of relying on untyped values.
 * Use: Import it when declaring, configuring, or consuming the corresponding human API.
 */
export interface HumanApproveOptions {
  key?: string;
  action: string;
  detail?: string;
  timeout?: Duration;
  onTimeout?: "deny" | "escalate" | HumanApprovalTimeoutDefault;
}

/**
 * Why: Gives the human DSL an explicit human review options contract instead of relying on untyped values.
 * Use: Import it when declaring, configuring, or consuming the corresponding human API.
 */
export interface HumanReviewOptions<S extends AnySchema, Props = never> {
  key?: string;
  question?: string;
  subject: HumanReviewSubject;
  attachments?: HumanReviewAttachment[];
  schema: S;
  timeout?: Duration;
  onTimeout?: HumanTimeoutPolicy<InferIn<S>>;
  ui?: InputUiBinding<Props, InferIn<S>>;
}

/**
 * Why: Gives the human DSL an explicit human edit file options contract instead of relying on untyped values.
 * Use: Import it when declaring, configuring, or consuming the corresponding human API.
 */
export interface HumanEditFileOptions {
  key?: string;
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
  approve(opts: HumanApproveOptions): Promise<HumanApprovalResult>;
  review<S extends AnySchema, Props = never>(
    opts: HumanReviewOptions<S, Props>,
  ): Promise<HumanReviewResult<InferOut<S>>>;
  editFile(opts: HumanEditFileOptions): Promise<HumanEditFileResult>;
}

/**
 * Why: Gives the human DSL an explicit human approval result contract instead of relying on untyped values.
 * Use: Import it when declaring, configuring, or consuming the corresponding human API.
 */
export interface HumanApprovalResult {
  approved: boolean;
  note?: string;
  reviewer: ReviewerIdentity;
}

/**
 * Why: Gives the human DSL an explicit ui render options contract instead of relying on untyped values.
 * Use: Import it when declaring, configuring, or consuming the corresponding human API.
 */
export interface UiRenderOptions<Props> {
  key: string;
  slot?: string;
  view: UiViewRef<Props, never, "display">;
  props: Props;
}

/**
 * Why: Gives the human DSL an explicit ui api contract instead of relying on untyped values.
 * Use: Import it when declaring, configuring, or consuming the corresponding human API.
 */
export interface UiApi {
  render<Props>(opts: UiRenderOptions<Props>): Promise<void>;
}
