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
  type WorkspaceSubject,
  z,
} from "../../index.ts";

declare function expectType<Type>(value: Type): void;

/** Why: Refines one engine-minted subject so exact-subject inference remains observable. Use: Compile-time fixture only. */
type CandidateSubject = WorkspaceSnapshotRef & {
  readonly workspaceId: "round-10-candidate";
  readonly generation: 10;
};

/** Why: Names a distinct generation that must never accept candidate evidence. Use: Negative compile-time fixture only. */
type OtherSubject = WorkspaceSnapshotRef & {
  readonly workspaceId: "round-10-other";
  readonly generation: 11;
};

const subjectCheck = defineCheck({
  name: "round-10-subject-check",
  policy: "required",
  command: ["pnpm", "test"],
});

const subjectSuite = defineCheckSuite({
  name: "round-10-subject-suite",
  checks: [subjectCheck],
});

const eligibleSubjectCheck = defineCheck({
  name: "round-10-eligible-subject-check",
  revision: "subject-check-v1",
  policy: "required",
  waiver: {
    mode: "eligible",
    binding: "checks.subject-waiver",
    action: "Waive the exact failed subject check",
    risk: "high",
    maxTtl: "30m",
  },
  command: ["pnpm", "test"],
});

const subjectArtifact = defineArtifact({
  name: "round-10-subject-artifact",
  mediaType: "application/json",
  content: z.object({ summary: z.string() }),
});

const sameShapeOtherArtifact = defineArtifact({
  name: "round-10-other-subject-artifact",
  mediaType: "application/json",
  content: z.object({ summary: z.string() }),
});

const subjectGoal = defineGoal({
  name: "round-10-subject-goal",
  check: subjectSuite,
});

expectType<"round-10-subject-suite">(subjectSuite.name);
expectType<"round-10-subject-suite">(null as unknown as CheckSuiteNameOf<typeof subjectSuite>);
expectType<"round-10-subject-artifact">(subjectArtifact.name);
expectType<"round-10-subject-artifact">(null as unknown as ArtifactNameOf<typeof subjectArtifact>);
expectType<"round-10-subject-goal">(subjectGoal.name);
expectType<"round-10-subject-goal">(null as unknown as GoalNameOf<typeof subjectGoal>);

declare const goalInvocation: GoalInvocation<typeof subjectGoal>;
expectType<typeof subjectGoal>(goalInvocation.definition);
expectType<"round-10-subject-goal">(goalInvocation.definition.name);

// @ts-expect-error Exact individual-check options require a nominal subject or a subject-bound waiver.
const missingCheckSubject: CheckInvocationOptions<typeof subjectCheck, CandidateSubject> = {
  key: "missing-check-subject",
};
expectType<CheckInvocationOptions<typeof subjectCheck, CandidateSubject>>(missingCheckSubject);

// @ts-expect-error Exact suite options require nominal subject evidence.
const missingSuiteSubject: CheckSuiteInvocationOptions<CandidateSubject> = {
  keyPrefix: "missing-suite-subject",
};
expectType<CheckSuiteInvocationOptions<CandidateSubject>>(missingSuiteSubject);

/** Why: Exercises broad and exact check paths plus bound and unbound artifact capture. Use: Typecheck only. */
async function exerciseSubjectSoundness(
  ctx: Ctx,
  candidateSubject: CandidateSubject,
  otherSubject: OtherSubject,
  waiver: CheckWaiverRef<typeof eligibleSubjectCheck, CandidateSubject>,
): Promise<void> {
  const unboundCheck = await ctx.check(subjectCheck, { key: "unbound-check" });
  expectType<WorkspaceSubject>(unboundCheck.subject);
  // @ts-expect-error An unbound call cannot claim the caller-selected refined candidate subject.
  expectType<CandidateSubject>(unboundCheck.subject);

  const exactCheck = await ctx.check(subjectCheck, {
    key: "exact-check",
    subject: candidateSubject,
  });
  expectType<CandidateSubject>(exactCheck.subject);
  // @ts-expect-error Candidate check evidence cannot be relabeled as another generation.
  expectType<OtherSubject>(exactCheck.subject);

  // @ts-expect-error Explicit subject generics do not replace the required nominal subject option.
  await ctx.check<typeof subjectCheck, CandidateSubject>(subjectCheck, {
    key: "forged-exact-check",
  });

  const waivedCheck = await ctx.check(eligibleSubjectCheck, {
    key: "waived-check",
    waive: waiver,
  });
  expectType<CandidateSubject>(waivedCheck.subject);
  // @ts-expect-error Nominal waiver authority cannot be paired with another exact subject.
  await ctx.check(eligibleSubjectCheck, {
    key: "mismatched-waived-check",
    waive: waiver,
    subject: otherSubject,
  });

  const unboundSuite = await ctx.check(subjectSuite, { keyPrefix: "unbound-suite" });
  expectType<WorkspaceSubject>(unboundSuite.subject);
  // @ts-expect-error An unbound suite result cannot claim the refined candidate subject.
  expectType<CandidateSubject>(unboundSuite.subject);

  const exactSuite = await ctx.check(subjectSuite, {
    keyPrefix: "exact-suite",
    subject: candidateSubject,
  });
  expectType<CandidateSubject>(exactSuite.subject);
  expectType<CandidateSubject>(exactSuite.results["round-10-subject-check"].subject);
  expectType<SubjectAttestation<"check-suite", typeof exactSuite.results, CandidateSubject>>(
    exactSuite.attestation,
  );
  expectType<SubjectAttestation<"check-suite", typeof exactSuite.results, OtherSubject>>(
    // @ts-expect-error Suite-level evidence remains tied to the candidate generation.
    exactSuite.attestation,
  );

  const boundArtifact = await ctx.artifact(
    subjectArtifact,
    { content: { summary: "candidate evidence" } },
    { key: "bound-artifact", subject: candidateSubject },
  );
  expectType<CandidateSubject>(boundArtifact.subject);
  expectType<"round-10-subject-artifact">(boundArtifact.name);
  expectType<SubjectAttestation<"artifact", { summary: string }, CandidateSubject>>(
    boundArtifact.attestation,
  );
  expectType<ArtifactRefOf<typeof subjectArtifact, CandidateSubject>>(boundArtifact);
  expectType<ArtifactRefBase<unknown>>(boundArtifact);
  // @ts-expect-error Same-shaped artifact definitions retain distinct exact names in their refs.
  expectType<ArtifactRefOf<typeof sameShapeOtherArtifact, CandidateSubject>>(boundArtifact);
  // @ts-expect-error A candidate artifact cannot be consumed as evidence for another generation.
  expectType<ArtifactRefOf<typeof subjectArtifact, OtherSubject>>(boundArtifact);

  const unboundArtifact = await ctx.artifact(
    subjectArtifact,
    { content: { summary: "global evidence" } },
    { key: "unbound-artifact" },
  );
  expectType<undefined>(unboundArtifact.subject);
  expectType<undefined>(unboundArtifact.attestation);

  expectType<OtherSubject>(otherSubject);
}

expectType<
  (
    ctx: Ctx,
    candidateSubject: CandidateSubject,
    otherSubject: OtherSubject,
    waiver: CheckWaiverRef<typeof eligibleSubjectCheck, CandidateSubject>,
  ) => Promise<void>
>(exerciseSubjectSoundness);
