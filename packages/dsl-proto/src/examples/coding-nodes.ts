import {
  defineArtifact,
  defineObserver,
  defineOperation,
  defineWorkflow,
  type MetadataArtifactRef,
  z,
} from "../index.ts";

declare function expectType<T>(value: T): void;

const PullRequestInput = z.object({ branch: z.string(), title: z.string() });
const PullRequestResult = z.object({ number: z.number().int(), url: z.string().url() });

const openPullRequest = defineOperation({
  name: "open-pull-request",
  input: PullRequestInput,
  output: PullRequestResult,
  capabilities: ["network", "git:read"],
  defaults: { timeout: "2m", attempts: 2 },
  authorization: {
    mode: "required",
    action: "open a pull request",
    risk: "high",
    timeout: "24h",
  },
  binding: "github.pull-request.create",
});

const CiLookup = z.object({ pullRequest: z.number().int() });
const CiState = z.object({
  status: z.enum(["queued", "running", "passed", "failed"]),
  runId: z.string(),
});
const PassedCi = z.object({ status: z.literal("passed"), runId: z.string() });

const waitForCi = defineObserver({
  name: "wait-for-ci",
  input: CiLookup,
  state: CiState,
  output: PassedCi,
  source: {
    kind: "poll",
    every: "30s",
    binding: "github.actions.status",
  },
  defaults: { timeout: "2h" },
  complete: (state) => (state.status === "passed" ? { status: "passed" as const, runId: state.runId } : null),
});

const CiEvidenceMetadata = z.object({ pullRequest: z.number().int(), runId: z.string() });
type CiEvidenceMetadataValue = z.infer<typeof CiEvidenceMetadata>;

const ciEvidence = defineArtifact({
  name: "ci-evidence",
  mediaType: "text/plain",
  extension: ".txt",
  content: z.string(),
  metadata: CiEvidenceMetadata,
});

const DeliveryInput = z.object({ branch: z.string(), title: z.string() });
const DeliveryOutput = z.object({
  pullRequestUrl: z.string().url(),
  evidenceRef: z.string(),
});

defineWorkflow(
  { id: "operation-observer-artifact", input: DeliveryInput, output: DeliveryOutput },
  async (ctx, input) => {
    const candidate = await ctx.operation.prepare(openPullRequest, input, {
      key: "prepare-pull-request",
      label: "Freeze pull request input",
    });
    const authorization = await ctx.operation.authorize(openPullRequest, candidate, {
      key: "authorize-pull-request",
      label: "Authorize pull request creation",
      detail: `Open ${input.title} from ${input.branch}`,
    });
    const pullRequest = await ctx.operation.execute(
      openPullRequest,
      { candidate, authorization },
      { key: "open-pull-request", label: "Open pull request" },
    );

    const ci = await ctx.observe(waitForCi, { pullRequest: pullRequest.number }, { key: "wait-for-ci" });

    const evidence = await ctx.artifact(
      ciEvidence,
      {
        content: `CI run ${ci.runId} passed`,
        metadata: { pullRequest: pullRequest.number, runId: ci.runId },
      },
      { key: "capture-ci-evidence", label: "Passing CI evidence" },
    );

    expectType<MetadataArtifactRef<string, CiEvidenceMetadataValue>>(evidence);
    return { pullRequestUrl: pullRequest.url, evidenceRef: evidence.ref };
  },
);
