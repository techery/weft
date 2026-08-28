/** Declaration-only checks surface for the Weft DSL prototype. */

import type { WorkspaceSubject } from "./goals.ts";
import type { AnySchema, Duration, InferIn, InferOut, WorkflowNode } from "./shared.ts";

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
 * Why: Carries a check verdict, evidence, disposition, and observed workspace generation as durable proof.
 * Use: Inspect it after `ctx.check` or through a suite or goal result.
 */
export interface CheckResult<Details extends readonly CheckEvidence[] = readonly CheckEvidence[]>
  extends CheckExecutionResult<Details> {
  disposition: CheckDisposition;
  subject?: WorkspaceSubject;
}

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
> extends WorkflowNode<"weft.check"> {
  readonly kind: "weft.check";
  readonly name: Name;
  readonly description?: string;
  readonly policy: CheckPolicy;
  readonly revision?: string;
  readonly input?: AnySchema;
  readonly defaults?: Readonly<CheckDefaults>;
  readonly __input?: Input;
  readonly __parsedInput?: ParsedInput;
  readonly __result?: Result;
}

/**
 * Why: Centralizes the internal check outcome relationship so adjacent public declarations infer consistently.
 * Use: It is used by the surrounding checks types and is not a separate runtime feature.
 */
type CheckOutcome = boolean | CheckExecutionResult | Promise<boolean | CheckExecutionResult>;

/**
 * Why: Gives the checks DSL an explicit check config base contract instead of relying on untyped values.
 * Use: Import it when declaring, configuring, or consuming the corresponding checks API.
 */
export interface CheckConfigBase<Name extends string> {
  name: Name;
  description?: string;
  revision?: string;
  policy?: CheckPolicy;
  defaults?: CheckDefaults;
}

/**
 * Why: Gives the checks DSL an explicit schema run check config contract instead of relying on untyped values.
 * Use: Import it when declaring, configuring, or consuming the corresponding checks API.
 */
export interface SchemaRunCheckConfig<S extends AnySchema, Name extends string>
  extends CheckConfigBase<Name> {
  input: S;
  run: (input: InferOut<S>, context: CheckRunContext) => CheckOutcome;
}

/**
 * Why: Gives the checks DSL an explicit schema command check config contract instead of relying on untyped values.
 * Use: Import it when declaring, configuring, or consuming the corresponding checks API.
 */
export interface SchemaCommandCheckConfig<S extends AnySchema, Name extends string>
  extends CheckConfigBase<Name> {
  input: S;
  command: (input: InferOut<S>) => readonly string[];
}

/**
 * Why: Gives the checks DSL an explicit parsed schema command check config contract instead of relying on untyped values.
 * Use: Import it when declaring, configuring, or consuming the corresponding checks API.
 */
export interface ParsedSchemaCommandCheckConfig<
  S extends AnySchema,
  Name extends string,
  Result extends CheckExecutionResult,
> extends SchemaCommandCheckConfig<S, Name> {
  parse: (result: CommandResult) => Result;
}

/**
 * Why: Gives the checks DSL an explicit static run check config contract instead of relying on untyped values.
 * Use: Import it when declaring, configuring, or consuming the corresponding checks API.
 */
export interface StaticRunCheckConfig<Name extends string> extends CheckConfigBase<Name> {
  run: (context: CheckRunContext) => CheckOutcome;
}

/**
 * Why: Gives the checks DSL an explicit static command check config contract instead of relying on untyped values.
 * Use: Import it when declaring, configuring, or consuming the corresponding checks API.
 */
export interface StaticCommandCheckConfig<Name extends string> extends CheckConfigBase<Name> {
  command: readonly string[] | (() => readonly string[]);
}

/**
 * Why: Gives the checks DSL an explicit parsed static command check config contract instead of relying on untyped values.
 * Use: Import it when declaring, configuring, or consuming the corresponding checks API.
 */
export interface ParsedStaticCommandCheckConfig<Name extends string, Result extends CheckExecutionResult>
  extends StaticCommandCheckConfig<Name> {
  parse: (result: CommandResult) => Result;
}

/**
 * Why: Declares a reusable command or function check without executing it.
 * Use: Choose the overload matching static or schema-backed input and optional structured parsing.
 */
export declare function defineCheck<S extends AnySchema, const Name extends string>(
  config: SchemaRunCheckConfig<S, Name>,
): CheckDefinition<InferIn<S>, Name, InferOut<S>>;

/**
 * Why: Declares a reusable command or function check without executing it.
 * Use: Choose the overload matching static or schema-backed input and optional structured parsing.
 */
export declare function defineCheck<
  S extends AnySchema,
  const Name extends string,
  Result extends CheckExecutionResult,
>(
  config: ParsedSchemaCommandCheckConfig<S, Name, Result>,
): CheckDefinition<InferIn<S>, Name, InferOut<S>, Result>;

/**
 * Why: Declares a reusable command or function check without executing it.
 * Use: Choose the overload matching static or schema-backed input and optional structured parsing.
 */
export declare function defineCheck<S extends AnySchema, const Name extends string>(
  config: SchemaCommandCheckConfig<S, Name>,
): CheckDefinition<InferIn<S>, Name, InferOut<S>>;

/**
 * Why: Declares a reusable command or function check without executing it.
 * Use: Choose the overload matching static or schema-backed input and optional structured parsing.
 */
export declare function defineCheck<const Name extends string>(
  config: StaticRunCheckConfig<Name>,
): CheckDefinition<void, Name>;

/**
 * Why: Declares a reusable command or function check without executing it.
 * Use: Choose the overload matching static or schema-backed input and optional structured parsing.
 */
export declare function defineCheck<const Name extends string, Result extends CheckExecutionResult>(
  config: ParsedStaticCommandCheckConfig<Name, Result>,
): CheckDefinition<void, Name, void, Result>;

/**
 * Why: Declares a reusable command or function check without executing it.
 * Use: Choose the overload matching static or schema-backed input and optional structured parsing.
 */
export declare function defineCheck<const Name extends string>(
  config: StaticCommandCheckConfig<Name>,
): CheckDefinition<void, Name>;

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
> extends WorkflowNode<"weft.check-suite"> {
  readonly kind: "weft.check-suite";
  readonly name: string;
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
export interface SchemaCheckSuiteConfig<S extends AnySchema, Members extends CheckSuiteMembers> {
  name: string;
  description?: string;
  input: S;
  checks: (input: InferOut<S>, use: CheckSuiteUse) => Members;
  concurrency?: number;
}

/**
 * Why: Gives the checks DSL an explicit static check suite config contract instead of relying on untyped values.
 * Use: Import it when declaring, configuring, or consuming the corresponding checks API.
 */
export interface StaticCheckSuiteConfig<Checks extends readonly CheckDefinition<void, string, any, any>[]> {
  name: string;
  description?: string;
  checks: Checks;
  concurrency?: number;
}

/**
 * Why: Groups named checks while preserving each member as independently visible evidence.
 * Use: Use the static overload for fixed checks or the schema-backed overload to derive members from input.
 */
export declare function defineCheckSuite<S extends AnySchema, const Members extends CheckSuiteMembers>(
  config: SchemaCheckSuiteConfig<S, Members>,
): CheckSuiteDefinition<InferIn<S>, Members, InferOut<S>>;

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
>(config: StaticCheckSuiteConfig<Checks>): CheckSuiteDefinition<void, StaticCheckMembers<Checks>>;

/**
 * Why: Gives the checks DSL an explicit check result of contract instead of relying on untyped values.
 * Use: Import it when declaring, configuring, or consuming the corresponding checks API.
 */
export type CheckResultOf<Definition> =
  Definition extends CheckDefinition<any, any, any, infer Result>
    ? CheckResult<NonNullable<Result["details"]>>
    : CheckResult;

/**
 * Why: Gives the checks DSL an explicit check suite result contract instead of relying on untyped values.
 * Use: Import it when declaring, configuring, or consuming the corresponding checks API.
 */
export interface CheckSuiteResult<Members extends CheckSuiteMembers = CheckSuiteMembers> {
  passed: boolean;
  results: CheckSuiteResults<Members>;
  subject?: WorkspaceSubject;
}

/**
 * Why: Gives the checks DSL an explicit check suite results contract instead of relying on untyped values.
 * Use: Import it when declaring, configuring, or consuming the corresponding checks API.
 */
export type CheckSuiteResults<Members extends CheckSuiteMembers> = {
  [Name in keyof Members]: CheckResultOf<Members[Name]["definition"]>;
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
 * Why: Gives the checks DSL an explicit check waiver contract instead of relying on untyped values.
 * Use: Import it when declaring, configuring, or consuming the corresponding checks API.
 */
export interface CheckWaiver {
  reason: string;
  issue?: string;
  expiresAt?: string;
}

/**
 * Why: Gives the checks DSL an explicit check invocation options contract instead of relying on untyped values.
 * Use: Import it when declaring, configuring, or consuming the corresponding checks API.
 */
export interface CheckInvocationOptions {
  key?: string;
  policy?: "required";
  timeout?: Duration;
  trust?: TrustedCheckSource;
  waive?: CheckWaiver;
}

/**
 * Why: Gives the checks DSL an explicit check suite invocation options contract instead of relying on untyped values.
 * Use: Import it when declaring, configuring, or consuming the corresponding checks API.
 */
export interface CheckSuiteInvocationOptions {
  keyPrefix?: string;
  policy?: "required";
  timeout?: Duration;
  concurrency?: number;
}

/**
 * Why: Defines the standalone check invocation surface shared by workflow and workspace contexts.
 * Use: Call `ctx.check(definition, input?, options?)` when workflow code owns the response to failure.
 */
export interface CheckFn {
  <Definition extends CheckDefinition<void, any, any, any>>(
    definition: Definition,
    opts?: CheckInvocationOptions,
  ): Promise<CheckResultOf<Definition>>;
  <Input, Definition extends CheckDefinition<Input, any, any, any>>(
    definition: Definition,
    input: Input,
    opts?: CheckInvocationOptions,
  ): Promise<CheckResultOf<Definition>>;
  <Members extends CheckSuiteMembers>(
    suite: CheckSuiteDefinition<void, Members>,
    opts?: CheckSuiteInvocationOptions,
  ): Promise<CheckSuiteResult<Members>>;
  <Input, Members extends CheckSuiteMembers>(
    suite: CheckSuiteDefinition<Input, Members, any>,
    input: Input,
    opts?: CheckSuiteInvocationOptions,
  ): Promise<CheckSuiteResult<Members>>;
}
