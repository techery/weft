# Weft DSL prototype

This package is a declaration-only playground for the intended Weft context DSL described in the
[Weft DSL user stories](https://github.com/techery/weft/blob/main/docs/weft-dsl-user-stories.md). It deliberately
contains no workflow engine, journal, provider, workspace, Git, task, gate, delivery, or UI implementation.
The declarations refine some older story syntax where ten rounds of coding-workflow experiments found a safer
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
    const result = await ctx.agent({
      key: "greet",
      prompt: `Write a greeting for ${input.name}`,
      schema: z.object({ greeting: z.string() }),
    });

    return result.value;
  },
);
```

The package re-exports Zod for realistic schema inference. Every Weft DSL function is declaration-only; the
emitted domain modules are empty and the barrel's only concrete export is Zod. Importing a declared Weft
function at runtime is unsupported. This package is for design exploration and compile-time feedback, not
workflow execution.

## Design boundaries

- A `WorkflowNode` is an inert, reusable definition returned by a public `define*` factory. It is common
  identity for registries and narrowing, not a claim that every definition has one context-free input/output
  pair.
- Context calls bind definitions, input, options, and execution state into internal `WorkflowInvocation`
  values. The declaration-only `InternalEngine.execute` proof preserves each concrete invocation's output.
- Inline agents are normalized to an internal agent node and use that same execution path. Primitive context
  effects such as filesystem reads, local Git mutations, tasks, and human interaction remain a separate
  host/journal layer rather than pretending to be public reusable nodes.
- Engine-minted subjects, evidence, write grants, candidates, authorizations, receipts, patches, and secret
  handles are nominal. Matching strings or object shapes cannot manufacture authority.
- Plain workflow contexts expose read-only Git. A workflow-owned workspace adds bounded local mutations.
  Remote publication is a `defineDelivery` transition that freezes one exact workspace generation and its
  evidence before authorization; caller-selected risk and raw Git publication are intentionally absent.
- Local edits, captures, and commits are provisional checkpoints. Required checks and reviews attest the
  current workspace generation, and only a delivery may promote that exact subject to an external system.
- Definition names, IDs, and policy revisions are retained as literal types where they participate in
  identity. Host-observed values such as actual trust authorities remain broad because declarations cannot
  invent runtime evidence.

## Module layout

- `src/core/shared.ts` — Standard Schema, shared primitives, providers, and prompts
- `src/core/context-sources.ts` — fresh, trusted, read-only host context and provenance
- `src/core/artifacts.ts` — typed immutable artifact contracts and capture references
- `src/core/checks.ts` — checks, suites, structured evidence, and invocation types
- `src/core/human.ts` — human interaction and schema-backed UI views
- `src/core/observers.ts` — durable polling and host-signal observation contracts
- `src/core/operations.ts` — authorized schema-backed atomic integration operations
- `src/core/deliveries.ts` — exact-subject promotion candidates, authorization, and receipts
- `src/core/reviews.ts` — exact-subject review orchestration and accepted evidence
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
- `src/core/index.ts` — the core declaration barrel
- `src/examples/workflows.ts` — compile-time workflow demonstrations based on the user stories
- `src/examples/coding-nodes.ts` — operation, observer, and artifact workflow demonstration
- `src/examples/internal-engine.ts` — compile-time proof that every node invocation preserves its output
- `src/examples/refined/` — canonical issue, security, and dependency workflows after reimplementation
- `src/examples/rounds/` — scenario and adversarial fixtures from the ten design rounds
- `src/index.ts` — the stable package barrel

## Declaration conventions

Every named type and declaration function has JSDoc with explicit `Why` and `Use` guidance. Public signatures
prefer named option, input, and result types; conditional and mapped-type machinery is named when it forms a
reusable contract. `pnpm run check:docs` enforces the documentation contract and is included in package
type-checking.

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
work, exact-subject checks and review, an attested artifact, and authorized delivery.

[`DESIGN-ROUNDS.md`](./DESIGN-ROUNDS.md) records the ten workflow rounds, DX findings, accepted API changes,
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
