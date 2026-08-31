/** Declaration-only checks surface for the Weft DSL prototype. */

import type {
  AnySchema,
  DefinitionTypeCarrier,
  Duration,
  HostBinding,
  InferIn,
  InferOut,
  InputMode,
  NominalValue,
  PromotionProof,
  Risk,
  SubjectAttestation,
  WorkflowNode,
  WorkspaceSnapshotRef,
} from "./shared.ts";

// ---------------------------------------------------------------------------
// Checks and check suites
// ---------------------------------------------------------------------------

/** Check status. */
export type CheckStatus = "pass" | "fail";
/** Check policy. */
export type CheckPolicy = "required" | "advisory";

/**
 * Why: Makes the default denial of check waivers explicit and inspectable on every check definition.
 * Use: Omit `waiver` in `defineCheck` configs to receive this policy, or declare `{ mode: "never" }` explicitly.
 */
export interface NeverCheckWaiverPolicy {
  readonly mode: "never";
}

/**
 * Why: Declares the host authority and non-weakenable bounds for the exceptional waiver path of one check.
 * Use: Attach it only to a revisioned check whose failure policy permits a short-lived exception.
 */
export interface EligibleCheckWaiverPolicy {
  readonly mode: "eligible";
  readonly binding: HostBinding;
  readonly action: string;
  readonly risk: Risk;
  readonly maxTtl: Duration;
}

/**
 * Why: Makes waiver eligibility a closed definition-time choice instead of a caller-selected invocation option.
 * Use: Narrow on `mode`; workflow invocations cannot replace or weaken the selected branch.
 */
export type CheckWaiverPolicy = NeverCheckWaiverPolicy | EligibleCheckWaiverPolicy;
/** Check disposition. */
export type CheckDisposition = "executed" | "trusted" | "waived";

/**
 * Why: Keeps verification evidence structured enough for reports, UIs, and agent remediation.
 * Use: Return these entries from a check parser or function result.
 */
export interface TextCheckEvidence {
  kind: "text";
  text: string;
}

/** File check evidence. */
export interface FileCheckEvidence {
  kind: "file";
  path: string;
  line?: number;
  message?: string;
}

/** Metric check evidence. */
export interface MetricCheckEvidence {
  kind: "metric";
  name: string;
  actual: number;
  expected?: number;
  unit?: string;
}

/** Command check evidence. */
export interface CommandCheckEvidence {
  kind: "command";
  exitCode: number;
  output?: string;
}

/** Artifact check evidence. */
export interface ArtifactCheckEvidence {
  kind: "artifact";
  ref: string;
  label?: string;
}

/**
 * Why: Keeps verification evidence structured enough for reports, UIs, and agent remediation.
 * Use: Return these entries from a check parser or function result.
 */
export type CheckEvidence =
  | TextCheckEvidence
  | FileCheckEvidence
  | MetricCheckEvidence
  | CommandCheckEvidence
  | ArtifactCheckEvidence;

/** Check execution result. */
export interface CheckExecutionResult<Details extends readonly CheckEvidence[] = readonly CheckEvidence[]> {
  readonly status: CheckStatus;
  readonly summary?: string;
  readonly evidence?: string;
  readonly details?: Details;
}

/**
 * Why: Names the successful execution payload carried by exact-candidate check attestations.
 * Use: Prefer it to intersecting an anonymous status discriminator into `CheckExecutionResult`.
 */
export interface PassedCheckExecutionResult<
  Details extends readonly CheckEvidence[] = readonly CheckEvidence[],
> extends CheckExecutionResult<Details> {
  readonly status: "pass";
}

/**
 * Why: Names the failed execution payload accepted by waiver authorization and failure attestations.
 * Use: Prefer it to intersecting an anonymous status discriminator into `CheckExecutionResult`.
 */
export interface FailedCheckExecutionResult<
  Details extends readonly CheckEvidence[] = readonly CheckEvidence[],
> extends CheckExecutionResult<Details> {
  readonly status: "fail";
}

/**
 * Why: Prevents a result for another check definition from satisfying waiver authorization structurally.
 * Use: It is carried only by engine-minted check results.
 */
declare const checkResultBrand: unique symbol;

/**
 * Why: Centralizes engine-minted identity and exact-candidate evidence shared by every check-result branch.
 * Use: Extend it only through the closed executed, trusted, and waived result contracts below.
 */
export interface CheckResultBase<
  Details extends readonly CheckEvidence[] = readonly CheckEvidence[],
  Candidate extends WorkspaceSnapshotRef = WorkspaceSnapshotRef,
  Definition extends AnyCheckDefinition = AnyCheckDefinition,
> extends CheckExecutionResult<Details>,
    NominalValue<readonly ["check-result", Definition, Candidate]> {
  readonly candidate: Candidate;
  readonly attestation: SubjectAttestation<"check", CheckExecutionResult<Details>, Candidate>;
  readonly [checkResultBrand]: readonly [definition: Definition, candidate: Candidate];
}

/**
 * Why: Makes an executed passing verdict a distinct branch for sound control-flow narrowing.
 * Use: Require it where exact-candidate verification must actually run and pass.
 */
export interface ExecutedPassedCheckResult<
  Details extends readonly CheckEvidence[] = readonly CheckEvidence[],
  Candidate extends WorkspaceSnapshotRef = WorkspaceSnapshotRef,
  Definition extends AnyCheckDefinition = AnyCheckDefinition,
> extends CheckResultBase<Details, Candidate, Definition> {
  readonly status: "pass";
  readonly disposition: "executed";
  readonly attestation: SubjectAttestation<"check", PassedCheckExecutionResult<Details>, Candidate>;
  readonly proof: PromotionProof<"check", Candidate>;
  readonly waiver?: never;
}

/**
 * Why: Makes an executed failure the only result branch accepted by waiver authorization.
 * Use: Narrow an eligible result to this branch before calling `ctx.check.authorizeWaiver`.
 */
export interface ExecutedFailedCheckResult<
  Details extends readonly CheckEvidence[] = readonly CheckEvidence[],
  Candidate extends WorkspaceSnapshotRef = WorkspaceSnapshotRef,
  Definition extends AnyCheckDefinition = AnyCheckDefinition,
> extends CheckResultBase<Details, Candidate, Definition> {
  readonly status: "fail";
  readonly disposition: "executed";
  readonly attestation: SubjectAttestation<"check", FailedCheckExecutionResult<Details>, Candidate>;
  readonly waiver?: never;
}

/**
 * Why: Separates reused host-trusted evidence from both fresh execution and exceptional waiver authority.
 * Use: Inspect its source through invocation history; it can never authorize a waiver.
 */
export interface TrustedCheckResult<
  Details extends readonly CheckEvidence[] = readonly CheckEvidence[],
  Candidate extends WorkspaceSnapshotRef = WorkspaceSnapshotRef,
  Definition extends AnyCheckDefinition = AnyCheckDefinition,
> extends CheckResultBase<Details, Candidate, Definition> {
  readonly disposition: "trusted";
  readonly waiver?: never;
}

/**
 * Why: Carries every non-waived verdict as a discriminated union that narrows by execution and status.
 * Use: Inspect `status`, `disposition`, `candidate`, and `attestation` after an ordinary invocation.
 */
export type NonWaivedCheckResult<
  Details extends readonly CheckEvidence[] = readonly CheckEvidence[],
  Candidate extends WorkspaceSnapshotRef = WorkspaceSnapshotRef,
  Definition extends AnyCheckDefinition = AnyCheckDefinition,
> =
  | ExecutedPassedCheckResult<Details, Candidate, Definition>
  | ExecutedFailedCheckResult<Details, Candidate, Definition>
  | TrustedCheckResult<Details, Candidate, Definition>;

/**
 * Why: Retains the exact nominal waiver authority on every waived verdict instead of reducing it to a disposition string.
 * Use: Narrow `disposition === "waived"`, then preserve `waiver` with delivery or audit evidence.
 */
export interface WaivedCheckResult<
  Details extends readonly CheckEvidence[] = readonly CheckEvidence[],
  Candidate extends WorkspaceSnapshotRef = WorkspaceSnapshotRef,
  Definition extends WaiverEligibleCheckDefinition = WaiverEligibleCheckDefinition,
> extends CheckResultBase<Details, Candidate, Definition> {
  readonly status: "fail";
  readonly disposition: "waived";
  readonly waiver: CheckWaiverRef<Definition, Candidate>;
}

/**
 * Why: Carries a definition-specific verdict, evidence, disposition, and exact observed workspace generation.
 * Use: Inspect it after `ctx.check`; only eligible definitions can produce the waived branch.
 */
export type CheckResult<
  Details extends readonly CheckEvidence[] = readonly CheckEvidence[],
  Candidate extends WorkspaceSnapshotRef = WorkspaceSnapshotRef,
  Definition extends AnyCheckDefinition = AnyCheckDefinition,
> =
  | NonWaivedCheckResult<Details, Candidate, Definition>
  | (Definition extends WaiverEligibleCheckDefinition
      ? WaivedCheckResult<Details, Candidate, Definition>
      : never);

/** Command result. */
export interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/** Check run context. */
export interface CheckRunContext {
  signal: AbortSignal;
}

/**
 * Why: Prevents a command-backed check from reaching the engine without an executable at tuple position zero.
 * Use: Return or provide `[executable, ...arguments]` from a command check configuration.
 */
export type CheckCommand = readonly [executable: string, ...arguments: string[]];

/** Check defaults. */
export interface CheckDefaults {
  timeout?: Duration;
}

/**
 * Why: Names the hidden input, result, waiver, revision, and definition-form relationships of one check.
 * Use: Check builders construct it; authors normally consume its fields through definition extractors.
 */
export interface CheckTypes {
  readonly input: unknown;
  readonly parsedInput: unknown;
  readonly executionResult: CheckExecutionResult;
  readonly result: unknown;
  readonly waiver: CheckWaiverPolicy;
  readonly revision: string;
  readonly inputMode: InputMode;
}

/** Exact hidden type relationships carried by one reusable check definition. */
export type CheckTypesOf<Definition> =
  Definition extends CheckDefinition<infer Types, any> ? Types : never;

/** Hidden relationship bag constructed by the check builder overloads. */
type DefinedCheckTypes<
  Input,
  ParsedInput,
  Result extends CheckExecutionResult,
  Waiver extends CheckWaiverPolicy,
  Revision extends string,
  Mode extends InputMode,
> = {
  readonly input: Input;
  readonly parsedInput: ParsedInput;
  readonly executionResult: Result;
  readonly result: CheckResult<NonNullable<Result["details"]>, WorkspaceSnapshotRef>;
  readonly waiver: Waiver;
  readonly revision: Revision;
  readonly inputMode: Mode;
};

/** Broad hidden relationship bag constrained to one waiver-policy branch. */
type CheckTypesWithWaiver<Waiver extends CheckWaiverPolicy> = Omit<CheckTypes, "waiver"> & {
  readonly waiver: Waiver;
};

/** Broad hidden relationship bag constrained to one waiver branch and definition-form input mode. */
type CheckTypesWithWaiverAndInputMode<
  Waiver extends CheckWaiverPolicy,
  Mode extends InputMode,
> = Omit<CheckTypes, "waiver" | "inputMode"> & {
  readonly waiver: Waiver;
  readonly inputMode: Mode;
};

/** Any check definition constrained to one builder-level input mode without erasing waiver eligibility. */
type CheckDefinitionWithInputMode<Mode extends InputMode> =
  | CheckDefinition<CheckTypesWithWaiverAndInputMode<NeverCheckWaiverPolicy, Mode>, string>
  | CheckDefinition<CheckTypesWithWaiverAndInputMode<EligibleCheckWaiverPolicy, Mode>, string>;

/**
 * Why: Captures a named deterministic verification contract independently from any particular invocation.
 * Use: Create it with `defineCheck`, then invoke it through `ctx.check`, a suite, or an agent goal.
 */
export interface CheckDefinition<
  Types extends CheckTypes = CheckTypes,
  Name extends string = string,
> extends WorkflowNode<"weft.check">,
    DefinitionTypeCarrier<Types> {
  readonly kind: "weft.check";
  readonly name: Name;
  readonly description?: string;
  readonly policy: Types["waiver"] extends EligibleCheckWaiverPolicy ? "required" : CheckPolicy;
  readonly revision: Types["waiver"] extends EligibleCheckWaiverPolicy
    ? Types["revision"]
    : string | undefined;
  readonly waiver: Readonly<Types["waiver"]>;
  readonly input?: AnySchema;
  readonly defaults?: Readonly<CheckDefaults>;
}

/**
 * Why: Names the broad check-definition union used by generic result and registry surfaces without erasing waiver policy branches.
 * Use: Prefer an exact `typeof definition` at call sites; use this only when code intentionally handles any check.
 */
export type AnyCheckDefinition =
  | CheckDefinition<CheckTypesWithWaiver<NeverCheckWaiverPolicy>, string>
  | CheckDefinition<CheckTypesWithWaiver<EligibleCheckWaiverPolicy>, string>;

/**
 * Why: Recovers one check definition's raw invocation input without using `void` or `undefined` as a presence signal.
 * Use: Pair it with `CheckInputModeOf` in generic check helpers.
 */
export type CheckInputOf<Definition> =
  Definition extends CheckDefinition<infer Types, any> ? Types["input"] : never;

/**
 * Why: Recovers whether the check builder used the static or schema-backed definition form.
 * Use: Require explicit input for schema-backed checks even when their raw input is `any`, `unknown`, or includes `undefined`.
 */
export type CheckInputModeOf<Definition> =
  Definition extends CheckDefinition<infer Types, any> ? Types["inputMode"] : InputMode;

/**
 * Why: Narrows check APIs to definitions whose non-weakenable policy permits host-authorized waivers.
 * Use: It is the constraint for `ctx.check.authorizeWaiver` and `CheckWaiverRef`.
 */
export type WaiverEligibleCheckDefinition = CheckDefinition<
  CheckTypesWithWaiver<EligibleCheckWaiverPolicy>,
  string
>;

/** Outcome accepted from a check implementation. */
type CheckOutcome = boolean | CheckExecutionResult | Promise<boolean | CheckExecutionResult>;

/** Check config base. */
export interface CheckConfigBase<
  Name extends string,
  Waiver extends CheckWaiverPolicy = NeverCheckWaiverPolicy,
> {
  name: Name;
  description?: string;
  revision?: string;
  policy?: CheckPolicy;
  defaults?: CheckDefaults;
  waiver?: Waiver;
}

/**
 * Why: Names the mandatory revision and fixed policy fields of a waiver-eligible check config.
 * Use: It is selected by `CheckConfigWithWaiverPolicy` when the definition permits host authorization.
 */
export interface EligibleCheckConfigPolicy<
  Waiver extends EligibleCheckWaiverPolicy,
  Revision extends string = string,
> {
  revision: Revision;
  policy: "required";
  waiver: Waiver;
}

/**
 * Why: Names the default-deny config branch without relying on an anonymous intersection member.
 * Use: It is selected by `CheckConfigWithWaiverPolicy` for ordinary non-waivable checks.
 */
export interface NeverCheckConfigPolicy {
  waiver?: NeverCheckWaiverPolicy;
}

/**
 * Why: Requires eligible checks to declare both their host waiver policy and a stable revision while preserving omission as default denial.
 * Use: It is applied to every `defineCheck` overload before inference reaches the public definition.
 */
export type CheckConfigWithWaiverPolicy<
  Config,
  Waiver extends CheckWaiverPolicy,
  Revision extends string = string,
> = Waiver extends EligibleCheckWaiverPolicy
  ? Config & EligibleCheckConfigPolicy<Waiver, Revision>
  : Config & NeverCheckConfigPolicy;

/** Schema run check config. */
export interface SchemaRunCheckConfig<
  S extends AnySchema,
  Name extends string,
  Waiver extends CheckWaiverPolicy = NeverCheckWaiverPolicy,
> extends CheckConfigBase<Name, Waiver> {
  input: S;
  run: (input: InferOut<S>, context: CheckRunContext) => CheckOutcome;
}

/** Schema command check config. */
export interface SchemaCommandCheckConfig<
  S extends AnySchema,
  Name extends string,
  Waiver extends CheckWaiverPolicy = NeverCheckWaiverPolicy,
> extends CheckConfigBase<Name, Waiver> {
  input: S;
  command: (input: InferOut<S>) => CheckCommand;
}

/** Parsed schema command check config. */
export interface ParsedSchemaCommandCheckConfig<
  S extends AnySchema,
  Name extends string,
  Result extends CheckExecutionResult,
  Waiver extends CheckWaiverPolicy = NeverCheckWaiverPolicy,
> extends SchemaCommandCheckConfig<S, Name, Waiver> {
  parse: (result: CommandResult) => Result;
}

/** Static run check config. */
export interface StaticRunCheckConfig<
  Name extends string,
  Waiver extends CheckWaiverPolicy = NeverCheckWaiverPolicy,
> extends CheckConfigBase<Name, Waiver> {
  run: (context: CheckRunContext) => CheckOutcome;
}

/** Static command check config. */
export interface StaticCommandCheckConfig<
  Name extends string,
  Waiver extends CheckWaiverPolicy = NeverCheckWaiverPolicy,
> extends CheckConfigBase<Name, Waiver> {
  command: CheckCommand;
}

/** Parsed static command check config. */
export interface ParsedStaticCommandCheckConfig<
  Name extends string,
  Result extends CheckExecutionResult,
  Waiver extends CheckWaiverPolicy = NeverCheckWaiverPolicy,
> extends StaticCommandCheckConfig<Name, Waiver> {
  parse: (result: CommandResult) => Result;
}

/**
 * Why: Declares a reusable command or function check without executing it.
 * Use: Choose the overload matching static or schema-backed input and optional structured parsing.
 */
export declare function defineCheck<
  S extends AnySchema,
  const Name extends string,
  const Waiver extends CheckWaiverPolicy = NeverCheckWaiverPolicy,
  const Revision extends string = string,
>(
  config: CheckConfigWithWaiverPolicy<SchemaRunCheckConfig<S, Name, Waiver>, Waiver, Revision>,
): CheckDefinition<
  DefinedCheckTypes<InferIn<S>, InferOut<S>, CheckExecutionResult, Waiver, Revision, "required">,
  Name
>;

/**
 * Why: Declares a reusable command or function check without executing it.
 * Use: Choose the overload matching static or schema-backed input and optional structured parsing.
 */
export declare function defineCheck<
  S extends AnySchema,
  const Name extends string,
  Result extends CheckExecutionResult,
  const Waiver extends CheckWaiverPolicy = NeverCheckWaiverPolicy,
  const Revision extends string = string,
>(
  config: CheckConfigWithWaiverPolicy<
    ParsedSchemaCommandCheckConfig<S, Name, Result, Waiver>,
    Waiver,
    Revision
  >,
): CheckDefinition<
  DefinedCheckTypes<InferIn<S>, InferOut<S>, Result, Waiver, Revision, "required">,
  Name
>;

/**
 * Why: Declares a reusable command or function check without executing it.
 * Use: Choose the overload matching static or schema-backed input and optional structured parsing.
 */
export declare function defineCheck<
  S extends AnySchema,
  const Name extends string,
  const Waiver extends CheckWaiverPolicy = NeverCheckWaiverPolicy,
  const Revision extends string = string,
>(
  config: CheckConfigWithWaiverPolicy<SchemaCommandCheckConfig<S, Name, Waiver>, Waiver, Revision>,
): CheckDefinition<
  DefinedCheckTypes<InferIn<S>, InferOut<S>, CheckExecutionResult, Waiver, Revision, "required">,
  Name
>;

/**
 * Why: Declares a reusable command or function check without executing it.
 * Use: Choose the overload matching static or schema-backed input and optional structured parsing.
 */
export declare function defineCheck<
  const Name extends string,
  const Waiver extends CheckWaiverPolicy = NeverCheckWaiverPolicy,
  const Revision extends string = string,
>(
  config: CheckConfigWithWaiverPolicy<StaticRunCheckConfig<Name, Waiver>, Waiver, Revision>,
): CheckDefinition<DefinedCheckTypes<void, void, CheckExecutionResult, Waiver, Revision, "none">, Name>;

/**
 * Why: Declares a reusable command or function check without executing it.
 * Use: Choose the overload matching static or schema-backed input and optional structured parsing.
 */
export declare function defineCheck<
  const Name extends string,
  Result extends CheckExecutionResult,
  const Waiver extends CheckWaiverPolicy = NeverCheckWaiverPolicy,
  const Revision extends string = string,
>(
  config: CheckConfigWithWaiverPolicy<ParsedStaticCommandCheckConfig<Name, Result, Waiver>, Waiver, Revision>,
): CheckDefinition<DefinedCheckTypes<void, void, Result, Waiver, Revision, "none">, Name>;

/**
 * Why: Declares a reusable command or function check without executing it.
 * Use: Choose the overload matching static or schema-backed input and optional structured parsing.
 */
export declare function defineCheck<
  const Name extends string,
  const Waiver extends CheckWaiverPolicy = NeverCheckWaiverPolicy,
  const Revision extends string = string,
>(
  config: CheckConfigWithWaiverPolicy<StaticCommandCheckConfig<Name, Waiver>, Waiver, Revision>,
): CheckDefinition<DefinedCheckTypes<void, void, CheckExecutionResult, Waiver, Revision, "none">, Name>;

/** Check suite member. */
export interface CheckSuiteMember<Definition extends CheckDefinition<any, any>> {
  readonly definition: Definition;
  readonly input: CheckInputOf<Definition>;
}

/** Check suite use. */
export interface CheckSuiteUse {
  <Definition extends CheckDefinitionWithInputMode<"none">>(
    definition: Definition,
  ): CheckSuiteMember<Definition>;
  <Definition extends CheckDefinitionWithInputMode<"required">>(
    definition: Definition,
    input: CheckInputOf<Definition>,
  ): CheckSuiteMember<Definition>;
}

/** Check suite members. */
export type CheckSuiteMembers = Record<string, CheckSuiteMember<CheckDefinition<any, any>>>;

/**
 * Why: Names the hidden input, member, result, and definition-form relationships of one check suite.
 * Use: Suite builders construct it; authors normally consume its fields through definition extractors.
 */
export interface CheckSuiteTypes {
  readonly input: unknown;
  readonly parsedInput: unknown;
  readonly members: CheckSuiteMembers;
  readonly result: unknown;
  readonly inputMode: InputMode;
}

/** Exact hidden type relationships carried by one reusable check suite definition. */
export type CheckSuiteTypesOf<Definition> =
  Definition extends CheckSuiteDefinition<infer Types, any> ? Types : never;

/** Hidden relationship bag constructed by the check-suite builder overloads. */
type DefinedCheckSuiteTypes<
  Input,
  Members extends CheckSuiteMembers,
  ParsedInput,
  Mode extends InputMode,
> = {
  readonly input: Input;
  readonly parsedInput: ParsedInput;
  readonly members: Members;
  readonly result: CheckSuiteResult<Members>;
  readonly inputMode: Mode;
};

/** Broad hidden suite relationship bag constrained to one definition-form input mode. */
type CheckSuiteTypesWithInputMode<Mode extends InputMode> = Omit<CheckSuiteTypes, "inputMode"> & {
  readonly inputMode: Mode;
};

/** Check suite definition. */
export interface CheckSuiteDefinition<
  Types extends CheckSuiteTypes = CheckSuiteTypes,
  Name extends string = string,
> extends WorkflowNode<"weft.check-suite">,
    DefinitionTypeCarrier<Types> {
  readonly kind: "weft.check-suite";
  readonly name: Name;
  readonly description?: string;
  readonly input?: AnySchema;
  readonly concurrency?: number;
}

/** Schema check suite config. */
export interface SchemaCheckSuiteConfig<
  S extends AnySchema,
  Members extends CheckSuiteMembers,
  Name extends string = string,
> {
  name: Name;
  description?: string;
  input: S;
  checks: (input: InferOut<S>, use: CheckSuiteUse) => Members;
  concurrency?: number;
}

/** Static check suite config. */
export interface StaticCheckSuiteConfig<
  Checks extends readonly CheckDefinitionWithInputMode<"none">[],
  Name extends string = string,
> {
  name: Name;
  description?: string;
  checks: Checks;
  concurrency?: number;
}

/**
 * Why: Groups named checks while preserving each member as independently visible evidence.
 * Use: Use the static overload for fixed checks or the schema-backed overload to derive members from input.
 */
export declare function defineCheckSuite<
  S extends AnySchema,
  const Members extends CheckSuiteMembers,
  const Name extends string = string,
>(
  config: SchemaCheckSuiteConfig<S, Members, Name>,
): CheckSuiteDefinition<DefinedCheckSuiteTypes<InferIn<S>, Members, InferOut<S>, "required">, Name>;

/** Named suite members inferred from static check definitions. */
type StaticCheckMembers<
  Checks extends readonly CheckDefinitionWithInputMode<"none">[],
> = {
  [Definition in Checks[number] as Definition["name"]]: CheckSuiteMember<Definition>;
};

/**
 * Why: Groups named checks while preserving each member as independently visible evidence.
 * Use: Use the static overload for fixed checks or the schema-backed overload to derive members from input.
 */
export declare function defineCheckSuite<
  const Checks extends readonly CheckDefinitionWithInputMode<"none">[],
  const Name extends string = string,
>(
  config: StaticCheckSuiteConfig<Checks, Name>,
): CheckSuiteDefinition<DefinedCheckSuiteTypes<void, StaticCheckMembers<Checks>, void, "none">, Name>;

/**
 * Why: Recovers the exact definition-time suite name for heterogeneous registries and diagnostics.
 * Use: Apply it to a concrete `defineCheckSuite` result; broad legacy definitions continue to produce `string`.
 */
export type CheckSuiteNameOf<Definition> =
  Definition extends CheckSuiteDefinition<any, infer Name> ? Name : never;

/**
 * Why: Recovers one suite definition's raw input independently of its definition-form presence mode.
 * Use: It supplies schema-backed suite calls and goal bindings.
 */
export type CheckSuiteInputOf<Definition> =
  Definition extends CheckSuiteDefinition<infer Types, any> ? Types["input"] : never;

/**
 * Why: Recovers whether a suite was built from fixed checks or an input-derived member factory.
 * Use: Require explicit input for the schema-backed branch even when its value type includes `undefined`.
 */
export type CheckSuiteInputModeOf<Definition> =
  Definition extends CheckSuiteDefinition<infer Types, any> ? Types["inputMode"] : InputMode;

/** Exact named member map retained by one reusable check suite definition. */
export type CheckSuiteMembersOf<Definition> =
  Definition extends CheckSuiteDefinition<infer Types, any> ? Types["members"] : never;

/** Check result of. */
type CheckResultDefinition<Definition> = Definition extends AnyCheckDefinition
  ? Definition
  : AnyCheckDefinition;

/**
 * Why: Derives a definition-specific check result while preserving its exact workspace candidate type.
 * Use: Apply it to `typeof check`; the engine brand then prevents results from another definition authorizing it.
 */
export type CheckResultOf<Definition, Candidate extends WorkspaceSnapshotRef = WorkspaceSnapshotRef> =
  Definition extends CheckDefinition<infer Types, any>
    ? CheckResult<
        NonNullable<Types["executionResult"]["details"]>,
        Candidate,
        CheckResultDefinition<Definition>
      >
    : CheckResult<readonly CheckEvidence[], Candidate>;

/**
 * Why: Narrows authorization input to an actually executed failure for one exact check definition and candidate.
 * Use: Check `status === "fail"` and `disposition === "executed"` before calling `ctx.check.authorizeWaiver`.
 */
export type FailedCheckResultOf<Definition, Candidate extends WorkspaceSnapshotRef = WorkspaceSnapshotRef> = Extract<
  CheckResultOf<Definition, Candidate>,
  ExecutedFailedCheckResult<any, any, any>
>;

/**
 * Why: Carries the exact suite member results, workspace generation, and attestation shared by both verdict branches.
 * Use: Narrow the public `CheckSuiteResult` on `passed` before accessing promotion proof.
 */
export interface CheckSuiteResultBase<
  Members extends CheckSuiteMembers = CheckSuiteMembers,
  Candidate extends WorkspaceSnapshotRef = WorkspaceSnapshotRef,
> {
  readonly results: CheckSuiteResults<Members, Candidate>;
  readonly candidate: Candidate;
  readonly attestation: SubjectAttestation<"check-suite", CheckSuiteResults<Members, Candidate>, Candidate>;
}

/**
 * Why: Mints positive promotion proof only when the suite policy is satisfied for one exact candidate.
 * Use: Narrow `passed === true`, then pass `proof` to verified delivery.
 */
export interface PassedCheckSuiteResult<
  Members extends CheckSuiteMembers = CheckSuiteMembers,
  Candidate extends WorkspaceSnapshotRef = WorkspaceSnapshotRef,
> extends CheckSuiteResultBase<Members, Candidate> {
  readonly passed: true;
  readonly proof: PromotionProof<"check", Candidate>;
}

/**
 * Why: Retains failed suite evidence for remediation without allowing it to authorize promotion.
 * Use: Narrow `passed === false`, inspect member results, and rerun or explicitly handle policy failure.
 */
export interface FailedCheckSuiteResult<
  Members extends CheckSuiteMembers = CheckSuiteMembers,
  Candidate extends WorkspaceSnapshotRef = WorkspaceSnapshotRef,
> extends CheckSuiteResultBase<Members, Candidate> {
  readonly passed: false;
  readonly proof?: never;
}

/**
 * Why: Makes suite success and failure an exhaustive union whose positive proof exists only after acceptance.
 * Use: Receive it from `ctx.check` and narrow on `passed` before promotion.
 */
export type CheckSuiteResult<
  Members extends CheckSuiteMembers = CheckSuiteMembers,
  Candidate extends WorkspaceSnapshotRef = WorkspaceSnapshotRef,
> = PassedCheckSuiteResult<Members, Candidate> | FailedCheckSuiteResult<Members, Candidate>;

/** Check suite results. */
export type CheckSuiteResults<
  Members extends CheckSuiteMembers,
  Candidate extends WorkspaceSnapshotRef = WorkspaceSnapshotRef,
> = {
  [Name in keyof Members]: CheckResultOf<Members[Name]["definition"], Candidate>;
};

/** Trusted check source. */
export interface TrustedCheckSource {
  run: string;
  reason: string;
}

/**
 * Why: Records the accountable host identity that approved one exact check waiver.
 * Use: Read it from a waiver ref or its attestation; never accept an authorizer from workflow input.
 */
export interface CheckWaiverAuthorizer {
  readonly kind: "human" | "policy";
  readonly id: string;
}

/**
 * Why: Defines the durable attestation payload for one host-authorized, expiring exception.
 * Use: Preserve it through waived results, artifacts, and delivery evidence.
 */
export interface CheckWaiverAttestationValue<
  Name extends string = string,
  Revision extends string = string,
  Policy extends EligibleCheckWaiverPolicy = EligibleCheckWaiverPolicy,
> {
  readonly check: Name;
  readonly revision: Revision;
  readonly definitionDigest: string;
  readonly binding: Policy["binding"];
  readonly action: Policy["action"];
  readonly risk: Policy["risk"];
  readonly maxTtl: Policy["maxTtl"];
  readonly failureAttestationRef: string;
  readonly reason: string;
  readonly issue?: string;
  readonly authorizedBy: CheckWaiverAuthorizer;
  readonly authorizedAt: string;
  readonly expiresAt: string;
}

/**
 * Why: Prevents plain objects or human answers from masquerading as host-minted waiver authority.
 * Use: It is carried only by `ctx.check.authorizeWaiver`.
 */
declare const checkWaiverRefBrand: unique symbol;

/**
 * Why: Binds one host authorization to an eligible check's exact name, revision, failed candidate, and expiry.
 * Use: Pass it unchanged to the matching check invocation and retain it from a waived `CheckResult`.
 */
export interface CheckWaiverRef<
  Definition extends WaiverEligibleCheckDefinition = WaiverEligibleCheckDefinition,
  Candidate extends WorkspaceSnapshotRef = WorkspaceSnapshotRef,
> extends NominalValue<readonly ["check-waiver", Definition, Candidate]> {
  readonly ref: string;
  readonly check: Definition["name"];
  readonly revision: Definition["revision"];
  readonly definitionDigest: string;
  readonly binding: Definition["waiver"]["binding"];
  readonly action: Definition["waiver"]["action"];
  readonly risk: Definition["waiver"]["risk"];
  readonly maxTtl: Definition["waiver"]["maxTtl"];
  readonly candidate: Candidate;
  readonly failure: SubjectAttestation<"check", FailedCheckExecutionResult, Candidate>;
  readonly reason: string;
  readonly issue?: string;
  readonly authorizedBy: CheckWaiverAuthorizer;
  readonly authorizedAt: string;
  readonly expiresAt: string;
  readonly attestation: SubjectAttestation<
    "check-waiver",
    CheckWaiverAttestationValue<Definition["name"], Definition["revision"], Definition["waiver"]>,
    Candidate
  >;
  readonly [checkWaiverRefBrand]: readonly [definition: Definition, candidate: Candidate];
}

/**
 * Why: Supplies replay identity and a bounded human or policy request without allowing callers to weaken definition policy.
 * Use: Pass it to `ctx.check.authorizeWaiver`; the host enforces `binding`, `action`, `risk`, and `maxTtl` from the definition.
 */
export interface CheckWaiverAuthorizeOptions {
  readonly key: string;
  readonly reason: string;
  readonly ttl: Duration;
  readonly issue?: string;
  readonly detail?: string;
}

/**
 * Why: Holds invocation controls common to executed, trusted, and waived check paths.
 * Use: Extend it only through the mutually exclusive public invocation option branches.
 */
export interface CheckInvocationBaseOptions {
  readonly key: string;
  readonly policy?: "required";
  readonly timeout?: Duration;
}

/**
 * Why: Represents an ordinary engine-executed check invocation with no evidence substitution.
 * Use: This is the default branch when neither `trust` nor `waive` is supplied.
 */
export interface ExecutedCheckInvocationOptions extends CheckInvocationBaseOptions {
  readonly candidate?: never;
  readonly trust?: never;
  readonly waive?: never;
}

/**
 * Why: Keeps trusted prior-run evidence mutually exclusive with execution and waiver authority.
 * Use: Supply a trusted run and reason only where host policy permits evidence reuse.
 */
export interface TrustedCheckInvocationOptions extends CheckInvocationBaseOptions {
  readonly candidate?: never;
  readonly trust: TrustedCheckSource;
  readonly waive?: never;
}

/**
 * Why: Requires nominal workspace evidence when an executed check should return one refined candidate type.
 * Use: Supply the current engine-minted candidate; the host rejects drift before minting the result.
 */
export interface CandidateExecutedCheckInvocationOptions<Candidate extends WorkspaceSnapshotRef>
  extends CheckInvocationBaseOptions {
  readonly candidate: Candidate;
  readonly trust?: never;
  readonly waive?: never;
}

/**
 * Why: Couples trusted evidence reuse to the exact nominal workspace candidate claimed by its result.
 * Use: Supply both `candidate` and `trust`; the host remains responsible for validating the trusted run.
 */
export interface CandidateTrustedCheckInvocationOptions<Candidate extends WorkspaceSnapshotRef>
  extends CheckInvocationBaseOptions {
  readonly candidate: Candidate;
  readonly trust: TrustedCheckSource;
  readonly waive?: never;
}

/**
 * Why: Allows only one nominal ref for the matching eligible definition and failed workspace candidate.
 * Use: Obtain `waive` from `ctx.check.authorizeWaiver`; do not copy or reconstruct its fields.
 */
export interface WaivedCheckInvocationOptions<
  Definition extends WaiverEligibleCheckDefinition,
  Candidate extends WorkspaceSnapshotRef = WorkspaceSnapshotRef,
> extends CheckInvocationBaseOptions {
  readonly candidate?: NoInfer<Candidate>;
  readonly trust?: never;
  readonly waive: CheckWaiverRef<Definition, Candidate>;
}

/**
 * Why: Names the only ordinary invocation branches that do not claim a refined workspace candidate.
 * Use: Use it for executed or trusted calls whose result should remain the broad `WorkspaceSnapshotRef`.
 */
export type UnboundCheckInvocationOptions = ExecutedCheckInvocationOptions | TrustedCheckInvocationOptions;

/**
 * Why: Selects ordinary, trusted, or definition-matched waived invocation options without caller-selected eligibility.
 * Use: Pass it to `ctx.check`; checks with `mode: "never"` have no waived branch.
 */
export type CheckInvocationOptions<
  Definition extends AnyCheckDefinition = AnyCheckDefinition,
  Candidate extends WorkspaceSnapshotRef = WorkspaceSnapshotRef,
> =
  | CandidateExecutedCheckInvocationOptions<Candidate>
  | CandidateTrustedCheckInvocationOptions<Candidate>
  | (Definition extends WaiverEligibleCheckDefinition
      ? WaivedCheckInvocationOptions<Definition, Candidate>
      : never);

/**
 * Why: Holds suite controls shared by exact-candidate and unbound invocation paths.
 * Use: Extend it through the two mutually exclusive suite option branches below.
 */
export interface CheckSuiteInvocationBaseOptions {
  key: string;
  policy?: "required";
  timeout?: Duration;
  concurrency?: number;
}

/**
 * Why: Requires nominal workspace evidence before a suite result may retain one refined candidate type.
 * Use: Pass the current engine-minted candidate; the host rejects drift before minting suite evidence.
 */
export interface CheckSuiteInvocationOptions<Candidate extends WorkspaceSnapshotRef = WorkspaceSnapshotRef>
  extends CheckSuiteInvocationBaseOptions {
  candidate: Candidate;
}

/**
 * Why: Gives candidate-agnostic suite calls a distinct path whose result cannot claim a refined candidate.
 * Use: Omit `candidate` only when broad `WorkspaceSnapshotRef` evidence is sufficient.
 */
export interface UnboundCheckSuiteInvocationOptions extends CheckSuiteInvocationBaseOptions {
  candidate?: never;
}

/**
 * Why: Exposes the sole host-authorized transition from an eligible executed failure to nominal waiver authority.
 * Use: Access it as `ctx.check.authorizeWaiver`; the exact definition and result brands must match.
 */
export type CheckWaiverAuthorizeFn = <
  Definition extends WaiverEligibleCheckDefinition,
  Candidate extends WorkspaceSnapshotRef,
>(
  definition: Definition,
  failure: FailedCheckResultOf<Definition, Candidate>,
  options: CheckWaiverAuthorizeOptions,
) => Promise<CheckWaiverRef<Definition, Candidate>>;

/**
 * Why: Defines the standalone check invocation surface shared by workflow and workspace contexts.
 * Use: Call `ctx.check(definition, input?, options?)` when workflow code owns the response to failure.
 */
export interface CheckFn {
  readonly authorizeWaiver: CheckWaiverAuthorizeFn;
  /** @deprecated Use `authorizeWaiver` to keep failed-check exception authority explicit. */
  readonly authorize: CheckWaiverAuthorizeFn;
  <
    Definition extends CheckDefinitionWithInputMode<"none">,
    Candidate extends WorkspaceSnapshotRef,
  >(
    definition: Definition,
    opts: CheckInvocationOptions<Definition, Candidate>,
  ): Promise<CheckResultOf<Definition, Candidate>>;
  <Definition extends CheckDefinitionWithInputMode<"none">>(
    definition: Definition,
    opts: UnboundCheckInvocationOptions,
  ): Promise<CheckResultOf<Definition, WorkspaceSnapshotRef>>;
  <
    Definition extends CheckDefinitionWithInputMode<"required">,
    Candidate extends WorkspaceSnapshotRef,
  >(
    definition: Definition,
    input: CheckInputOf<Definition>,
    opts: CheckInvocationOptions<Definition, Candidate>,
  ): Promise<CheckResultOf<Definition, Candidate>>;
  <Definition extends CheckDefinitionWithInputMode<"required">>(
    definition: Definition,
    input: CheckInputOf<Definition>,
    opts: UnboundCheckInvocationOptions,
  ): Promise<CheckResultOf<Definition, WorkspaceSnapshotRef>>;
  <
    Definition extends CheckSuiteDefinition<CheckSuiteTypesWithInputMode<"none">, any>,
    Candidate extends WorkspaceSnapshotRef,
  >(
    suite: Definition,
    opts: CheckSuiteInvocationOptions<Candidate>,
  ): Promise<CheckSuiteResult<CheckSuiteMembersOf<Definition>, Candidate>>;
  <Definition extends CheckSuiteDefinition<CheckSuiteTypesWithInputMode<"none">, any>>(
    suite: Definition,
    opts: UnboundCheckSuiteInvocationOptions,
  ): Promise<CheckSuiteResult<CheckSuiteMembersOf<Definition>, WorkspaceSnapshotRef>>;
  <
    Definition extends CheckSuiteDefinition<CheckSuiteTypesWithInputMode<"required">, any>,
    Candidate extends WorkspaceSnapshotRef,
  >(
    suite: Definition,
    input: CheckSuiteInputOf<Definition>,
    opts: CheckSuiteInvocationOptions<Candidate>,
  ): Promise<CheckSuiteResult<CheckSuiteMembersOf<Definition>, Candidate>>;
  <Definition extends CheckSuiteDefinition<CheckSuiteTypesWithInputMode<"required">, any>>(
    suite: Definition,
    input: CheckSuiteInputOf<Definition>,
    opts: UnboundCheckSuiteInvocationOptions,
  ): Promise<CheckSuiteResult<CheckSuiteMembersOf<Definition>, WorkspaceSnapshotRef>>;
}
