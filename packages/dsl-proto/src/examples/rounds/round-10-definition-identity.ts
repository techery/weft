import type {
  DefinedAgentInvocation,
  PromptRenderInvocation,
  RecipeInvocation,
} from "../../core/internal-engine.ts";
import {
  type AgentDefinition,
  defineAgent,
  definePrompt,
  defineRecipe,
  type PromptDefinition,
  type RecipeDefinition,
  z,
} from "../../index.ts";

/** Why: Makes exact-name compatibility and rejection visible without runtime behavior. Use: Compile this fixture with the package. */
declare function expectType<Type>(value: Type): void;

const IdentityInputSchema = z.object({ task: z.string().min(1) }).strict();
const IdentityOutputSchema = z.object({ summary: z.string().min(1) }).strict();

/** Why: Names the raw prompt and recipe input used by compatibility assertions. Use: Keep schema input separate from parsed callback input. */
type IdentityInput = z.input<typeof IdentityInputSchema>;

/** Why: Names the parsed prompt and recipe input used by invocation assertions. Use: Verify schema parsing remains unchanged by name identity. */
type IdentityInputValue = z.output<typeof IdentityInputSchema>;

/** Why: Names the validated output shared by both agents and recipes. Use: Isolate name identity from I/O differences. */
type IdentityOutputValue = z.output<typeof IdentityOutputSchema>;

const primaryPrompt = definePrompt({
  name: "round-10-primary-prompt",
  input: IdentityInputSchema,
  render: ({ task }) => `Complete ${task}`,
});

const alternatePrompt = definePrompt({
  name: "round-10-alternate-prompt",
  input: IdentityInputSchema,
  render: ({ task }) => `Complete ${task}`,
});

const primaryAgent = defineAgent({
  name: "round-10-primary-agent",
  prompt: primaryPrompt,
  schema: IdentityOutputSchema,
});

const alternateAgent = defineAgent({
  name: "round-10-alternate-agent",
  prompt: primaryPrompt,
  schema: IdentityOutputSchema,
});

const primaryRecipe = defineRecipe({
  name: "round-10-primary-recipe",
  input: IdentityInputSchema,
  output: IdentityOutputSchema,
  run: async (_ctx, input) => ({ summary: input.task }),
});

const alternateRecipe = defineRecipe({
  name: "round-10-alternate-recipe",
  input: IdentityInputSchema,
  output: IdentityOutputSchema,
  run: async (_ctx, input) => ({ summary: input.task }),
});

/** Why: Binds one exact reusable agent into the internal invocation fixture. Use: Confirm invocation nodes do not widen the agent name. */
interface PrimaryAgentCall {
  readonly key: "round-10-primary-agent-call";
  readonly agent: typeof primaryAgent;
  readonly input: IdentityInput;
}

declare const primaryPromptInvocation: PromptRenderInvocation<typeof primaryPrompt>;
declare const alternatePromptInvocation: PromptRenderInvocation<typeof alternatePrompt>;
declare const primaryAgentInvocation: DefinedAgentInvocation<PrimaryAgentCall, false>;
declare const primaryRecipeInvocation: RecipeInvocation<typeof primaryRecipe>;
declare const alternateRecipeInvocation: RecipeInvocation<typeof alternateRecipe>;

expectType<"round-10-primary-prompt">(primaryPrompt.name);
expectType<"round-10-primary-agent">(primaryAgent.name);
expectType<"round-10-primary-recipe">(primaryRecipe.name);
expectType<"round-10-primary-prompt">(primaryPromptInvocation.node.name);
expectType<"round-10-primary-agent">(primaryAgentInvocation.node.name);
expectType<"round-10-primary-recipe">(primaryRecipeInvocation.node.name);

expectType<PromptDefinition<IdentityInput, IdentityInputValue>>(primaryPrompt);
expectType<AgentDefinition<IdentityInput, typeof IdentityOutputSchema, IdentityInputValue>>(primaryAgent);
expectType<RecipeDefinition<IdentityInput, IdentityOutputValue, IdentityInputValue>>(primaryRecipe);

// @ts-expect-error Exact prompt names prevent a different nominal definition from entering this slot.
expectType<typeof primaryPrompt>(alternatePrompt);
// @ts-expect-error Prompt invocation identity retains its exact definition name.
expectType<typeof primaryPromptInvocation>(alternatePromptInvocation);
// @ts-expect-error Exact agent names distinguish otherwise identical reusable roles.
expectType<typeof primaryAgent>(alternateAgent);
// @ts-expect-error Exact recipe names prevent a different nominal definition from entering this slot.
expectType<typeof primaryRecipe>(alternateRecipe);
// @ts-expect-error Recipe invocation identity retains its exact definition name.
expectType<typeof primaryRecipeInvocation>(alternateRecipeInvocation);
