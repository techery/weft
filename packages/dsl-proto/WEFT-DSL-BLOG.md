# Weft DSL prototype: one language instead of two

The latest Weft DSL prototype is smaller. We removed abstractions that duplicated TypeScript and hid internal
engine machinery that workflow authors should not have to operate.

This is a source-level prototype update, not a published runtime release. The package is still declaration-only.
What changed is the proposed authoring contract.

## The short version

The new model has four basic ideas:

1. Use normal TypeScript for order, branching, loops, and reusable functions.
2. Use `ctx.step` when several effects need one durable key namespace.
3. Use `ctx.parallel.all` or `ctx.parallel.settled` for durable fan-out.
4. Use one function per capability: `ctx.agent`, `ctx.operation`, and `ctx.delivery`.

The engine still owns replay, authorization, candidate freshness, evidence, and recovery. Authors simply see less
of that machinery.

## Agents were the model to follow

The previous revision unified several agent methods into one function:

```ts
const plan = await ctx.agent(planner, issue, { key: "plan" });

const implementation = await ctx.agent(developer, plan.value, {
  key: "implement",
  write: writeScope,
});

const review = await ctx.agent(reviewer, implementation.value, {
  key: "review",
  failure: "return",
});
```

The definition says what the agent is. Options say what is different about this invocation. There is no separate
`run`, `write`, or `try` vocabulary to remember.

Operations and deliveries now follow the same rule.

## One operation function

Previously, authors had to choose among calls such as:

```ts
ctx.operation(...)
ctx.operation.run(...)
ctx.operation.runRecoverable(...)
```

The new API is one function:

```ts
const pullRequest = await ctx.operation(openPullRequest, input, {
  key: "open-pull-request",
  authorization: {
    detail: "Open a pull request for the reviewed change",
  },
});
```

If the operation definition requires authorization, the engine performs the protected lifecycle. If it is direct,
the engine runs it directly. If it was created with `withRecovery`, the engine registers cleanup before dispatch
and returns the recoverable result.

Authors no longer choose the lifecycle twice—once in the definition and again in the method name.

## One delivery function

Delivery is now callable too:

```ts
const receipt = await ctx.delivery(pullRequestDelivery, {
  key: "deliver",
  candidate: ctx.workspace.snapshot,
  input: { title, branch },
  proofs: [quality.proof, review.proof],
  authorization: {
    detail: "Publish the exact checked and reviewed candidate",
  },
});
```

The host still freezes the request, checks that every proof belongs to the same candidate, rejects stale workspace
state, requests authorization, and performs the external effect atomically. Those are engine responsibilities,
not authoring steps.

## Normal TypeScript replaces mini-languages

The prototype used to include recipes, sequences, and pipelines. Each introduced another way to express something
TypeScript already expresses clearly.

Same-run reuse is now a plain function:

```ts
async function inspect(item: Package): Promise<Inspection> {
  return analyzePackage(item);
}
```

Sequential processing is a loop:

```ts
for (const item of items) {
  await ctx.step(item.id, async (step) => {
    await step.agent(reviewer, item, { key: "review" });
  });
}
```

Parallel processing remains explicit because the engine needs stable lane identity:

```ts
const inspections = await ctx.parallel.all(
  items,
  (item) => inspect(item),
  {
    key: "inspect-packages",
    keyOf: (item) => item.name,
    concurrency: 4,
  },
);
```

Use `settled` instead of `all` when failures are expected domain data that the workflow will inspect.

## Step and phase are no longer competing ideas

The prototype keeps one grouping primitive:

```ts
const result = await ctx.step("verify", async (step) => {
  const tests = await step.check(testSuite, { key: "tests" });
  const review = await step.review(codeReview, input, { key: "review" });
  return { tests, review };
});
```

A step owns a callback and namespaces the durable effects inside it. Presentation-only phase labels belong to the
runnable SDK and UI, not to this prototype's authoring grammar. There is no additional stage layer.

## One public context

The package previously had a smaller root context and a second `/advanced` context with explicit operation and
delivery lifecycle methods. The two contexts had already started to disagree about parallel lanes, sequence
callbacks, and workspace diagnostics.

That split is gone. `defineWorkflow` now uses one canonical context from `core/workflow.ts`:

- `WorkflowCtx` for normal read-only orchestration;
- `WorkspaceCtx` when the workflow owns a writable workspace;
- `ReviewCtx` for deliberately restricted review evaluators.

There is no alternate workflow builder under `/advanced`.

## What disappeared

The following author-facing concepts were removed:

- `defineRecipe` and `ctx.recipe`
- `ctx.sequence`
- `ctx.pipeline`
- `ctx.successes` and `ctx.all`
- the context-returning `ctx.step(key)` overload
- `ctx.workspace.lease`
- `ctx.gate`
- `ctx.human.approve`
- `ctx.check.authorize`
- `lane.ctx`
- explicit operation and delivery lifecycle methods
- the declaration-only `/testing` placeholder

The deprecated aliases offered no useful migration value because this package is still a prototype.

## What did not get weaker

The smaller API does not mean a weaker execution model.

We kept:

- nominal engine-minted candidates, evidence, proofs, authorizations, receipts, and write scopes;
- candidate-bound checks, reviews, artifacts, and delivery;
- positive proof requirements for promotion;
- explicit commit ambiguity for external effects;
- recovery registration before a recoverable operation is dispatched;
- read-only versus writable context boundaries;
- restricted reusable review contexts;
- stable keys for every replayable effect;
- exact workflow, goal, and task input relationships.

The simplification is about who sees the machinery. The engine still needs a precise state machine. A workflow
author should not have to program that state machine manually.

## A smaller package to learn and verify

The package root now exports one authoring surface instead of root, `/advanced`, and `/testing` variants. Internal
marker and lifecycle types are no longer re-exported as ordinary author tools.

Historical design-round fixtures were also removed after their conclusions were incorporated. Six focused
examples remain: two compact API demonstrations, three end-to-end coding workflows, and one internal invocation
proof. Git history preserves the experiments without compiling them on every change.

Finally, declaration documentation checks now focus on types that the public barrel actually exposes. Internal
helpers can use short comments and inline object shapes when that is clearer.

## The design rule going forward

Before adding a DSL method, ask two questions:

1. Does the engine need a distinct durable or security boundary here?
2. Is ordinary TypeScript unable to express the author intent clearly?

If both answers are not yes, prefer TypeScript.

That leaves Weft with a smaller language and a stronger division of responsibility: authors describe the work;
the engine enforces replay, authority, evidence, and recovery.
