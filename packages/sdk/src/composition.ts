import type { AnySchema, InferIn, InferOut } from "./schema.ts";
import type {
  AgentDefinition,
  AgentDefinitionDefaults,
  CheckDefinition,
  CheckExecutionResult,
  CheckPolicy,
  CheckRunContext,
  CheckSuiteDefinition,
  CheckSuiteMembers,
  CheckSuiteUse,
  ParameterizedCheckSuiteDefinition,
  PromptPart,
  PromptSection,
  PromptTemplate,
  RecipeDefinition,
  StepDefinition,
} from "./types.ts";

function assertName(kind: string, name: string): void {
  if (typeof name !== "string" || name.trim() === "") {
    throw new TypeError(`${kind}: name must be a non-empty string`);
  }
}

function renderPart(part: PromptPart, output: string[]): void {
  if (part === false || part === null || part === undefined) return;
  if (Array.isArray(part)) {
    for (const child of part) renderPart(child, output);
    return;
  }
  if (typeof part === "string") {
    const value = part.trim();
    if (value) output.push(value);
    return;
  }
  const section = part as PromptSection;
  const body = section.body.trim();
  if (body) output.push(`## ${section.title.trim()}\n${body}`);
}

/** Render prompt fragments with stable section spacing and no empty blocks. */
export function renderPrompt(parts: PromptPart): string {
  const output: string[] = [];
  renderPart(parts, output);
  return output.join("\n\n");
}

/** Small prompt-building helpers; templates remain plain data-to-string functions. */
export const prompt = Object.freeze({
  section(title: string, body: string): PromptSection {
    return Object.freeze({ kind: "section" as const, title, body });
  },
  json(title: string, value: unknown): PromptSection {
    return Object.freeze({
      kind: "section" as const,
      title,
      body: `\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\``,
    });
  },
});

/** Define a schema-backed prompt contract. */
export function definePrompt<S extends AnySchema>(config: {
  name: string;
  input: S;
  render: (input: InferOut<S>) => PromptPart;
}): PromptTemplate<InferIn<S>, InferOut<S>>;
/** Define a legacy TypeScript-only prompt contract. */
export function definePrompt<Input>(config: {
  name: string;
  render: (input: Input) => PromptPart;
}): PromptTemplate<Input>;
export function definePrompt(config: any): any {
  assertName("definePrompt", config.name);
  if (typeof config.render !== "function") throw new TypeError("definePrompt: render must be a function");
  if (config.input !== undefined && typeof config.input?.["~standard"]?.validate !== "function") {
    throw new TypeError("definePrompt: input must be a Standard Schema");
  }
  return Object.freeze({
    kind: "weft.prompt" as const,
    name: config.name,
    ...(config.input !== undefined ? { input: config.input } : {}),
    render: (input: unknown) => renderPrompt(config.render(input)),
  });
}

/** Define a reusable agent role with one output contract and overridable execution defaults. */
export function defineAgent<Input, ParsedInput, S extends AnySchema>(config: {
  name: string;
  description?: string;
  prompt: PromptTemplate<Input, ParsedInput>;
  schema: S;
  defaults?: AgentDefinitionDefaults<S>;
}): AgentDefinition<Input, S, ParsedInput> {
  assertName("defineAgent", config.name);
  if (config.prompt?.kind !== "weft.prompt") {
    throw new TypeError("defineAgent: prompt must be created with definePrompt");
  }
  if (!config.schema) throw new TypeError("defineAgent: schema is required");
  return Object.freeze({
    kind: "weft.agent" as const,
    name: config.name,
    ...(config.description !== undefined ? { description: config.description } : {}),
    prompt: config.prompt,
    schema: config.schema,
    defaults: Object.freeze({ ...(config.defaults ?? {}) }),
  });
}

/** @deprecated Use schema-backed `defineRecipe()`. */
export function defineStep<Input, Output>(config: {
  name: string;
  description?: string;
  run: (ctx: import("./types.ts").Ctx<any, any>, input: Input) => Promise<Output>;
}): StepDefinition<Input, Output> {
  assertName("defineStep", config.name);
  if (typeof config.run !== "function") throw new TypeError("defineStep: run must be an async function");
  return Object.freeze({
    kind: "weft.step" as const,
    name: config.name,
    ...(config.description !== undefined ? { description: config.description } : {}),
    run: config.run,
  });
}

/** Define a schema-backed transparent recipe. */
export function defineRecipe<InputSchema extends AnySchema, OutputSchema extends AnySchema>(config: {
  name: string;
  description?: string;
  input: InputSchema;
  output: OutputSchema;
  run: (
    ctx: import("./types.ts").Ctx<any, any>,
    input: InferOut<InputSchema>,
  ) => Promise<InferIn<OutputSchema>> | InferIn<OutputSchema>;
}): RecipeDefinition<
  InferIn<InputSchema>,
  InferOut<OutputSchema>,
  InferOut<InputSchema>,
  InferIn<OutputSchema>
> {
  assertName("defineRecipe", config.name);
  if (typeof config.input?.["~standard"]?.validate !== "function") {
    throw new TypeError("defineRecipe: input must be a Standard Schema");
  }
  if (typeof config.output?.["~standard"]?.validate !== "function") {
    throw new TypeError("defineRecipe: output must be a Standard Schema");
  }
  if (typeof config.run !== "function") throw new TypeError("defineRecipe: run must be an async function");
  return Object.freeze({
    kind: "weft.recipe" as const,
    name: config.name,
    ...(config.description !== undefined ? { description: config.description } : {}),
    input: config.input,
    output: config.output,
    run: config.run,
  });
}

type CheckOutcome = Promise<boolean | CheckExecutionResult> | boolean | CheckExecutionResult;

/** Define a callback check with schema-validated input. */
export function defineCheck<S extends AnySchema, const Name extends string = string>(config: {
  name: Name;
  description?: string;
  policy?: CheckPolicy;
  revision?: string;
  input: S;
  run: (input: InferOut<S>, context: CheckRunContext) => CheckOutcome;
}): CheckDefinition<InferIn<S>, Name, InferOut<S>>;
/** Define a command check with schema-validated input. */
export function defineCheck<S extends AnySchema, const Name extends string = string>(config: {
  name: Name;
  description?: string;
  policy?: CheckPolicy;
  revision?: string;
  input: S;
  command: (input: InferOut<S>) => [string, ...string[]];
}): CheckDefinition<InferIn<S>, Name, InferOut<S>>;
/** Define a static callback check. */
export function defineCheck<const Name extends string>(config: {
  name: Name;
  description?: string;
  policy?: CheckPolicy;
  revision?: string;
  run: (context: CheckRunContext) => CheckOutcome;
}): CheckDefinition<void, Name>;
/** Define a static command check. */
export function defineCheck<const Name extends string>(config: {
  name: Name;
  description?: string;
  policy?: CheckPolicy;
  revision?: string;
  command: [string, ...string[]];
}): CheckDefinition<void, Name>;
export function defineCheck(config: any): any {
  assertName("defineCheck", config.name);
  if (config.policy !== undefined && config.policy !== "required" && config.policy !== "advisory") {
    throw new TypeError('defineCheck: policy must be "required" or "advisory"');
  }
  const parameterized = config.input !== undefined;
  if (parameterized && typeof config.input?.["~standard"]?.validate !== "function") {
    throw new TypeError("defineCheck: input must be a Standard Schema");
  }
  const sourceCount = Number(config.run !== undefined) + Number(config.command !== undefined);
  if (sourceCount !== 1) throw new TypeError("defineCheck: specify exactly one of run or command");
  if (config.run !== undefined && typeof config.run !== "function") {
    throw new TypeError("defineCheck: run must be a function");
  }
  if (
    config.command !== undefined &&
    !Array.isArray(config.command) &&
    typeof config.command !== "function"
  ) {
    throw new TypeError("defineCheck: command must be an argv tuple or function");
  }
  if (
    config.revision !== undefined &&
    (typeof config.revision !== "string" || config.revision.trim() === "")
  ) {
    throw new TypeError("defineCheck: revision must be a non-empty string");
  }
  if (
    Array.isArray(config.command) &&
    (config.command.length === 0 || config.command.some((part: unknown) => typeof part !== "string"))
  ) {
    throw new TypeError("defineCheck: command must be a non-empty string argv tuple");
  }
  const common = {
    kind: "weft.check" as const,
    name: config.name,
    ...(config.description !== undefined ? { description: config.description } : {}),
    policy: config.policy ?? "advisory",
    ...(config.revision !== undefined ? { revision: config.revision } : {}),
    ...(parameterized ? { input: config.input } : {}),
  };
  if (config.run) {
    const run = parameterized
      ? (input: unknown, context: CheckRunContext) => config.run!(input, context)
      : (_input: unknown, context: CheckRunContext) => config.run!(context);
    return Object.freeze({ ...common, mode: "run" as const, run });
  }
  const command =
    typeof config.command === "function"
      ? config.command
      : (_input: unknown): [string, ...string[]] => config.command as [string, ...string[]];
  return Object.freeze({ ...common, mode: "command" as const, command });
}

const suiteUse: CheckSuiteUse = ((definition: CheckDefinition<unknown>, input?: unknown) =>
  Object.freeze({ definition, input })) as CheckSuiteUse;

/** Define a reusable contextual suite; named members stay independently journaled. */
export function defineCheckSuite<S extends AnySchema, const Members extends CheckSuiteMembers>(config: {
  name: string;
  description?: string;
  input: S;
  checks: (input: InferOut<S>, use: CheckSuiteUse) => Members;
  concurrency?: number;
}): ParameterizedCheckSuiteDefinition<InferIn<S>, Members, InferOut<S>>;
/** Define a reusable group of static checks; members stay independently journaled. */
export function defineCheckSuite<const Checks extends readonly CheckDefinition<void>[]>(config: {
  name: string;
  description?: string;
  checks: Checks;
  concurrency?: number;
}): CheckSuiteDefinition<Checks>;
export function defineCheckSuite(config: any): any {
  assertName("defineCheckSuite", config.name);
  if (config.concurrency !== undefined && (!Number.isInteger(config.concurrency) || config.concurrency < 1)) {
    throw new TypeError("defineCheckSuite: concurrency must be a positive integer");
  }
  if (config.input !== undefined) {
    if (typeof config.input?.["~standard"]?.validate !== "function") {
      throw new TypeError("defineCheckSuite: input must be a Standard Schema");
    }
    if (typeof config.checks !== "function") {
      throw new TypeError("defineCheckSuite: contextual checks must be a function");
    }
    return Object.freeze({
      kind: "weft.check-suite" as const,
      name: config.name,
      ...(config.description !== undefined ? { description: config.description } : {}),
      input: config.input,
      resolve: (input: unknown) => config.checks(input, suiteUse),
      ...(config.concurrency !== undefined ? { concurrency: config.concurrency } : {}),
    });
  }
  if (!Array.isArray(config.checks) || config.checks.length === 0) {
    throw new TypeError("defineCheckSuite: checks must contain at least one check");
  }
  const names = new Set<string>();
  for (const check of config.checks) {
    if (check?.kind !== "weft.check" || check.input !== undefined) {
      throw new TypeError("defineCheckSuite: checks must be static definitions created with defineCheck");
    }
    if (names.has(check.name)) throw new TypeError(`defineCheckSuite: duplicate check name "${check.name}"`);
    names.add(check.name);
  }
  return Object.freeze({
    kind: "weft.check-suite" as const,
    name: config.name,
    ...(config.description !== undefined ? { description: config.description } : {}),
    checks: Object.freeze([...config.checks]),
    ...(config.concurrency !== undefined ? { concurrency: config.concurrency } : {}),
  });
}
