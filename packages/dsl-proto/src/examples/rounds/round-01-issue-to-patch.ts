import { z } from "zod";

import {
  type CheckExecutionResult,
  type CheckSuiteResult,
  type CommandCheckEvidence,
  defineAgent,
  defineArtifact,
  defineCheck,
  defineCheckSuite,
  defineGoal,
  definePathPolicy,
  definePrompt,
  defineWorkflow,
  type MetadataArtifactRef,
  type PatchAgentResult,
  type PatchRef,
  prompt,
  type WorkflowNode,
} from "../../core/index.ts";

/** Why: Makes compile-time assertions visible in the example without adding runtime behavior. Use: Pass an inferred DSL value to verify its exact public type. */
declare function expectType<T>(value: T): void;

const IssueInput = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  description: z.string().min(1),
  reproduction: z.string().min(1),
  allowedPaths: z.array(z.string().min(1)).min(1),
  testCommand: z.tuple([z.string().min(1)]).rest(z.string()),
});

const issuePatchPaths = definePathPolicy({
  name: "issue-patch-paths",
  description: "Canonicalizes issue-provided paths before granting detached patch writes.",
  revision: "v1",
  roots: ["."],
  deny: [".git/**", ".weft/**"],
  grantTtl: "1h",
});

/** Why: Gives prompt and workflow helpers one named, schema-derived issue contract. Use: Refer to it when proving input inference across definitions. */
type IssueInputValue = z.infer<typeof IssueInput>;

const ImplementationPromptInput = z.object({ issue: IssueInput });

const ImplementationResult = z.object({
  summary: z.string().min(1),
  rootCause: z.string().min(1),
  redEvidence: z.string().min(1),
  greenEvidence: z.string().min(1),
  testsAdded: z.array(z.string()),
  changedFiles: z.array(z.string()).min(1),
  residualRisks: z.array(z.string()),
});

/** Why: Names the writer's validated domain result separately from operational patch metadata. Use: Assert the value carried by the agent result envelope. */
type ImplementationResultValue = z.infer<typeof ImplementationResult>;

const implementationPrompt = definePrompt({
  name: "round-01-issue-implementation",
  input: ImplementationPromptInput,
  render: ({ issue }) => [
    prompt.section("Issue", `${issue.id}: ${issue.title}\n\n${issue.description}`),
    prompt.section("Reproduction", issue.reproduction),
    prompt.json("Allowed paths", issue.allowedPaths),
    prompt.section(
      "Method",
      [
        "Reproduce the defect before editing and preserve the failing output.",
        "Add or strengthen a regression test that fails for the reported reason.",
        "Implement the smallest sound fix within the allowed paths.",
        "Run the focused test after the fix and report remaining risks honestly.",
      ].join("\n"),
    ),
  ],
});

const issueDeveloper = defineAgent({
  name: "round-01-issue-developer",
  description: "Reproduces one issue, implements a scoped fix, and returns red-green evidence.",
  prompt: implementationPrompt,
  schema: ImplementationResult,
  defaults: {
    provider: {
      id: "codex",
      model: "gpt-5.5",
      effort: "high",
      options: { networkAccess: false, sandboxMode: "workspace-write", webSearch: "disabled" },
    },
    maxTurns: 24,
    timeout: "45m",
  },
});

const ReviewInput = z.object({
  issueId: z.string().min(1),
  expectedBehavior: z.string().min(1),
  allowedPaths: z.array(z.string().min(1)).min(1),
});

const ReviewResult = z.object({
  decision: z.enum(["approve", "request-changes"]),
  summary: z.string().min(1),
  findings: z.array(z.string()),
});

/** Why: Preserves the reviewer verdict as a named type for goal-result assertions. Use: Verify that goal composition retains the reviewer schema. */
type ReviewResultValue = z.infer<typeof ReviewResult>;

const reviewPrompt = definePrompt({
  name: "round-01-patch-review",
  input: ReviewInput,
  render: (input) => [
    prompt.section("Review target", `Patch for ${input.issueId}`),
    prompt.section("Expected behavior", input.expectedBehavior),
    prompt.json("Authorized paths", input.allowedPaths),
    "Reject unrelated edits, missing regression coverage, or behavior that does not match the issue.",
  ],
});

const patchReviewer = defineAgent({
  name: "round-01-patch-reviewer",
  description: "Performs an independent read-only review of the candidate patch.",
  prompt: reviewPrompt,
  schema: ReviewResult,
  defaults: {
    provider: {
      id: "claude",
      model: "sonnet",
      effort: "high",
      options: { permissionMode: "dontAsk" },
    },
    timeout: "15m",
  },
});

const RegressionCheckInput = z.object({
  command: z.tuple([z.string().min(1)]).rest(z.string()),
});

/** Why: Keeps focused-test evidence structurally distinct from generic check evidence. Use: Preserve the exact single command evidence tuple through check and goal inference. */
type RegressionEvidence = readonly [CommandCheckEvidence];

/** Why: Gives the regression parser a named result contract instead of relying on an inferred object literal. Use: Return it from the regression check parser. */
interface RegressionExecutionResult extends CheckExecutionResult<RegressionEvidence> {}

const regression = defineCheck({
  name: "round-01-regression",
  description: "Runs the issue-specific regression command in the candidate workspace.",
  policy: "required",
  revision: "v1",
  input: RegressionCheckInput,
  defaults: { timeout: "15m" },
  command: ({ command }) => command,
  parse: ({ exitCode, stdout, stderr }): RegressionExecutionResult => ({
    status: exitCode === 0 ? "pass" : "fail",
    summary: exitCode === 0 ? "Focused regression passed" : "Focused regression failed",
    evidence: stdout || stderr,
    details: [{ kind: "command", exitCode, output: stdout || stderr }],
  }),
});

const lint = defineCheck({
  name: "round-01-lint",
  description: "Rejects style and static-analysis regressions in the candidate workspace.",
  policy: "required",
  revision: "v1",
  defaults: { timeout: "10m" },
  command: ["pnpm", "lint"],
});

const typecheck = defineCheck({
  name: "round-01-typecheck",
  description: "Rejects TypeScript errors introduced by the candidate patch.",
  policy: "required",
  revision: "v1",
  defaults: { timeout: "10m" },
  command: ["pnpm", "typecheck"],
});

const QualityInput = z.object({
  testCommand: z.tuple([z.string().min(1)]).rest(z.string()),
});

const implementationQuality = defineCheckSuite({
  name: "round-01-implementation-quality",
  description: "Runs focused regression, lint, and type checks against one candidate generation.",
  input: QualityInput,
  checks: ({ testCommand }, use) => ({
    regression: use(regression, { command: testCommand }),
    lint: use(lint),
    typecheck: use(typecheck),
  }),
  concurrency: 3,
});

const CompletionInput = z.object({
  issue: IssueInput,
});

const issueCompletion = defineGoal({
  name: "round-01-issue-complete",
  input: CompletionInput,
  components: ({ issue }, use) => ({
    quality: use.check(implementationQuality, { testCommand: issue.testCommand }),
    review: use.agentReview(patchReviewer, {
      input: {
        issueId: issue.id,
        expectedBehavior: issue.description,
        allowedPaths: issue.allowedPaths,
      },
      accept: ({ value }) => value.decision === "approve" && value.findings.length === 0,
      feedback: ({ value }) => value.findings,
    }),
  }),
  defaults: { attempts: 3 },
});

const EvidenceMetadata = z.object({
  issueId: z.string().min(1),
  patchRef: z.string().min(1),
  baseTree: z.string().min(1),
  goalAttempts: z.number().int().positive(),
});

/** Why: Names the validated provenance attached to the immutable verification artifact. Use: Assert artifact metadata inference at the capture boundary. */
type EvidenceMetadataValue = z.infer<typeof EvidenceMetadata>;

const verificationEvidence = defineArtifact({
  name: "round-01-verification-evidence",
  mediaType: "text/markdown",
  extension: ".md",
  content: z.string().min(1),
  metadata: EvidenceMetadata,
});

const IssuePatchOutput = z.object({
  issueId: z.string().min(1),
  summary: z.string().min(1),
  rootCause: z.string().min(1),
  changedFiles: z.array(z.string()),
  patch: z.object({
    ref: z.string().min(1),
    key: z.string().min(1),
    files: z.array(z.string()),
    baseTree: z.string().min(1),
  }),
  evidence: z.object({
    ref: z.string().min(1),
    sha256: z.string().min(1),
  }),
});

/** Why: Represents the schema-validated handoff from issue diagnosis to an explicit later promotion decision. Use: Consume it from a child workflow or test harness. */
type IssuePatchOutputValue = z.infer<typeof IssuePatchOutput>;

const issueToPatchWorkflow = defineWorkflow(
  {
    id: "round-01-issue-to-patch",
    name: "Issue to verified patch",
    description: "Reproduce a reported issue and return a reviewed, verified, unintegrated patch.",
    input: IssueInput,
    output: IssuePatchOutput,
  },
  async (ctx, issue) => {
    const implementation = await ctx.step("implement", async (step) => {
      const writeScope = await step.paths.resolve(
        issuePatchPaths,
        { proposedPaths: issue.allowedPaths },
        { key: "issue-write-scope", label: `Resolve paths for ${issue.id}` },
      );
      return step.agent(
        issueDeveloper,
        { issue },
        {
          key: "issue-developer",
          label: `Fix ${issue.id}`,
          write: writeScope,
          goal: { definition: issueCompletion, input: { issue }, attempts: 3 },
        },
      );
    });

    expectType<PatchAgentResult<ImplementationResultValue, typeof implementation.goal>>(implementation);
    expectType<PatchRef>(implementation.patch);
    expectType<"met">(implementation.goal.status);
    expectType<CheckSuiteResult>(implementation.goal.results.quality);
    expectType<ReviewResultValue>(implementation.goal.results.review.value);
    expectType<"pass" | "fail">(implementation.goal.results.quality.results.regression.status);

    const evidence = await ctx.artifact(
      verificationEvidence,
      {
        content: [
          `# ${issue.id}: ${issue.title}`,
          `## Root cause\n${implementation.value.rootCause}`,
          `## Red evidence\n${implementation.value.redEvidence}`,
          `## Green evidence\n${implementation.value.greenEvidence}`,
          `## Independent verification\n${implementation.goal.evidence}`,
        ].join("\n\n"),
        metadata: {
          issueId: issue.id,
          patchRef: implementation.patch.ref,
          baseTree: implementation.patch.baseTree,
          goalAttempts: implementation.goal.attempts,
        },
      },
      { key: "verification-evidence", label: `Evidence for ${issue.id}` },
    );

    expectType<MetadataArtifactRef<string, EvidenceMetadataValue>>(evidence);

    await ctx.note({
      key: "record-reviewed-patch",
      kind: "claim",
      text: `${issue.id} has a reviewed patch awaiting an explicit integration decision.`,
      evidence: `${implementation.goal.evidence}\nArtifact: ${evidence.ref}`,
    });

    const output = {
      issueId: issue.id,
      summary: implementation.value.summary,
      rootCause: implementation.value.rootCause,
      changedFiles: [...implementation.patch.files],
      patch: {
        ref: implementation.patch.ref,
        key: implementation.patch.key,
        files: [...implementation.patch.files],
        baseTree: implementation.patch.baseTree,
      },
      evidence: { ref: evidence.ref, sha256: evidence.sha256 },
    } satisfies IssuePatchOutputValue;

    expectType<IssueInputValue>(issue);
    return output;
  },
);

expectType<WorkflowNode<"weft.workflow">>(issueToPatchWorkflow);
