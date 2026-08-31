# Weft DSL prototype

This package is a declaration-only playground for the intended Weft context DSL described in the
[Weft DSL user stories](https://github.com/techery/weft/blob/main/docs/weft-dsl-user-stories.md). It deliberately
contains no workflow engine, journal, provider, workspace, Git, task, gate, delivery, or UI implementation.
The declarations refine some older story syntax where eleven rounds of coding-workflow experiments found a safer
or more concise contract.

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

The source barrel re-exports Zod for realistic schema inference in compiler fixtures. The build emits declarations
only, and package entrypoints expose only the `types` condition—there is no runtime default, including for that
Zod convenience export. This package is for design exploration and compile-time feedback, not workflow execution.

## Design boundaries

- A `WorkflowNode` is an inert, reusable definition returned by a public `define*` factory. It is common
  identity for registries and narrowing, not a claim that every definition has one context-free input/output
  pair.
- Context calls bind definitions, input, options, and execution state into internal `WorkflowInvocation`
  values. The declaration-only `InternalEngine.execute` proof preserves each concrete invocation's output.
- Inline agents are normalized to an internal agent node and use that same execution path. Primitive context
  effects such as filesystem reads, local Git mutations, tasks, and human interaction remain a separate
  host/journal layer rather than pretending to be public reusable nodes.
- Engine-minted snapshots, evidence, write grants, candidates, authorizations, receipts, patches, and secret
  handles are nominal. Matching strings or object shapes cannot manufacture authority.
- Plain workflow contexts expose read-only Git. A workflow-owned workspace adds bounded local mutations.
  Remote publication is a `defineDelivery` transition that freezes one exact workspace generation, positive
  check/review/goal proofs, and supporting artifacts before authorization; caller-selected risk and raw Git
  publication are intentionally absent.
- Local edits, captures, and commits are provisional checkpoints. `ctx.workspace.snapshot` names the current
  workspace generation. Required checks, reviews, and artifacts bind to that candidate, and only a delivery may
  promote the exact same candidate to an external system.
- Definition names, IDs, policy revisions, accepted trust authorities, and enforced trust floors remain literal
  where they participate in identity or a postcondition. Those precise result types are contracts for a future
  host to validate and mint; a declaration alone does not create runtime evidence.

Nominal typing is an accidental-misuse boundary, not a security boundary. Private-member identity rejects plain
objects and direct spread rewriting, but casts and generic intersection helpers can still lie to TypeScript. A
future host must revalidate registered identity, digests, workspace snapshot, policy, and expiry whenever a nominal
value enters an authoritative operation.

## Preferred authoring surface

Ordinary workflow code uses one agent function with orthogonal options:

- `ctx.agent(definition, input, { key })` for a reusable typed agent,
  `ctx.agent(definition, input, { key, write })` for an authorized edit, and
  `ctx.agent(definition, input, { key, failure: "return" })` for an explicit success/failure union;
- inputless definitions omit the input argument, and one-off agents use
  `ctx.agent({ prompt, schema }, { key })` without creating a reusable definition;
- `ctx.operation.run(...)` and `ctx.delivery.run(...)` for the common protected lifecycles, each with one stable
  parent key whose internal lifecycle keys are engine-derived. Bind guaranteed cleanup once with `withRecovery(...)`, then use
  `ctx.operation.runRecoverable(...)` for an exhaustive commit classification without spelling attempt generics;
- `ctx.parallel.all(...)` for fail-fast fan-out and `ctx.parallel.settled(...)` for inspected lane failures. Both
  accept an item callback and stable `keyOf`; already-started promises are not accepted;
- `ctx.pipeline(items).map(...)` for synchronous pure transforms and `.mapEffect("name", ...)` for durable effects,
  followed by `.all(...)` or `.settled(...)`;
- one stable author key on every independently replayable primitive effect, including checks, filesystem/Git,
  process/network, signals, clock/randomness, environment, notes, and patch integration. `ctx.step` and lane scopes
  namespace keys but do not infer identity from source locations;
- `ctx.policy.decide(...)` and `ctx.human.confirm(...)` only for branching;
  `ctx.check.authorizeWaiver(...)` mints only an exact failed-check exception. Protected operations and deliveries
  still mint candidate-specific authorization internally.

Use `WorkflowCtx`, `WorkspaceCtx`, and `ReviewCtx` in helper signatures so authority is visible without spelling
positional context generics. Workflow definitions carry a hidden type bag; prefer `typeof workflow`,
`InputOf`, `OutputOf`, `WorkflowInputOf`, `WorkflowOutputOf`, or the compact `WorkflowContract` instead of annotating
its implementation callback.

The root package is the curated ordinary-authoring entrypoint; its workflow contexts expose direct, one-shot
protected, and declaratively bound recoverable effects. Import `defineWorkflow` plus low-level proofs,
attestations, waivers, candidates, authorizations, attempts, recovery state, and the comprehensive context from
`@techery/weft-dsl-proto/advanced` when implementing an explicit lifecycle.

Task contracts are intentionally short-lived: they declare only an extension schema and optional agent access.
There is no author-facing task version, contract revision, or migration surface. Each task row still carries an
engine-owned numeric revision for optimistic updates, and `dedupeKey` still makes retried upserts converge. If an
older run cannot resume against the exact workflow build that created it, the host should fail closed or restart
it.

### Compile-time testing contract

The `/testing` subpath sketches the intended host-mediated harness:

```ts
import { testWorkflow } from "@techery/weft-dsl-proto/testing";

const harness = testWorkflow(workflow).withContext({ context: fakeWorkflowContext });
const result = await harness.run(input);
```

This package supplies only the types for that chain. It does not contain an executable harness or fake host;
a future engine-backed testing package must implement validation, journaling, and capability behavior.

## Module layout

- `src/core/shared.ts` — Standard Schema, shared primitives, providers, and prompts
- `src/core/context-sources.ts` — fresh, trusted, read-only host context and provenance
- `src/core/artifacts.ts` — typed immutable artifact contracts and capture references
- `src/core/checks.ts` — checks, suites, structured evidence, and invocation types
- `src/core/human.ts` — human interaction and schema-backed UI views
- `src/core/observers.ts` — durable polling and host-signal observation contracts
- `src/core/operations.ts` — authorized schema-backed atomic integration operations
- `src/core/deliveries.ts` — exact-candidate promotion, authorization, and receipts
- `src/core/reviews.ts` — exact-candidate review orchestration and accepted evidence
- `src/core/path-policies.ts` — canonical path resolution and nominal write grants
- `src/core/triggers.ts` — authenticated, deduplicated external workflow admission
- `src/core/goals.ts` — goal components, attempts, and accepted verdicts
- `src/core/agent.ts` — agent calls/results, write scopes, patches, and recipes
- `src/core/composition.ts` — parallel, sequence, pipeline, and settlement types
- `src/core/effects.ts` — filesystem, processes, HTTP, secrets, polling, and Git
- `src/core/workspace.ts` — candidate workspaces, integration, gates, and notes
- `src/core/tasks.ts` — durable task contracts and mutations
- `src/core/workflow.ts` — workflow definitions and the composed context API
- `src/core/internal-engine.ts` — internal bound invocation algebra and generic executor contract
- `src/core/index.ts` — the comprehensive internal declaration barrel
- `src/examples/workflows.ts` — compile-time workflow demonstrations based on the user stories
- `src/examples/coding-nodes.ts` — operation, observer, and artifact workflow demonstration
- `src/examples/internal-engine.ts` — compile-time proof that every node invocation preserves its output
- `src/examples/refined/` — canonical issue, security, and dependency workflows after reimplementation
- `src/examples/rounds/` — scenario and adversarial fixtures from the eleven design rounds
- `src/advanced.ts` — opt-in nominal operation and delivery lifecycle contracts
- `src/testing.ts` — explicit workflow harness contracts for engine-backed test hosts
- `src/index.ts` — the curated stable authoring barrel

## Declaration conventions

Every named type and declaration function has JSDoc. Detailed `Why` and `Use` guidance is reserved for trust,
authority, replay, and proof invariants; routine data shapes use concise descriptions to keep editor hovers useful.
Public signatures prefer named option, input, and result types. `pnpm run check:docs` enforces documentation and
named-object contracts and is included in package type-checking.

Every value returned by a `define*` function extends the nominal `WorkflowNode` contract. Its `kind` remains a
specific `WorkflowNodeKind`, so mixed definition registries can accept one global type and still narrow each
node. Exact definition values retain the additional schemas, identity, policy, and result relationships needed
by their own context APIs.

Definitions remain inert. Internally, definition-backed context methods bind them to nominal
`WorkflowInvocation` values that carry a concrete key, input, execution context, and output type.
`InternalEngine.execute` accepts the closed node-backed invocation union and preserves each exact output; the
internal engine module is intentionally not exported from the public package barrel.

## Examples and design record

Start with [`src/examples/refined/issue-to-reviewed-pr.ts`](./src/examples/refined/issue-to-reviewed-pr.ts),
[`src/examples/refined/security-remediation.ts`](./src/examples/refined/security-remediation.ts), and
[`src/examples/refined/dependency-migration.ts`](./src/examples/refined/dependency-migration.ts). They show the
accepted end-to-end shape: authoritative context, a host-bound workspace, nominal path authority, bounded agent
work, exact-candidate checks and review, an attested artifact, positive promotion proofs, and authorized delivery.

[`DESIGN-ROUNDS.md`](./DESIGN-ROUNDS.md) records the eleven workflow rounds, DX findings, accepted API changes,
and rejected abstractions. The round examples are compile-time experiments rather than a second supported API.

## Verification

```bash
pnpm --filter @techery/weft-dsl-proto typecheck
pnpm --filter @techery/weft-dsl-proto build
pnpm --filter @techery/weft-dsl-proto pack
```

The package TypeScript configuration enables the full strict family plus exact optional properties, unchecked
index protection, unused and control-flow checks, isolated declarations, declaration emit, and no library-check
skipping. `prepack` performs a clean build and type-check so the published `dist` contract cannot silently lag
behind `src`.
