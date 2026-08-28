# Weft DSL prototype

This package is a type-only playground for the intended Weft context DSL described in
[`docs/weft-dsl-user-stories.md`](../../docs/weft-dsl-user-stories.md). It deliberately contains no
workflow engine, journal, provider, workspace, Git, task, gate, or UI implementation.

Use it to author and type-check proposed workflows:

```ts
import { defineWorkflow, z } from "@techery/weft-dsl-proto";

export default defineWorkflow(
  {
    id: "hello-weft",
    input: z.object({ name: z.string() }),
    output: z.object({ greeting: z.string() }),
  },
  async (ctx, input) => {
    const result = await ctx.agent({
      key: "greet",
      prompt: `Write a greeting for ${input.name}`,
      schema: z.object({ greeting: z.string() }),
    });

    return result.value;
  },
);
```

The package re-exports Zod for realistic schema inference. Every Weft DSL function is declaration-only;
the emitted domain modules are empty and the barrel's only concrete export is Zod. Importing a declared
Weft function at runtime is unsupported. This package is for design exploration and compile-time feedback,
not workflow execution.

## Module layout

- `src/core/shared.ts` — Standard Schema, shared primitives, providers, and prompts
- `src/core/artifacts.ts` — typed immutable artifact contracts and capture references
- `src/core/checks.ts` — checks, suites, structured evidence, and invocation types
- `src/core/human.ts` — human interaction and schema-backed UI views
- `src/core/observers.ts` — durable polling and host-signal observation contracts
- `src/core/operations.ts` — authorized schema-backed atomic integration operations
- `src/core/goals.ts` — goal components, attempts, and accepted verdicts
- `src/core/agent.ts` — agent calls/results, write scopes, patches, and recipes
- `src/core/composition.ts` — parallel, sequence, pipeline, and settlement types
- `src/core/effects.ts` — filesystem, processes, HTTP, secrets, polling, and Git
- `src/core/workspace.ts` — candidate workspaces, integration, gates, and notes
- `src/core/tasks.ts` — durable task contracts and mutations
- `src/core/workflow.ts` — workflow definitions and the composed context API
- `src/core/internal-engine.ts` — internal bound invocation algebra and generic executor contract
- `src/core/index.ts` — the core declaration barrel
- `src/examples/workflows.ts` — compile-time workflow demonstrations based on the user stories
- `src/examples/coding-nodes.ts` — operation, observer, and artifact workflow demonstration
- `src/examples/internal-engine.ts` — compile-time proof that every node invocation preserves its output
- `src/index.ts` — the stable package barrel

## Declaration conventions

Every named type and declaration function has JSDoc with explicit `Why` and `Use` guidance. Public
signatures prefer named option, input, and result types; the remaining inline object syntax is limited to
mapped-type machinery where TypeScript requires an object mapping. `pnpm run check:docs` enforces the
documentation contract and is included in the package type-check.

Every value returned by a `define*` function extends the nominal `WorkflowNode` contract. Its `kind` remains
a specific `WorkflowNodeKind`, so mixed definition registries can accept one global type and still narrow
each node without losing the definition's inferred schemas or inputs.

Definitions remain inert. Internally, context methods bind them to nominal `WorkflowInvocation` values that
carry a concrete key, input, execution context, and output type. `InternalEngine.execute` accepts the closed
invocation union and preserves each exact output; the internal engine module is intentionally not exported
from the public package barrel.
