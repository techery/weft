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
  defaults: { risk: "high", timeout: "2m", attempts: 2 },
  run: async ({ branch }, { signal }) => {
    signal.throwIfAborted();
    return { number: 42, url: `https://example.com/pulls/${encodeURIComponent(branch)}` };
  },
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
    observe: async ({ pullRequest }, { signal }) => {
      signal.throwIfAborted();
      return { status: "passed" as const, runId: `ci:${pullRequest}` };
    },
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
    const pullRequest = await ctx.operation(openPullRequest, input, {
      key: "open-pull-request",
      risk: "high",
    });

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
