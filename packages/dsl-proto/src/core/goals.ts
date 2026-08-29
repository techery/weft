/** Declaration-only goals surface for the Weft DSL prototype. */
import type { AgentDefinition, AgentResult } from "./agent.ts";
import type {
  CheckDefinition,
  CheckResultOf,
  CheckSuiteDefinition,
  CheckSuiteMembers,
  CheckSuiteResult,
} from "./checks.ts";
import type { HumanReviewOptions, HumanReviewResult } from "./human.ts";
import type {
  AnySchema,
  InferIn,
  InferOut,
  SubjectAttestation,
  WorkflowNode,
  WorkspaceSubject,
} from "./shared.ts";

// ---------------------------------------------------------------------------
// Agent goals
// ---------------------------------------------------------------------------

/**
 * Why: Gives the goals DSL an explicit goal component contract instead of relying on untyped values.
 * Use: Import it when declaring, configuring, or consuming the corresponding goals API.
 */
export interface GoalComponent<Result> {
  readonly kind: "weft.goal-component";
  readonly __result?: Result;
}

/**
 * Why: Gives the goals DSL an explicit goal component result contract instead of relying on untyped values.
 * Use: Import it when declaring, configuring, or consuming the corresponding goals API.
 */
export type GoalComponentResult<Component> = Component extends GoalComponent<infer Result> ? Result : never;

/**
 * Why: Gives the goals DSL an explicit agent review component options contract instead of relying on untyped values.
 * Use: Import it when declaring, configuring, or consuming the corresponding goals API.
 */
export interface AgentReviewComponentOptions<Input, Value> {
  input: Input;
  accept: (result: AgentResult<Value>) => boolean;
  feedback?: (result: AgentResult<Value>) => unknown;
}

/**
 * Why: Gives the goals DSL an explicit human review component options contract instead of relying on untyped values.
 * Use: Import it when declaring, configuring, or consuming the corresponding goals API.
 */
export interface HumanReviewComponentOptions<S extends AnySchema, Props = never>
  extends Omit<HumanReviewOptions<S, Props>, "key"> {
  accept: (result: HumanReviewResult<InferOut<S>>) => boolean;
  feedback?: (result: HumanReviewResult<InferOut<S>>) => unknown;
}

/**
 * Why: Gives the goals DSL an explicit goal use contract instead of relying on untyped values.
 * Use: Import it when declaring, configuring, or consuming the corresponding goals API.
 */
export interface GoalUse {
  check<Definition extends CheckDefinition<void, any, any, any>>(
    definition: Definition,
  ): GoalComponent<CheckResultOf<Definition>>;
  check<Input, Definition extends CheckDefinition<Input, any, any, any>>(
    definition: Definition,
    input: Input,
  ): GoalComponent<CheckResultOf<Definition>>;
  check<Members extends CheckSuiteMembers>(
    definition: CheckSuiteDefinition<void, Members>,
  ): GoalComponent<CheckSuiteResult<Members>>;
  check<Input, Members extends CheckSuiteMembers>(
    definition: CheckSuiteDefinition<Input, Members, any>,
    input: Input,
  ): GoalComponent<CheckSuiteResult<Members>>;
  agentReview<Input, S extends AnySchema, ParsedInput>(
    definition: AgentDefinition<Input, S, ParsedInput>,
    options: AgentReviewComponentOptions<Input, InferOut<S>>,
  ): GoalComponent<AgentResult<InferOut<S>>>;
  humanReview<S extends AnySchema, Props = never>(
    schema: S,
    options: Omit<HumanReviewComponentOptions<S, Props>, "schema">,
  ): GoalComponent<HumanReviewResult<InferOut<S>>>;
}

/**
 * Why: Gives the goals DSL an explicit goal defaults contract instead of relying on untyped values.
 * Use: Import it when declaring, configuring, or consuming the corresponding goals API.
 */
export interface GoalDefaults {
  attempts?: number;
}

/**
 * Why: Names the ordered completion contract that keeps an implementation agent active until verification accepts.
 * Use: Create it with `defineGoal`, then attach it to an agent call through `goal.definition`.
 */
export interface GoalDefinition<
  Input = void,
  Results = Record<string, unknown>,
  ParsedInput = Input,
  Name extends string = string,
> extends WorkflowNode<"weft.goal"> {
  readonly kind: "weft.goal";
  readonly name: Name;
  readonly input?: AnySchema;
  readonly defaults?: Readonly<GoalDefaults>;
  readonly __input?: Input;
  readonly __parsedInput?: ParsedInput;
  readonly __results?: Results;
}

/**
 * Why: Centralizes the internal results of components relationship so adjacent public declarations infer consistently.
 * Use: It is used by the surrounding goals types and is not a separate runtime feature.
 */
type ResultsOfComponents<Components extends Record<string, GoalComponent<any>>> = {
  [Name in keyof Components]: GoalComponentResult<Components[Name]>;
};

/**
 * Why: Centralizes the internal check definition input relationship so adjacent public declarations infer consistently.
 * Use: It is used by the surrounding goals types and is not a separate runtime feature.
 */
type CheckDefinitionInput<Definition> =
  Definition extends CheckDefinition<infer Input, any, any, any>
    ? Input
    : Definition extends CheckSuiteDefinition<infer Input, any, any>
      ? Input
      : never;

/**
 * Why: Centralizes the internal check definition result relationship so adjacent public declarations infer consistently.
 * Use: It is used by the surrounding goals types and is not a separate runtime feature.
 */
type CheckDefinitionResult<Definition> =
  Definition extends CheckDefinition<any, any, any, any>
    ? CheckResultOf<Definition>
    : Definition extends CheckSuiteDefinition<any, infer Members, any>
      ? CheckSuiteResult<Members>
      : never;

/**
 * Why: Gives the goals DSL an explicit goal component map contract instead of relying on untyped values.
 * Use: Import it when declaring, configuring, or consuming the corresponding goals API.
 */
export type GoalComponentMap = Record<string, GoalComponent<any>>;

/**
 * Why: Gives the goals DSL an explicit goal config base contract instead of relying on untyped values.
 * Use: Import it when declaring, configuring, or consuming the corresponding goals API.
 */
export interface GoalConfigBase<Name extends string = string> {
  name: Name;
  defaults?: GoalDefaults;
}

/**
 * Why: Gives the goals DSL an explicit schema components goal config contract instead of relying on untyped values.
 * Use: Import it when declaring, configuring, or consuming the corresponding goals API.
 */
export interface SchemaComponentsGoalConfig<
  S extends AnySchema,
  Components extends GoalComponentMap,
  Name extends string = string,
> extends GoalConfigBase<Name> {
  input: S;
  components: (input: InferOut<S>, use: GoalUse) => Components;
}

/**
 * Why: Gives the goals DSL an explicit static components goal config contract instead of relying on untyped values.
 * Use: Import it when declaring, configuring, or consuming the corresponding goals API.
 */
export interface StaticComponentsGoalConfig<Components extends GoalComponentMap, Name extends string = string>
  extends GoalConfigBase<Name> {
  components: (input: undefined, use: GoalUse) => Components;
}

/**
 * Why: Gives the goals DSL an explicit check goal config contract instead of relying on untyped values.
 * Use: Import it when declaring, configuring, or consuming the corresponding goals API.
 */
export interface CheckGoalConfig<
  Definition extends CheckDefinition<any, any, any, any> | CheckSuiteDefinition<any, any, any>,
  Name extends string = string,
> extends GoalConfigBase<Name> {
  check: Definition;
}

/**
 * Why: Gives the goals DSL an explicit human review goal config contract instead of relying on untyped values.
 * Use: Import it when declaring, configuring, or consuming the corresponding goals API.
 */
export interface HumanReviewGoalConfig<
  InputSchema extends AnySchema,
  ReviewSchema extends AnySchema,
  Props,
  Name extends string = string,
> extends GoalConfigBase<Name> {
  input: InputSchema;
  humanReview: (input: InferOut<InputSchema>) => HumanReviewComponentOptions<ReviewSchema, Props>;
}

/**
 * Why: Gives the goals DSL an explicit agent review goal config contract instead of relying on untyped values.
 * Use: Import it when declaring, configuring, or consuming the corresponding goals API.
 */
export interface AgentReviewGoalConfig<Input, S extends AnySchema, ParsedInput, Name extends string = string>
  extends GoalConfigBase<Name> {
  agentReview: AgentDefinition<Input, S, ParsedInput>;
}

/**
 * Why: Gives the goals DSL an explicit check goal results contract instead of relying on untyped values.
 * Use: Import it when declaring, configuring, or consuming the corresponding goals API.
 */
export interface CheckGoalResults<Result> {
  check: Result;
}

/**
 * Why: Gives the goals DSL an explicit human review goal results contract instead of relying on untyped values.
 * Use: Import it when declaring, configuring, or consuming the corresponding goals API.
 */
export interface HumanReviewGoalResults<Result> {
  humanReview: Result;
}

/**
 * Why: Gives the goals DSL an explicit agent review goal results contract instead of relying on untyped values.
 * Use: Import it when declaring, configuring, or consuming the corresponding goals API.
 */
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
): GoalDefinition<InferIn<S>, ResultsOfComponents<Components>, InferOut<S>, Name>;

/**
 * Why: Declares an agent completion contract without running checks or reviewers.
 * Use: Use the component, check, human-review, or agent-review overload and attach the result to an agent invocation.
 */
export declare function defineGoal<
  const Components extends GoalComponentMap,
  const Name extends string = string,
>(
  config: StaticComponentsGoalConfig<Components, Name>,
): GoalDefinition<undefined, ResultsOfComponents<Components>, undefined, Name>;

/**
 * Why: Declares an agent completion contract without running checks or reviewers.
 * Use: Use the component, check, human-review, or agent-review overload and attach the result to an agent invocation.
 */
export declare function defineGoal<
  Definition extends CheckDefinition<any, any, any, any> | CheckSuiteDefinition<any, any, any>,
  const Name extends string = string,
>(
  config: CheckGoalConfig<Definition, Name>,
): GoalDefinition<
  CheckDefinitionInput<Definition>,
  CheckGoalResults<CheckDefinitionResult<Definition>>,
  CheckDefinitionInput<Definition>,
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
  InferIn<InputSchema>,
  HumanReviewGoalResults<HumanReviewResult<InferOut<ReviewSchema>>>,
  InferOut<InputSchema>,
  Name
>;

/**
 * Why: Declares an agent completion contract without running checks or reviewers.
 * Use: Use the component, check, human-review, or agent-review overload and attach the result to an agent invocation.
 */
export declare function defineGoal<
  Input,
  S extends AnySchema,
  ParsedInput,
  const Name extends string = string,
>(
  config: AgentReviewGoalConfig<Input, S, ParsedInput, Name>,
): GoalDefinition<Input, AgentReviewGoalResults<AgentResult<InferOut<S>>>, ParsedInput, Name>;

/**
 * Why: Recovers the exact definition-time goal name carried through goal invocation references.
 * Use: Apply it to a concrete `defineGoal` result; broad legacy definitions continue to produce `string`.
 */
export type GoalNameOf<Definition> =
  Definition extends GoalDefinition<any, any, any, infer Name> ? Name : never;

/**
 * Why: Gives the goals DSL an explicit goal attempt contract instead of relying on untyped values.
 * Use: Import it when declaring, configuring, or consuming the corresponding goals API.
 */
export interface GoalAttempt<Results> {
  attempt: number;
  status: "met" | "rejected" | "error" | "superseded";
  subject: WorkspaceSubject;
  results: Partial<Results>;
  evidence: string;
  attestation: SubjectAttestation<"goal-attempt", Partial<Results>>;
}

/**
 * Why: Exposes the accepted component results and full proposal history after an agent meets its goal.
 * Use: Read it from `AgentResult.goal` for evidence, reporting, or reviewed artifact metadata.
 */
export interface GoalResult<Results = Record<string, unknown>> {
  status: "met";
  attempts: number;
  results: Results;
  history: GoalAttempt<Results>[];
  evidence: string;
  subject: WorkspaceSubject;
  attestation: SubjectAttestation<"goal", Results>;
}
