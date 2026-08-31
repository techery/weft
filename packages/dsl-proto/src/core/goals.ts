/** Declaration-only goals surface for the Weft DSL prototype. */
import type { AgentDefinition, AgentResult, AgentTypesOf } from "./agent.ts";
import type {
  AnyCheckDefinition,
  CheckDefinition,
  CheckInputModeOf,
  CheckInputOf,
  CheckResultOf,
  CheckSuiteDefinition,
  CheckSuiteInputModeOf,
  CheckSuiteInputOf,
  CheckSuiteMembersOf,
  CheckSuiteResult,
  CheckSuiteTypes,
  CheckTypes,
} from "./checks.ts";
import type { HumanReviewOptions, HumanReviewResult } from "./human.ts";
import type {
  AnySchema,
  DefinitionTypeCarrier,
  InferIn,
  InferOut,
  InputMode,
  InputOf,
  OutputOf,
  ParsedInputOf,
  PromotionProof,
  SubjectAttestation,
  WorkflowNode,
  WorkspaceSnapshotRef,
} from "./shared.ts";

// ---------------------------------------------------------------------------
// Agent goals
// ---------------------------------------------------------------------------

/** Goal component. */
export interface GoalComponent<Result> extends DefinitionTypeCarrier<{ result: Result }> {
  readonly kind: "weft.goal-component";
}

/** Goal component result. */
export type GoalComponentResult<Component> =
  Component extends DefinitionTypeCarrier<{ result: infer Result }> ? Result : never;

/** Agent review component options. */
export interface AgentReviewComponentOptions<Input, Value> {
  input: Input;
  accept: (result: AgentResult<Value>) => boolean;
  feedback?: (result: AgentResult<Value>) => unknown;
}

/** Human review component options. */
export interface HumanReviewComponentOptions<S extends AnySchema, Props = never>
  extends Omit<HumanReviewOptions<S, Props>, "key"> {
  accept: (result: HumanReviewResult<InferOut<S>>) => boolean;
  feedback?: (result: HumanReviewResult<InferOut<S>>) => unknown;
}

/** Check definition constrained to one builder-level input mode. */
type CheckDefinitionWithInputMode<Mode extends InputMode> = CheckDefinition<
  Omit<CheckTypes, "inputMode"> & { readonly inputMode: Mode },
  any
>;

/** Check-suite definition constrained to one builder-level input mode. */
type CheckSuiteDefinitionWithInputMode<Mode extends InputMode> = CheckSuiteDefinition<
  Omit<CheckSuiteTypes, "inputMode"> & { readonly inputMode: Mode },
  any
>;

/** Goal use. */
export interface GoalUse {
  check<Definition extends CheckDefinitionWithInputMode<"none">>(
    definition: Definition,
  ): GoalComponent<CheckResultOf<Definition>>;
  check<Definition extends CheckDefinitionWithInputMode<"required">>(
    definition: Definition,
    input: CheckInputOf<Definition>,
  ): GoalComponent<CheckResultOf<Definition>>;
  check<Definition extends CheckSuiteDefinitionWithInputMode<"none">>(
    definition: Definition,
  ): GoalComponent<CheckSuiteResult<CheckSuiteMembersOf<Definition>>>;
  check<Definition extends CheckSuiteDefinitionWithInputMode<"required">>(
    definition: Definition,
    input: CheckSuiteInputOf<Definition>,
  ): GoalComponent<CheckSuiteResult<CheckSuiteMembersOf<Definition>>>;
  agentReview<Definition extends AgentDefinition<any, any>>(
    definition: Definition,
    options: AgentReviewComponentOptions<InputOf<Definition>, OutputOf<Definition>>,
  ): GoalComponent<AgentResult<OutputOf<Definition>>>;
  humanReview<S extends AnySchema, Props = never>(
    schema: S,
    options: Omit<HumanReviewComponentOptions<S, Props>, "schema">,
  ): GoalComponent<HumanReviewResult<InferOut<S>>>;
}

/** Goal defaults. */
export interface GoalDefaults {
  attempts?: number;
}

/** Hidden type relationships carried by one reusable goal definition. */
export interface GoalTypes {
  readonly input: unknown;
  readonly parsedInput: unknown;
  readonly results: unknown;
  readonly result: GoalResult<unknown>;
  readonly inputMode: InputMode;
}

/**
 * Why: Names the ordered completion contract that keeps an implementation agent active until verification accepts.
 * Use: Create it with `defineGoal`, then attach it to an agent call through `goal.definition`.
 */
export interface GoalDefinition<Types extends GoalTypes = GoalTypes, Name extends string = string>
  extends WorkflowNode<"weft.goal">,
    DefinitionTypeCarrier<Types> {
  readonly kind: "weft.goal";
  readonly name: Name;
  readonly input?: AnySchema;
  readonly defaults?: Readonly<GoalDefaults>;
}

/** Exact hidden type relationships carried by one reusable goal definition. */
export type GoalTypesOf<Definition> = Definition extends GoalDefinition<infer Types, any> ? Types : never;

/** Exact component-result map carried by one reusable goal definition. */
export type GoalResultsOf<Definition> = GoalTypesOf<Definition>["results"];

/** Inferred result map for a goal's components. */
type ResultsOfComponents<Components extends Record<string, GoalComponent<any>>> = {
  [Name in keyof Components]: GoalComponentResult<Components[Name]>;
};

/** Input accepted by a check or check-suite definition. */
type CheckDefinitionInput<Definition> = Definition extends AnyCheckDefinition
  ? CheckInputOf<Definition>
  : Definition extends CheckSuiteDefinition<any, any>
    ? CheckSuiteInputOf<Definition>
    : never;

/** Schema-validated input accepted by a check or check-suite implementation. */
type CheckDefinitionParsedInput<Definition> = Definition extends
  | CheckDefinition<any, any>
  | CheckSuiteDefinition<any, any>
  ? ParsedInputOf<Definition>
  : never;

/**
 * Why: Preserves whether a goal derived from a check definition requires an explicit input property.
 * Use: It is carried into the corresponding `GoalDefinition` instead of re-deriving presence from the input value type.
 */
type CheckDefinitionInputMode<Definition> = Definition extends AnyCheckDefinition
  ? CheckInputModeOf<Definition>
  : Definition extends CheckSuiteDefinition<any, any>
    ? CheckSuiteInputModeOf<Definition>
    : InputMode;

/** Result produced by a check or check-suite definition. */
type CheckDefinitionResult<Definition> = Definition extends AnyCheckDefinition
  ? CheckResultOf<Definition>
  : Definition extends CheckSuiteDefinition<any, any>
    ? CheckSuiteResult<CheckSuiteMembersOf<Definition>>
    : never;

/** Goal component map. */
export type GoalComponentMap = Record<string, GoalComponent<any>>;

/** Goal config base. */
export interface GoalConfigBase<Name extends string = string> {
  name: Name;
  defaults?: GoalDefaults;
}

/** Schema components goal config. */
export interface SchemaComponentsGoalConfig<
  S extends AnySchema,
  Components extends GoalComponentMap,
  Name extends string = string,
> extends GoalConfigBase<Name> {
  input: S;
  components: (input: InferOut<S>, use: GoalUse) => Components;
}

/** Static components goal config. */
export interface StaticComponentsGoalConfig<Components extends GoalComponentMap, Name extends string = string>
  extends GoalConfigBase<Name> {
  components: (input: undefined, use: GoalUse) => Components;
}

/** Check goal config. */
export interface CheckGoalConfig<
  Definition extends AnyCheckDefinition | CheckSuiteDefinition<any, any>,
  Name extends string = string,
> extends GoalConfigBase<Name> {
  check: Definition;
}

/** Human review goal config. */
export interface HumanReviewGoalConfig<
  InputSchema extends AnySchema,
  ReviewSchema extends AnySchema,
  Props,
  Name extends string = string,
> extends GoalConfigBase<Name> {
  input: InputSchema;
  humanReview: (input: InferOut<InputSchema>) => HumanReviewComponentOptions<ReviewSchema, Props>;
}

/** Agent review goal config. */
export interface AgentReviewGoalConfig<
  Definition extends AgentDefinition<any, any>,
  Name extends string = string,
> extends GoalConfigBase<Name> {
  agentReview: Definition;
}

/** Check goal results. */
export interface CheckGoalResults<Result> {
  check: Result;
}

/** Human review goal results. */
export interface HumanReviewGoalResults<Result> {
  humanReview: Result;
}

/** Agent review goal results. */
export interface AgentReviewGoalResults<Result> {
  agentReview: Result;
}

/**
 * Why: Declares an agent completion contract without running checks or reviewers.
 * Use: Use the component, check, human-review, or agent-review overload and attach the result to an agent invocation.
 */
export declare function defineGoal<
  S extends AnySchema,
  const Components extends Record<string, GoalComponent<any>>,
  const Name extends string = string,
>(
  config: SchemaComponentsGoalConfig<S, Components, Name>,
): GoalDefinition<
  {
    input: InferIn<S>;
    parsedInput: InferOut<S>;
    results: ResultsOfComponents<Components>;
    result: GoalResult<ResultsOfComponents<Components>>;
    inputMode: "required";
  },
  Name
>;

/**
 * Why: Declares an agent completion contract without running checks or reviewers.
 * Use: Use the component, check, human-review, or agent-review overload and attach the result to an agent invocation.
 */
export declare function defineGoal<
  const Components extends GoalComponentMap,
  const Name extends string = string,
>(
  config: StaticComponentsGoalConfig<Components, Name>,
): GoalDefinition<
  {
    input: undefined;
    parsedInput: undefined;
    results: ResultsOfComponents<Components>;
    result: GoalResult<ResultsOfComponents<Components>>;
    inputMode: "none";
  },
  Name
>;

/**
 * Why: Declares an agent completion contract without running checks or reviewers.
 * Use: Use the component, check, human-review, or agent-review overload and attach the result to an agent invocation.
 */
export declare function defineGoal<
  Definition extends AnyCheckDefinition | CheckSuiteDefinition<any, any>,
  const Name extends string = string,
>(
  config: CheckGoalConfig<Definition, Name>,
): GoalDefinition<
  {
    input: CheckDefinitionInput<Definition>;
    parsedInput: CheckDefinitionParsedInput<Definition>;
    results: CheckGoalResults<CheckDefinitionResult<Definition>>;
    result: GoalResult<CheckGoalResults<CheckDefinitionResult<Definition>>>;
    inputMode: CheckDefinitionInputMode<Definition>;
  },
  Name
>;

/**
 * Why: Declares an agent completion contract without running checks or reviewers.
 * Use: Use the component, check, human-review, or agent-review overload and attach the result to an agent invocation.
 */
export declare function defineGoal<
  InputSchema extends AnySchema,
  ReviewSchema extends AnySchema,
  Props = never,
  const Name extends string = string,
>(
  config: HumanReviewGoalConfig<InputSchema, ReviewSchema, Props, Name>,
): GoalDefinition<
  {
    input: InferIn<InputSchema>;
    parsedInput: InferOut<InputSchema>;
    results: HumanReviewGoalResults<HumanReviewResult<InferOut<ReviewSchema>>>;
    result: GoalResult<HumanReviewGoalResults<HumanReviewResult<InferOut<ReviewSchema>>>>;
    inputMode: "required";
  },
  Name
>;

/**
 * Why: Declares an agent completion contract without running checks or reviewers.
 * Use: Use the component, check, human-review, or agent-review overload and attach the result to an agent invocation.
 */
export declare function defineGoal<
  Definition extends AgentDefinition<any, any>,
  const Name extends string = string,
>(
  config: AgentReviewGoalConfig<Definition, Name>,
): GoalDefinition<
  {
    input: InputOf<Definition>;
    parsedInput: ParsedInputOf<Definition>;
    results: AgentReviewGoalResults<AgentResult<OutputOf<Definition>>>;
    result: GoalResult<AgentReviewGoalResults<AgentResult<OutputOf<Definition>>>>;
    inputMode: AgentTypesOf<Definition>["inputMode"];
  },
  Name
>;

/**
 * Why: Recovers the exact definition-time goal name carried through goal invocation references.
 * Use: Apply it to a concrete `defineGoal` result; broad legacy definitions continue to produce `string`.
 */
export type GoalNameOf<Definition> = Definition extends GoalDefinition<any, infer Name> ? Name : never;

/** Goal attempt. */
export interface GoalAttempt<Results, Candidate extends WorkspaceSnapshotRef = WorkspaceSnapshotRef> {
  readonly attempt: number;
  readonly status: "met" | "rejected" | "error" | "superseded";
  readonly candidate: Candidate;
  readonly results: Partial<Results>;
  readonly evidence: string;
  readonly attestation: SubjectAttestation<"goal-attempt", Partial<Results>, Candidate>;
}

/**
 * Why: Exposes the accepted component results and full proposal history after an agent meets its goal.
 * Use: Read it from `AgentResult.goal` for evidence, reporting, or reviewed artifact metadata.
 */
export interface GoalResult<
  Results = Record<string, unknown>,
  Candidate extends WorkspaceSnapshotRef = WorkspaceSnapshotRef,
> {
  readonly status: "met";
  readonly attempts: number;
  readonly results: Results;
  readonly history: readonly GoalAttempt<Results, Candidate>[];
  readonly evidence: string;
  readonly candidate: Candidate;
  readonly attestation: SubjectAttestation<"goal", Results, Candidate>;
  readonly proof: PromotionProof<"goal", Candidate>;
}
