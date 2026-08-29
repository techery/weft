/** Declaration-only checks surface for the Weft DSL prototype. */

import type {
  AnySchema,
  Duration,
  HostBinding,
  InferIn,
  InferOut,
  Risk,
  SubjectAttestation,
  WorkflowNode,
  WorkspaceSubject,
} from "./shared.ts";

// ---------------------------------------------------------------------------
// Checks and check suites
// ---------------------------------------------------------------------------

/**
 * Why: Gives the checks DSL an explicit check status contract instead of relying on untyped values.
 * Use: Import it when declaring, configuring, or consuming the corresponding checks API.
 */
export type CheckStatus = "pass" | "fail";
/**
 * Why: Gives the checks DSL an explicit check policy contract instead of relying on untyped values.
 * Use: Import it when declaring, configuring, or consuming the corresponding checks API.
 */
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
/**
 * Why: Gives the checks DSL an explicit check disposition contract instead of relying on untyped values.
 * Use: Import it when declaring, configuring, or consuming the corresponding checks API.
 */
export type CheckDisposition = "executed" | "trusted" | "waived";

/**
 * Why: Keeps verification evidence structured enough for reports, UIs, and agent remediation.
 * Use: Return these entries from a check parser or function result.
 */
export interface TextCheckEvidence {
  kind: "text";
  text: string;
}

/**
 * Why: Gives the checks DSL an explicit file check evidence contract instead of relying on untyped values.
 * Use: Import it when declaring, configuring, or consuming the corresponding checks API.
 */
export interface FileCheckEvidence {
  kind: "file";
  path: string;
  line?: number;
  message?: string;
}

/**
 * Why: Gives the checks DSL an explicit metric check evidence contract instead of relying on untyped values.
 * Use: Import it when declaring, configuring, or consuming the corresponding checks API.
 */
export interface MetricCheckEvidence {
  kind: "metric";
  name: string;
  actual: number;
  expected?: number;
  unit?: string;
}

/**
 * Why: Gives the checks DSL an explicit command check evidence contract instead of relying on untyped values.
 * Use: Import it when declaring, configuring, or consuming the corresponding checks API.
 */
export interface CommandCheckEvidence {
  kind: "command";
  exitCode: number;
  output?: string;
}

/**
 * Why: Gives the checks DSL an explicit artifact check evidence contract instead of relying on untyped values.
 * Use: Import it when declaring, configuring, or consuming the corresponding checks API.
 */
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

/**
 * Why: Gives the checks DSL an explicit check execution result contract instead of relying on untyped values.
 * Use: Import it when declaring, configuring, or consuming the corresponding checks API.
 */
export interface CheckExecutionResult<Details extends readonly CheckEvidence[] = readonly CheckEvidence[]> {
  status: CheckStatus;
  summary?: string;
  evidence?: string;
  details?: Details;
}

/**
 * Why: Names the successful execution payload carried by exact-subject check attestations.
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
 * Why: Centralizes engine-minted identity and exact-subject evidence shared by every check-result branch.
 * Use: Extend it only through the closed executed, trusted, and waived result contracts below.
 */
export interface CheckResultBase<
  Details extends readonly CheckEvidence[] = readonly CheckEvidence[],
  Subject extends WorkspaceSubject = WorkspaceSubject,
  Definition extends AnyCheckDefinition = AnyCheckDefinition,
> extends CheckExecutionResult<Details> {
  readonly subject: Subject;
  readonly attestation: SubjectAttestation<"check", CheckExecutionResult<Details>, Subject>;
  readonly [checkResultBrand]: readonly [definition: Definition, subject: Subject];
}

/**
 * Why: Makes an executed passing verdict a distinct branch for sound control-flow narrowing.
 * Use: Require it where exact-subject verification must actually run and pass.
 */
export interface ExecutedPassedCheckResult<
  Details extends readonly CheckEvidence[] = readonly CheckEvidence[],
  Subject extends WorkspaceSubject = WorkspaceSubject,
  Definition extends AnyCheckDefinition = AnyCheckDefinition,
> extends CheckResultBase<Details, Subject, Definition> {
  readonly status: "pass";
  readonly disposition: "executed";
  readonly attestation: SubjectAttestation<"check", PassedCheckExecutionResult<Details>, Subject>;
  readonly waiver?: never;
}

/**
 * Why: Makes an executed failure the only result branch accepted by waiver authorization.
 * Use: Narrow an eligible result to this branch before calling `ctx.check.authorize`.
 */
export interface ExecutedFailedCheckResult<
  Details extends readonly CheckEvidence[] = readonly CheckEvidence[],
  Subject extends WorkspaceSubject = WorkspaceSubject,
  Definition extends AnyCheckDefinition = AnyCheckDefinition,
> extends CheckResultBase<Details, Subject, Definition> {
  readonly status: "fail";
  readonly disposition: "executed";
  readonly attestation: SubjectAttestation<"check", FailedCheckExecutionResult<Details>, Subject>;
  readonly waiver?: never;
}

/**
 * Why: Separates reused host-trusted evidence from both fresh execution and exceptional waiver authority.
 * Use: Inspect its source through invocation history; it can never authorize a waiver.
 */
export interface TrustedCheckResult<
  Details extends readonly CheckEvidence[] = readonly CheckEvidence[],
  Subject extends WorkspaceSubject = WorkspaceSubject,
  Definition extends AnyCheckDefinition = AnyCheckDefinition,
> extends CheckResultBase<Details, Subject, Definition> {
  readonly disposition: "trusted";
  readonly waiver?: never;
}

/**
 * Why: Carries every non-waived verdict as a discriminated union that narrows by execution and status.
 * Use: Inspect `status`, `disposition`, `subject`, and `attestation` after an ordinary invocation.
 */
export type NonWaivedCheckResult<
  Details extends readonly CheckEvidence[] = readonly CheckEvidence[],
  Subject extends WorkspaceSubject = WorkspaceSubject,
  Definition extends AnyCheckDefinition = AnyCheckDefinition,
> =
  | ExecutedPassedCheckResult<Details, Subject, Definition>
  | ExecutedFailedCheckResult<Details, Subject, Definition>
  | TrustedCheckResult<Details, Subject, Definition>;

/**
 * Why: Retains the exact nominal waiver authority on every waived verdict instead of reducing it to a disposition string.
 * Use: Narrow `disposition === "waived"`, then preserve `waiver` with delivery or audit evidence.
 */
export interface WaivedCheckResult<
  Details extends readonly CheckEvidence[] = readonly CheckEvidence[],
  Subject extends WorkspaceSubject = WorkspaceSubject,
  Definition extends WaiverEligibleCheckDefinition = WaiverEligibleCheckDefinition,
> extends CheckResultBase<Details, Subject, Definition> {
  readonly status: "fail";
  readonly disposition: "waived";
  readonly waiver: CheckWaiverRef<Definition, Subject>;
}

/**
 * Why: Carries a definition-specific verdict, evidence, disposition, and exact observed workspace generation.
 * Use: Inspect it after `ctx.check`; only eligible definitions can produce the waived branch.
 */
export type CheckResult<
  Details extends readonly CheckEvidence[] = readonly CheckEvidence[],
  Subject extends WorkspaceSubject = WorkspaceSubject,
  Definition extends AnyCheckDefinition = AnyCheckDefinition,
> =
  | NonWaivedCheckResult<Details, Subject, Definition>
  | (Definition extends WaiverEligibleCheckDefinition
      ? WaivedCheckResult<Details, Subject, Definition>
      : never);

/**
 * Why: Gives the checks DSL an explicit command result contract instead of relying on untyped values.
 * Use: Import it when declaring, configuring, or consuming the corresponding checks API.
 */
export interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/**
 * Why: Gives the checks DSL an explicit check run context contract instead of relying on untyped values.
 * Use: Import it when declaring, configuring, or consuming the corresponding checks API.
 */
export interface CheckRunContext {
  signal: AbortSignal;
}

/**
 * Why: Prevents a command-backed check from reaching the engine without an executable at tuple position zero.
 * Use: Return or provide `[executable, ...arguments]` from a command check configuration.
 */
export type CheckCommand = readonly [executable: string, ...arguments: string[]];

/**
 * Why: Gives the checks DSL an explicit check defaults contract instead of relying on untyped values.
 * Use: Import it when declaring, configuring, or consuming the corresponding checks API.
 */
export interface CheckDefaults {
  timeout?: Duration;
}

/**
 * Why: Captures a named deterministic verification contract independently from any particular invocation.
 * Use: Create it with `defineCheck`, then invoke it through `ctx.check`, a suite, or an agent goal.
 */
export interface CheckDefinition<
  Input = void,
  Name extends string = string,
  ParsedInput = Input,
  Result extends CheckExecutionResult = CheckExecutionResult,
  Waiver extends CheckWaiverPolicy = CheckWaiverPolicy,
  Revision extends string = string,
> extends WorkflowNode<"weft.check"> {
  readonly kind: "weft.check";
  readonly name: Name;
  readonly description?: string;
  readonly policy: Waiver extends EligibleCheckWaiverPolicy ? "required" : CheckPolicy;
  readonly revision: Waiver extends EligibleCheckWaiverPolicy ? Revision : string | undefined;
  readonly waiver: Readonly<Waiver>;
  readonly input?: AnySchema;
  readonly defaults?: Readonly<CheckDefaults>;
  readonly __input?: Input;
  readonly __parsedInput?: ParsedInput;
  readonly __result?: Result;
}

/**
 * Why: Names the broad check-definition union used by generic result and registry surfaces without erasing waiver policy branches.
 * Use: Prefer an exact `typeof definition` at call sites; use this only when code intentionally handles any check.
 */
export type AnyCheckDefinition =
  | CheckDefinition<any, string, any, any, NeverCheckWaiverPolicy>
  | CheckDefinition<any, string, any, any, EligibleCheckWaiverPolicy>;

/**
 * Why: Narrows check APIs to definitions whose non-weakenable policy permits host-authorized waivers.
 * Use: It is the constraint for `ctx.check.authorize` and `CheckWaiverRef`.
 */
export type WaiverEligibleCheckDefinition = CheckDefinition<any, string, any, any, EligibleCheckWaiverPolicy>;

/**
 * Why: Centralizes the internal check outcome relationship so adjacent public declarations infer consistently.
 * Use: It is used by the surrounding checks types and is not a separate runtime feature.
 */
type CheckOutcome = boolean | CheckExecutionResult | Promise<boolean | CheckExecutionResult>;

/**
 * Why: Gives the checks DSL an explicit check config base contract instead of relying on untyped values.
 * Use: Import it when declaring, configuring, or consuming the corresponding checks API.
 */
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

/**
 * Why: Gives the checks DSL an explicit schema run check config contract instead of relying on untyped values.
 * Use: Import it when declaring, configuring, or consuming the corresponding checks API.
 */
export interface SchemaRunCheckConfig<
  S extends AnySchema,
  Name extends string,
  Waiver extends CheckWaiverPolicy = NeverCheckWaiverPolicy,
> extends CheckConfigBase<Name, Waiver> {
  input: S;
  run: (input: InferOut<S>, context: CheckRunContext) => CheckOutcome;
}

/**
 * Why: Gives the checks DSL an explicit schema command check config contract instead of relying on untyped values.
 * Use: Import it when declaring, configuring, or consuming the corresponding checks API.
 */
export interface SchemaCommandCheckConfig<
  S extends AnySchema,
  Name extends string,
  Waiver extends CheckWaiverPolicy = NeverCheckWaiverPolicy,
> extends CheckConfigBase<Name, Waiver> {
  input: S;
  command: (input: InferOut<S>) => CheckCommand;
}

/**
 * Why: Gives the checks DSL an explicit parsed schema command check config contract instead of relying on untyped values.
 * Use: Import it when declaring, configuring, or consuming the corresponding checks API.
 */
export interface ParsedSchemaCommandCheckConfig<
  S extends AnySchema,
  Name extends string,
  Result extends CheckExecutionResult,
  Waiver extends CheckWaiverPolicy = NeverCheckWaiverPolicy,
> extends SchemaCommandCheckConfig<S, Name, Waiver> {
  parse: (result: CommandResult) => Result;
}

/**
 * Why: Gives the checks DSL an explicit static run check config contract instead of relying on untyped values.
 * Use: Import it when declaring, configuring, or consuming the corresponding checks API.
 */
export interface StaticRunCheckConfig<
  Name extends string,
  Waiver extends CheckWaiverPolicy = NeverCheckWaiverPolicy,
> extends CheckConfigBase<Name, Waiver> {
  run: (context: CheckRunContext) => CheckOutcome;
}

/**
 * Why: Gives the checks DSL an explicit static command check config contract instead of relying on untyped values.
 * Use: Import it when declaring, configuring, or consuming the corresponding checks API.
 */
export interface StaticCommandCheckConfig<
  Name extends string,
  Waiver extends CheckWaiverPolicy = NeverCheckWaiverPolicy,
> extends CheckConfigBase<Name, Waiver> {
  command: CheckCommand;
}

/**
 * Why: Gives the checks DSL an explicit parsed static command check config contract instead of relying on untyped values.
 * Use: Import it when declaring, configuring, or consuming the corresponding checks API.
 */
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
): CheckDefinition<InferIn<S>, Name, InferOut<S>, CheckExecutionResult, Waiver, Revision>;

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
): CheckDefinition<InferIn<S>, Name, InferOut<S>, Result, Waiver, Revision>;

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
): CheckDefinition<InferIn<S>, Name, InferOut<S>, CheckExecutionResult, Waiver, Revision>;

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
): CheckDefinition<void, Name, void, CheckExecutionResult, Waiver, Revision>;

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
): CheckDefinition<void, Name, void, Result, Waiver, Revision>;

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
): CheckDefinition<void, Name, void, CheckExecutionResult, Waiver, Revision>;

/**
 * Why: Gives the checks DSL an explicit check suite member contract instead of relying on untyped values.
 * Use: Import it when declaring, configuring, or consuming the corresponding checks API.
 */
export interface CheckSuiteMember<Definition extends CheckDefinition<any, any, any, any>> {
  readonly definition: Definition;
  readonly input: Definition extends CheckDefinition<infer Input, any, any, any> ? Input : never;
}

/**
 * Why: Gives the checks DSL an explicit check suite use contract instead of relying on untyped values.
 * Use: Import it when declaring, configuring, or consuming the corresponding checks API.
 */
export interface CheckSuiteUse {
  <Definition extends CheckDefinition<void, any, any, any>>(
    definition: Definition,
  ): CheckSuiteMember<Definition>;
  <Input, Definition extends CheckDefinition<Input, any, any, any>>(
    definition: Definition,
    input: Input,
  ): CheckSuiteMember<Definition>;
}

/**
 * Why: Gives the checks DSL an explicit check suite members contract instead of relying on untyped values.
 * Use: Import it when declaring, configuring, or consuming the corresponding checks API.
 */
export type CheckSuiteMembers = Record<string, CheckSuiteMember<CheckDefinition<any, any, any, any>>>;

/**
 * Why: Gives the checks DSL an explicit check suite definition contract instead of relying on untyped values.
 * Use: Import it when declaring, configuring, or consuming the corresponding checks API.
 */
export interface CheckSuiteDefinition<
  Input = void,
  Members extends CheckSuiteMembers = CheckSuiteMembers,
  ParsedInput = Input,
  Name extends string = string,
> extends WorkflowNode<"weft.check-suite"> {
  readonly kind: "weft.check-suite";
  readonly name: Name;
  readonly description?: string;
  readonly input?: AnySchema;
  readonly concurrency?: number;
  readonly __input?: Input;
  readonly __parsedInput?: ParsedInput;
  readonly __members?: Members;
}

/**
 * Why: Gives the checks DSL an explicit schema check suite config contract instead of relying on untyped values.
 * Use: Import it when declaring, configuring, or consuming the corresponding checks API.
 */
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

/**
 * Why: Gives the checks DSL an explicit static check suite config contract instead of relying on untyped values.
 * Use: Import it when declaring, configuring, or consuming the corresponding checks API.
 */
export interface StaticCheckSuiteConfig<
  Checks extends readonly CheckDefinition<void, string, any, any>[],
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
): CheckSuiteDefinition<InferIn<S>, Members, InferOut<S>, Name>;

/**
 * Why: Centralizes the internal static check members relationship so adjacent public declarations infer consistently.
 * Use: It is used by the surrounding checks types and is not a separate runtime feature.
 */
type StaticCheckMembers<Checks extends readonly CheckDefinition<void, string, any, any>[]> = {
  [Definition in Checks[number] as Definition["name"]]: CheckSuiteMember<Definition>;
};

/**
 * Why: Groups named checks while preserving each member as independently visible evidence.
 * Use: Use the static overload for fixed checks or the schema-backed overload to derive members from input.
 */
export declare function defineCheckSuite<
  const Checks extends readonly CheckDefinition<void, string, any, any>[],
  const Name extends string = string,
>(
  config: StaticCheckSuiteConfig<Checks, Name>,
): CheckSuiteDefinition<void, StaticCheckMembers<Checks>, void, Name>;

/**
 * Why: Recovers the exact definition-time suite name for heterogeneous registries and diagnostics.
 * Use: Apply it to a concrete `defineCheckSuite` result; broad legacy definitions continue to produce `string`.
 */
export type CheckSuiteNameOf<Definition> =
  Definition extends CheckSuiteDefinition<any, any, any, infer Name> ? Name : never;

/**
 * Why: Gives the checks DSL an explicit check result of contract instead of relying on untyped values.
 * Use: Import it when declaring, configuring, or consuming the corresponding checks API.
 */
type CheckResultDefinition<Definition> = Definition extends AnyCheckDefinition
  ? Definition
  : AnyCheckDefinition;

/**
 * Why: Derives a definition-specific check result while preserving its exact workspace subject type.
 * Use: Apply it to `typeof check`; the engine brand then prevents results from another definition authorizing it.
 */
export type CheckResultOf<Definition, Subject extends WorkspaceSubject = WorkspaceSubject> =
  Definition extends CheckDefinition<any, any, any, infer Result, any>
    ? CheckResult<NonNullable<Result["details"]>, Subject, CheckResultDefinition<Definition>>
    : CheckResult<readonly CheckEvidence[], Subject>;

/**
 * Why: Narrows authorization input to an actually executed failure for one exact check definition and subject.
 * Use: Check `status === "fail"` and `disposition === "executed"` before calling `ctx.check.authorize`.
 */
export type FailedCheckResultOf<Definition, Subject extends WorkspaceSubject = WorkspaceSubject> = Extract<
  CheckResultOf<Definition, Subject>,
  ExecutedFailedCheckResult<any, any, any>
>;

/**
 * Why: Gives the checks DSL an explicit check suite result contract instead of relying on untyped values.
 * Use: Import it when declaring, configuring, or consuming the corresponding checks API.
 */
export interface CheckSuiteResult<
  Members extends CheckSuiteMembers = CheckSuiteMembers,
  Subject extends WorkspaceSubject = WorkspaceSubject,
> {
  passed: boolean;
  results: CheckSuiteResults<Members, Subject>;
  subject: Subject;
  attestation: SubjectAttestation<"check-suite", CheckSuiteResults<Members, Subject>, Subject>;
}

/**
 * Why: Gives the checks DSL an explicit check suite results contract instead of relying on untyped values.
 * Use: Import it when declaring, configuring, or consuming the corresponding checks API.
 */
export type CheckSuiteResults<
  Members extends CheckSuiteMembers,
  Subject extends WorkspaceSubject = WorkspaceSubject,
> = {
  [Name in keyof Members]: CheckResultOf<Members[Name]["definition"], Subject>;
};

/**
 * Why: Gives the checks DSL an explicit trusted check source contract instead of relying on untyped values.
 * Use: Import it when declaring, configuring, or consuming the corresponding checks API.
 */
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
 * Use: It is carried only by `ctx.check.authorize`.
 */
declare const checkWaiverRefBrand: unique symbol;

/**
 * Why: Binds one host authorization to an eligible check's exact name, revision, failed subject, and expiry.
 * Use: Pass it unchanged to the matching check invocation and retain it from a waived `CheckResult`.
 */
export interface CheckWaiverRef<
  Definition extends WaiverEligibleCheckDefinition = WaiverEligibleCheckDefinition,
  Subject extends WorkspaceSubject = WorkspaceSubject,
> {
  readonly ref: string;
  readonly check: Definition["name"];
  readonly revision: Definition["revision"];
  readonly definitionDigest: string;
  readonly binding: Definition["waiver"]["binding"];
  readonly action: Definition["waiver"]["action"];
  readonly risk: Definition["waiver"]["risk"];
  readonly maxTtl: Definition["waiver"]["maxTtl"];
  readonly subject: Subject;
  readonly failure: SubjectAttestation<"check", FailedCheckExecutionResult, Subject>;
  readonly reason: string;
  readonly issue?: string;
  readonly authorizedBy: CheckWaiverAuthorizer;
  readonly authorizedAt: string;
  readonly expiresAt: string;
  readonly attestation: SubjectAttestation<
    "check-waiver",
    CheckWaiverAttestationValue<Definition["name"], Definition["revision"], Definition["waiver"]>,
    Subject
  >;
  readonly [checkWaiverRefBrand]: readonly [definition: Definition, subject: Subject];
}

/**
 * Why: Supplies replay identity and a bounded human or policy request without allowing callers to weaken definition policy.
 * Use: Pass it to `ctx.check.authorize`; the host enforces `binding`, `action`, `risk`, and `maxTtl` from the definition.
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
  readonly key?: string;
  readonly policy?: "required";
  readonly timeout?: Duration;
}

/**
 * Why: Represents an ordinary engine-executed check invocation with no evidence substitution.
 * Use: This is the default branch when neither `trust` nor `waive` is supplied.
 */
export interface ExecutedCheckInvocationOptions extends CheckInvocationBaseOptions {
  readonly subject?: never;
  readonly trust?: never;
  readonly waive?: never;
}

/**
 * Why: Keeps trusted prior-run evidence mutually exclusive with execution and waiver authority.
 * Use: Supply a trusted run and reason only where host policy permits evidence reuse.
 */
export interface TrustedCheckInvocationOptions extends CheckInvocationBaseOptions {
  readonly subject?: never;
  readonly trust: TrustedCheckSource;
  readonly waive?: never;
}

/**
 * Why: Requires nominal workspace evidence when an executed check should return one refined subject type.
 * Use: Supply the current engine-minted subject instead of selecting a subject generic at the call site.
 */
export interface SubjectExecutedCheckInvocationOptions<Subject extends WorkspaceSubject>
  extends CheckInvocationBaseOptions {
  readonly subject: Subject;
  readonly trust?: never;
  readonly waive?: never;
}

/**
 * Why: Couples trusted evidence reuse to the exact nominal workspace subject claimed by its result.
 * Use: Supply both `subject` and `trust`; the host remains responsible for validating the trusted run.
 */
export interface SubjectTrustedCheckInvocationOptions<Subject extends WorkspaceSubject>
  extends CheckInvocationBaseOptions {
  readonly subject: Subject;
  readonly trust: TrustedCheckSource;
  readonly waive?: never;
}

/**
 * Why: Allows only one nominal ref for the matching eligible definition and failed workspace subject.
 * Use: Obtain `waive` from `ctx.check.authorize`; do not copy or reconstruct its fields.
 */
export interface WaivedCheckInvocationOptions<
  Definition extends WaiverEligibleCheckDefinition,
  Subject extends WorkspaceSubject = WorkspaceSubject,
> extends CheckInvocationBaseOptions {
  readonly subject?: NoInfer<Subject>;
  readonly trust?: never;
  readonly waive: CheckWaiverRef<Definition, Subject>;
}

/**
 * Why: Names the only ordinary invocation branches that do not claim a refined workspace subject.
 * Use: Use it for executed or trusted calls whose result should remain the broad `WorkspaceSubject`.
 */
export type UnboundCheckInvocationOptions = ExecutedCheckInvocationOptions | TrustedCheckInvocationOptions;

/**
 * Why: Selects ordinary, trusted, or definition-matched waived invocation options without caller-selected eligibility.
 * Use: Pass it to `ctx.check`; checks with `mode: "never"` have no waived branch.
 */
export type CheckInvocationOptions<
  Definition extends CheckDefinition<any, any, any, any, any> = AnyCheckDefinition,
  Subject extends WorkspaceSubject = WorkspaceSubject,
> =
  | SubjectExecutedCheckInvocationOptions<Subject>
  | SubjectTrustedCheckInvocationOptions<Subject>
  | (Definition extends WaiverEligibleCheckDefinition
      ? WaivedCheckInvocationOptions<Definition, Subject>
      : never);

/**
 * Why: Holds suite controls shared by exact-subject and unbound invocation paths.
 * Use: Extend it through the two mutually exclusive suite option branches below.
 */
export interface CheckSuiteInvocationBaseOptions {
  keyPrefix?: string;
  policy?: "required";
  timeout?: Duration;
  concurrency?: number;
}

/**
 * Why: Requires nominal workspace evidence before a suite result may retain one refined subject type.
 * Use: Pass the current engine-minted subject whenever suite evidence will authorize review or promotion.
 */
export interface CheckSuiteInvocationOptions<Subject extends WorkspaceSubject = WorkspaceSubject>
  extends CheckSuiteInvocationBaseOptions {
  subject: Subject;
}

/**
 * Why: Gives subject-agnostic suite calls a distinct path whose result cannot claim a refined subject.
 * Use: Omit `subject` only when broad `WorkspaceSubject` evidence is sufficient.
 */
export interface UnboundCheckSuiteInvocationOptions extends CheckSuiteInvocationBaseOptions {
  subject?: never;
}

/**
 * Why: Exposes the sole host-authorized transition from an eligible executed failure to nominal waiver authority.
 * Use: Access it as `ctx.check.authorize`; the exact definition and result brands must match.
 */
export type CheckWaiverAuthorizeFn = <
  Definition extends WaiverEligibleCheckDefinition,
  Subject extends WorkspaceSubject,
>(
  definition: Definition,
  failure: FailedCheckResultOf<Definition, Subject>,
  options: CheckWaiverAuthorizeOptions,
) => Promise<CheckWaiverRef<Definition, Subject>>;

/**
 * Why: Defines the standalone check invocation surface shared by workflow and workspace contexts.
 * Use: Call `ctx.check(definition, input?, options?)` when workflow code owns the response to failure.
 */
export interface CheckFn {
  readonly authorize: CheckWaiverAuthorizeFn;
  <Definition extends CheckDefinition<void, any, any, any>, Subject extends WorkspaceSubject>(
    definition: Definition,
    opts: CheckInvocationOptions<Definition, Subject>,
  ): Promise<CheckResultOf<Definition, Subject>>;
  <Definition extends CheckDefinition<void, any, any, any>>(
    definition: Definition,
    opts?: UnboundCheckInvocationOptions,
  ): Promise<CheckResultOf<Definition, WorkspaceSubject>>;
  <Input, Definition extends CheckDefinition<Input, any, any, any>, Subject extends WorkspaceSubject>(
    definition: Definition,
    input: Input,
    opts: CheckInvocationOptions<Definition, Subject>,
  ): Promise<CheckResultOf<Definition, Subject>>;
  <Input, Definition extends CheckDefinition<Input, any, any, any>>(
    definition: Definition,
    input: Input,
    opts?: UnboundCheckInvocationOptions,
  ): Promise<CheckResultOf<Definition, WorkspaceSubject>>;
  <Members extends CheckSuiteMembers, Subject extends WorkspaceSubject>(
    suite: CheckSuiteDefinition<void, Members>,
    opts: CheckSuiteInvocationOptions<Subject>,
  ): Promise<CheckSuiteResult<Members, Subject>>;
  <Members extends CheckSuiteMembers>(
    suite: CheckSuiteDefinition<void, Members>,
    opts?: UnboundCheckSuiteInvocationOptions,
  ): Promise<CheckSuiteResult<Members, WorkspaceSubject>>;
  <Input, Members extends CheckSuiteMembers, Subject extends WorkspaceSubject>(
    suite: CheckSuiteDefinition<Input, Members, any>,
    input: Input,
    opts: CheckSuiteInvocationOptions<Subject>,
  ): Promise<CheckSuiteResult<Members, Subject>>;
  <Input, Members extends CheckSuiteMembers>(
    suite: CheckSuiteDefinition<Input, Members, any>,
    input: Input,
    opts?: UnboundCheckSuiteInvocationOptions,
  ): Promise<CheckSuiteResult<Members, WorkspaceSubject>>;
}
