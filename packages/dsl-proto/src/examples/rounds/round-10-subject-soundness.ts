import { z } from "zod";

import {
  type ArtifactNameOf,
  type ArtifactRefBase,
  type ArtifactRefOf,
  type CheckInvocationOptions,
  type CheckSuiteInvocationOptions,
  type CheckSuiteNameOf,
  type CheckWaiverRef,
  type Ctx,
  defineArtifact,
  defineCheck,
  defineCheckSuite,
  defineGoal,
  type GoalInvocation,
  type GoalNameOf,
  type SubjectAttestation,
  type WorkspaceSnapshotRef,
} from "../../core/index.ts";

declare function expectType<Type>(value: Type): void;

/** Why: Refines one engine-minted snapshot so exact-candidate inference remains observable. Use: Compile-time fixture only. */
type CandidateSnapshot = WorkspaceSnapshotRef & {
  readonly workspaceId: "round-10-candidate";
  readonly generation: 10;
};

/** Why: Names a distinct generation that must never accept candidate evidence. Use: Negative compile-time fixture only. */
type OtherSnapshot = WorkspaceSnapshotRef & {
  readonly workspaceId: "round-10-other";
  readonly generation: 11;
};

const candidateCheck = defineCheck({
  name: "round-10-candidate-check",
  policy: "required",
  command: ["pnpm", "test"],
});

const candidateSuite = defineCheckSuite({
  name: "round-10-candidate-suite",
  checks: [candidateCheck],
});

const eligibleCandidateCheck = defineCheck({
  name: "round-10-eligible-candidate-check",
  revision: "candidate-check-v1",
  policy: "required",
  waiver: {
    mode: "eligible",
    binding: "checks.candidate-waiver",
    action: "Waive the exact failed candidate check",
    risk: "high",
    maxTtl: "30m",
  },
  command: ["pnpm", "test"],
});

const candidateArtifact = defineArtifact({
  name: "round-10-candidate-artifact",
  mediaType: "application/json",
  content: z.object({ summary: z.string() }),
});

const sameShapeOtherArtifact = defineArtifact({
  name: "round-10-other-candidate-artifact",
  mediaType: "application/json",
  content: z.object({ summary: z.string() }),
});

const candidateGoal = defineGoal({
  name: "round-10-candidate-goal",
  check: candidateSuite,
});

expectType<"round-10-candidate-suite">(candidateSuite.name);
expectType<"round-10-candidate-suite">(null as unknown as CheckSuiteNameOf<typeof candidateSuite>);
expectType<"round-10-candidate-artifact">(candidateArtifact.name);
expectType<"round-10-candidate-artifact">(null as unknown as ArtifactNameOf<typeof candidateArtifact>);
expectType<"round-10-candidate-goal">(candidateGoal.name);
expectType<"round-10-candidate-goal">(null as unknown as GoalNameOf<typeof candidateGoal>);

declare const goalInvocation: GoalInvocation<typeof candidateGoal>;
expectType<typeof candidateGoal>(goalInvocation.definition);
expectType<"round-10-candidate-goal">(goalInvocation.definition.name);

// @ts-expect-error Exact individual-check options require a nominal candidate or a candidate-bound waiver.
const missingCheckCandidate: CheckInvocationOptions<typeof candidateCheck, CandidateSnapshot> = {
  key: "missing-check-candidate",
};
expectType<CheckInvocationOptions<typeof candidateCheck, CandidateSnapshot>>(missingCheckCandidate);

// @ts-expect-error Exact suite options require a nominal candidate or candidate-bound waiver evidence.
const missingSuiteCandidate: CheckSuiteInvocationOptions<CandidateSnapshot> = {
  key: "missing-suite-candidate",
};
expectType<CheckSuiteInvocationOptions<CandidateSnapshot>>(missingSuiteCandidate);

/** Why: Exercises broad and exact check paths plus bound and unbound artifact capture. Use: Typecheck only. */
async function exerciseCandidateSoundness(
  ctx: Ctx,
  candidateSnapshot: CandidateSnapshot,
  otherSnapshot: OtherSnapshot,
  waiver: CheckWaiverRef<typeof eligibleCandidateCheck, CandidateSnapshot>,
): Promise<void> {
  const unboundCheck = await ctx.check(candidateCheck, { key: "unbound-check" });
  expectType<WorkspaceSnapshotRef>(unboundCheck.candidate);
  // @ts-expect-error An unbound call cannot claim the caller-selected refined candidate snapshot.
  expectType<CandidateSnapshot>(unboundCheck.candidate);

  const exactCheck = await ctx.check(candidateCheck, {
    key: "exact-check",
    candidate: candidateSnapshot,
  });
  expectType<CandidateSnapshot>(exactCheck.candidate);
  // @ts-expect-error Candidate check evidence cannot be relabeled as another generation.
  expectType<OtherSnapshot>(exactCheck.candidate);

  // @ts-expect-error Explicit candidate generics do not replace the required nominal candidate option.
  await ctx.check<typeof candidateCheck, CandidateSnapshot>(candidateCheck, {
    key: "forged-exact-check",
  });

  const waivedCheck = await ctx.check(eligibleCandidateCheck, {
    key: "waived-check",
    waive: waiver,
  });
  expectType<CandidateSnapshot>(waivedCheck.candidate);
  // @ts-expect-error Nominal waiver authority cannot be paired with another exact candidate.
  await ctx.check(eligibleCandidateCheck, {
    key: "mismatched-waived-check",
    waive: waiver,
    candidate: otherSnapshot,
  });

  const unboundSuite = await ctx.check(candidateSuite, { key: "unbound-suite" });
  expectType<WorkspaceSnapshotRef>(unboundSuite.candidate);
  // @ts-expect-error An unbound suite result cannot claim the refined candidate snapshot.
  expectType<CandidateSnapshot>(unboundSuite.candidate);

  const exactSuite = await ctx.check(candidateSuite, {
    key: "exact-suite",
    candidate: candidateSnapshot,
  });
  expectType<CandidateSnapshot>(exactSuite.candidate);
  expectType<CandidateSnapshot>(exactSuite.results["round-10-candidate-check"].candidate);
  expectType<SubjectAttestation<"check-suite", typeof exactSuite.results, CandidateSnapshot>>(
    exactSuite.attestation,
  );
  expectType<SubjectAttestation<"check-suite", typeof exactSuite.results, OtherSnapshot>>(
    // @ts-expect-error Suite-level evidence remains tied to the candidate generation.
    exactSuite.attestation,
  );

  const boundArtifact = await ctx.artifact(
    candidateArtifact,
    { content: { summary: "candidate evidence" } },
    { key: "bound-artifact", candidate: candidateSnapshot },
  );
  expectType<CandidateSnapshot>(boundArtifact.candidate);
  expectType<"round-10-candidate-artifact">(boundArtifact.name);
  expectType<SubjectAttestation<"artifact", { summary: string }, CandidateSnapshot>>(
    boundArtifact.attestation,
  );
  expectType<ArtifactRefOf<typeof candidateArtifact, CandidateSnapshot>>(boundArtifact);
  expectType<ArtifactRefBase<unknown>>(boundArtifact);
  // @ts-expect-error Same-shaped artifact definitions retain distinct exact names in their refs.
  expectType<ArtifactRefOf<typeof sameShapeOtherArtifact, CandidateSnapshot>>(boundArtifact);
  // @ts-expect-error A candidate artifact cannot be consumed as evidence for another generation.
  expectType<ArtifactRefOf<typeof candidateArtifact, OtherSnapshot>>(boundArtifact);

  const unboundArtifact = await ctx.artifact(
    candidateArtifact,
    { content: { summary: "global evidence" } },
    { key: "unbound-artifact" },
  );
  expectType<undefined>(unboundArtifact.candidate);
  expectType<undefined>(unboundArtifact.attestation);

  expectType<OtherSnapshot>(otherSnapshot);
}

expectType<
  (
    ctx: Ctx,
    candidateSnapshot: CandidateSnapshot,
    otherSnapshot: OtherSnapshot,
    waiver: CheckWaiverRef<typeof eligibleCandidateCheck, CandidateSnapshot>,
  ) => Promise<void>
>(exerciseCandidateSoundness);

/** Why: Exercises advanced workspace diagnostics without burdening the ordinary facade. Use: Typecheck only. */
async function exerciseAdvancedWorkspaceDiagnostics(
  ctx: Ctx<unknown, unknown, true>,
  candidateSnapshot: CandidateSnapshot,
  otherSnapshot: OtherSnapshot,
): Promise<void> {
  expectType<boolean>(ctx.workspace.sameSnapshot(candidateSnapshot, otherSnapshot));
  await ctx.workspace.assertUnchanged(candidateSnapshot);
}

expectType<
  (
    ctx: Ctx<unknown, unknown, true>,
    candidateSnapshot: CandidateSnapshot,
    otherSnapshot: OtherSnapshot,
  ) => Promise<void>
>(exerciseAdvancedWorkspaceDiagnostics);
