# Weft DSL prototype

This package is a declaration-only design lab for a future Weft context DSL. It has no workflow engine or
runtime exports. Its job is to make authoring ideas concrete enough for TypeScript to check.

```ts
import { defineWorkflow, z } from "@techery/weft-dsl-proto";

export default defineWorkflow(
  {
    id: "hello-weft",
    input: z.object({ name: z.string() }),
    output: z.object({ greeting: z.string() }),
  },
  async (ctx, input) => {
    const result = await ctx.agent(
      {
        prompt: `Write a greeting for ${input.name}`,
        schema: z.object({ greeting: z.string() }),
      },
      { key: "greet" },
    );

    return result.value;
  },
);
```

The source barrel re-exports Zod for realistic compiler fixtures. The declaration build exposes only a `types`
condition, so even that convenience export is not available at runtime.

## The smaller authoring model

The prototype deliberately uses ordinary TypeScript wherever a separate DSL concept adds no durable behavior:

- `await` expresses order;
- `if`, `switch`, and bounded loops express control flow;
- plain typed functions provide same-run reuse;
- `ctx.step(key, callback)` groups several durable effects under one stable namespace;
- `ctx.parallel.all` and `ctx.parallel.settled` provide durable keyed fan-out;
- `ctx.workflow` starts a separately durable child workflow.

There is no recipe, sequence, pipeline, stage, or graph-builder abstraction. For example:

```ts
async function inspect(item: Item): Promise<Inspection> {
  return analyze(item);
}

const inspections = await ctx.parallel.all(
  items,
  (item) => inspect(item),
  { key: "inspect", keyOf: (item) => item.id },
);

for (const item of inspections) {
  await ctx.step(item.id, async (step) => {
    await step.agent(reviewer, item, { key: "review" });
  });
}
```

`ctx.scope(...)` remains for inherited defaults such as agent settings, budgets, task access, concurrency, and a
composed key prefix. It does not create a new execution node.

## One call per capability

Agent behavior is selected by orthogonal options rather than separate methods:

```ts
const plan = await ctx.agent(planner, issue, { key: "plan" });

const implementation = await ctx.agent(developer, plan.value, {
  key: "implement",
  write: writeScope,
});

const optionalReview = await ctx.agent(reviewer, implementation.value, {
  key: "optional-review",
  failure: "return",
});
```

Operations follow the same rule. Their definition determines whether execution is direct, protected, or
recoverable:

```ts
const pullRequest = await ctx.operation(openPullRequest, input, {
  key: "open-pull-request",
  authorization: { detail: "Publish the reviewed change" },
});

const deployment = await ctx.operation(recoverableDeployment, input, {
  key: "deploy",
  idempotencyKey: input.releaseId,
  authorization: { detail: "Deploy the verified release" },
});
```

Authors do not call `prepare`, `authorize`, or `execute`. Those remain engine stages behind one journaled call.
Recoverable results still distinguish success, confirmed non-commit, and ambiguous external state.

Verified delivery is also one call:

```ts
const receipt = await ctx.delivery(pullRequestDelivery, {
  key: "deliver",
  candidate: ctx.workspace.snapshot,
  input,
  proofs: [quality.proof, review.proof],
  authorization: { detail: "Open the pull request" },
});
```

## Safety boundaries

- `WorkflowNode` is inert public identity. Execution-bound input, output, key, and context live on internal
  invocation types.
- Engine-minted snapshots, proofs, evidence, write grants, waivers, receipts, patches, and secret handles remain
  nominal. Matching object shapes cannot accidentally manufacture authority.
- Plain workflows have read-only Git. Workflows that declare a workspace receive `WorkspaceCtx` with bounded Git
  mutation and `ctx.workspace.snapshot`.
- Checks, reviews, artifacts, and delivery bind to the exact snapshot they observed. The host must reject stale
  candidates or evidence from another candidate atomically.
- `ctx.policy.decide` and `ctx.human.confirm` are branching answers, not reusable authorization.
- Protected operations and delivery derive candidate-specific authorization from their definitions inside the
  engine-owned call.
- External effects require stable idempotency. If the host cannot establish whether an effect committed, it must
  return an ambiguous or recovery-required outcome rather than inventing success.

Nominal typing catches accidental misuse; it is not a security boundary. A future host must validate registered
identities, digests, snapshots, policy, expiry, and replay state before honoring nominal values.

## Contexts

- `WorkflowCtx` is the normal read-only workflow context.
- `WorkspaceCtx` adds the active writable workspace and local Git mutation.
- `ReviewCtx` is intentionally restricted to observation, read-only agents, read-only files and Git, fan-out,
  cancellation, and diagnostics.

Candidate workspace callbacks use `WorkspaceCtx` plus `apply` and `capture`. Parallel lanes are the scoped context
itself and add only `itemKey` and `key(local)`.

## Task state

Task contracts are run-scoped and intentionally small. They declare an extension schema and optional agent access.
There is no author-managed task-contract version or migration chain. The engine may keep an internal numeric
revision for optimistic updates, while `dedupeKey` makes retried upserts converge.

## Module layout

- `src/index.ts` — the only public authoring barrel
- `src/core/workflow.ts` — workflow definitions and the canonical context
- `src/core/composition.ts` — parallel fan-out
- `src/core/agent.ts` — agents, results, goals, write scopes, and patches
- `src/core/checks.ts`, `reviews.ts`, and `artifacts.ts` — candidate-bound evidence
- `src/core/operations.ts` and `deliveries.ts` — one-shot protected external effects
- `src/core/internal-engine.ts` — internal invocation algebra and output-preservation proof
- `src/examples/workflows.ts` and `coding-nodes.ts` — compact API examples
- `src/examples/refined/` — three end-to-end coding workflows
- `src/type-tests/authoring-surface.ts` — focused compile-negative checks for removed API variants

The historical design-round fixtures were removed from the active tree after their findings were incorporated.
Git history remains the design archive.

## Declaration conventions

Detailed `Why` and `Use` documentation is required for public contracts and safety invariants. Internal helpers and
obvious data shapes may use short comments or inline object types. This keeps editor hovers focused on information
an author needs to make a decision.

## Verification

```bash
pnpm --filter @techery/weft-dsl-proto typecheck
pnpm --filter @techery/weft-dsl-proto build
pnpm --filter @techery/weft-dsl-proto pack
```

The package enables strict TypeScript checking, exact optional properties, unchecked index protection, isolated
declarations, and declaration-only emit. `prepack` cleans, builds, and type-checks the package.
