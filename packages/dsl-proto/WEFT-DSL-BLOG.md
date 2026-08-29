# Weft: Turning Coding Agents into Durable, Type-Safe Workflows

Coding agents are good at individual tasks: inspect a repository, propose a change, run a test, or explain a
failure. Real engineering work is larger than any one of those steps. It has ordering, retries, review,
authorization, external systems, and long pauses. It also needs to survive the process that started it.

Weft makes that larger unit—the coding workflow—an ordinary TypeScript program.

Instead of drawing a graph in one tool and writing its implementation somewhere else, a Weft workflow uses
language constructs developers already know:

- `await` creates a sequential dependency;
- `if` selects a branch from validated data;
- bounded loops express rework;
- `ctx.parallel` and `ctx.pipeline` create controlled fan-out;
- schemas define the values crossing every important step;
- journaled context operations make work replayable and resumable.

The result is a workflow that can coordinate agents, humans, checks, Git workspaces, and external systems while
remaining reviewable as code.

This article has two goals. First, it explains what you can run in Weft today. Second, it introduces
`@techery/weft-dsl-proto`, a declaration-only design lab that pressure-tests a stricter future DSL. Keeping
those surfaces separate matters: the prototype contains types and examples, but intentionally contains no
engine or integration implementation.

## Choose the right surface

| Surface | Purpose | Can it execute? | Best starting point |
| --- | --- | --- | --- |
| `@techery/weft-sdk` | Current workflow authoring API used by the engine, CLI, tests, and Workflow Manager | Yes, from a Weft checkout | [Repository Quickstart](../../README.md#quickstart) |
| `@techery/weft-dsl-proto` | Proposed, maximum-safety context DSL for compile-time experimentation | No; its Weft functions are declarations only | [Prototype contract](./PROTOTYPE.md) |

Both are design-preview software. The difference is more specific than “stable versus experimental”:

- the SDK is wired to the current runtime and is the surface to use for runnable workflows;
- the prototype is a type-system model of where the authoring API could go next;
- prototype examples must never be copied into the SDK and assumed to run unchanged.

Every example below is labeled **Runnable SDK**, **DSL prototype**, or **Conceptual model** for that reason.

## When Weft is a good fit

Weft earns its weight when a workflow has several of these properties:

- multiple model or tool calls depend on one another;
- independent agents should work in parallel but under bounded concurrency;
- a human may answer hours later;
- repository changes need isolation, review, and explicit integration;
- the workflow must survive a crash or restart;
- checks and approvals must remain attributable to the exact candidate they evaluated;
- an external effect such as publishing, deployment, or pull-request creation needs authorization and recovery;
- the final result needs an audit trail rather than only a chat transcript.

It is usually not the right abstraction for a pure function, a one-shot disposable prompt, or a tiny script
where restart and provenance do not matter. Weft is orchestration infrastructure; it is most useful when the
work itself has a lifecycle.

## What is Weft?

Weft is a TypeScript framework for durable, journaled, schema-validated multi-agent coding workflows.

Consider an issue-to-pull-request workflow. It may need to:

1. authenticate the event that requested work;
2. read the current issue and repository policy from authoritative sources;
3. ask an agent for a plan;
4. grant another agent access to only approved paths;
5. run type checking, tests, and linting;
6. ask an independent reviewer to inspect the exact checked tree;
7. perform bounded rework when the review finds a blocker;
8. wait for a person or external CI;
9. publish the reviewed commit and open a pull request.

A process can disappear between any two of those steps. A test result can become stale after one more edit. A
webhook can be authentic but old. A network timeout after “create pull request” can mean either “nothing
happened” or “the request succeeded but the response was lost.”

Weft treats those as workflow concerns rather than hiding them inside one large agent prompt.

Three ideas define the model.

### The graph is the program

Weft does not introduce a second graph language. The workflow's control flow is its TypeScript control flow.
That keeps branching, loops, helper functions, and domain logic in one place, with the TypeScript compiler
checking how data moves between them.

### Values cross schemas

Workflow input, workflow output, agent results, human answers, and integration results have declared schemas.
The guarantee is not that every string is true. A `z.string()` can still contain a bad claim. The guarantee is
that each boundary receives and returns the shape the workflow expects, and validation failures are handled
where they occur.

This separation is useful in practice:

- schemas establish structure;
- deterministic checks establish mechanical facts;
- independent review evaluates semantics;
- provenance records where evidence came from;
- human or host authorization decides whether a consequential effect may proceed.

### Effects belong to the journal

Agent turns, commands, human interactions, context reads, and integration calls are durable steps rather than
ambient side effects. Semantic content—including the definition, schema, prompt, and effective input—identifies
work during replay; a stable invocation key disambiguates calls that would otherwise look alike. The engine can
reuse completed results, rerun invalidated work, and produce both a mechanical journal and a semantic report.

Journaling does not magically make every remote effect exactly once. For an external mutation, the runtime
also needs a provider idempotency key, intent recorded before dispatch, postcondition probes, and an explicit
ambiguous state when it cannot prove what happened.

## Run a workflow today

### Five-minute path from a checkout

**Runnable SDK**

```bash
pnpm install
pnpm typecheck

node packages/cli/bin/weft.js workflow list
node packages/cli/bin/weft.js workflow inspect review --json
node packages/cli/bin/weft.js check review
node packages/cli/bin/weft.js run review --base main --watch
```

The `review` workflow is already included in the repository. A run creates an append-only journal plus derived
`state.json`, `tree.json`, and `report.md` projections under `.weft/runs/<run-id>/`; large immutable blobs live
in the shared `.weft/blobs/` store. If a human step suspends a workflow, the CLI, Workflow Manager, or calling
session can answer it later.

### The smallest useful workflow

**Runnable SDK**

```ts
import { defineWorkflow, z } from "@techery/weft-sdk";

export default defineWorkflow(
  {
    id: "summarize-change",
    description: "Summarize a change for a reviewer",
    input: z.object({ diff: z.string() }),
    output: z.object({ summary: z.string() }),
  },
  async (ctx, { diff }) => {
    const result = await ctx.agent(
      `Summarize this change for a reviewer:\n\n${diff}`,
      {
        key: "summarize",
        schema: z.object({ summary: z.string() }),
      },
    );

    return result;
  },
);
```

The workflow looks like an ordinary async function, but the engine owns the durable execution of `ctx.agent`.
The schema connects the agent result to the workflow output without parsing an informal response.

### A realistic bounded review

The current SDK already supports ordinary TypeScript plus durable fan-out:

**Runnable SDK**

```ts
import { defineWorkflow, z } from "@techery/weft-sdk";

const Finding = z.object({
  file: z.string(),
  line: z.number().int().positive(),
  claim: z.string(),
});

export default defineWorkflow(
  {
    id: "parallel-review",
    description: "Review changed files with bounded parallel agents",
    input: z.object({ base: z.string().default("main") }),
    output: z.object({ findings: z.array(Finding) }),
  },
  async (ctx, { base }) => {
    const changed = await ctx.git.changedSince(base);
    const paths = changed.files
      .filter((file) => file.status !== "D")
      .map((file) => file.path);

    const settled = await ctx.parallel(
      paths,
      (path) =>
        ctx.agent(`Review ${path}. Cite exact correctness defects.`, {
          key: `review:${path}`,
          schema: z.object({ findings: z.array(Finding) }),
        }),
      { concurrency: 4, errors: "settle" },
    );

    return {
      findings: ctx.all(settled).flatMap((result) => result.findings),
    };
  },
);
```

The array order stays deterministic even though lanes run concurrently. `ctx.parallel` waits for its lanes and
returns settled results in input order; `ctx.all` then synchronously unwraps them or throws a recorded lane
failure. `ctx.successes` is the tolerant alternative when partial results are part of the workflow's explicit
policy.

### What replay does

Resume re-executes workflow code from the top, but it does not blindly repeat every effect.

| Situation | Replay behavior |
| --- | --- |
| Same completed step identity and effective input | Reuse the journaled, validated result |
| Step was started but has no reusable completion | Execute according to that effect's recovery contract |
| Prompt, schema, input, or relevant definition changed | Treat it as changed work and execute again |
| Code moved but content-addressed identity still matches | Salvage the prior result when the runtime can prove the match |
| Result fails schema validation | Do not let malformed data cross the boundary |
| Human step is still unanswered | Restore the durable wait |

The current engine already provides edit-tolerant replay, durable human waits, cancellation fencing, and
verification for many built-in effects. It does **not** yet provide one complete effectively-once recovery
contract for every arbitrary external mutation. A crash around a raw remote command can still require
reconciliation. The prototype's recoverable-operation types model the stronger contract a future runtime must
actually implement.

A workflow `key` identifies a step in the run and makes replay, tests, and the UI understandable. An external
idempotency key identifies one provider-side mutation. They solve different problems and a consequential
operation often needs both.

Good keys are:

- stable across harmless refactors;
- unique among semantically distinct calls;
- derived from durable domain identity for repeated items;
- namespaced inside loops and child helpers.

For example, `review:packages/core/src/engine.ts` is better than `step-17`, and
`migrate:package-a:attempt-2:checks` is better than reusing `checks` on every loop iteration.

### Workspace ownership: current runtime and proposed DSL

Today, a write-enabled SDK agent receives its own detached Git worktree. Its result carries a captured patch;
the integration tree remains unchanged until the workflow explicitly integrates that patch.

**Runnable SDK**

```ts
const fixes = ctx.successes(
  await ctx.parallel([
    ctx.agent.detailed("Fix the retry loop in auth.ts.", {
      key: "fix:auth",
      schema: z.object({ summary: z.string() }),
      write: { paths: ["auth.ts"], mode: "strict" },
    }),
    ctx.agent.detailed("Fix pagination in api.ts.", {
      key: "fix:api",
      schema: z.object({ summary: z.string() }),
      write: { paths: ["api.ts"], mode: "strict" },
    }),
  ]),
);

const ledger = await ctx.integrate(fixes, {
  order: "sequential",
  onConflict: "fail",
});
```

That model is excellent for independent, reviewable edits. The prototype explores an additional shape for
sequential delivery workflows:

| Current SDK | Proposed DSL prototype |
| --- | --- |
| One isolated worktree per writing agent step | One workflow-owned candidate branch may span several steps |
| Write scope is declared directly on the call | `definePathPolicy` is resolved into a nominal grant |
| Agent result carries a patch | Local workspace operations advance a generation subject |
| `ctx.integrate` explicitly applies selected patches | Checks, review, and artifacts attest the current generation |
| Remote publication uses today's available effects and workflow policy | `defineDelivery` freezes evidence and authorizes exact-subject promotion |

The workflow-owned branch model is a design direction, not a claim about the currently shipped default.
A real runtime still has to persist or reconstruct that workspace, invalidate evidence on every mutation,
and enforce delivery against the exact generation.

## The stricter DSL prototype

`@techery/weft-dsl-proto` asks a different question: how much coding-workflow correctness can the TypeScript
API express before the runtime is implemented?

It is deliberately declaration-only:

- every `define*` function exists only in emitted type declarations;
- there is no workflow engine, journal, provider, workspace, Git, trigger, observer, or delivery adapter;
- importing and calling the Weft declarations at runtime is unsupported;
- examples are compiler fixtures and design experiments.

The only concrete runtime export is Zod, re-exported so schemas and type inference are realistic.

### A taxonomy of definitions

The prototype organizes reusable definitions by the engine boundary they describe.

| Area | Definitions | What they name |
| --- | --- | --- |
| Authoring | prompt, agent, recipe, goal, workflow | model roles, reusable orchestration, completion goals, workflow I/O |
| Context and authority | context source, path policy | trusted reads and engine-minted write scope |
| Verification | check, check suite, review, artifact | deterministic results, semantic assessment, immutable evidence |
| External lifecycle | operation, delivery, observer, trigger | atomic effects, exact-subject promotion, durable waits, authenticated admission |
| Interaction and state | task contract, UI view, result view | durable work records and schema-backed human presentation |

There are 18 public `define*` factories across 17 `WorkflowNodeKind` values. The count difference comes from
closely related factories sharing a node family. The more important property is that every returned definition
is a `WorkflowNode` while retaining its exact name, schemas, policy, and other definition-specific types.

## Case study: issue to reviewed pull request

The next snippets are abridged from the complete
[issue-to-reviewed-PR workflow](./src/examples/refined/issue-to-reviewed-pr.ts). They show the accepted shape,
but omit supporting schemas and small validation helpers. They **typecheck only** as part of the prototype;
they do not execute.

### 1. Declare reusable policy at module scope

**DSL prototype — abridged**

```ts
const issueSource = defineContextSource({
  name: "authoritative-issue",
  input: z.object({
    repository: z.string(),
    issueNumber: z.number().int().positive(),
  }),
  output: IssueSchema,
  binding: "github.issue.read",
  freshness: { maxAge: "30s", stale: "reject" },
  trust: {
    minimum: "authoritative",
    authorities: ["github-app"],
  },
});

const writePolicy = definePathPolicy({
  name: "issue-write-policy",
  revision: "v1",
  roots: ["src", "test"],
  deny: [".git/**", "**/.env*", "**/node_modules/**"],
  grantTtl: "2h",
});

const quality = defineCheckSuite({
  name: "required-quality",
  checks: [typecheck, tests, lint],
  concurrency: 3,
});

const pullRequestDelivery = defineDelivery({
  name: "publish-reviewed-pull-request",
  binding: "github.pull-request.publish",
  input: PullRequestInput,
  output: PullRequestReceipt,
  capabilities: ["workspace:read", "git:write", "network"],
  defaults: {
    attempts: 2,
    authorization: {
      action: "Publish a reviewed workspace generation",
      risk: "high",
    },
  },
});
```

These declarations are inert. They do not read GitHub, grant paths, run checks, or create a pull request.
They establish contracts that a host must later bind and enforce.

Notice where policy lives:

- freshness and minimum trust belong to the context definition;
- allowed and denied paths belong to a revisioned path policy;
- check membership and concurrency belong to the suite;
- delivery risk belongs to the delivery definition, not to an invocation that could understate it.

### 2. Resolve facts and authority

**DSL prototype — abridged**

```ts
const issue = await ctx.context(
  issueSource,
  {
    repository: input.repository,
    issueNumber: input.issueNumber,
  },
  { key: "issue" },
);

const planResult = await ctx.agent({
  key: "plan",
  agent: planner,
  input: issue.value,
  context: [issue],
});
const plan = planResult.value;

const writeScope = await ctx.paths.resolve(
  writePolicy,
  { proposedPaths: plan.proposedPaths },
  { key: "write-scope" },
);

await ctx.agent({
  key: "implement",
  agent: implementer,
  input: { issue: issue.value, plan },
  context: [issue],
  write: writeScope,
});
```

The issue body can influence planning, but it cannot mint write authority. The path list returned by the
planner is only a proposal. `ctx.paths.resolve` asks the host to canonicalize it against a revisioned policy
and returns a nominal `WriteScope` only after approval. Likewise, the context definition's trust setting is a
required floor, not proof: consequential code must still inspect the trust level and authority the host
actually established on the returned snapshot.

### 3. Verify one exact candidate

**DSL prototype — abridged**

```ts
const subject = ctx.workspace.subject;

const checks = await ctx.check(quality, {
  keyPrefix: "quality",
  policy: "required",
  subject,
});

if (!checks.passed) {
  return { status: "blocked", reason: "quality-exhausted" };
}

const review = await ctx.review(candidateReview, reviewInput, {
  key: "review",
  subject,
});

if (review.status !== "accepted") {
  return { status: "blocked", reason: "review-exhausted" };
}
```

The `subject` is an engine-minted reference to one workspace generation, including its identity and tree hash.
Checks and review preserve that subject in their attestations. If another agent or local Git operation mutates
the workspace, the runtime must treat the new generation as different and reject stale evidence. TypeScript can
also reject cross-generation mixing when callers preserve distinct refined subject types, but ordinary
`WorkspaceSnapshotRef` values still require runtime identity comparison.

### 4. Capture the dossier and deliver

**DSL prototype — abridged**

```ts
const dossier = await ctx.artifact(
  deliveryDossier,
  {
    content: {
      issue: issue.value,
      changedFiles,
      checkRef: checks.attestation.ref,
      reviewRef: review.attestation.ref,
    },
  },
  {
    key: "delivery-dossier",
    subject,
    sources: [issue.evidence, checks.attestation, review.attestation],
  },
);

const candidate = await ctx.delivery.prepare(
  pullRequestDelivery,
  {
    subject,
    input: pullRequestInput,
    evidence: [
      checks.attestation,
      review.attestation,
      dossier.attestation,
    ],
    artifacts: [dossier],
  },
  { key: "prepare-delivery" },
);

const authorization = await ctx.delivery.authorize(
  pullRequestDelivery,
  candidate,
  {
    key: "authorize-delivery",
    detail: `Publish checked tree ${subject.treeHash}.`,
  },
);

const receipt = await ctx.delivery(
  pullRequestDelivery,
  { candidate, authorization },
  { key: "deliver", attempts: 2 },
);
```

Preparation freezes the exact subject, provider input, evidence, and artifacts. Authorization applies to that
candidate, not to a broad future permission. Execution returns a receipt correlated with the same candidate.

This is intentionally more explicit than `git push` followed by an API call. Verification, review,
authorization, and publication are different trust transitions. Making them visible is what lets a runtime
journal, resume, audit, and enforce them independently.

## The trust ladder

The case study follows a useful progression:

| Value | Meaning | What it does **not** grant |
| --- | --- | --- |
| Trigger payload or workflow input | Validated request or hint | Current system-of-record truth |
| `ContextSnapshot` | Fresh host-observed value with provenance | Permission to mutate |
| `WriteScope` | Engine-minted path authority under one policy revision | Proof that an edit is correct |
| `WorkspaceSnapshotRef` | Identity of one exact workspace generation | Verification or publication authority |
| Check/review/artifact attestation | Evidence tied to that subject | Approval for a consequential effect |
| Promotion candidate | Frozen subject, input, evidence, and artifacts | Authorization to execute |
| Authorization reference | Candidate-specific host authority | Proof that execution succeeded |
| Delivery receipt | Schema-validated execution and subject attestation | Permission to reuse it for another candidate |

This ladder prevents a common collapse in agent systems where “the model said it,” “the test passed,” “a
person clicked approve,” and “the provider performed it” are all represented as similar-looking JSON.

## Definitions are not executions

Every public `define*` function returns a nominal `WorkflowNode`. That gives registries, inspectors, and graph
tools one common type while preserving the exact identity of each definition.

The engine should not execute a bare node. It should execute a node after a context method binds the
invocation-specific information:

**Conceptual model**

```text
defineSomething(...)
        ↓
WorkflowNode definition
        ↓  ctx method binds mode, input, key, options, and execution context
WorkflowInvocation<Input, Output>
        ↓
InternalEngine.execute(invocation)
        ↓
Promise<Output>
```

Why not simply call `internalEngine.execute(anyNode)`?

A node alone does not always describe one input/output transformation. A delivery definition participates in
three different transformations:

```text
prepare:   subject + delivery input + evidence → promotion candidate
authorize: promotion candidate              → authorization reference
execute:   candidate + authorization         → delivery receipt
```

An observer has output-only and detailed-provenance invocation modes. A child workflow can return just its
validated value or a detailed receipt. A UI definition can request input or render output. The input/output
relationship therefore belongs to the **bound invocation**, not to the inert definition in isolation.

**Conceptual model**

```ts
// Too little information: no mode, input, durable key, or execution context.
internalEngine.execute(pullRequestDelivery); // rejected

// The public DSL binds three concrete invocations with three concrete outputs.
const candidate = await ctx.delivery.prepare(
  pullRequestDelivery,
  preparation,
  { key: "prepare" },
);

const authority = await ctx.delivery.authorize(
  pullRequestDelivery,
  candidate,
  { key: "authorize" },
);

const receipt = await ctx.delivery(
  pullRequestDelivery,
  { candidate, authorization: authority },
  { key: "execute" },
);
```

Internally, the prototype has a closed union of 27 invocation kinds. An implementation can exhaustively switch
over that union while a generic `execute()` preserves the exact output of the concrete invocation it receives.
Primitive filesystem, task, human, and local Git effects remain a separate host/journal layer; they are not
forced into public reusable nodes merely to make the dispatcher look uniform.

## Ordinary TypeScript owns orchestration

The prototype deliberately avoids nodes for branching, modules, programs, reviewer hierarchies, and automatic
rework. TypeScript already expresses those things more clearly.

### Bounded rework

**DSL prototype — abridged**

```ts
interface ReworkFeedback {
  source: "quality" | "review";
  summary: string;
}

const feedback: ReworkFeedback[] = [];

for (let attempt = 1; attempt <= 3; attempt += 1) {
  ctx.cancellation.throwIfRequested();

  const write = await ctx.paths.resolve(
    writePolicy,
    { proposedPaths: plan.proposedPaths },
    { key: `attempt:${attempt}:paths` },
  );

  await ctx.agent({
    key: `attempt:${attempt}:implement`,
    agent: implementer,
    input: { issue: issue.value, plan, attempt, feedback },
    context: [issue],
    write,
  });

  const subject = ctx.workspace.subject;
  const quality = await ctx.check(qualitySuite, {
    keyPrefix: `attempt:${attempt}:quality`,
    subject,
  });

  if (!quality.passed) {
    feedback.push({
      source: "quality",
      summary: "Required checks failed",
    });
    continue;
  }

  const review = await ctx.review(candidateReview, reviewInput, {
    key: `attempt:${attempt}:review`,
    subject,
  });

  if (review.status === "accepted") {
    return { status: "ready", subject, quality, review };
  }

  feedback.push(
    ...review.blocking.map((finding) => ({
      source: "review" as const,
      summary: finding.message,
    })),
  );
}

return { status: "blocked", reason: "rework-exhausted" };
```

Every mutation is followed by a fresh subject lookup and fresh evidence. The loop has a visible bound. Expected
exhaustion becomes a typed domain result instead of being confused with a host crash or invalid adapter output.

### Parallel discovery

Use parallel work for independent reads and retain the provenance of each result:

**DSL prototype — abridged**

```ts
const settled = await ctx.parallel(
  [
    () =>
      ctx.context(repositorySource, repositoryInput, {
        key: "context:repository",
      }),
    () =>
      ctx.context(releaseSource, releaseInput, {
        key: "context:release",
      }),
  ],
  { key: "context", concurrency: 2, errors: "throw" },
);

const snapshots = ctx.all(settled);
```

The [refined dependency migration](./src/examples/refined/dependency-migration.ts) shows the full pattern:
authoritative parallel discovery, deterministic plan construction, one rework pass, exact-subject checks and
review, an attested dossier, and authorized pull-request delivery.

## Focused lifecycle patterns

### Trigger admission is not authoritative context

A trigger answers “may this event start work?” It does not permanently establish every fact contained in that
event.

**DSL prototype — abridged**

```ts
const githubIssueTrigger = defineTrigger({
  name: "github-issue-coding",
  revision: "github-v1",
  source: { binding: "github.webhook.authenticated" },
  event: GithubIssueEvent,
  workflow: processIssueEvent,
  filter: (event) => event.action === "labeled",
  eventId: (event) => event.deliveryId,
  dedupeKey: (event) => `${event.repository}:${event.deliveryId}`,
  map: (event) => ({
    repository: event.repository,
    issueNumber: event.issue.number,
  }),
});
```

The engine authenticates and validates the event, computes identity, maps and validates workflow input, and
atomically claims admission before launch. Inside the workflow, consequential decisions still re-resolve the
current issue and repository policy:

**DSL prototype — abridged**

```ts
const currentIssue = await ctx.context(
  authoritativeIssueSource,
  {
    repository: input.repository,
    issueNumber: input.issueNumber,
  },
  { key: "current-issue" },
);
```

The full [PR event trigger example](./src/examples/rounds/round-05-pr-event-trigger.ts) demonstrates authenticated
admission, revision-scoped deduplication, filtering, current-policy resolution, and exact child-workflow
dispatch.

### Observers make long waits durable

An observer represents external state that reaches a schema-validated terminal value. It may poll, wait for a
trusted signal, or use a signal-first strategy with a polling fallback.

**DSL prototype — abridged**

```ts
const observed = await ctx.observe.detailed(
  waitForDeploymentCompletion,
  deploymentReceipt,
  {
    key: "wait-for-deployment",
    timeout: "2h",
    grace: "5m",
    fallbackEvery: "30s",
  },
);

if (observed.output.outcome !== "succeeded") {
  return {
    status: "blocked",
    evidenceRef: observed.evidence.ref,
  };
}
```

The detailed form retains which endpoint won, what host binding and trust were established, which external
identity completed, and the nominal evidence reference. The engine owns the signal-versus-poll race and
cancels the losing endpoint. Cancelling this wait does not itself cancel the remote deployment; that requires
a separately registered provider cancellation operation. See the complete
[deployment observation example](./src/examples/rounds/round-05-deployment-observation.ts).

### Exact definitions replace string dispatch

**DSL prototype**

```ts
// @ts-expect-error A string cannot carry an exact input schema, output schema, or identity.
await ctx.workflow("security-remediation", input);

// Accepted: the definition carries the complete relationship.
const value = await ctx.workflow(
  securityRemediationWorkflow,
  input,
  { key: "remediate" },
);

// Use the detailed form when downstream work needs child-run provenance.
const receipt = await ctx.workflow.detailed(
  securityRemediationWorkflow,
  input,
  { key: "remediate-with-lineage" },
);
```

A detailed receipt contains the validated value, child run identity, input and output digests, an optional
workspace subject when the exact child owns a workspace, and nominal workflow-run evidence. The
[typed registry example](./src/examples/rounds/round-07-typed-workflow-registry.ts) shows how an exhaustive
discriminated union preserves those relationships even under dynamic routing.

### Protected operations make consequence visible

**DSL prototype**

```ts
const publishRelease = defineOperation({
  name: "publish-release",
  input: ReleaseInput,
  output: ReleaseReceipt,
  binding: "registry.release.publish",
  capabilities: ["network", "secrets:read"],
  authorization: {
    mode: "required",
    action: "Publish a package release",
    risk: "high",
  },
});

const candidate = await ctx.operation.prepare(
  publishRelease,
  input,
  { key: "publish:prepare" },
);

const authorization = await ctx.operation.authorize(
  publishRelease,
  candidate,
  { key: "publish:authorize" },
);

const output = await ctx.operation.execute(
  publishRelease,
  { candidate, authorization },
  { key: "publish:execute", attempts: 1 },
);
```

The caller cannot lower `risk` to `"low"` and cannot call a protected definition through the direct overload.
Candidate and authorization references are nominally paired with each other and with the exact definition.

### Recoverable operations represent uncertainty

For effects where a timeout can hide a successful remote commit, the refined API records recovery relationships
before dispatch:

**Conceptual model**

```text
prepare candidate
  → authorize candidate
  → register attempt + conditional cleanup + optional compensation
  → dispatch attempt
  → succeeded(receipt)
     | retryable(not committed)
     | terminal(not committed)
     | ambiguous(may have committed, with cleanup evidence)
```

Only a successful receipt can prepare later compensation. A pre-dispatch attempt is not evidence that the
primary effect committed. An ambiguous result is not silently converted into a retry.

The [compensated release example](./src/examples/rounds/round-06-compensated-release.ts) shows the complete
contract: registration before deployment, automatic conditional cancellation after ambiguous dispatch,
reverse-order rollback prepared from exact success receipts, and explicit retryable, terminal, and ambiguous
recovery results.

## Functions, recipes, and child workflows

Not every reusable piece needs a new node kind.

| Construct | Use it when | Durability behavior |
| --- | --- | --- |
| Plain TypeScript function | Pure calculation or a local helper over an existing `ctx` | Its nested context effects remain the durable steps |
| Recipe | Reusable orchestration should remain transparent in the caller's run | Recipe internals remain independently journaled and inspectable |
| Child workflow | Work needs its own input/output contract, run identity, budget, task scope, or workspace ownership | Parent invokes an exact definition and may retain a detailed child receipt |
| New `define*` node | The concept needs reusable identity or a real engine/host boundary | It joins the closed node and invocation algebra |

This rule kept the API concise during the ten rounds. Helpers, loops, factories, registries, and branching
remain ordinary TypeScript unless a real trust or execution boundary justifies more machinery.

## What TypeScript proves—and what it cannot

The prototype aims for maximum accidental-misuse prevention, not a security proof.

| Contract | Type system responsibility | Engine or host responsibility |
| --- | --- | --- |
| Schema input/output | Connect exact declared input and output types | Parse and validate actual bytes and adapter values |
| Definition identity | Preserve literal names, IDs, revisions, and schemas | Resolve the registered definition and its digest |
| Write authority | Reject ordinary objects and path arrays as `WriteScope` | Canonicalize paths; mint, constrain, expire, and validate the grant |
| Workspace subject | Preserve exact subject generics through results | Compute workspace identity, generation, head, and tree hash |
| Evidence | Prevent accidental cross-subject pairing | Execute checks/reviews and mint honest attestations |
| Authorization | Prevent candidate/definition swapping | Authenticate policy or approver, enforce expiry, and consume authority |
| Secrets | Expose an opaque nominal handle rather than a value | Store, scope, redact, rotate, and resolve the secret |
| Replay | Require explicit keys on consequential APIs | Hash definitions and inputs, journal outcomes, detect divergence, and replay |
| Recovery | Force code to branch on uncertainty | Probe provider state, perform registered cleanup, and classify commit state |
| Trigger admission | Preserve exact event and workflow relationships | Authenticate, deduplicate, atomically claim, and launch |

Unsafe casts, `any`, or a dishonest declaration file can bypass TypeScript. Nominal brands make accidental
construction difficult; the runtime must ensure only the engine can mint values that carry those brands.

### Compiler rejection: a path list is not authority

**DSL prototype**

```ts
declare const sourcePolicy: typeof writePolicy;

// @ts-expect-error A proposed path list is not an engine-minted WriteScope.
const forgedScope: WriteScope<typeof sourcePolicy> = [
  "packages/core/src/engine.ts",
];

const realScope = await ctx.paths.resolve(
  sourcePolicy,
  { proposedPaths: ["packages/core/src/engine.ts"] },
  { key: "resolve-source-scope" },
);
```

### Compiler rejection: evidence cannot cross generations

**DSL prototype**

```ts
type CandidateSubject = WorkspaceSnapshotRef & {
  readonly workspaceId: "candidate-workspace";
  readonly generation: 1;
};

type LaterSubject = WorkspaceSnapshotRef & {
  readonly workspaceId: "candidate-workspace";
  readonly generation: 2;
};

declare const candidateSubject: CandidateSubject;
declare const laterSubject: LaterSubject;

const checks = await ctx.check(requiredChecks, {
  keyPrefix: "candidate-checks",
  subject: candidateSubject,
});

await ctx.delivery.prepare(
  pullRequestDelivery,
  {
    subject: laterSubject,
    input: pullRequestInput,
    evidence: [
      // @ts-expect-error The check attestation belongs to candidateSubject.
      checks.attestation,
    ],
  },
  { key: "prepare-wrong-generation" },
);
```

The exactness is strongest when workflow code retains the refined engine-minted subject type. Unbound checks
remain available, but they intentionally return a broader `WorkspaceSubject` and cannot claim a caller-selected
generation after the fact.

### Compiler rejection: protected calls cannot skip type-state

**DSL prototype**

```ts
// @ts-expect-error A protected operation has no direct-execution overload.
await ctx.operation(publishRelease, input, {
  key: "unsafe-direct-publish",
});
```

These negative examples live as real `@ts-expect-error` fixtures in
[round 8](./src/examples/rounds/round-08-adversarial-types.ts) and
[round 10](./src/examples/rounds/round-10-subject-soundness.ts). Type checking fails if an unsafe call starts
compiling or if an expected-safe call stops compiling.

## Failure is part of the contract

Different failures should not collapse into one thrown string.

| Situation | Recommended representation |
| --- | --- |
| Expected business outcome, such as no eligible issue or exhausted rework | Typed workflow output such as `{ status: "blocked", reason }` |
| Invalid schema output or unavailable required host binding | Step or run failure |
| Caller, parent, deadline, or policy cancellation | Engine-admitted cancellation, not a successful workflow output |
| Check failure under a non-waivable policy | Failed exact-subject result; block promotion |
| Eligible check exception | Host-minted, revisioned, expiring waiver tied to the exact failed check and subject |
| Remote effect proven not committed | Typed `retryable` or `terminal` result |
| Remote effect may have committed | Typed `ambiguous` result plus cleanup/reconciliation evidence |
| Compensation may have committed | Preserve its own ambiguous result; do not report a clean rollback |

Cancellation is cooperative in workflow code through `ctx.cancellation`, but the engine retains terminal-state
authority. Catching an abort cannot convert a cancelled run into success.

Waivers are default-deny. A check must declare a stable revision and an eligible host policy before
`ctx.check.authorize` accepts its failure. The resulting waiver remains tied to the exact executed failure and
workspace subject.

## How ten workflow rounds improved the original prototype

The first version was already strict TypeScript. It had schemas, named declarations, JSDoc, and a common
`WorkflowNode`. The ten-round exercise changed something deeper: what the types *mean*.

### 1. Structural values became nominal capabilities

Earlier shapes allowed workflow code to construct objects that looked like workspace subjects, write scopes,
patches, or secret handles.

The refined version uses unique-symbol brands for engine-minted subjects, grants, evidence, candidates,
authorizations, waivers, patches, receipts, and secret handles. Matching fields are no longer enough.

### 2. Verification became generation-bound

An earlier check could be “green” without encoding which tree it checked. Artifact and review results were also
easy to separate from the workspace state they described.

Checks, suites, reviews, goals, artifacts, waivers, and deliveries now preserve their workspace-subject type.
When callers retain distinct refined subject types, `NoInfer<Subject>` prevents TypeScript from widening them
merely to make a delivery call compile. Broad `WorkspaceSnapshotRef` values still require runtime identity
comparison.

### 3. Definition identity survives inference

Names, IDs, revisions, and versions used to widen too readily to `string` or `number`. That made same-shaped
definitions interchangeable in generic code.

Factories now retain exact literal identity for prompts, agents, recipes, artifacts, checks, suites, goals,
operations, reviews, deliveries, UI views, task contracts, and workflows. Workflow IDs are required in the
prototype. Exact definitions, not strings, drive child-workflow calls.

### 4. External effects gained explicit type-state

The original operation shape was directly callable, and invocation code could select the risk level.

Risk and authorization now belong to definitions. Protected operations require
prepare → authorize → execute. Recoverable operations additionally distinguish pre-dispatch registration,
proven non-commit, ambiguous commit state, conditional cleanup, and receipt-only compensation.

### 5. Context, admission, and observation became separate boundaries

Agent prompts and trigger payloads are not automatically authoritative business data.

`defineContextSource` declares explicit freshness and trust policy and returns host-attested metadata.
`defineTrigger` describes authenticated and deduplicated workflow admission. `defineObserver` describes a
durable, identity-aware wait for terminal external state. Keeping them separate prevents a valid ingress event
from becoming permanent authority or a poll response from becoming unattributed evidence.

### 6. Direct effects were narrowed

Plain workflow contexts expose read-only Git. Workflow-owned workspace contexts add bounded local mutation.
Raw push, pull, and tag operations are absent. Publishing an exact generation is a `defineDelivery` transition.

Fetch is read-only (`GET` or `HEAD`), secret values remain opaque, and callers do not assign risk to process or
Git operations. Generic remote effects belong behind protected operations; promotion of repository state
belongs behind delivery.

### 7. Failure semantics became honest

Cancellation is distinct from worker loss and resumable interruption. Waivers are not free-form reasons.
Unknown post-dispatch state remains ambiguous until the host proves otherwise. Recovery output is evidence, not
a boolean promise that the world is clean.

### 8. Common execution moved to invocations, not nodes

The original desire for one internal `execute(anyNode)` entrypoint was sound in spirit but underspecified in
type terms.

The refined model preserves one generic executor while changing its input from `WorkflowNode` to the closed
`WorkflowInvocation` union. That retains a uniform engine architecture without erasing the distinct
input/output relationships of prepare, authorize, execute, detailed observation, child receipts, and other
modes.

### 9. The API grew only at real boundaries

Pressure tests added first-class artifact, observer, operation, context source, path policy, review, delivery,
and trigger concepts because they introduced identity, authority, provenance, or lifecycle semantics the
engine must own.

They did not add nodes for ordinary branching, loops, catalogs, modules, or program structure.

### 10. The examples became executable type-system tests

The final package includes three canonical refined workflows and 30 additional base, round, and internal-engine
examples. They cover issue delivery, security remediation, dependency migration, flaky tests, monorepo
refactors, hotfixes, cross-repository programs, CI repair, event admission, observation, waivers, cancellation,
recovery, and adversarial type construction.

The examples are not decorative snippets. They are compiled under the package's strict configuration and act
as regression tests for inference and rejection behavior.

## What we deliberately did not add

Ten rounds also removed or rejected tempting abstractions.

There is no `defineModule`, `defineProgram`, catalog node, fixed reviewer hierarchy, automatic rework loop,
implicit artifact capture, implicit delivery, generic saga node, or workflow-authored error classifier.

Ordinary TypeScript already handles factories, helpers, loops, branching, and exhaustive switches. A new node
is justified only when it introduces a reusable definition identity or a real engine boundary. Keeping that
bar high makes the DSL smaller and leaves policy visible in workflow code.

The resulting developer experience has a useful asymmetry:

- low-risk orchestration remains compact;
- high-risk actions are longer because evidence, authorization, execution, and recovery are genuinely separate
  concerns.

## Strictness is part of the product

The prototype enables the full TypeScript strict family and several additional checks:

- exact optional property semantics;
- unchecked indexed-access protection;
- unknown catch variables;
- strict function and iterator behavior;
- unused declaration and parameter checks;
- implicit-return and switch-fallthrough checks;
- isolated modules and isolated declaration emit;
- no skipped library checking;
- no unchecked side-effect imports.

Public signatures prefer named input, option, result, and helper types over anonymous inline shapes. Every
public type and declaration function includes `Why` and `Use` JSDoc, and a package script verifies that
documentation contract.

Strict flags alone do not create a sound DSL. Their value is that they expose places where the semantic model
is vague: optional subjects, widened identities, structurally forgeable authority, incomplete unions, and
overloads that allow an unsafe shortcut.

## Try the prototype in 15 minutes

From a Weft checkout:

**DSL prototype — compile-time only**

```bash
pnpm --filter @techery/weft-dsl-proto typecheck
pnpm --filter @techery/weft-dsl-proto build
pnpm --filter @techery/weft-dsl-proto pack
```

Then:

1. open [the refined issue workflow](./src/examples/refined/issue-to-reviewed-pr.ts);
2. trace one subject from `ctx.workspace.subject` through checks, review, artifact, and delivery;
3. open [the adversarial type fixtures](./src/examples/rounds/round-08-adversarial-types.ts);
4. remove one `@ts-expect-error` or try to pass the wrong authorization to a candidate;
5. run `typecheck` and read the compiler's explanation;
6. add a small reusable definition at module scope and invoke it through the appropriate `ctx` API.

For a broader tour:

- [security remediation](./src/examples/refined/security-remediation.ts) demonstrates authority boundaries and
  security evidence;
- [dependency migration](./src/examples/refined/dependency-migration.ts) demonstrates parallel discovery,
  deterministic planning, rework, and delivery;
- [the prototype contract](./PROTOTYPE.md) explains module boundaries and declaration conventions;
- [the ten-round design record](./DESIGN-ROUNDS.md) records accepted changes, DX findings, and rejected ideas;
- [the current SDK context reference](../../docs/workflow-context-reference.md) documents runnable `ctx`
  behavior.

## Compact glossary

| Term | Meaning |
| --- | --- |
| Definition | Inert reusable contract returned by a `define*` function |
| `WorkflowNode` | Common nominal base for all public definitions |
| Invocation | One definition bound to mode, input, key, options, and execution context |
| Subject | Exact engine-observed thing that evidence describes, often a workspace generation |
| Attestation | Nominal evidence tied to a subject |
| Write scope | Engine-minted authority to mutate canonical paths under one policy |
| Candidate | Frozen proposed consequential effect |
| Authorization | Host-minted authority for one exact candidate |
| Receipt | Schema-validated record of an executed effect |
| Host binding | Portable adapter name resolved by the runtime environment |
| Stable key | Workflow-side durable identity used for replay and inspection |
| Idempotency key | Provider-side identity used to avoid duplicating one external mutation |

## Closing thought

The difficult part of a coding workflow is not asking a model to edit a file. It is proving which repository
state was edited, which evidence applies to it, who authorized the next irreversible step, and what should
happen if the process disappears halfway through.

Weft makes those questions part of the program. The current SDK makes the workflow durable and inspectable.
The refined DSL prototype explores how to make its trust transitions visible to the TypeScript compiler as
well—without replacing ordinary programming with a second language.
