import { z } from "zod";

import {
  type AgentResult,
  type CheckCommand,
  type CheckExecutionResult,
  type CheckResult,
  type CheckResultOf,
  type CommandCheckEvidence,
  type CommandResult,
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
  prompt,
  type WorkflowNode,
  type WorkspaceSnapshotRef,
} from "../../core/index.ts";

/**
 * Why: Makes compile-time assertions visible without turning this declaration-only example into a runtime test.
 * Use: Pass an inferred definition or invocation result to prove the DSL preserves its exact type.
 */
declare function expectType<T>(value: T): void;

const TestCommand = z.tuple([z.string().min(1)]).rest(z.string());

const FlakyTestInput = z.object({
  target: z.string().min(1),
  command: TestCommand,
  qualityCommand: TestCommand,
  seedFlag: z.string().min(1).default("--seed"),
  baseSeed: z.number().int().nonnegative().default(1),
  repetitions: z.number().int().min(4).max(50).default(12),
  allowedPaths: z.array(z.string().min(1)).min(1),
});

const flakyTestWritePolicy = definePathPolicy({
  name: "round-02-flaky-test-writes",
  description: "Allows a repair only within caller-proposed repository paths after canonical resolution.",
  revision: "v1",
  roots: ["."],
  deny: [".git/**", ".weft/**"],
  grantTtl: "2h",
});

const WorkspaceSnapshot = z.object({
  workspaceId: z.string().min(1),
  generation: z.number().int().nonnegative(),
  treeHash: z.string().min(1),
});

const SeedTrial = z.object({
  ordinal: z.number().int().positive(),
  seed: z.number().int().nonnegative(),
  status: z.enum(["pass", "fail"]),
  summary: z.string().optional(),
  evidence: z.string().optional(),
  candidate: WorkspaceSnapshot,
});

const HypothesisInput = z.object({
  target: z.string().min(1),
  trials: z.array(SeedTrial).min(4),
});

const FlakeHypothesis = z.object({
  mechanism: z.string().min(1),
  suspectedFiles: z.array(z.string().min(1)),
  evidenceFor: z.array(z.string().min(1)),
  evidenceAgainst: z.array(z.string().min(1)),
  confidence: z.enum(["high", "medium", "low"]),
  recommendedFix: z.string().min(1),
});

const FixInput = z.object({
  target: z.string().min(1),
  command: TestCommand,
  seedFlag: z.string().min(1),
  trials: z.array(SeedTrial).min(4),
  hypothesis: FlakeHypothesis,
});

const FixResult = z.object({
  summary: z.string().min(1),
  rootCause: z.string().min(1),
  stabilizationStrategy: z.string().min(1),
  changedFiles: z.array(z.string().min(1)).min(1),
  testsAdded: z.array(z.string().min(1)),
  residualRisks: z.array(z.string().min(1)),
});

const SeededCheckInput = z.object({
  command: TestCommand,
  seedFlag: z.string().min(1),
  seed: z.number().int().nonnegative(),
});

const CommandCheckInput = z.object({
  command: TestCommand,
});

const CandidateVerificationInput = z.object({
  command: TestCommand,
  qualityCommand: TestCommand,
  seedFlag: z.string().min(1),
  seeds: z.array(z.number().int().nonnegative()).min(4),
});

const PatchSummary = z.object({
  ref: z.string().min(1),
  key: z.string().min(1),
  files: z.array(z.string()),
  baseTree: z.string().min(1),
});

const CandidateEvidence = z.object({
  snapshot: WorkspaceSnapshot,
  attempts: z.number().int().positive(),
  goalEvidence: z.string().min(1),
  qualityPassed: z.literal(true),
  patch: PatchSummary,
});

const FlakyTestEvidenceContent = z.object({
  target: z.string().min(1),
  sourceSnapshot: WorkspaceSnapshot,
  trials: z.array(SeedTrial).min(4),
  failingSeeds: z.array(z.number().int().nonnegative()).min(1),
  passingSeeds: z.array(z.number().int().nonnegative()).min(1),
  hypothesis: FlakeHypothesis,
  fix: FixResult,
  candidate: CandidateEvidence,
});

const FlakyTestEvidenceMetadata = z.object({
  sourceWorkspaceId: z.string().min(1),
  sourceGeneration: z.number().int().nonnegative(),
  sourceTreeHash: z.string().min(1),
  candidateWorkspaceId: z.string().min(1),
  candidateGeneration: z.number().int().nonnegative(),
  candidateTreeHash: z.string().min(1),
});

const FlakyTestOutput = z.object({
  target: z.string().min(1),
  status: z.literal("stabilized"),
  observedFailures: z.number().int().positive(),
  observedPasses: z.number().int().positive(),
  patch: PatchSummary,
  evidenceRef: z.string().min(1),
  evidenceSha256: z.string().min(1),
  sourceSnapshot: WorkspaceSnapshot,
  candidateSnapshot: WorkspaceSnapshot,
});

/**
 * Why: Names the exact trial record shared by hypothesis, artifact, and classification helpers.
 * Use: Construct one after each schema-validated check invocation.
 */
type SeedTrialValue = z.infer<typeof SeedTrial>;

/**
 * Why: Retains the engine-minted candidate while remaining schema-compatible with serialized trial evidence.
 * Use: Keep this richer type inside orchestration and allow schema validation to erase provenance only at boundaries.
 */
type SeedTrialRecord = Omit<SeedTrialValue, "candidate"> & { candidate: WorkspaceSnapshotRef };

/**
 * Why: Names the analyst's validated explanation independently from its operational agent envelope.
 * Use: Pass `AgentResult.value` into the implementation agent and evidence artifact.
 */
type FlakeHypothesisValue = z.infer<typeof FlakeHypothesis>;

/**
 * Why: Names the implementation agent's domain output independently from patch and goal metadata.
 * Use: Assert the value embedded in the write-bound agent result.
 */
type FixResultValue = z.infer<typeof FixResult>;

/**
 * Why: Names the artifact metadata that carries both incomparable workspace-generation domains.
 * Use: Assert the metadata returned from the artifact invocation.
 */
type FlakyTestEvidenceMetadataValue = z.infer<typeof FlakyTestEvidenceMetadata>;

/**
 * Why: Keeps the workflow return object contextually checked without widening its terminal status literal.
 * Use: Apply it with `satisfies` before returning the final handoff.
 */
type FlakyTestOutputValue = z.infer<typeof FlakyTestOutput>;

/**
 * Why: Preserves one command evidence item as an exact tuple through check-result inference.
 * Use: Return it from the shared command parser used by baseline and candidate checks.
 */
type SingleCommandEvidence = readonly [CommandCheckEvidence];

/**
 * Why: Gives the command parser a named result instead of widening its evidence array.
 * Use: Return it from `parseCommandResult` for strongly typed check invocations.
 */
interface SeedCheckExecutionResult extends CheckExecutionResult<SingleCommandEvidence> {}

/**
 * Why: Converts a test command into a reproducible seed-specific command without using a shell.
 * Use: Bind it to both baseline and candidate checks so the same seed means the same experiment.
 */
function withSeed(command: CheckCommand, seedFlag: string, seed: number): CheckCommand {
  const [executable, ...arguments_] = command;
  return [executable, ...arguments_, seedFlag, String(seed)];
}

/**
 * Why: Normalizes process output into durable structured evidence for every deterministic trial.
 * Use: Attach it to command-backed checks instead of interpreting output inside workflow code.
 */
function parseCommandResult(result: CommandResult): SeedCheckExecutionResult {
  const output = [result.stdout, result.stderr].filter(Boolean).join("\n");
  const detail: CommandCheckEvidence = {
    kind: "command",
    exitCode: result.exitCode,
    ...(output === "" ? {} : { output }),
  };

  return {
    status: result.exitCode === 0 ? "pass" : "fail",
    summary: result.exitCode === 0 ? "Seeded trial passed" : "Seeded trial failed",
    evidence: output,
    details: [detail],
  };
}

const seededTest = defineCheck({
  name: "round-02-seeded-test",
  description: "Runs the focused flaky test with an explicit deterministic seed.",
  revision: "seed-contract-v1",
  policy: "required",
  input: SeededCheckInput,
  defaults: { timeout: "10m" },
  command: ({ command, seedFlag, seed }) => withSeed(command, seedFlag, seed),
  parse: parseCommandResult,
});

const repositoryQuality = defineCheck({
  name: "round-02-repository-quality",
  description: "Runs the caller-selected static and regression quality command.",
  revision: "caller-command-v1",
  policy: "required",
  input: CommandCheckInput,
  defaults: { timeout: "20m" },
  command: ({ command }) => command,
  parse: parseCommandResult,
});

const candidateVerification = defineCheckSuite({
  name: "round-02-candidate-verification",
  description: "Replays every observed seed and runs repository quality on the candidate generation.",
  input: CandidateVerificationInput,
  checks: ({ command, qualityCommand, seedFlag, seeds }, use) =>
    Object.fromEntries([
      ...seeds.map(
        (seed, index) => [`seed:${index + 1}:${seed}`, use(seededTest, { command, seedFlag, seed })] as const,
      ),
      ["quality", use(repositoryQuality, { command: qualityCommand })] as const,
    ]),
  concurrency: 4,
});

const stabilizedCandidate = defineGoal({
  name: "round-02-stabilized-candidate",
  check: candidateVerification,
  defaults: { attempts: 3 },
});

const hypothesisPrompt = definePrompt({
  name: "round-02-flake-hypothesis",
  input: HypothesisInput,
  render: ({ target, trials }) => [
    prompt.section("Target", target),
    prompt.json("Deterministic trials", trials),
    prompt.section(
      "Analysis contract",
      [
        "Treat each seed and workspace snapshot as evidence, not as a probabilistic anecdote.",
        "Explain one falsifiable mechanism for the pass/fail split.",
        "Name suspected files, contrary evidence, confidence, and the smallest sound repair.",
        "Do not modify files.",
      ].join("\n"),
    ),
  ],
});

const flakyTestAnalyst = defineAgent({
  name: "round-02-flaky-test-analyst",
  description: "Forms a repository-grounded, falsifiable hypothesis from deterministic test evidence.",
  prompt: hypothesisPrompt,
  schema: FlakeHypothesis,
  defaults: { maxTurns: 16, timeout: "20m" },
});

const fixPrompt = definePrompt({
  name: "round-02-flaky-test-fix",
  input: FixInput,
  render: ({ target, command, seedFlag, trials, hypothesis }) => [
    prompt.section("Target", target),
    prompt.json("Focused command", { command, seedFlag }),
    prompt.json("Baseline evidence", trials),
    prompt.json("Hypothesis", hypothesis),
    prompt.section(
      "Implementation contract",
      [
        "Reproduce at least one failing seed before editing.",
        "Fix the underlying ordering, timing, isolation, or shared-state defect; do not add retries or sleeps.",
        "Keep the edit inside the supplied write scope.",
        "Let the attached goal replay all observed seeds and quality checks on each candidate generation.",
      ].join("\n"),
    ),
  ],
});

const flakyTestFixer = defineAgent({
  name: "round-02-flaky-test-fixer",
  description: "Repairs one evidenced flaky test in an isolated candidate workspace.",
  prompt: fixPrompt,
  schema: FixResult,
  defaults: { maxTurns: 28, timeout: "45m", repair: 1 },
});

const flakyTestEvidence = defineArtifact({
  name: "round-02-flaky-test-evidence",
  mediaType: "application/json",
  extension: ".json",
  content: FlakyTestEvidenceContent,
  metadata: FlakyTestEvidenceMetadata,
});

/**
 * Why: Requires the engine's workspace snapshot before evidence can influence a repair decision.
 * Use: Read the exact candidate carried by a deterministic check result.
 */
function requireCandidate(result: CheckResult): WorkspaceSnapshotRef {
  return result.candidate;
}

/**
 * Why: Proves every baseline trial observed one unchanged source generation rather than a moving checkout.
 * Use: Call it before treating the pass/fail split as evidence of flakiness.
 */
function requireStableBaseline(trials: readonly SeedTrialRecord[]): WorkspaceSnapshotRef {
  const first = trials.at(0);
  if (first === undefined) {
    throw new Error("At least one baseline trial is required");
  }

  const source = first.candidate;
  const drifted = trials.find(
    ({ candidate }) =>
      candidate.workspaceId !== source.workspaceId ||
      candidate.generation !== source.generation ||
      candidate.treeHash !== source.treeHash,
  );
  if (drifted !== undefined) {
    throw new Error("The source workspace changed while collecting flaky-test evidence");
  }
  return source;
}

/**
 * Why: Rejects one-sided runs that prove only a stable pass or stable failure, not an intermittent defect.
 * Use: Split the baseline into the exact seeds the candidate goal must replay.
 */
function classifySeeds(trials: readonly SeedTrialRecord[]): FlakeClassification {
  const failing = trials.filter(({ status }) => status === "fail").map(({ seed }) => seed);
  const passing = trials.filter(({ status }) => status === "pass").map(({ seed }) => seed);
  if (failing.length === 0 || passing.length === 0) {
    throw new Error("The deterministic sample did not reproduce both passing and failing outcomes");
  }
  return { failing, passing };
}

/**
 * Why: Names the two-sided seed partition returned by deterministic baseline classification.
 * Use: Feed all observed seeds into the candidate goal and preserve the original split as evidence.
 */
interface FlakeClassification {
  failing: number[];
  passing: number[];
}

/**
 * Why: Converts an invoked check result into the stable artifact and agent-input schema.
 * Use: Retain its seed, verdict, evidence, and exact workspace candidate after each sequence item.
 */
function toSeedTrial(
  ordinal: number,
  seed: number,
  result: CheckResultOf<typeof seededTest>,
): SeedTrialRecord {
  return {
    ordinal,
    seed,
    status: result.status,
    candidate: requireCandidate(result),
    ...(result.summary === undefined ? {} : { summary: result.summary }),
    ...(result.evidence === undefined ? {} : { evidence: result.evidence }),
  };
}

/**
 * Why: Verifies patch lineage without ordering generation counters from different workspace identities.
 * Use: Check that the isolated candidate forks from the measured source and produces a different tree.
 */
function assertCandidateLineage(
  source: WorkspaceSnapshotRef,
  candidate: WorkspaceSnapshotRef,
  patchBaseTree: string,
): void {
  if (patchBaseTree !== source.treeHash) {
    throw new Error("The candidate patch was not based on the measured source tree");
  }
  if (candidate.workspaceId === source.workspaceId) {
    throw new Error("The fix did not run in an isolated candidate workspace");
  }
  if (candidate.treeHash === source.treeHash) {
    throw new Error("The accepted candidate did not produce a new tree");
  }
}

/**
 * Why: Demonstrates evidence-first flaky-test repair with immutable source and candidate snapshot identities.
 * Use: Launch it with a focused seed-aware test command, a quality command, and a strict write scope.
 */
const flakyTestTriageWorkflow = defineWorkflow(
  {
    id: "round-02-flaky-test-triage",
    name: "Flaky-test triage",
    description: "Reproduce a flake deterministically, repair it in isolation, and retain typed proof.",
    input: FlakyTestInput,
    output: FlakyTestOutput,
  },
  async (ctx, input) => {
    const seeds = Array.from({ length: input.repetitions }, (_, index) => input.baseSeed + index);

    const baselineResults = await ctx.step("collect-baseline", (step) =>
      step.sequence(
        seeds,
        {
          key: "baseline-trials",
          keyOf: (seed, index) => `${index + 1}-${seed}`,
          labelOf: (_seed, index) => `Trial ${index + 1}`,
        },
        async (seed, scope, index) => {
          const result = await scope.ctx.check(
            seededTest,
            { command: input.command, seedFlag: input.seedFlag, seed },
            { key: scope.key("seeded-test") },
          );
          return toSeedTrial(index + 1, seed, result);
        },
      ),
    );

    const sourceSnapshot = requireStableBaseline(baselineResults);
    const classification = classifySeeds(baselineResults);

    const analysis = await ctx.step("form-hypothesis", (step) =>
      step.agent(
        flakyTestAnalyst,
        { target: input.target, trials: baselineResults },
        {
          key: "flaky-test-analysis",
        },
      ),
    );
    expectType<AgentResult<FlakeHypothesisValue>>(analysis);

    const implementation = await ctx.step("repair-candidate", async (step) => {
      const writeScope = await step.paths.resolve(
        flakyTestWritePolicy,
        { proposedPaths: input.allowedPaths },
        { key: "resolve-flaky-test-write-paths", label: "Resolve repair paths" },
      );
      return step.agent(
        flakyTestFixer,
        {
          target: input.target,
          command: input.command,
          seedFlag: input.seedFlag,
          trials: baselineResults,
          hypothesis: analysis.value,
        },
        {
          key: "flaky-test-fix",
          write: writeScope,
          goal: {
            definition: stabilizedCandidate,
            input: {
              command: input.command,
              qualityCommand: input.qualityCommand,
              seedFlag: input.seedFlag,
              seeds,
            },
            attempts: 3,
          },
        },
      );
    });

    expectType<PatchAgentResult<FixResultValue, typeof implementation.goal>>(implementation);
    const candidateSnapshot = implementation.goal.candidate;
    const verification = implementation.goal.results.check;
    if (!verification.passed) {
      throw new Error("The completion goal returned without passing candidate verification");
    }
    assertCandidateLineage(sourceSnapshot, candidateSnapshot, implementation.patch.baseTree);

    const evidence = await ctx.artifact(
      flakyTestEvidence,
      {
        content: {
          target: input.target,
          sourceSnapshot,
          trials: baselineResults,
          failingSeeds: classification.failing,
          passingSeeds: classification.passing,
          hypothesis: analysis.value,
          fix: implementation.value,
          candidate: {
            snapshot: candidateSnapshot,
            attempts: implementation.goal.attempts,
            goalEvidence: implementation.goal.evidence,
            qualityPassed: true,
            patch: {
              ref: implementation.patch.ref,
              key: implementation.patch.key,
              files: [...implementation.patch.files],
              baseTree: implementation.patch.baseTree,
            },
          },
        },
        metadata: {
          sourceWorkspaceId: sourceSnapshot.workspaceId,
          sourceGeneration: sourceSnapshot.generation,
          sourceTreeHash: sourceSnapshot.treeHash,
          candidateWorkspaceId: candidateSnapshot.workspaceId,
          candidateGeneration: candidateSnapshot.generation,
          candidateTreeHash: candidateSnapshot.treeHash,
        },
      },
      {
        key: "flaky-test-evidence",
        label: `Flaky-test proof for ${input.target}`,
        candidate: candidateSnapshot,
      },
    );

    expectType<MetadataArtifactRef<unknown, FlakyTestEvidenceMetadataValue>>(evidence);

    await ctx.note({
      key: "record-flaky-test-verification",
      kind: "claim",
      text: `${input.target} passed every observed deterministic seed on an isolated candidate.`,
      evidence: `${implementation.goal.evidence}\nArtifact: ${evidence.ref}`,
    });

    const output = {
      target: input.target,
      status: "stabilized",
      observedFailures: classification.failing.length,
      observedPasses: classification.passing.length,
      patch: {
        ref: implementation.patch.ref,
        key: implementation.patch.key,
        files: [...implementation.patch.files],
        baseTree: implementation.patch.baseTree,
      },
      evidenceRef: evidence.ref,
      evidenceSha256: evidence.sha256,
      sourceSnapshot,
      candidateSnapshot,
    } satisfies FlakyTestOutputValue;

    return output;
  },
);

// Definitions are globally registrable WorkflowNodes; their execution envelopes
// appear only after a context binds input, write isolation, goals, and error policy.
expectType<WorkflowNode<"weft.check">>(seededTest);
expectType<WorkflowNode<"weft.check-suite">>(candidateVerification);
expectType<WorkflowNode<"weft.goal">>(stabilizedCandidate);
expectType<WorkflowNode<"weft.agent">>(flakyTestFixer);
expectType<WorkflowNode<"weft.artifact">>(flakyTestEvidence);
expectType<WorkflowNode<"weft.workflow">>(flakyTestTriageWorkflow);
