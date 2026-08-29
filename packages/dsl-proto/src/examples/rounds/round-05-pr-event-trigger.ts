import {
  defineAgent,
  defineCheck,
  defineCheckSuite,
  defineContextSource,
  definePathPolicy,
  definePrompt,
  defineReview,
  defineTrigger,
  defineWorkflow,
  type ReviewEvaluation,
  type TriggerAdmissionResult,
  type TriggerInputOf,
  type TriggerOutputOf,
  type WorkflowNode,
  type WorkspaceSnapshotRef,
  z,
} from "../../index.ts";

/** Why: Makes the final workflow contract visible to the typechecker without adding runtime behavior. Use: Assert the inferred definition at the end of the example. */
declare function expectType<Type>(value: Type): void;

// The trigger authenticates, validates, filters, maps, and atomically admits each delivery. The admitted target
// still re-resolves the immutable delivery and current repository policy before choosing consequential work.

const DeliveryHintSchema = z.object({
  repository: z.string().min(1),
  deliveryId: z.string().min(1),
});

const IssueDeliverySchema = z.object({
  event: z.literal("issues"),
  repository: z.string().min(1),
  deliveryId: z.string().min(1),
  action: z.string().min(1),
  defaultBranch: z.string().min(1),
  issue: z.object({
    number: z.number().int().positive(),
    title: z.string().min(1),
    body: z.string().nullable(),
    labels: z.array(z.string()),
  }),
});

const PullRequestDeliverySchema = z.object({
  event: z.literal("pull_request"),
  repository: z.string().min(1),
  deliveryId: z.string().min(1),
  action: z.string().min(1),
  pullRequest: z.object({
    number: z.number().int().positive(),
    title: z.string().min(1),
    body: z.string().nullable(),
    draft: z.boolean(),
    labels: z.array(z.string()),
    baseRef: z.string().min(1),
    baseSha: z.string().min(1),
    headRef: z.string().min(1),
    headSha: z.string().min(1),
  }),
});

const CanonicalDeliverySchema = z.discriminatedUnion("event", [
  IssueDeliverySchema,
  PullRequestDeliverySchema,
]);

/** Why: Names the authenticated delivery value used by filtering and mapping. Use: Accept only values returned by the canonical delivery context source. */
type CanonicalDelivery = z.infer<typeof CanonicalDeliverySchema>;

const CommandSchema = z.tuple([z.string().min(1)]).rest(z.string());

const RepositoryAutomationPolicySchema = z.object({
  issueLabel: z.string().min(1),
  pullRequestLabel: z.string().min(1),
  allowedPaths: z.array(z.string().min(1)).min(1),
  acceptanceCriteria: z.array(z.string().min(1)).min(1),
  testCommand: CommandSchema,
  lintCommand: CommandSchema,
});

/** Why: Keeps repository-owned automation policy distinct from user-authored issue and PR text. Use: Map it into bounded writer and check inputs only after authoritative resolution. */
type RepositoryAutomationPolicy = z.infer<typeof RepositoryAutomationPolicySchema>;

const canonicalDelivery = defineContextSource({
  name: "github-canonical-delivery",
  description: "Resolves a persisted, signature-verified GitHub delivery by its host delivery ID.",
  input: DeliveryHintSchema,
  output: CanonicalDeliverySchema,
  binding: "github.delivery.resolve",
  freshness: { maxAge: "7d", stale: "reject" },
  trust: { minimum: "authoritative", authorities: ["github"] },
});

const repositoryAutomationPolicy = defineContextSource({
  name: "repository-automation-policy",
  description: "Reads the current host-governed labels, paths, and commands for event automation.",
  input: z.object({ repository: z.string().min(1) }),
  output: RepositoryAutomationPolicySchema,
  binding: "repository.automation-policy",
  freshness: { maxAge: "5m", stale: "reject" },
  trust: { minimum: "authoritative", authorities: ["repository-policy"] },
});

const CodingEventBaseSchema = z.object({
  repository: z.string().min(1),
  deliveryId: z.string().min(1),
  eventEvidenceRef: z.string().min(1),
  policyEvidenceRef: z.string().min(1),
  allowedPaths: z.array(z.string().min(1)).min(1),
  acceptanceCriteria: z.array(z.string().min(1)).min(1),
  testCommand: CommandSchema,
  lintCommand: CommandSchema,
});

const IssueCodingEventSchema = CodingEventBaseSchema.extend({
  kind: z.literal("issue"),
  issueNumber: z.number().int().positive(),
  title: z.string().min(1),
  body: z.string(),
  baseRef: z.string().min(1),
});

const PullRequestReviewEventSchema = CodingEventBaseSchema.extend({
  kind: z.literal("pull-request"),
  pullRequestNumber: z.number().int().positive(),
  title: z.string().min(1),
  body: z.string(),
  baseRef: z.string().min(1),
  baseSha: z.string().min(1),
  headRef: z.string().min(1),
  headSha: z.string().min(1),
});

const CodingEventSchema = z.discriminatedUnion("kind", [
  IssueCodingEventSchema,
  PullRequestReviewEventSchema,
]);

/** Why: Names the child workflow input produced from two independently validated host reads. Use: Return it only from the event mapper and pass it through `ctx.workflow` for schema revalidation. */
type CodingEvent = z.infer<typeof CodingEventSchema>;

/** Why: Carries durable provenance links without pretending that strings are the nominal source snapshots. Use: Include them in the mapped child input and reviewer prompt for traceability. */
interface MappingEvidence {
  eventRef: string;
  policyRef: string;
}

/** Why: Represents a delivery intentionally filtered before workspace creation. Use: Return it for unsupported actions, missing labels, or draft pull requests. */
interface FilteredEvent {
  accepted: false;
  reason: string;
}

/** Why: Represents a validated delivery that is ready for a workspace-owning child run. Use: Carry the exact mapped schema value into deduplication and dispatch. */
interface AcceptedEvent {
  accepted: true;
  input: CodingEvent;
}

/** Why: Makes filter and mapping outcomes exhaustively branchable. Use: Narrow on `accepted` before creating durable work. */
type EventMapping = FilteredEvent | AcceptedEvent;

/** Why: Gives trigger admission and authoritative re-resolution one shared pure action filter. Use: Reject future or non-coding actions before policy-specific label mapping. */
function hasSupportedAction(event: CanonicalDelivery): boolean {
  if (event.event === "issues") {
    return event.action === "opened" || event.action === "reopened" || event.action === "labeled";
  }
  return (
    event.action === "opened" ||
    event.action === "reopened" ||
    event.action === "synchronize" ||
    event.action === "ready_for_review" ||
    event.action === "review_requested"
  );
}

/** Why: Filters future or irrelevant GitHub actions and maps accepted events without using user text as policy. Use: Call only with schema-validated authoritative source values. */
function mapDelivery(
  event: CanonicalDelivery,
  policy: RepositoryAutomationPolicy,
  evidence: MappingEvidence,
): EventMapping {
  const shared = {
    repository: event.repository,
    deliveryId: event.deliveryId,
    eventEvidenceRef: evidence.eventRef,
    policyEvidenceRef: evidence.policyRef,
    allowedPaths: policy.allowedPaths,
    acceptanceCriteria: policy.acceptanceCriteria,
    testCommand: policy.testCommand,
    lintCommand: policy.lintCommand,
  };

  if (event.event === "issues") {
    if (!hasSupportedAction(event)) {
      return { accepted: false, reason: `Ignored issues.${event.action}` };
    }
    if (!event.issue.labels.includes(policy.issueLabel)) {
      return { accepted: false, reason: `Issue lacks ${policy.issueLabel}` };
    }
    return {
      accepted: true,
      input: {
        ...shared,
        kind: "issue",
        issueNumber: event.issue.number,
        title: event.issue.title,
        body: event.issue.body ?? "",
        baseRef: event.defaultBranch,
      },
    };
  }

  if (!hasSupportedAction(event)) {
    return { accepted: false, reason: `Ignored pull_request.${event.action}` };
  }
  if (event.pullRequest.draft) return { accepted: false, reason: "Draft pull request" };
  if (!event.pullRequest.labels.includes(policy.pullRequestLabel)) {
    return { accepted: false, reason: `Pull request lacks ${policy.pullRequestLabel}` };
  }
  return {
    accepted: true,
    input: {
      ...shared,
      kind: "pull-request",
      pullRequestNumber: event.pullRequest.number,
      title: event.pullRequest.title,
      body: event.pullRequest.body ?? "",
      baseRef: event.pullRequest.baseRef,
      baseSha: event.pullRequest.baseSha,
      headRef: event.pullRequest.headRef,
      headSha: event.pullRequest.headSha,
    },
  };
}

const eventWriterPaths = definePathPolicy({
  name: "round-05-event-writer-paths",
  description: "Canonicalizes repository-policy paths before an issue event may start a writer.",
  revision: "v1",
  roots: ["."],
  deny: [".git/**", ".weft/**", "**/.env*", "**/*secret*"],
  grantTtl: "1h",
});

const ImplementationInputSchema = z.object({
  issueNumber: z.number().int().positive(),
  title: z.string().min(1),
  body: z.string(),
  allowedPaths: z.array(z.string().min(1)).min(1),
  acceptanceCriteria: z.array(z.string().min(1)).min(1),
  eventEvidenceRef: z.string().min(1),
  policyEvidenceRef: z.string().min(1),
});

const ImplementationResultSchema = z.object({
  summary: z.string().min(1),
  changedFiles: z.array(z.string().min(1)).min(1),
  testsChanged: z.array(z.string().min(1)),
});

const implementationPrompt = definePrompt({
  name: "implement-event-issue",
  input: ImplementationInputSchema,
  render: (input) => [
    `Implement issue #${input.issueNumber}: ${input.title}`,
    input.body,
    `Allowed paths:\n${input.allowedPaths.map((path) => `- ${path}`).join("\n")}`,
    `Acceptance criteria:\n${input.acceptanceCriteria.map((criterion) => `- ${criterion}`).join("\n")}`,
    `Event evidence: ${input.eventEvidenceRef}`,
    `Policy evidence: ${input.policyEvidenceRef}`,
    "Do not commit, push, open a pull request, or modify files outside the granted scope.",
  ],
});

const issueImplementer = defineAgent({
  name: "event-issue-implementer",
  description: "Implements one host-filtered issue in a workflow-owned branch.",
  prompt: implementationPrompt,
  schema: ImplementationResultSchema,
  defaults: {
    maxTurns: 24,
    timeout: "40m",
    provider: {
      id: "codex",
      model: "gpt-5.6-sol",
      effort: "high",
      options: { sandboxMode: "workspace-write", networkAccess: false, webSearch: "disabled" },
    },
  },
});

const QualityInputSchema = z.object({
  testCommand: CommandSchema,
  lintCommand: CommandSchema,
});

const eventTests = defineCheck({
  name: "event-coding-tests",
  description: "Runs the repository-policy test command against the exact workspace generation.",
  policy: "required",
  input: QualityInputSchema,
  command: ({ testCommand }) => testCommand,
  defaults: { timeout: "20m" },
});

const eventLint = defineCheck({
  name: "event-coding-lint",
  description: "Runs the repository-policy lint command against the exact workspace generation.",
  policy: "required",
  input: QualityInputSchema,
  command: ({ lintCommand }) => lintCommand,
  defaults: { timeout: "10m" },
});

const eventQuality = defineCheckSuite({
  name: "event-coding-quality",
  description: "Keeps event-triggered tests and lint independently visible.",
  input: QualityInputSchema,
  checks: (input, use) => ({ tests: use(eventTests, input), lint: use(eventLint, input) }),
  concurrency: 2,
});

const ReviewTargetSchema = z.object({
  kind: z.enum(["issue", "pull-request"]),
  identifier: z.string().min(1),
  title: z.string().min(1),
  body: z.string(),
  base: z.string().min(1),
  changedFiles: z.array(z.string().min(1)).min(1),
  acceptanceCriteria: z.array(z.string().min(1)).min(1),
  eventEvidenceRef: z.string().min(1),
  policyEvidenceRef: z.string().min(1),
});

const ReviewFindingSchema = z.object({
  path: z.string().min(1),
  line: z.number().int().positive().optional(),
  severity: z.enum(["low", "medium", "high", "critical"]),
  blocking: z.boolean(),
  message: z.string().min(1),
  evidence: z.string().min(1),
});

/** Why: Names one schema-validated review finding for the exact-subject review evaluator. Use: Preserve it through assessment and workflow output. */
type ReviewFinding = z.infer<typeof ReviewFindingSchema>;

const ReviewReportSchema = z.object({
  summary: z.string().min(1),
  findings: z.array(ReviewFindingSchema),
});

/** Why: Names the review agent result before it is assigned blocking or advisory disposition. Use: Convert it with `toReviewEvaluation`. */
type ReviewReport = z.infer<typeof ReviewReportSchema>;

const reviewPrompt = definePrompt({
  name: "review-event-change",
  input: ReviewTargetSchema,
  render: (input) => [
    `Review ${input.identifier}: ${input.title} against the current workspace only.`,
    `Change kind: ${input.kind}; base: ${input.base}`,
    `Changed files:\n${input.changedFiles.map((path) => `- ${path}`).join("\n")}`,
    `Acceptance criteria:\n${input.acceptanceCriteria.map((criterion) => `- ${criterion}`).join("\n")}`,
    `Event evidence: ${input.eventEvidenceRef}; policy evidence: ${input.policyEvidenceRef}`,
    "Report only repository-supported findings. Do not modify files.",
  ],
});

const eventReviewer = defineAgent({
  name: "event-change-reviewer",
  description: "Performs a read-only review of the exact event workspace generation.",
  prompt: reviewPrompt,
  schema: ReviewReportSchema,
  defaults: {
    maxTurns: 12,
    timeout: "20m",
    provider: {
      id: "codex",
      model: "gpt-5.6-sol",
      effort: "high",
      options: { sandboxMode: "read-only", networkAccess: false, webSearch: "disabled" },
    },
  },
});

/** Why: Assigns explicit dispositions without allowing the model to decide acceptance policy. Use: Return it from the reusable exact-subject review definition. */
function toReviewEvaluation(report: ReviewReport): ReviewEvaluation<ReviewFinding> {
  return {
    summary: report.summary,
    assessments: report.findings.map((finding) => ({
      finding,
      disposition: finding.blocking ? "blocking" : "advisory",
      sources: ["event-change-reviewer"],
      rationale: finding.evidence,
    })),
  };
}

const exactEventReview = defineReview({
  name: "exact-event-change-review",
  description: "Binds review findings and acceptance to one immutable workspace generation.",
  input: ReviewTargetSchema,
  finding: ReviewFindingSchema,
  evaluate: async (ctx, input) => {
    const report = await ctx.agent({ key: "review", agent: eventReviewer, input });
    return toReviewEvaluation(report.value);
  },
  accept: ({ assessments }) => assessments.every(({ disposition }) => disposition !== "blocking"),
});

const WorkspaceSubjectSchema = z.object({
  workspaceId: z.string().min(1),
  generation: z.number().int().nonnegative(),
  treeHash: z.string().min(1),
});

/** Why: Names the serializable projection of nominal workspace identity. Use: Return it for diagnostics without reconstructing authority from it. */
type WorkspaceSubject = z.infer<typeof WorkspaceSubjectSchema>;

const CodingOutcomeSchema = z.object({
  status: z.enum(["accepted", "rework"]),
  kind: z.enum(["issue", "pull-request"]),
  deliveryId: z.string().min(1),
  branch: z.string().min(1),
  wroteChanges: z.boolean(),
  changedFiles: z.array(z.string().min(1)).min(1),
  checksPassed: z.literal(true),
  reviewEvidence: z.string().min(1),
  findings: z.array(ReviewFindingSchema),
  subject: WorkspaceSubjectSchema,
});

/** Why: Names the validated child result stored in the delivery ledger and returned by intake. Use: Preserve it across the parent workflow boundary. */
type CodingOutcome = z.infer<typeof CodingOutcomeSchema>;

/** Why: Produces a Git-safe deterministic branch segment from host-validated identifiers. Use: Derive workspace branch names without shell interpolation. */
function branchSegment(value: string): string {
  const normalized = value
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, "-")
    .replaceAll(/^-|-$/g, "");
  return normalized || "event";
}

/** Why: Compares nominal subjects without projecting them into substitute authority. Use: Reject workspace drift across checks and review. */
function requireSameSubject(
  actual: WorkspaceSnapshotRef,
  expected: WorkspaceSnapshotRef,
  label: string,
): void {
  if (
    actual.workspaceId !== expected.workspaceId ||
    actual.generation !== expected.generation ||
    actual.treeHash !== expected.treeHash
  ) {
    throw new Error(`${label} did not preserve the exact workspace subject`);
  }
}

/** Why: Makes nominal workspace identity serializable for workflow output only. Use: Never pass the projection back into an authority-consuming API. */
function projectSubject(subject: WorkspaceSnapshotRef): WorkspaceSubject {
  return {
    workspaceId: subject.workspaceId,
    generation: subject.generation,
    treeHash: subject.treeHash,
  };
}

const eventCodingWorkflow = defineWorkflow(
  {
    id: "round-05-handle-mapped-github-event",
    name: "Handle a validated GitHub coding event",
    description: "Implements labeled issues or reviews exact pull request heads after authoritative mapping.",
    input: CodingEventSchema,
    output: CodingOutcomeSchema,
    workspace: ({ input }) =>
      input.kind === "issue"
        ? {
            branch: `codex/event-issue-${input.issueNumber}-${branchSegment(input.deliveryId)}`,
            from: input.baseRef,
          }
        : {
            branch: `codex/event-review-${input.pullRequestNumber}-${input.headSha.slice(0, 12)}`,
            from: input.headSha,
          },
  },
  async (ctx, input): Promise<CodingOutcome> => {
    let changedFiles: string[];
    let wroteChanges: boolean;

    if (input.kind === "issue") {
      const writeScope = await ctx.paths.resolve(
        eventWriterPaths,
        { proposedPaths: input.allowedPaths },
        { key: "resolve-issue-write-scope", label: `Resolve paths for issue #${input.issueNumber}` },
      );
      const implementation = await ctx.agent({
        key: "implement-issue",
        agent: issueImplementer,
        input: {
          issueNumber: input.issueNumber,
          title: input.title,
          body: input.body,
          allowedPaths: input.allowedPaths,
          acceptanceCriteria: input.acceptanceCriteria,
          eventEvidenceRef: input.eventEvidenceRef,
          policyEvidenceRef: input.policyEvidenceRef,
        },
        write: writeScope,
      });
      if (implementation.files.length === 0) throw new Error("Issue implementation changed no files");
      changedFiles = implementation.files;
      wroteChanges = true;
    } else {
      const head = await ctx.git.head();
      if (head.sha !== input.headSha) {
        throw new Error(`Pull request workspace is at ${head.sha}, expected ${input.headSha}`);
      }
      const changed = await ctx.git.changedSince(input.baseSha);
      if (changed.files.length === 0) throw new Error("Pull request contains no changed files to review");
      changedFiles = changed.files.map(({ path }) => path);
      wroteChanges = false;
    }

    const subject = ctx.workspace.subject;
    const quality = await ctx.check(
      eventQuality,
      { testCommand: input.testCommand, lintCommand: input.lintCommand },
      { keyPrefix: "event-quality", policy: "required", concurrency: 2 },
    );
    requireSameSubject(quality.subject, subject, "Quality suite");
    if (!quality.passed) throw new Error("Required event quality checks failed");

    const identifier =
      input.kind === "issue" ? `Issue #${input.issueNumber}` : `Pull request #${input.pullRequestNumber}`;
    const review = await ctx.review(
      exactEventReview,
      {
        kind: input.kind,
        identifier,
        title: input.title,
        body: input.body,
        base: input.kind === "issue" ? input.baseRef : input.baseSha,
        changedFiles,
        acceptanceCriteria: input.acceptanceCriteria,
        eventEvidenceRef: input.eventEvidenceRef,
        policyEvidenceRef: input.policyEvidenceRef,
      },
      { key: "exact-event-review", label: `Review ${identifier}`, subject },
    );
    requireSameSubject(review.subject, subject, "Review");

    return {
      status: review.status,
      kind: input.kind,
      deliveryId: input.deliveryId,
      branch: ctx.workspace.branch,
      wroteChanges,
      changedFiles,
      checksPassed: true,
      reviewEvidence: review.evidence,
      findings: review.assessments.map(({ finding }) => finding),
      subject: projectSubject(subject),
    };
  },
);

const IgnoredOutputSchema = z.object({
  status: z.literal("ignored"),
  deliveryId: z.string().min(1),
  reason: z.string().min(1),
});

const ProcessedOutputSchema = z.object({
  status: z.literal("processed"),
  deliveryId: z.string().min(1),
  outcome: CodingOutcomeSchema,
});

const EventProcessingOutputSchema = z.discriminatedUnion("status", [
  IgnoredOutputSchema,
  ProcessedOutputSchema,
]);

const githubEventProcessingWorkflow = defineWorkflow(
  {
    id: "round-05-process-github-event",
    name: "Process an admitted GitHub PR or issue event",
    description:
      "Re-resolves an admitted delivery and repository policy before dispatching consequential coding work.",
    input: DeliveryHintSchema,
    output: EventProcessingOutputSchema,
  },
  async (ctx, hint) => {
    const ingress = ctx.run.trigger;
    if (
      ingress === undefined ||
      ingress.provenance.trigger !== "round-05-github-coding-event" ||
      ingress.provenance.revision !== "github-v1" ||
      ingress.provenance.eventId !== hint.deliveryId
    ) {
      throw new Error("GitHub event processing requires matching nominal trigger provenance");
    }

    const eventSnapshot = await ctx.context(canonicalDelivery, hint, {
      key: "resolve-canonical-delivery",
      label: `Resolve GitHub delivery ${hint.deliveryId}`,
      maxAge: "7d",
    });
    const event = eventSnapshot.value;
    if (event.repository !== hint.repository || event.deliveryId !== hint.deliveryId) {
      throw new Error("Canonical delivery identity does not match the trigger hint");
    }

    const policySnapshot = await ctx.context(
      repositoryAutomationPolicy,
      { repository: event.repository },
      { key: "resolve-repository-policy", label: `Resolve policy for ${event.repository}` },
    );
    const mapped = mapDelivery(event, policySnapshot.value, {
      eventRef: eventSnapshot.evidence.ref,
      policyRef: policySnapshot.evidence.ref,
    });
    if (!mapped.accepted) {
      return { status: "ignored" as const, deliveryId: event.deliveryId, reason: mapped.reason };
    }

    const outcome = await ctx.workflow(eventCodingWorkflow, mapped.input, {
      key: "handle-mapped-event",
      label: `Handle ${mapped.input.kind} delivery ${mapped.input.deliveryId}`,
    });
    return { status: "processed" as const, deliveryId: mapped.input.deliveryId, outcome };
  },
);

const githubCodingEventTrigger = defineTrigger({
  name: "round-05-github-coding-event",
  revision: "github-v1",
  description:
    "Authenticates and atomically admits supported GitHub issue and pull-request deliveries exactly once.",
  source: { binding: "github.webhook.authenticated" },
  event: CanonicalDeliverySchema,
  workflow: githubEventProcessingWorkflow,
  filter: (event) => hasSupportedAction(event) && (event.event === "issues" || !event.pullRequest.draft),
  eventId: (event) => event.deliveryId,
  dedupeKey: (event) => `${event.repository}:${event.deliveryId}`,
  map: (event) => ({ repository: event.repository, deliveryId: event.deliveryId }),
});

/** Why: Proves that trigger ingress retains the raw canonical event schema exactly. Use: Keep internal admission dispatch from widening event payloads to `unknown`. */
declare const triggerInput: TriggerInputOf<typeof githubCodingEventTrigger>;
/** Why: Supplies the reverse input assignability proof for the trigger schema. Use: Confirm `TriggerInputOf` did not accidentally narrow the raw event contract. */
declare const canonicalInput: z.input<typeof CanonicalDeliverySchema>;
/** Why: Proves that trigger output preserves its exact nominal admission and suppression union. Use: Keep internal admission execution definition-specific. */
declare const triggerOutput: TriggerOutputOf<typeof githubCodingEventTrigger>;
/** Why: Supplies the reverse output assignability proof for the trigger result. Use: Confirm `TriggerOutputOf` is neither widened nor incomplete. */
declare const admissionOutput: TriggerAdmissionResult<typeof githubCodingEventTrigger>;

expectType<WorkflowNode<"weft.workflow">>(githubEventProcessingWorkflow);
expectType<WorkflowNode<"weft.trigger">>(githubCodingEventTrigger);
expectType<z.input<typeof CanonicalDeliverySchema>>(triggerInput);
expectType<TriggerInputOf<typeof githubCodingEventTrigger>>(canonicalInput);
expectType<TriggerAdmissionResult<typeof githubCodingEventTrigger>>(triggerOutput);
expectType<TriggerOutputOf<typeof githubCodingEventTrigger>>(admissionOutput);
