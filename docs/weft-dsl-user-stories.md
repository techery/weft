# Solving developer work with the Weft DSL

This guide starts with work a software team needs to finish: fix a bug, deliver a feature, review a
change, migrate a repository, diagnose CI, or release safely. Each story maps that job to Weft concepts
and shows how those concepts combine into an inspectable, resumable result.

It is deliberately not an API tour. A developer rarely wakes up wanting to “use a gate” or “call a
sequence.” They want to ship a correct change without losing progress, repeating expensive work, or
hiding evidence. Gates, sequences, checks, workspaces, tasks, and journals are the means.

## What Weft is

Weft is a TypeScript runtime for durable, schema-validated developer workflows. A workflow coordinates
coding agents, deterministic tools, Git, people, and long waits as one resumable program. It can route work
to Claude, Codex, or another provider, but Weft—not the provider—owns step identity, permissions, write
boundaries, validation, replay, budgets, and the audit trail.

A Weft workflow is ordinary TypeScript with durable effects:

```text
typed request
  → TypeScript control flow (`await`, `if`, loops, functions)
  → journaled effects (agents, commands, Git, checks, people, waits)
  → verified patch, branch, artifact, decision, or report
  → schema-validated workflow output
```

The engine runs the program again when a suspended or interrupted run resumes. Completed effectful steps
are served from the append-only journal when their identity still matches; ordinary calculations run
again. This makes the source code the workflow graph while the journal supplies durability. A workflow can
pause for approval, survive process exit, and continue without repeating a completed agent call or command.

Weft is not itself a coding agent, a replacement for Git, or a YAML DAG language. It is the layer that says
which actor performs each job, what that actor may change, how results are validated, when work is safe to
promote, and what evidence remains afterward.

## The DSL mental model

The DSL has two layers:

- `define*` functions declare reusable, typed contracts without performing work.
- `ctx.*` methods perform or observe journaled effects during a workflow run.

Everything else is normal TypeScript. `await` creates an ordered dependency, `if` chooses a branch, a
bounded loop expresses rework, and a helper function factors ordinary logic. Specialized composition APIs
exist where Weft must add durable item identity, bounded concurrency, settlement, or a separate run.

Five rules connect the concepts:

1. **Schemas are runtime boundaries.** Workflow inputs, outputs, agent results, human answers, task
   extensions, and custom UI data are validated, usually with Zod.
2. **Keys are durable identity.** `key` identifies an effect for replay; `label` is only presentation.
   Nested phases and item combinators namespace local keys.
3. **Effects go through `ctx`.** Agent turns, commands, Git, network reads, clocks, waits, and human input
   are journaled so resume sees the same completed work.
4. **Writes have explicit ownership.** An isolated writer produces a patch; a delivery workspace owns a
   branch; integration, commit, push, or discard is an explicit promotion decision.
5. **Checks can gate completion.** Attached as `agent.goal`, a check prevents that named agent from
   completing and feeds failures back into its session. Invoked standalone, it returns evidence for
   workflow code, policy, or a person to act on.

## Key DSL concepts

### Workflow contracts and reusable definitions

| Concept | Principal API | Meaning |
|---|---|---|
| Workflow | `defineWorkflow` | Typed durable unit registered by ID, with its own input, output, run, status, report, and optional task/UI contracts |
| Runtime schemas | `z` / Standard Schema | Validate data as it crosses a workflow, agent, human, task, command, HTTP, or UI boundary |
| Prompt definition | `definePrompt` | Reusable typed input-to-prompt renderer; useful when instructions are large or shared |
| Agent role | `defineAgent` | Names a reusable prompt, output schema, provider route, and defaults; invoking it starts a step/session |
| Recipe | `defineRecipe`, `ctx.recipe` | Schema-backed reusable composition whose nested steps remain in the current run and journal |
| Child workflow | `ctx.workflow` | Starts a separate durable run when work needs its own lifecycle, budget, status, or task contract |
| Check definition | `defineCheck` | Reusable deterministic command or function with input, policy, timeout, and structured evidence |
| Check suite | `defineCheckSuite` | Parameterized group of named checks; every member remains independently visible |
| Agent goal | proposed `defineGoal` | Composes named checks, read-only agent reviews, and human reviews into one ordered, bounded completion contract |
| Task contract | `defineTaskContract` | Defines durable work-item data, acceptance criteria, typed extensions, revision, and agent authority |
| Workflow UI | `defineUiView`, `defineResultView` | Interactive input/review views and read-only result presentations; Zod-typed props and answers are proposed |
| Deprecated step definition | `defineStep` | Older TypeScript-only reuse mechanism; schema-backed recipes are the intended replacement |

A definition does not perform an effect. For example, `defineAgent` describes the role, while
`ctx.agent({ agent: role, input, key })` creates a journaled invocation with a concrete key.

### Identity, durability, and execution policy

| Concept | Principal API | Meaning |
|---|---|---|
| Step identity | `key` | Stable replay identity for one semantic effect; changing a prompt or definition revision invalidates incompatible reuse |
| Presentation | `label` | Human-readable run-tree name that may change without redefining semantic identity |
| Journal and replay | engine-managed | Append-only record of inputs, results, patches, checks, decisions, usage, and waits; resume replays code against it |
| Determinism | `ctx.now`, `ctx.random`, `ctx.uuid` | Journaled replacements for ambient clock/random/UUID values used in workflow decisions |
| Provider routing | current routing / proposed provider object | Selects provider, model, effort, and vendor-specific `options` per role or step without expanding Weft capabilities |
| Scope | `ctx.scope` | Immutable inherited defaults for provider routing, task access, budget, and parallel behavior |
| Phase | `ctx.phase` | Groups related work in the run tree and contributes a structural key namespace; it is not a child run |
| Budget | `ctx.budget` | Exposes and enforces token/USD ceilings shared according to workflow policy |
| Error policy | thrown errors, `StepError`, `onError: "null"` | Required work fails explicitly; only deliberately optional enrichment should become `AgentResult<T> | null` |

### Control flow and composition

| Developer intent | DSL shape | Semantics |
|---|---|---|
| Do B after A | normal `await` | Sequential dependency using the value returned by A |
| Choose from typed evidence | normal `if` / `switch` | Branch remains visible through the steps it invokes |
| Retry or remediate | bounded `for` / `while` | Ordinary workflow code names the responder, carries evidence, and limits cost |
| Process ordered items | `ctx.sequence` | Gives each item stable context while later items may build on earlier results |
| Run independent items | `ctx.parallel` | Bounded fan-out that settles lanes in input order |
| Run stages per item | `ctx.pipeline` | Independent items move through multiple mapped/filtering stages |
| Require every lane | `ctx.all` | Throws after settlement if any required lane failed |
| Accept partial success | `ctx.successes` | Returns successful lanes and records dropped failures; must be an explicit product choice |
| Reuse inside one run | ordinary function or `defineRecipe` | Use a function for calculation; use a recipe when nested effects need typed reusable structure |
| Isolate lifecycle | `ctx.workflow` | Creates a child journal/status/budget boundary rather than merely grouping steps |

### Agents, workspaces, patches, and Git

| Concept | Principal API | Meaning |
|---|---|---|
| Agent turn | `ctx.agent` | Schema-validated model work returning one `AgentResult<T>` envelope with value, files, patch, usage, attempts, session, and optional goal verdict |
| Write scope | `write: { paths, mode }` | Declares and enforces the files a writer may modify; strict mode rolls back out-of-scope edits |
| Isolated patch work | writable `ctx.agent` | Current default for an independent edit: run in a detached worktree and return a captured patch |
| Configured worktree bootstrap | proposed `.weft/config.json` `worktrees` policy | Apply one repository-owned setup policy whenever Weft creates a worktree; workflows cannot select profiles or commands |
| Patch ownership | `ctx.integrate`, `ctx.discard` | Apply a patch to the integration tree or explicitly abandon it; a dangling patch is not a deliverable |
| Workflow-owned workspace | proposed `workspace: true | ({ input }) => ({ branch?, from? })` | Start the whole workflow in one host-bootstrapped worktree; no branch means a detached patch workspace, while `branch` makes Git history the deliverable |
| Nested patch candidate | proposed `ctx.workspace.with({ key, from? }, callback)` | Reuse one disposable detached tree inside a workflow for patch composition before capture |
| Existing-checkout lease | proposed workspace fallback | Exclusive journaled claim for environments that cannot be reconstructed safely in a new worktree |
| Git | `ctx.git` / proposed `ws.git` | Journaled reads and risk-tiered writes for diffs, branches, commits, fetches, pushes, and synchronization |
| Conflict handling | fail/rebuild or named resolver | Intent-sensitive stale work returns to its named developer; bounded named resolvers handle mechanical overlap |

Ordinary patch work and durable branch delivery intentionally have different ownership. The former yields a
diff for explicit integration; the latter yields branch history and usually a pull request. They may share
one workspace manager internally without collapsing those public contracts.

### Verification, people, and artifacts

| Concept | Principal API | Meaning |
|---|---|---|
| Check invocation | `ctx.check` / proposed `ws.check` | Runs deterministic verification and returns pass/fail evidence; it never chooses a repair agent |
| Agent completion goal | proposed `defineGoal` plus `agent({ goal: { definition, input } })` | Runs ordered programmatic, agent-review, and human-review components; keeps the owning agent active until every component accepts one workspace generation |
| Required versus advisory | check `policy` | Required evidence blocks promotion; advisory failure remains visible but may continue under policy |
| Generation-scoped evidence | proposed workspace checks | Binds a result to the exact candidate tree, marks older results superseded after mutation, and gates promotion |
| General human input | `ctx.human.ask` | Collects a schema-validated choice or data needed to continue work |
| Human authorization | `ctx.human.approve` | Requires an attributable person to authorize an operation regardless of automatic risk policy |
| Artifact review | `ctx.human.review` | Presents a file or artifact for editing, anchored comments, and a structured decision |
| Policy gate | `ctx.gate` | Evaluates whether an action may proceed; policy may decide automatically or suspend for a human |
| Custom presentation | `ctx.ui.render` and workflow views | Renders journaled schema-backed UI while host controls own final submission |
| Durable evidence | `ctx.note` | Adds a claim, decision, or risk with supporting evidence to the generated report |

### Repository effects, durable work, and operation

| Concept | Principal API | Meaning |
|---|---|---|
| Repository observation | `ctx.fs.read/glob/stat` | Journaled, repository-relative reads with content hashes and metadata |
| Processes | `ctx.exec`, `ctx.bash` | Journaled commands; use argument arrays by default and shell grammar only intentionally |
| Configuration and credentials | `ctx.env.get`, `ctx.secret` | Journaled non-secret config versus opaque secret access with stricter handling |
| HTTP observation | `ctx.fetch` | Journaled network response with optional schema validation |
| Durable tasks | `ctx.tasks.observe/upsert/update/note/setCriterion` | Deduplicate real work across runs and update lifecycle, evidence, and acceptance progress optimistically |
| Durable waits | `ctx.sleep`, `ctx.signal`, proposed `ctx.poll` | Exit the process safely, resume on time/event, or poll from a local machine while preserving deadline and attempts |
| Run metadata | `ctx.run` | Current run ID, working directory, base reference, and child depth |
| Operator narration | `ctx.log` | Transient progress text; unlike a note, it is not durable report evidence |
| Testing | `runWorkflow` | Executes real workflow code with mock agents, commands, Git, humans, signals, and task seeds |
| Operation | CLI and Workflow Manager | Discover contracts, start, inspect, answer, resume, replay, and report runs |

These concepts compose; they are not mandatory ceremony. A read-only review may need one agent and one
schema. A branch-and-PR delivery workflow needs workspaces, checks, Git, people, and resume validation. The
stories below start from that real-world difference and introduce only the concepts each job requires.

## Reading the examples

- **Current** means the behavior exists in Weft today.
- **Proposed** means the example uses an agreed API improvement that is not implemented yet.
- **Mixed** means the workflow is possible today but the example uses a proposed ergonomic shape.

The examples use the intended object-shaped agent call:

```ts
const reviewed = await ctx.agent({
  key: "review:src/cart.ts",
  label: "Review cart totals",
  prompt: reviewPrompt,
  schema: ReviewResult,
});

reviewed.value; // ReviewResult
```

Today this is written as `ctx.agent(reviewPrompt, { key, label, schema })`. The meaning is unchanged:
`key` is durable identity, `label` is presentation, and `prompt` can be a long model instruction. The
single-envelope return is proposed; current `ctx.agent` returns the bare value while
`ctx.agent.detailed` returns the envelope.

```ts
type AgentResult<T> = {
  value: T;
  usage: Usage;
  files: string[];
  patch?: PatchRef;
  attempts: number;
  sessionId?: string;
  goal?: GoalResult;
};

type PatchAgentResult<T> = AgentResult<T> & {
  patch: PatchRef;
};

type WorkspaceWriteAgentResult<T> = AgentResult<T> & {
  patch?: never; // the journaled change is already present in the current workspace
};
```

Read-only callers can destructure the value—`const { value: review } = await ctx.agent(...)`—while write,
budget, audit, and goal-aware workflows use the metadata from the same result. There is no second method or
return-type mode to learn. The context makes the write result precise: on a plain workflow context,
declaring `write` creates an isolated writer and returns `PatchAgentResult<T>` with a required patch; on a
workspace-bound context, the same call returns `WorkspaceWriteAgentResult<T>` because the journaled change is
already applied there. Callers never test `if (result.patch)` to discover what happened—the context's type
determines whether patch integration is required.

## Real work at a glance

| Developer job | Finished result | Weft concepts used |
|---|---|---|
| Fix a reported bug | Reproducing test, scoped patch, green verification | named developer, write scope, `defineGoal`, test/lint/typecheck suite, patch |
| Deliver a feature | Reviewed plan, commits on one branch, pushed PR | human review, workflow-owned branch workspace, agent goal, phases, Git, gate |
| Review a pull request | Findings independently verified across providers | changed files, parallel, pipeline, provider routing, `all` |
| Apply review feedback | Bounded rework with verification restarted each round | ordinary loop, nested phases, stable keys, same workspace |
| Migrate many files | Independent patches integrated in a controlled order | recipe, parallel worktrees, named conflict resolver, `successes` |
| Upgrade a monorepo dependency | Lockfile change plus parameterized package evidence | `defineGoal`, check suite, parser, defaults, command evidence |
| Diagnose flaky CI | Durable investigation that waits without losing state | fetch, poll, signal, sleep, notes, deterministic time |
| Run a security audit | Isolated specialist workflow with its own budget and tasks | child workflow, scope, provider, budget, task boundary |
| Maintain work across runs | Deduplicated tasks with typed acceptance progress | task contract, upsert, observe, optimistic update |
| Review a design artifact | Edited file, many anchored comments, explicit decision | artifact review, schema, content hash, custom UI |
| Release after CI | Local polling, policy gate, exact commit deployment | poll, gate, secrets, exec, Git, result view |
| Test and operate automation | Repeatable tests, inspectable run, safe resume | test harness, journal, CLI, report, replay |

---

## 1. Fix a reported bug and prove the fix

**Developer story:** As the engineer assigned a production bug, I need to reproduce it with a failing test,
make the smallest allowed change, and prove the same test passes afterward.

**Done when:** the run contains red and green evidence, the edit stayed inside the declared scope, and the
verified patch is integrated. A prose claim from the coding agent is not enough.

**Status:** Mixed — isolated writer worktrees, patches, integration, and checks are current. Global
worktree bootstrap, `defineGoal`, goal-backed agent continuation, exact-base integration validation, the
object-shaped call, and the reusable provider object are proposed DX.

### Map the job to Weft

| Part of the job | Weft concept | Why it exists |
|---|---|---|
| “Work on BUG-421” | typed workflow input | Reject malformed ticket data before work starts |
| “Return actual red/green output” | schema-validated agent result | Make evidence part of the contract |
| “Only touch source and tests” | strict write scope | Detect and roll back unrelated edits |
| “Review the change before applying it” | isolated worktree and patch | Keep agent writes out of the integration checkout |
| “The checkout changed outside this workflow” | exact patch-base validation | Fail closed instead of silently integrating against an unknown tree |
| “Prove tests, lint, and types are green” | check suite wrapped by `defineGoal` | All executable acceptance conditions gate the agent's completion |
| “Apply exactly this change” | `ctx.integrate` | Make ownership transfer explicit |

```ts
import {
  defineAgent,
  defineCheck,
  defineCheckSuite,
  defineGoal,
  definePrompt,
  defineWorkflow,
  z,
} from "@techery/weft-sdk";

const BugInput = z.object({
  ticket: z.string(),
  title: z.string(),
  reproduction: z.string(),
  allowedPaths: z.array(z.string()).min(1),
  testCommand: z.array(z.string()).min(1),
});

const BuildResult = z.object({
  summary: z.string(),
  rootCause: z.string(),
  redEvidence: z.string().min(1),
  greenEvidence: z.string().min(1),
  testsAdded: z.array(z.string()),
});

const bugDeveloperPrompt = definePrompt({
  name: "bug-developer-prompt",
  input: z.object({
    ticket: BugInput,
  }),
  render: ({ ticket }) => [
    `Fix ${ticket.ticket}: ${ticket.title}`,
    ticket.reproduction,
    "Add a regression test first.",
    "Run it before the fix and quote the relevant failing output as redEvidence.",
    "Implement the smallest fix, rerun it, and quote passing output as greenEvidence.",
  ],
});

const bugDeveloper = defineAgent({
  name: "bug-developer",
  prompt: bugDeveloperPrompt,
  schema: BuildResult,
  defaults: {
    provider: {
      id: "claude",
      model: "sonnet",
      effort: "high",
      options: { permissionMode: "dontAsk" },
    },
  },
});

const regressionCheck = defineCheck({
  name: "bug-regression",
  policy: "required",
  input: z.object({ command: z.array(z.string()).min(1) }),
  command: ({ command }) => command as [string, ...string[]],
});

const lintCheck = defineCheck({
  name: "typescript-lint",
  policy: "required",
  command: () => ["pnpm", "lint"],
});

const typecheckCheck = defineCheck({
  name: "typescript-typecheck",
  policy: "required",
  command: () => ["pnpm", "typecheck"],
});

const bugFixQuality = defineCheckSuite({
  name: "bug-fix-quality",
  input: z.object({
    testCommand: z.array(z.string()).min(1),
  }),
  checks: ({ testCommand }, use) => ({
    tests: use(regressionCheck, { command: testCommand }),
    lint: use(lintCheck),
    typecheck: use(typecheckCheck),
  }),
  concurrency: 3,
});

const bugFixGoal = defineGoal({
  name: "bug-fix-complete",
  check: bugFixQuality,
  defaults: {
    attempts: 3,
  },
});

export default defineWorkflow(
  {
    id: "fix-reported-bug",
    description: "Reproduce, fix, and verify one reported bug",
    input: BugInput,
    output: z.object({
      summary: z.string(),
      files: z.array(z.string()),
    }),
  },
  async (ctx, input) => {
    const built = await ctx.agent({
      key: "developer",
      label: `Fix ${input.ticket}`,
      agent: bugDeveloper,
      input: { ticket: input },
      write: { paths: input.allowedPaths, mode: "strict" },
      goal: {
        definition: bugFixGoal,
        input: { testCommand: input.testCommand },
      },
    });

    await ctx.integrate([built.patch]);

    await ctx.note({
      kind: "claim",
      text: `${input.ticket} reproduced, independently verified, and integrated`,
      evidence: [
        built.value.redEvidence,
        built.value.greenEvidence,
        built.goal.evidence,
      ].join("\n\n"),
    });

    return {
      summary: built.value.summary,
      files: built.patch.files,
    };
  },
);
```

`bugDeveloper` is one logical agent step, not a workflow-level remediation loop. When the agent proposes
that it is finished, Weft runs the `bugFixQuality` suite in the same isolated writer worktree. Failed tests,
lint, or typecheck results are journaled and fed back into the same provider session with command evidence;
the workspace and conversational context stay intact. The step does not resolve, return `BuildResult`, or
capture a patch until every suite member passes.

`attempts: 3` bounds proposed-completion cycles. Provider turn limits and the workflow budget remain
additional hard ceilings. If the goal is still unmet, the agent step fails with goal evidence and the
worktree never yields a patch. “The agent cannot finish” therefore means it cannot report success—not that
Weft loops forever or converts exhaustion into a passing result.

Before starting the agent, Weft applies the repository's global worktree bootstrap policy. Goal attempts
reuse that same worktree, so a failed check does not reinstall dependencies. If the repository depends on
ignored state such as `node_modules`, a venv, Pods, or a local SDK, the host policy must reconstruct or
safely link that state. If it cannot, use the explicit leased-checkout fallback described in the next
story.

`bugDeveloper` is a named `defineAgent` role with an explicit provider, model, effort, prompt contract, and
output schema. Goal failure continues that role's current session because its workspace and source base are
still valid.

There is no integration retry loop. This workflow has one writer and no intervening step mutates the
integration checkout, so a patch created from that tree should apply deterministically. The patch records
its `baseTree`; `ctx.integrate` verifies the current integration tree still matches before applying it. A
different tree is `stale_base`, meaning a person, another run, or an unjournaled process interfered with the
checkout. Weft fails closed and reports that ownership violation rather than asking the implementation
agent to reinterpret already verified work against an unknown base.

### A programmatic check can be an agent completion goal

Attaching a check through `agent({ goal })` changes who owns remediation without letting the check choose a
random agent. The enclosing agent is already the named owner. Weft evaluates each proposed completion and
continues that same session until the goal passes or its limits are exhausted:

```text
agent works → proposes completion → goal check
                    ↑                ├─ fail: journal evidence and continue the same session
                    └────────────────┘
                                     └─ pass: resolve the agent step and allow capture
```

`defineGoal` gives that completion contract a stable name, inferred input, and default attempt policy
without duplicating the underlying checks:

```ts
const bugFixGoal = defineGoal({
  name: "bug-fix-complete",
  check: bugFixQuality,          // CheckDefinition or CheckSuiteDefinition
  defaults: { attempts: 3 },    // completion proposals, not blind process retries
});

await ctx.agent({
  // ...agent, input, and write scope...
  goal: {
    definition: bugFixGoal,
    input: { testCommand },      // inferred from bugFixQuality
  },
});
```

`defineCheck` describes one deterministic observation. `defineCheckSuite` groups independently visible
observations—in this workflow regression tests, TypeScript lint, and typecheck. `defineGoal` adds agent
completion semantics around that check or suite. The same `bugFixQuality` suite can still be invoked
standalone for CI or release verification without starting an agent loop.

`AgentResult` exposes the accepted verdict as
`goal: { status: "met", attempts, results, history, evidence }`. `results` is keyed by component name and
`history` points to every superseded rejection and final acceptance, which is why the bug story can include
independent command evidence in its note without invoking the check again.

Output schemas and goals solve different problems. `schema: BuildResult` makes the implementation agent's
returned explanation structurally usable. Goal components prove executable conditions and collect typed
review verdicts against that workspace generation. The output schema and every required goal component
must pass before the step succeeds. A check used as a goal component is completion-blocking even if the
same definition is advisory when invoked elsewhere.

A command spawn error, timeout, malformed parser output, or unavailable toolchain is a goal execution
error, not evidence that the code is wrong. It stops or suspends the step according to explicit policy
instead of consuming every agent attempt. Only a successfully executed check returning `status: "fail"`
is fed back as remediable goal evidence.

Checks still have a standalone form. Use `ctx.check` or `ws.check` when there is no agent that owns the
repair—for example, validating an immutable release candidate, auditing an external artifact, or gathering
advisory evidence. Standalone failures return to workflow code, which may stop, ask a person, or explicitly
invoke a named specialist. A check itself never selects a provider or invents a repair role.

The intended model binds every check result to a subject such as
`{ workspaceId, generation, treeHash }`. A mutation creates a new generation and makes passes whose declared
subject may have changed stale. A failed first generation remains useful evidence, but it does not poison
completion after the named developer produces a later generation that passes. Promotion operations such as
`ws.capture`, `ws.git.commit`, and `ws.git.push` refuse a generation that lacks its applicable required
passing checks.

The run UI should render goal attempts inside their owning agent step: proposed completion, failed check
with evidence, continued work, and final pass. Older generations remain inspectable as `superseded`; the
current agent shows `goal unmet` rather than `completed`, and capture/commit/push show the goal that blocks
promotion.

Today, command checks run in the integration working directory and required failures accumulate at run
scope. That explains the awkward integrate-then-check ordering in workflows built only from the current
API: the check cannot see an isolated patch until it is applied. It is a limitation, not the desired
contract. A check-backed agent goal runs inside the agent's writable workspace before the step resolves,
capture, or commit. A check after composition is still useful when several independently verified patches
are combined, but it is a second integration check inside a rollbackable candidate transaction—not the
first validation of untrusted edits.

### Compose checks, agent reviews, and human reviews

A goal may contain several named components. Builder helpers provide syntax sugar while preserving the
component's result type:

```ts
const releaseReadyGoal = defineGoal({
  name: "release-ready",
  input: z.object({
    ticket: z.string(),
    testCommand: z.array(z.string()).min(1),
    planPath: z.string(),
  }),
  components: (input, use) => ({
    tests: use.check(regressionCheck, { command: input.testCommand }),
    lint: use.check(lintCheck),
    types: use.check(typecheckCheck),

    semanticReview: use.agentReview(acceptanceReviewer, {
      input: { ticket: input.ticket },
      accept: ({ value }) => value.accepted,
      // Omit `feedback` to send the rejected typed value and evidence by default.
      feedback: ({ value }) => value.feedback,
    }),

    ownerReview: use.humanReview(PlanReview, {
      question: `Review the delivery plan for ${input.ticket}`,
      subject: { kind: "file", path: input.planPath, mode: "edit" },
      accept: ({ answer }) => answer.decision === "approved",
      // Omit `feedback` to send the answer and subject-edit summary by default.
      timeout: "24h",
      onTimeout: "escalate",
    }),
  }),
  defaults: { attempts: 3 },
});
```

The engine groups components by kind and always executes the stages in this order, regardless of object
property order:

1. All programmatic checks or suites run first. Their failures are aggregated; later stages do not run.
2. Named agent reviews run only after checks pass. Each reviewer is schema-bound, read-only, separately
   routed, budgeted, and journaled.
3. Human reviews run only after automated evaluation passes, so people are not asked to review a candidate
   already known to be broken.

A rejection stops the current pipeline, feeds its structured evidence to the implementation agent, and
starts the next proposal again from programmatic checks. Every component result is bound to the workspace
generation it observed. If a human edits the subject, even an approving answer changes the generation, so
the automated stages rerun before final human confirmation. Invalid human answers reopen the same request
and do not consume an agent attempt.

The object keys become stable component names and nested journal namespaces; authors do not supply request
or attempt keys. A goal-backed agent is displayed as one logical step but implemented as replayable
substeps such as `attempt:1`, `check:lint`, `agent-review:semanticReview`, and
`human-review:ownerReview`. When a human review suspends the run, the completed agent proposal, provider
continuation, workspace checkpoint, component results, and pending request are already journaled. Resume
replays those substeps and continues at the answer rather than rerunning the paid agent turn.

For one-component goals, top-level fields are concise aliases for the component builder:

```ts
defineGoal({ name: "quality", check: deliveryChecks });

defineGoal({
  name: "plan-approved",
  input: z.object({ ticket: z.string(), path: z.string() }),
  humanReview: (input) => ({
    schema: PlanReview,
    question: `Review the implementation plan for ${input.ticket}`,
    subject: { kind: "file", path: input.path, mode: "edit" },
    accept: ({ answer }) => answer.decision === "approved",
    timeout: "24h",
    onTimeout: "escalate",
  }),
  defaults: { attempts: 3 },
});
```

The human-review alias supplies the request and acceptance rule directly—there is no nested
`evaluator.kind`, `request`, or `verdict` ceremony. A separate named agent reviewer remains distinct from
the implementation agent; rejection continues the implementation owner rather than letting the reviewer
edit code.

---

## 2. Deliver a feature as a branch and pull request

**Developer story:** As a feature owner, I need one workflow to take a ticket through planning, build,
review, documentation, commits, push, and PR creation. Every phase must see the commits produced by the
previous phase.

**Done when:** the deliverable is a branch with commits and a PR, not merely a diff. If the run pauses for
plan approval and resumes tomorrow, it must verify that it still owns the same branch and HEAD.

**Status:** Proposed workflow-owned workspace API built on current scoped direct-write safety, journaling, phases,
checks, human steps, process execution, and Git operations.

### Resolve missing product choices before coding begins

When the ticket leaves a decision open, ask for that decision as typed intake instead of making the coding
agent guess:

```ts
const intake = await ctx.human.ask({
  key: `feature-intake:${input.ticket}`,
  question: "Choose the compatibility policy for this feature",
  detail: "This changes whether old clients receive the new response field.",
  schema: z.object({
    compatibility: z.enum(["additive", "new-version"]),
    constraints: z.array(z.string()).default([]),
  }),
  timeout: "24h",
  onTimeout: "escalate",
});
```

The run enters `waiting_for_human`. The Workflow Manager, CLI, or embedding host submits a candidate
answer, and Weft validates it before the workflow resumes. Unlike a gate, `human.ask` gathers work input;
it does not authorize a risky effect.

### Why this job needs branch ownership

A temporary worktree per writer is the right boundary for independent patches. It is the wrong lifecycle
for a sequential delivery lane whose reviewers and documentation agents must read committed work from
earlier phases. This workflow owns one managed worktree for its full scope:

```text
create and bootstrap one managed worktree
  └─ Plan → Build agent (goal: Verify, bounded) → Commit candidate → Sync upstream → Review
                                                        ├─ findings → Rework → Verify → Recommit → Review
                                                        └─ approved → Docs → Final checks → Publish → PR

Commit = stage declared files → create local history
Publish = approval gate → push the fully reviewed branch
All phases see the same branch, toolchain, files, and Git history.
```

```ts
const deliveryGoal = defineGoal({
  name: "delivery-quality",
  check: deliveryChecks,
  defaults: { attempts: 3 },
});

const approvedPlanGoal = defineGoal({
  name: "approved-delivery-plan",
  input: z.object({
    ticket: z.string(),
    path: z.string(),
  }),
  humanReview: (input) => ({
    schema: PlanReview,
    question: `Review the implementation plan for ${input.ticket}`,
    subject: { kind: "file", path: input.path, mode: "edit" },
    accept: ({ answer }) => answer.decision === "approved",
    timeout: "24h",
    onTimeout: "escalate",
  }),
  defaults: { attempts: 3 },
});

export default defineWorkflow(
  {
    id: "deliver-feature",
    input: DeliveryInput,
    output: z.object({
      files: z.array(z.string()),
      branch: z.string(),
      commit: z.string(),
      prUrl: z.string().url(),
    }),
    workspace: ({ input }) => ({
      branch: `feature/${input.ticket}`,
      from: input.base,
    }),
  },
  async (ctx, input) => {
    const branch = ctx.workspace.branch;

    const approvedPlan = await ctx.phase("Plan", async (plan) => {
      const planPath = `.weft/plans/${input.ticket}.md`;
      const drafted = await plan.agent({
        key: "draft",
        prompt: `Write ${planPath} for:\n${input.description}`,
        schema: z.object({ summary: z.string() }),
        write: { paths: [planPath], mode: "strict" },
        goal: {
          definition: approvedPlanGoal,
          input: { ticket: input.ticket, path: planPath },
        },
      });

      const approval = drafted.goal.results.humanReview;
      return {
        document: {
          path: planPath,
          ref: approval.subject.ref,
          sha256: approval.subject.afterSha256,
        },
        review: approval.answer,
      };
    });

    const built = await ctx.phase("Build", (build) =>
      build.agent({
        key: "implementation",
        label: `Implement ${input.ticket}`,
        agent: featureDeveloper,
        input: {
          ticket: input,
          approvedPlan,
        },
        write: {
          paths: ["packages/**", "apps/**", "tests/**", "pnpm-lock.yaml"],
          mode: "strict",
        },
        goal: {
          definition: deliveryGoal,
          input: { package: input.package },
        },
      }),
    );

    const buildCommit = await ctx.phase("Commit candidate", async (commitCtx) => {
      const commitFiles = [approvedPlan.document.path, ...built.files];
      await commitCtx.git.add({ paths: commitFiles });
      return commitCtx.git.commit({
        message: `feat: ${input.title}`,
        paths: commitFiles,
      });
    });

    const syncedHead = await ctx.phase("Sync upstream", async (sync) => {
      await sync.git.fetch({ remote: "origin" });
      return syncUpstreamIfRequired(sync, {
        branch,
        base: input.base,
        head: buildCommit.sha,
        approvedPlan,
        resolver: upstreamSyncResolver,
      });
    });

    const review = await ctx.phase("Review", async (reviewCtx) =>
      reviewCtx.agent({
        key: "correctness",
        prompt: [
          `Review local commit ${syncedHead} on the current branch for defects.`,
          input.acceptanceCriteria.join("\n"),
        ].join("\n\n"),
        schema: CodeReview,
        provider: {
          id: "claude",
          model: "sonnet",
          effort: "high",
          options: { permissionMode: "dontAsk" },
        },
      }),
    );

    if (review.value.blocking.length > 0) {
      throw new Error("Blocking review findings must be resolved before publication");
    }

    const released = await ctx.phase("Release", async (release) => {
      const docs = await release.agent({
        key: "documentation",
        prompt: `Update documentation and release notes for reviewed commit ${syncedHead}.`,
        schema: z.object({ summary: z.string() }),
        write: {
          paths: ["docs/**", "CHANGELOG.md"],
          mode: "strict",
        },
      });

      let finalSha = syncedHead;
      if (docs.files.length > 0) {
        await release.git.add({ paths: docs.files });
        const docsCommit = await release.git.commit({
          message: `docs: document ${input.title}`,
          paths: docs.files,
        });
        finalSha = docsCommit.sha;
      }

      const finalQuality = await release.check(
        deliveryChecks,
        { package: input.package },
        { keyPrefix: "final-quality" },
      );
      if (!finalQuality.passed) {
        throw new Error("Final verification failed; the local branch was not published");
      }

      const publish = await release.gate({
        key: "publish-branch",
        action: `git.push:${branch}`,
        risk: "medium",
        detail: `Push reviewed commit ${finalSha} to origin`,
      });
      if (!publish.approved) throw new Error(publish.note ?? "Branch publication denied");

      await release.git.push({
        remote: "origin",
        branch,
        setUpstream: true,
      });

      await release.git.fetch({ remote: "origin" });
      const remoteHead = await release.bash(
        `git rev-parse "refs/remotes/origin/${branch}"`,
        { key: "validate-remote-head" },
      );
      if (remoteHead.stdout.trim() !== finalSha) {
        throw new Error("The owned remote branch changed outside this workspace");
      }

      const open = await release.gate({
        key: "approve-pr",
        action: `pull-request.create:${branch}`,
        risk: "high",
        detail: `Open a PR for reviewed commit ${finalSha}`,
      });
      if (!open.approved) throw new Error(open.note ?? "PR creation denied");

      const pr = await release.exec("gh", [
        "pr", "create",
        "--base", input.base,
        "--head", branch,
        "--title", input.title,
        "--body-file", approvedPlan.document.path,
      ], { key: "open-pr", risk: "high" });

      return { commit: finalSha, prUrl: pr.stdout.trim(), files: docs.files };
    });

    return {
      files: [approvedPlan.document.path, ...built.files, ...released.files],
      branch,
      commit: released.commit,
      prUrl: released.prUrl,
    };
  },
);
```

`approvedPlanGoal` is a single human-review component using the concise alias. `plan.agent()` remains
pending while the review is unanswered. A `changes-requested` result and any edited file content are fed
to the same logical planning agent, which revises the current workspace and produces another proposal.
Only the approved review resolves the agent call, so Build needs no rejection branch. The final typed
review is available at `drafted.goal.results.humanReview`. The Plan phase returns an `approvedPlan`
containing the reviewed document's workspace path, immutable blob reference, exact SHA-256, and review
answer. The implementation agent receives that complete record, reads the plan from the shared workspace,
and can verify that it is using the exact content the person approved.

### Workspace declaration and defaults

`workspace: true` starts the workflow in a detached worktree. Supplying `branch` attaches that worktree to
the requested branch and changes the durable deliverable from a patch to Git history:

```ts
workspace: true,

workspace: ({ input }) => ({
  branch: `feature/${input.ticket}`,
  from: input.base,
}),
```

The defaults are deliberately conservative:

| Setting | Default |
|---|---|
| Backing location | A new Git worktree |
| `branch` | Absent; checkout is detached |
| `from` | The workflow run's captured initial revision |
| Bootstrap | Resolved global `.weft/config.json` worktree policy |
| Lifetime | The full workflow, including suspension and resume |
| Existing named branch | Refuse it unless the journal proves this run created it |
| Detached success | Capture the final diff as a run patch artifact, then remove the worktree |
| Named-branch success | Require a clean committed tree, record branch and HEAD, then remove the worktree |
| Failure or recovery-required state | Keep the worktree for diagnosis or resume |
| Commit and push | Never automatic |

The workspace artifact is operational metadata and does not replace the workflow's typed output. A named
branch can only be reused when its journaled repository, branch, HEAD, and workspace identity match; an
unrelated pre-existing branch fails closed.

The workflow body receives a workspace-bound context, and every phase inherits that binding. Therefore
`ctx.agent({ write })`, `plan.agent({ write })`, and `candidate.agent({ write })` edit their current
workspace directly; there is no separate `.agent.inPlace` API. Ordinary awaited mutations remain
sequential, while the engine rejects concurrent direct writers targeting the same workspace. Parallel
writers must use independent nested workspaces and return patches for explicit composition.

The workspace factory is a pure configuration mapper over validated workflow input, not a workflow step.
Weft evaluates and journals its resolved value before creating the worktree, then reuses that recorded
value during replay rather than asking the factory to inspect ambient Git or filesystem state.

### Worktree preparation is repository policy

The workflow declares the ownership and lifetime it needs; it does not know how to install dependencies
or select a preparation profile. A conceptual extension to the existing repository-level
`.weft/config.json` supplies one policy for every worktree Weft creates:

```json
{
  "worktrees": {
    "bootstrap": {
      "command": ["pnpm", "install", "--offline", "--frozen-lockfile"],
      "inputs": ["package.json", "pnpm-lock.yaml"],
      "timeout": "10m"
    }
  }
}
```

This policy applies equally to an isolated writer, a patch-composition workspace, and a workflow-owned
workspace. There is no `prepare` field in `ctx.agent`, `defineWorkflow`, or `ctx.workspace.with`, so two
workflows cannot silently construct different versions of the same repository environment.

The worktree manager runs bootstrap once after creating a worktree and before any workflow step can use
it. It journals the resolved config, source-revision and setup-input fingerprints, command evidence, and
outcome. All activity in that workspace, including goal attempts, reuses the initialized environment. On
resume, the manager validates the recorded workspace identity. If recovery requires reconstructing the
worktree, it recreates the journaled Git state and reapplies the same resolved policy; if that cannot be
done without changing its identity, resume fails closed. A bootstrap failure is an infrastructure failure,
not a negative goal verdict, and its output is never presented as proof that a regression test failed.

Host-wide defaults may supply the policy when a repository has none, while a repository setting takes
precedence. The resolved policy must be inspectable and validated by the host. Secret files and ignored
directories are never copied implicitly; any future copy or link mechanism belongs to this same trusted
configuration boundary, not to workflow-authored DSL.

The callback form of `phase` is proposed. Today, bind and use the returned context:

```ts
const build = ctx.phase("Build");
const result = await build.agent(/* ... */);
result.value; // schema-validated agent output
result.files; // operational metadata from the same API
```

`featureDeveloper` is the named implementation owner. `deliveryChecks` is its completion goal, so failures
continue the same session with structured suite evidence rather than escaping into a workflow-level repair
loop. `Commit candidate` is reached only after that agent step resolves with a passing current generation;
it creates local history but publishes nothing. Upstream synchronization happens next, and semantic review
sees the resulting local commit. Exhausted goal attempts or blocking review findings leave the branch in
the run-owned worktree without exposing it on the remote. This compact story stops on blocking findings;
Story 4 replaces that terminal branch with a bounded rework, reverify, recommit, and rereview loop. In both
forms, publication remains after the final accepted review.

The durable workspace record must include repository identity, workspace path, branch, HEAD, tree, the
resolved global worktree-config fingerprint, the completed bootstrap fingerprint, and recovery state.
Resume reacquires and validates those facts. If a person checked out another branch or rewrote HEAD, Weft
refuses to continue rather than committing onto an unrelated branch.

Under the hood, one workspace manager can support all write modes while preserving their ownership rules:

| Public model | Backing location | Lifetime | Result ownership |
|---|---|---|---|
| Isolated agent writer | detached Git worktree | one agent step, including its goal attempts | patch |
| Workflow-owned detached workspace | detached Git worktree | workflow scope | patch |
| Workflow-owned branch workspace | managed Git worktree | workflow scope | branch |
| Explicit existing-checkout lease | current checkout | workflow scope | branch |

The last mode is an escape hatch for environments that cannot be reconstructed in a new worktree. It must
hold an exclusive, journaled lease; exposing unrestricted direct editing would let parallel runs trample
the checkout.

### Treat branch divergence separately from patch conflicts

A durable delivery workspace does not call `ctx.integrate` between Build, Review, Rework, and Docs. Those
phases are sequential owners of one tree. Conflict handling belongs to the explicit upstream-sync boundary:

| Observed change | Workflow response |
|---|---|
| Local branch, HEAD, or workspace fingerprint changed outside the run | Refuse resume; the workspace lease is broken |
| Owned remote feature branch no longer equals the last SHA pushed by this run | Fail closed or ask a human; do not combine unknown remote work automatically |
| Base branch advanced, but project policy allows the PR to remain behind | Record the new base and continue without rewriting the feature branch |
| Base branch advanced and policy requires merge/rebase | Run a named upstream-sync resolver, then restart all verification |
| Two ordinary workflow phases touch the same file | No merge is needed; the later phase reads the earlier phase's current tree |

The intended sync API makes the resolver identity and fallback explicit rather than choosing the engine's
default agent:

```ts
const verifiedHead = await ctx.phase("Sync upstream", async (sync) => {
  await sync.git.fetch({ remote: "origin" });
  const state = await sync.git.compare({
    branch,
    upstream: `origin/${input.base}`,
  });
  if (!state.upstreamMoved) return state.head;

  const rebased = await sync.git.rebase({
    onto: `origin/${input.base}`,
    onConflict: {
      resolver: upstreamSyncResolver,
      context: {
        ticket: input.ticket,
        approvedPlan,
        lastVerifiedCommit: state.head,
      },
      attempts: 1,
      fallback: "ask",
    },
  });

  // A rebase or conflict resolution changes code, so every earlier verdict is stale.
  const quality = await sync.check(deliveryChecks, { package: input.package }, {
    keyPrefix: "post-sync-quality:1",
  });
  let repaired = false;

  if (!quality.passed) {
    await sync.agent({
      key: "post-sync-repair",
      agent: postSyncDeveloper,
      input: {
        ticket: input.ticket,
        approvedPlan,
        checkFailure: quality.results,
        rebasedHead: rebased.head,
      },
      write: { paths: input.allowedPaths, mode: "strict" },
      goal: {
        definition: deliveryGoal,
        input: { package: input.package },
        attempts: 2,
      },
    });
    repaired = true;
  }

  let verifiedHead = rebased.head;
  if (repaired) {
    await sync.git.add({ paths: input.allowedPaths });
    const repairCommit = await sync.git.commit({
      message: `fix: repair ${input.ticket} after upstream sync`,
      paths: input.allowedPaths,
    });
    verifiedHead = repairCommit.sha;
  }

  return verifiedHead;
});
```

This API is conceptual. `upstreamSyncResolver` is the named specialist for resolving Git conflicts;
`postSyncDeveloper` is the named implementation owner for code that merges cleanly but fails verification.
Those are different jobs and may use different prompts and providers. The engine adds authoritative
conflict files and Git identities to the resolver input, constrains writes to the conflict transaction,
verifies that the repository has no unresolved entries, and journals the resolution. A failed resolver
suspends for the configured human fallback or restores the pre-sync state and fails. The first standalone
check avoids calling `postSyncDeveloper` when the clean rebase is already valid. If it fails, that evidence
starts the named repair agent, whose own goal keeps the same repair session active until the new generation
passes. This phase returns a verified local commit and never pushes it. Because a rebase, resolver, or
repair can change semantics, the caller must run the named semantic review against `verifiedHead` before
the later publication gate. If a previously published branch ever needs replacement, that is a separate
high-risk force-with-lease operation after renewed verification and review; plain force is never acceptable.

---

## 3. Review a pull request with independent verification

**Developer story:** As a reviewer, I need several specialists to inspect changed files and a different
provider to challenge every reported defect before I send feedback to the author.

**Done when:** each surviving finding cites concrete file evidence and has passed an independent refutation
stage. A failed reviewer lane cannot silently disappear from a required review.

**Status:** Mixed — changed-file reads, providers, `parallel`, `pipeline`, and settled-result helpers are
current; direct definition passing and provider objects are proposed.

```ts
const Finding = z.object({
  id: z.string(),
  file: z.string(),
  line: z.number().int().positive(),
  claim: z.string(),
  evidence: z.string(),
  severity: z.enum(["low", "medium", "high"]),
});

const reviewPrompt = definePrompt({
  name: "review-file-prompt",
  input: z.object({ file: z.string() }),
  render: ({ file }) =>
    `Review ${file} for correctness defects. Cite file:line and quote evidence.`,
});

const reviewFile = defineAgent({
  name: "review-file",
  prompt: reviewPrompt,
  schema: z.object({ findings: z.array(Finding) }),
  defaults: {
    provider: {
      id: "claude",
      model: "sonnet",
      effort: "high",
      options: { permissionMode: "dontAsk" },
    },
  },
});

const refutePrompt = definePrompt({
  name: "refute-finding-prompt",
  input: Finding,
  render: (finding) => [
    `Try to disprove this finding: ${finding.claim}`,
    `Location: ${finding.file}:${finding.line}`,
    `Claimed evidence: ${finding.evidence}`,
    "Mark real=false when the repository does not support it.",
  ],
});

const refuteFinding = defineAgent({
  name: "refute-finding",
  prompt: refutePrompt,
  schema: z.object({ real: z.boolean(), reason: z.string() }),
  defaults: {
    provider: {
      id: "codex",
      model: "gpt-5.6-sol",
      effort: "high",
      options: { sandboxMode: "read-only", networkAccess: false },
    },
  },
});

const { files } = await ctx.git.changedSince(input.base);
const reviewInputs = files
  .filter((file) => file.status !== "D")
  .map((file) => ({ file: file.path }));

const reviewed = ctx.all(
  await ctx.parallel(reviewInputs, reviewFile, {
    key: "review-files",
    keyOf: (item) => item.file,
    concurrency: 4,
    errors: "throw",
  }),
);

const candidates = reviewed.flatMap((result) => result.value.findings);

const confirmed = ctx.all(
  await ctx
    .pipeline(candidates)
    .step((finding) =>
      ctx.agent({
        key: `refute:${finding.id}`,
        agent: refuteFinding,
        input: finding,
      }),
    )
    .filter((verdict) => verdict.value.real)
    .map((_verdict, finding) => finding)
    .run({ concurrency: 4, errors: "throw" }),
);
```

Provider adapters translate their own `options`; Weft still owns schema validation, replay, write scope,
approval, task access, and budget. A provider option can make a vendor more restrictive, but it cannot
expand the workflow's capabilities.

`ctx.parallel` settles every lane. `ctx.all(settled)` then fails if any required lane failed. For an
explicitly best-effort scan, use `ctx.successes(settled)`; Weft records which lanes were dropped so the
report cannot imply complete coverage.

The proposed direct-definition overload also gives each nested invocation an automatic namespace. A
definition-local key such as `inspect` becomes `review-files:src/cart.ts:inspect`, so reusable recipes do
not collide in the journal.

---

## 4. Apply review feedback and restart verification

**Developer story:** As the implementation owner, I need the coding agent to address review findings on
the same branch, then rerun the full review and test sequence. I want a hard limit so a disagreement does
not burn the entire budget.

**Done when:** a round ends with no blocking findings and all required checks pass, or the workflow stops
with the unresolved evidence after the configured number of rounds.

**Status:** No general remediation primitive is required. Normal bounded TypeScript control flow is
current; the workflow-owned workspace, callback phase syntax, and check-backed agent goal are proposed.

```ts
// The containing workflow declares its named branch with `workspace: ({ input }) => (...)`.
let reviewFindings: ReviewFinding[] = [];

for (let round = 1; round <= 3; round += 1) {
  const outcome = await ctx.phase(`Round ${round}`, async (roundCtx) => {
    const implementation = roundCtx.phase("Implementation");

    await implementation.agent({
      key: "implement",
      label: round === 1 ? "Implement feature" : "Address review findings",
      agent: implementationDeveloper,
      input: { work: input, reviewFindings },
      write: { paths: input.allowedPaths, mode: "strict" },
      goal: {
        definition: deliveryGoal,
        input: { package: input.package },
      },
    });

    const review = await roundCtx.phase("Review").agent({
      key: "code-review",
      prompt: reviewCurrentBranchPrompt(input),
      schema: CodeReview,
    });

    return review.value.findings.filter((finding) => finding.blocking);
  });

  if (outcome.length === 0) return { status: "ready" as const, round };
  reviewFindings = outcome;
}

await ctx.note({
  kind: "risk",
  text: "Delivery stopped after three rework rounds",
  evidence: JSON.stringify(reviewFindings),
});
throw new Error("Review findings remain after three rounds");
```

`implementationDeveloper` owns executable verification through its goal. Failed checks continue its same
session and never escape as a successful implementation result. The outer loop exists only for the
separate review cycle: a reviewer returns semantic findings, then the workflow starts the next named
implementation round with those findings.

Review cannot run on a generation whose goal check fails because the implementation call has not resolved.
A review-driven edit starts a new agent step and invalidates the prior generation's goal verdict. Only a
round whose current implementation goal and subsequent review both pass is ready to land.

The effective step identity includes structural scope:

```text
Round 1:Implementation:implement
  goal attempt 1:quality:test (fail)
  goal attempt 2:quality:test (pass)
Round 1:Review:code-review
Round 2:Implementation:implement
…
```

That is why retrying one step reuses its own durable result while the next remediation round remains a new
decision. Nested phases are visible in the run tree, not merely cosmetic log messages.

---

## 5. Migrate many independent files without collisions

**Developer story:** As the engineer leading an API migration, I need agents to update many independent
packages concurrently, validate each edit's scope, and integrate successful patches in a predictable
order.

**Done when:** every required package is migrated, each patch names the files it changed, and integration
conflicts are either resolved visibly or fail the run.

**Status:** Mixed — parallel patch production and integration are current. The managed composition
workspace, workspace-scoped checks, direct recipe passing, automatic nested namespaces, and explicit named
resolver policies are proposed.

```ts
const PackageInput = z.object({
  name: z.string(),
  paths: z.array(z.string()),
});

const Patch = z.object({
  ref: z.string(),
  key: z.string(),
  files: z.array(z.string()),
  quarantined: z.boolean().optional(),
  outOfScope: z.array(z.string()).optional(),
});

const migrationGuide = await ctx.fs.read("docs/client-v2-migration.md");
const discovered = await ctx.fs.glob("packages/*/src/**/*.{ts,tsx}");
const lockfile = await ctx.fs.stat("pnpm-lock.yaml");

if (!lockfile.exists) throw new Error("Expected a pnpm workspace lockfile");

const migratePackage = defineRecipe({
  name: "migrate-package",
  input: PackageInput,
  output: z.object({
    package: z.string(),
    patch: Patch,
    files: z.array(z.string()),
  }),
  run: async (ctx, pkg) => {
    const migrated = await ctx.agent({
      key: "edit",
      prompt: `Migrate ${pkg.name} to the new client API and update its tests.`,
      schema: z.object({ summary: z.string() }),
      write: {
        paths: pkg.paths,
        also: ["pnpm-lock.yaml"],
        mode: "strict",
      },
    });

    return {
      package: pkg.name,
      patch: migrated.patch,
      files: migrated.files,
    };
  },
});

const inputs = packages.map((pkg) => ({
  name: pkg.name,
  paths: [`packages/${pkg.name}/**`],
}));

const settled = await ctx.parallel(inputs, migratePackage, {
  key: "migrate",
  keyOf: (pkg) => pkg.name,
  concurrency: 3,
  errors: "settle",
});

const migrated = input.allowPartial
  ? ctx.successes(settled)
  : ctx.all(settled);

const migrationGoal = defineGoal({
  name: "migration-quality",
  check: migrationQuality,
  defaults: { attempts: 2 },
});

const composed = await ctx.workspace.with(
  {
    key: "compose:client-v2",
    from: "integration",
  },
  async (candidate) => {
    await candidate.apply(
      migrated.map((result) => result.patch),
      {
        order: "sequential",
        onConflict: {
          resolver: migrationConflictResolver,
          context: {
            migration: "client-v2",
            guideSha256: migrationGuide.sha256,
          },
          attempts: 1,
          fallback: "ask",
        },
      },
    );

    const goalInput = {
      packages: migrated.map((result) => result.package),
    };
    const quality = await candidate.check(
      migrationQuality,
      goalInput,
      { keyPrefix: "quality:initial" },
    );

    if (!quality.passed) {
      await candidate.agent({
        key: "repair",
        agent: migrationReworkDeveloper,
        input: {
          migration: "client-v2",
          checkFailure: quality.results,
        },
        write: { paths: migrationPaths, mode: "strict" },
        goal: {
          definition: migrationGoal,
          input: goalInput,
        },
      });
    }

    return candidate.capture({ paths: migrationPaths });
  },
);

// Promote only the composite generation that passed. If the integration base moved,
// discard it and rebuild the composition transaction against the new base.
await ctx.integrate([composed], { order: "sequential", onConflict: "fail" });
```

`ctx.fs.read` returns content plus a hash and byte size; `glob` returns repository-relative paths; `stat`
makes existence and type checks explicit. These are journaled observations. Edits still go through a
writable agent or managed workspace so change ownership remains visible.

`migrationConflictResolver` is a named read/resolve role with an explicit provider, model, and prompt. It
is a new session—not whichever provider happens to be the workflow default. The engine supplies the two
patch intents, conflicted paths, and tree identities, and grants strict direct writes only for the atomic
conflict transaction. Marker and repository-state validation remain engine-owned.

`migrationReworkDeveloper` owns a different failure class: the patches composed successfully, but their
combined tree failed deterministic checks. An initial standalone check avoids invoking an agent when the
composition is already valid. On failure, its evidence starts the named rework agent and the same suite
becomes that agent's completion goal. Package checks therefore run after the patches are applied to the
disposable composition workspace but **before** the composite patch is captured or promoted.

This resolver is appropriate when two otherwise independent mechanical patches overlap. If the conflict
reveals that a migration package was designed against obsolete semantics and needs broader edits, Weft
should restore the pre-apply tree, discard that patch, and rerun `migratePackage` sequentially from the
current integration state instead of silently expanding the resolver's write scope.

The final `ctx.integrate` is a narrow promotion boundary. A base-fingerprint mismatch is not sent to
`migrationReworkDeveloper` or the conflict resolver because neither owns an externally changed base. The
workflow discards the stale composite patch and repeats the whole composition-and-verification transaction
against the new integration tree, with a separate bound on those rebuilds.

`defineRecipe` is a schema-backed, transparent composition inside the current run: its nested agent and
check steps remain visible. It differs from `defineWorkflow`, which owns a separate run, journal, status,
budget boundary, and task contract. The deprecated TypeScript-only `defineStep` should be removed before a
stable DSL; schema-backed recipes cover the reusable-composition case.

Use `ctx.sequence` instead when packages must build on one another:

```ts
const migrated = await ctx.sequence(
  orderedPackages,
  { key: "migrate", keyOf: (pkg) => pkg.name },
  migratePackage,
);
```

Map values into the definition's input shape before parallelizing. Keep the callback form when a lane
needs branching or several steps:

```ts
await ctx.parallel(files, async (file) => {
  const source = await ctx.fs.read(file);
  return source.content.includes("legacyClient")
    ? ctx.recipe(migrateFile, { file })
    : { file, skipped: true };
});
```

---

## 6. Upgrade a dependency across a monorepo

**Developer story:** As a maintainer, I need to update one dependency and lockfile, then prove every
affected package passes its own lint, typecheck, and test commands.

**Done when:** command output is parsed into durable evidence, each package has independently visible
check results, and a required check cannot be weakened at the call site.

**Status:** Mixed — parameterized checks and suites are current. Definition-level operational defaults,
structured command parsers, managed candidate workspaces, and check-backed agent goals are proposed.

```ts
const packageManager = (await ctx.env.get("WEFT_PACKAGE_MANAGER")) ?? "pnpm";
if (packageManager !== "pnpm") throw new Error(`Unsupported package manager: ${packageManager}`);

const workspaceGraph = await ctx.bash("pnpm -r list --depth -1 --json", {
  key: "workspace-graph",
  schema: z.array(z.object({ name: z.string(), path: z.string() })),
});

const EslintOutput = z.array(z.object({
  filePath: z.string(),
  errorCount: z.number().int(),
  warningCount: z.number().int(),
}));

const lintCheck = defineCheck({
  name: "package-lint",
  revision: "eslint-json-v1",
  policy: "required",
  defaults: {
    timeout: "2m",
  },
  input: z.object({ package: z.string() }),
  command: ({ package: name }) => [
    "pnpm", "--filter", name, "eslint", "--format", "json", ".",
  ],
  parse: ({ stdout, stderr, exitCode }) => {
    const files = EslintOutput.parse(JSON.parse(stdout));
    const errors = files.reduce((sum, file) => sum + file.errorCount, 0);

    return {
      status: exitCode === 0 && errors === 0 ? "pass" : "fail",
      summary: `${errors} lint errors`,
      evidence: stderr || stdout,
      details: files
        .filter((file) => file.errorCount > 0)
        .map((file) => ({
          kind: "file" as const,
          path: file.filePath,
          message: `${file.errorCount} errors`,
        })),
    };
  },
});

const testCheck = defineCheck({
  name: "package-tests",
  policy: "required",
  input: z.object({
    package: z.string(),
    pattern: z.string().optional(),
  }),
  command: ({ package: name, pattern }) => [
    "pnpm", "--filter", name, "test", ...(pattern ? [pattern] : []),
  ],
});

const upgradeQuality = defineCheckSuite({
  name: "upgrade-quality",
  input: z.object({
    packages: z.array(z.object({
      name: z.string(),
      testPattern: z.string().optional(),
    })),
  }),
  checks: ({ packages }, use) => Object.fromEntries(
    packages.flatMap((pkg) => [
      [`${pkg.name}:lint`, use(lintCheck, { package: pkg.name })],
      [`${pkg.name}:tests`, use(testCheck, {
        package: pkg.name,
        pattern: pkg.testPattern,
      })],
    ]),
  ),
  concurrency: 4,
});

const upgradeGoal = defineGoal({
  name: "dependency-upgrade-complete",
  check: upgradeQuality,
  defaults: { attempts: 3 },
});

const upgradePatch = await ctx.workspace.with(
  {
    key: `upgrade:${input.dependency}`,
    from: "integration",
  },
  async (candidate) => {
    await candidate.agent({
      key: "implementation",
      agent: dependencyUpgradeDeveloper,
      input: {
        dependency: input.dependency,
        targetVersion: input.targetVersion,
        affectedPackages,
      },
      write: {
        paths: ["package.json", "packages/**/package.json", "pnpm-lock.yaml"],
        mode: "strict",
      },
      goal: {
        definition: upgradeGoal,
        input: { packages: affectedPackages },
      },
    });

    return candidate.capture({
      paths: ["package.json", "packages/**/package.json", "pnpm-lock.yaml"],
    });
  },
);

await ctx.integrate([upgradePatch], { order: "sequential", onConflict: "fail" });
```

The parameterized `upgradeQuality` suite expands the affected packages into independently named lint and
test members. Those names remain visible under every goal attempt, while `concurrency` bounds command load.

Definition defaults prevent repeated timeout boilerplate. Invocation options may strengthen an advisory
check to required and may adjust operational limits, but may not weaken a required policy. A parser can
turn JSON, JUnit, SARIF, or a domain-specific command format into a uniform check result. Parsing failure
is a check execution failure, not a pass inferred from a friendly-looking log line.

Here `dependencyUpgradeDeveloper` owns the suite as a completion goal. A failed member continues that same
session with package-specific evidence, and all members are evaluated again against the new generation. A
verification-only workflow could invoke `upgradeQuality` standalone and stop with its report; attaching it
to the agent is what turns the same deterministic suite into a remediation gate.

Prefer `ctx.exec(program, args)` when no shell grammar is needed. Use `ctx.bash(command)` for an intentional
shell expression. `ctx.env.get` is a journaled non-secret configuration read; credentials use
`ctx.secret`, as shown in the release story.

---

## 7. Diagnose flaky CI without losing the investigation

**Developer story:** As the engineer investigating a flaky pipeline, I need to collect the failing run,
wait for reruns, compare evidence, and pause for hours without keeping a Node process alive.

**Done when:** the report records which CI attempts were observed, what changed between them, and whether
the failure was reproduced or classified. Resume must preserve the original deadline and prior responses.

**Status:** Current with a bounded `fetch` + `sleep` loop; `ctx.poll` is a proposed local-friendly
primitive. Push signals are current when an embedding host can deliver them.

```ts
const CiRun = z.object({
  id: z.string(),
  status: z.enum(["queued", "running", "passed", "failed"]),
  attempt: z.number().int(),
  commit: z.string().optional(),
  logUrl: z.string().url().optional(),
});

const terminal = await ctx.poll({
  key: `ci:${input.runId}`,
  every: "30s",
  timeout: "2h",
  schema: CiRun,
  check: async () => {
    const run = await ctx.fetch(`${input.ciBase}/runs/${input.runId}`, {
      key: "status",
      schema: CiRun,
    });
    return run.status === "passed" || run.status === "failed" ? run : null;
  },
});

const diagnosis = await ctx.agent({
  key: "diagnose",
  prompt: flakyCiPrompt(terminal),
  schema: z.object({
    classification: z.enum(["product", "test", "infrastructure", "unknown"]),
    evidence: z.array(z.string()),
    nextExperiment: z.string(),
  }),
});

const suspectedOwner = await ctx.agent({
  key: "suggest-owner",
  prompt: `Suggest an owner for ${diagnosis.value.classification} using CODEOWNERS.`,
  schema: z.object({ team: z.string(), reason: z.string() }),
  onError: "null",
});

await ctx.note({
  kind: "claim",
  text: `CI failure classified as ${diagnosis.value.classification}`,
  evidence: diagnosis.value.evidence.join("\n"),
});
```

`onError: "null"` is appropriate here because owner suggestion is optional enrichment; its type is
`AgentResult<T> | null`, forcing the caller to handle absence. Do not use it for reproduction, required
verification, or release authorization—those failures should stop the workflow.

Today, write the poll as an explicit bounded loop:

```ts
const deadline = (await ctx.now()) + 2 * 60 * 60 * 1_000;
let terminal: z.infer<typeof CiRun> | null = null;

for (let attempt = 1; attempt <= 240; attempt += 1) {
  const run = await ctx.fetch(`${input.ciBase}/runs/${input.runId}`, {
    key: `ci:${input.runId}:attempt:${attempt}`,
    schema: CiRun,
  });

  if (run.status === "passed" || run.status === "failed") {
    terminal = run;
    break;
  }

  if ((await ctx.now()) >= deadline) throw new Error("CI wait timed out");
  await ctx.sleep("30s");
}
```

`ctx.poll` should journal the deadline, attempt results, and next wake time. Its callback returns a typed
value to finish, `null` to sleep and retry, or throws to fail. It fits local Weft better than requiring an
external SaaS to call a localhost webhook.

When a connected host can deliver events, a push signal is simpler:

```ts
const completed = await ctx.signal(`ci.completed:${input.runId}`, CiRun, {
  timeout: "2h",
});
```

Signals are schema-validated, journaled, and buffered if they arrive before the wait. One wait consumes
one occurrence. The host—not arbitrary workflow code—provides the transport into the local engine.

Use `ctx.now()`, `ctx.random()`, and `ctx.uuid()` instead of ambient nondeterministic globals. Their values
are journaled so replay observes the same decision inputs.

---

## 8. Delegate a security audit with an independent budget

**Developer story:** As a tech lead, I need a specialist security workflow to inspect the proposed change
without giving it the parent workflow's full token budget, provider defaults, or task authority.

**Done when:** the parent receives a schema-valid audit result, the child remains independently inspectable,
and its spending and task writes cannot exceed the declared boundary.

**Status:** Current child workflows, scopes, budgets, provider routing, and task contracts; provider object
shape is proposed.

```ts
const SecurityTaskContract = defineTaskContract({
  schema: z.object({
    cwe: z.string().optional(),
    affectedSymbol: z.string().optional(),
  }),
  revision: "security-finding-v1",
  version: 1,
  agentAccess: "write",
});

export const securityAudit = defineWorkflow(
  {
    id: "security-audit",
    description: "Audit a branch for exploitable security defects",
    input: z.object({ base: z.string(), head: z.string() }),
    output: z.object({ findings: z.array(SecurityFinding) }),
    tasks: SecurityTaskContract,
  },
  async (ctx, input) => {
    const restricted = ctx.scope({
      agent: {
        provider: {
          id: "codex",
          model: "gpt-5.6-sol",
          effort: "high",
          options: { sandboxMode: "read-only", networkAccess: false },
        },
      },
      tasks: { mode: "write", limit: 20 },
      parallel: { concurrency: 2, errors: "throw" },
    });

    const audit = await restricted.agent({
      key: "audit",
      prompt: securityPrompt(input),
      schema: z.object({ findings: z.array(SecurityFinding) }),
      tasks: { mode: "write", limit: 10 },
    });

    return audit.value;
  },
);

const security = await ctx.workflow(
  securityAudit,
  { base: input.base, head: featureCommit.sha },
  {
    key: "security-audit",
    label: "Independent security audit",
    budget: { tokens: 80_000, usd: 12 },
  },
);
```

`ctx.scope` applies inherited defaults without hiding child effects. Explicit call options win, but a
nested scope cannot manufacture capabilities forbidden by the workflow or host.

A recipe and a child workflow solve different reuse problems:

| Need | Use | Runtime boundary |
|---|---|---|
| Reuse orchestration inside the current delivery | `defineRecipe` + `ctx.recipe` | same run and journal |
| Delegate a durable unit with separate ownership | `defineWorkflow` + `ctx.workflow` | child run, journal, status, budget, tasks |

The child workflow uses its own task IDs, extension schema, and namespace. It does not inherit the parent's
delivery-task contract. Cross-workflow task access should require an explicit future import/delegation
contract, never implicit structural compatibility.

`ctx.budget.spent` and `ctx.budget.remaining` let orchestration choose a cheaper path or stop early. The
engine still enforces the hard ceiling before paid work and rolls child usage into the parent budget.

---

## 9. Maintain engineering work across runs

**Developer story:** As an engineering manager, I need recurring workflow runs to converge on the same
ticket, preserve typed delivery metadata, and update acceptance criteria without racing another run.

**Done when:** the task has one stable logical identity across runs, every mutation is journaled, and an
update made from stale task state fails instead of overwriting newer work.

**Status:** Current.

```ts
const DeliveryTaskContract = defineTaskContract({
  schema: z.object({
    ticketKey: z.string(),
    branch: z.string().nullable(),
    prUrl: z.string().url().nullable(),
    ownerTeam: z.string(),
  }),
  revision: "delivery-task-v1",
  version: 1,
  agentAccess: "write",
});

export const deliverTicket = defineWorkflow(
  {
    id: "deliver-ticket",
    description: "Deliver one engineering ticket",
    input: TicketInput,
    output: DeliveryOutput,
    tasks: DeliveryTaskContract,
  },
  async (ctx, ticket) => {
    await ctx.tasks.upsert({
      key: `task:${ticket.key}:intake`,
      dedupeKey: `tracker:${ticket.key}`,
      set: {
        title: ticket.title,
        description: ticket.description,
        status: "in_progress",
        priority: ticket.priority,
        tags: [ticket.type],
        relatedFiles: ticket.relatedFiles,
        acceptanceCriteria: ticket.acceptanceCriteria,
        extensions: {
          ticketKey: ticket.key,
          branch: null,
          prUrl: null,
          ownerTeam: ticket.ownerTeam,
        },
      },
    });

    const snapshot = await ctx.tasks.observe(
      { dedupeKeys: [`tracker:${ticket.key}`], limit: 1 },
      { key: `task:${ticket.key}:before-build` },
    );
    const task = snapshot.tasks[0];
    if (!task) throw new Error(`Task for ${ticket.key} was not found after upsert`);
    if (!task.extensions) throw new Error(`Task ${task.id} has no delivery extensions`);

    const delivered = await buildAndRelease(ctx, ticket);

    await ctx.tasks.update(
      task.id,
      {
        status: "done",
        ifRevision: task.revision,
        extensions: {
          ...task.extensions,
          branch: delivered.branch,
          prUrl: delivered.prUrl,
        },
      },
      { key: `task:${ticket.key}:complete` },
    );

    await ctx.tasks.note(
      task.id,
      `Delivered by run ${ctx.run.id}`,
      { key: `task:${ticket.key}:note` },
    );

    for (const criterion of task.acceptanceCriteria) {
      await ctx.tasks.setCriterion(
        task.id,
        criterion.id,
        true,
        { key: `task:${ticket.key}:criterion:${criterion.id}` },
      );
    }

    return delivered;
  },
);
```

The two keys solve different problems:

- `dedupeKey` identifies the same logical task across many workflow runs.
- `key` identifies this particular journaled mutation inside one run.

`observe` is intentionally stronger than a live `get`: it records the task snapshot used for a durable
decision. After resume, the step sees the same snapshot rather than silently changing its reasoning because
another run updated the task. `snapshot` may be a clearer future name for this behavior.

Agent task access is bounded twice. The workflow contract declares the maximum, and each agent call can
narrow it further or disable it. Agents receive a bounded snapshot and return validated operations; they
do not edit task storage directly.

---

## 10. Review a design or plan with many comments

**Developer story:** As a staff engineer, I need to edit an implementation plan, leave several comments at
specific lines, attach supporting artifacts, and return one explicit approval decision.

**Done when:** file edits are protected from stale overwrites, every comment is structured and retained,
and the decision is separate from the document content.

**Status:** Current file/artifact review with one schema-backed answer; the single-envelope return,
structured comment UX, and schema-first custom views are proposed.

```ts
const ReviewComment = z.object({
  id: z.string(),
  path: z.string(),
  line: z.number().int().positive().optional(),
  quote: z.string().optional(),
  body: z.string(),
  severity: z.enum(["suggestion", "required"]),
});

const PlanReview = z.object({
  decision: z.enum(["approved", "changes-requested"]),
  summary: z.string(),
  comments: z.array(ReviewComment),
});

type HumanReviewResult<T> = {
  answer: T;
  reviewer: {
    id: string;
    displayName?: string;
  };
  subject:
    | {
        kind: "file";
        path: string;
        ref: string;
        beforeSha256: string;
        afterSha256: string;
        applied: boolean;
      }
    | {
        kind: "artifact";
        ref: string;
        sha256: string;
        applied: false;
      };
  submittedAt: string;
  waitedMs: number;
};

const reviewed = await ctx.human.review({
  key: `plan-review:${input.ticket}`,
  question: `Edit and review the delivery plan for ${input.ticket}`,
  subject: {
    kind: "file",
    path: `.weft/plans/${input.ticket}.md`,
    mode: "edit",
  },
  attachments: [
    {
      kind: "artifact",
      content: architectureAnalysis,
      mediaType: "text/markdown",
      label: "Architecture analysis",
    },
    {
      kind: "artifact",
      path: "artifacts/dependency-graph.svg",
      mediaType: "image/svg+xml",
      label: "Dependency graph",
    },
  ],
  schema: PlanReview,
});

if (reviewed.answer.decision !== "approved") {
  return { status: "needs-plan-rework", comments: reviewed.answer.comments };
}

reviewed.reviewer.id;          // attributable decision maker
reviewed.subject.afterSha256;  // exact reviewed file generation
reviewed.submittedAt;          // journaled completion time
```

The schema validates the review decision, summary, and comments—not the Markdown file. The file has its own
before/after content hashes and an applied flag. If its content changed after the person opened the review,
Weft must reject or reconcile the stale edit rather than overwrite it.

`human.review()` always returns `HumanReviewResult<T>`; there is no bare-answer mode and no
`human.review.detailed()`. A caller that only needs the decision reads `reviewed.answer`, while audit- or
artifact-aware code uses the same result's reviewer, subject hashes, application state, and timing. The
answer schema remains fully inferred as `T`.

For edit-only work, the proposed convenience does not invent a meaningless answer schema:

```ts
const edited = await ctx.human.editFile({
  key: `edit-release-notes:${input.release}`,
  path: "RELEASE_NOTES.md",
  question: "Edit the release notes and submit when finished",
});

edited.beforeSha256;
edited.afterSha256;
edited.applied;
```

A team can render the same contract as a purpose-built UI while keeping the host responsible for submit
and validation:

```tsx
export const PlanReviewView = defineUiView({
  id: "plan-review",
  revision: "v1",
  props: z.object({
    path: z.string(),
    markdown: z.string(),
    comments: z.array(ReviewComment),
  }),
  answer: PlanReview,
  component: PlanReviewPanel,
});

const reviewedWithUi = await ctx.human.review({
  key: `plan-review-ui:${input.ticket}`,
  question: `Edit and review the delivery plan for ${input.ticket}`,
  subject: {
    kind: "file",
    path: `.weft/plans/${input.ticket}.md`,
    mode: "edit",
  },
  schema: PlanReview,
  ui: {
    view: PlanReviewView,
    props: {
      path: `.weft/plans/${input.ticket}.md`,
      markdown: planMarkdown,
      comments: [],
    },
  },
});
```

Custom UI is presentation, not a second state machine. Props and answers are Zod-validated, the host chrome
submits the answer, and the journal remains authoritative. A `defineResultView` uses the same schema-first
shape for read-only completion output.

---

## 11. Release only after CI and human policy allow it

**Developer story:** As a release engineer working from a local machine, I need to wait for CI, inspect the
exact commit, request approval only when policy requires it, and deploy without exposing credentials in the
journal.

**Done when:** the deployed SHA equals the tested SHA, every authorization decision names who or what made
it, and secrets never enter workflow output.

**Status:** Current gates, secrets, Git, exec, human approval, and result views; local polling helper is
proposed.

```ts
export const ReleaseResultView = defineResultView({
  id: "release-result",
  revision: "v1",
  props: z.object({
    environment: z.string(),
    commit: z.string(),
    deploymentUrl: z.string().url(),
  }),
  component: ReleaseResultPanel,
});

const head = await ctx.git.head();

const ci = await ctx.poll({
  key: `release-ci:${head.sha}`,
  every: "20s",
  timeout: "90m",
  schema: CiRun,
  check: () => readCiForCommit(head.sha),
});

if (ci.status !== "passed" || ci.commit !== head.sha) {
  throw new Error(`CI did not pass for the release commit ${head.sha}`);
}

const gate = await ctx.gate({
  key: `deploy:${input.environment}`,
  action: `deploy:${input.environment}`,
  risk: input.environment === "production" ? "high" : "medium",
  detail: `Deploy ${head.sha} from ${ctx.run.id}`,
});

if (!gate.approved) {
  return {
    status: "denied" as const,
    reason: gate.note ?? "Deployment was not approved",
  };
}

const deployToken = ctx.secret("deployment-token");
const deployment = await ctx.exec("./scripts/deploy", [
  "--environment", input.environment,
  "--commit", head.sha,
], {
  key: "deploy",
  risk: "high",
  env: { DEPLOYMENT_TOKEN: deployToken },
  schema: DeploymentResult,
});

await ctx.ui.render({
  key: "release-result",
  view: ReleaseResultView,
  props: {
    environment: input.environment,
    commit: head.sha,
    deploymentUrl: deployment.url,
  },
});
```

A gate authorizes an action; it does not perform it. The host evaluates an action-specific policy first,
then the risk-tier default:

```text
action + risk
    ├─ matching action policy → auto / ask / deny
    └─ risk-tier fallback     → auto / ask / deny

ask → suspend → Workflow Manager, CLI, or embedding host submits a decision
auto or deny → policy records the decision immediately
```

The result reports `approved`, optional `note`, and `answeredBy: "human" | "policy" | "timeout"`.
Irreversible actions in ask mode require the generated confirmation token. Built-in Git writes and
commands with a risk declaration perform their own gate internally; an explicit preceding gate is useful
when the authorization covers a larger release transaction.

Use `ctx.human.approve` instead when the requirement is specifically “a person must approve,” regardless
of host policy.

```ts
const approval = await ctx.human.approve({
  key: `production-owner:${head.sha}`,
  action: "Release the tested commit to production",
  detail: `Commit ${head.sha}; CI run ${ci.id}`,
  timeout: "4h",
  onTimeout: "deny",
});

if (!approval.approved) throw new Error(approval.note ?? "Release owner denied deployment");
```

Secret values are opaque handles resolved at execution time. They must not be stringified into prompts,
notes, outputs, or journal records.

---

## 12. Test, resume, and operate the workflow itself

**Developer story:** As the engineer maintaining automation, I need fast tests without real model calls,
a way to answer suspended runs, and enough inspection to understand what will be reused on resume.

**Done when:** the test asserts the same durable structure operators see in production, and a resumed run
does not repeat completed paid or mutating work.

**Status:** Current.

### Test behavior without external providers

```ts
import { mock, runWorkflow } from "@techery/weft-testing";
import workflow from "../main.ts";

it("returns a verified bug-fix result", async () => {
  const run = await runWorkflow(workflow, {
    input: {
      ticket: "BUG-421",
      title: "Cart total rounds twice",
      reproduction: "A EUR cart rounds tax before summing line items",
      allowedPaths: ["src/cart.ts", "test/cart.test.ts"],
      testCommand: ["pnpm", "test", "cart-total"],
    },
    provider: mock()
      .on({ key: "build:BUG-421" }, () => ({
        summary: "Round once at presentation boundary",
        rootCause: "Tax was rounded per line and again at the cart boundary",
        redEvidence: "expected 10.01, received 10.00",
        greenEvidence: "1 test passed",
        testsAdded: ["test/cart.test.ts"],
      })),
    exec: {
      "pnpm test cart-total": { exitCode: 0, stdout: "1 test passed", stderr: "" },
    },
    git: {
      changedSince: [{ path: "src/cart.ts", status: "M" }],
    },
    signals: [],
    taskSeeds: [],
  });

  expect(run.output.summary).toContain("Round once");
  expect(run.journal).toContainEqual(expect.objectContaining({
    type: "step.completed",
    key: "build:BUG-421",
  }));
});
```

Test fixtures can supply provider results, Git state, commands, shell, fetches, environment, human answers,
signals, and task seeds. Assert outputs and journaled decisions; do not reduce workflow tests to prompt text
snapshots.

### Operate a suspended or completed run

```bash
weft workflow list
weft workflow inspect deliver-ticket --json
weft run deliver-ticket --args '{"ticket":"BUG-421"}'
weft status <run-id>
weft answer <run-id>
weft resume <run-id>
weft report <run-id>
weft replay <run-id>
weft ui
```

The registry exposes workflow input/output schemas and metadata before execution. Status shows the live run
tree, waiting reason, budget, tasks, checks, patches, and workspace recovery state. Report turns the journal
into durable evidence; replay reconstructs state without serving a completed step to the wrong call site.

### Why keys matter during resume

Every effectful call has a stable identity. Code around it may be refactored, but reusing a key for a
different semantic operation is a breaking workflow change. Structural namespaces let local definitions
use concise keys while retaining unambiguous effective identities:

```text
deliver:BUG-421:Round 2:Verification:quality:tests
```

`ctx.run` exposes the current run ID, working directory, base ref, and child depth. `ctx.log` is transient
operator narration. `ctx.note({ kind, text, evidence })` is durable report evidence for decisions, claims,
and risks.

---

## Choosing the right Weft shape for a new developer job

Start from the deliverable and ownership boundary:

| Question | If yes | Shape |
|---|---|---|
| Is this one read-only judgment? | review, classify, summarize | one schema-backed agent step |
| Is this one independent edit whose output is a diff? | isolated fix or migration shard | writable agent → patch → integrate/discard |
| Must several phases share files, dependencies, commits, and branch history? | feature/bug delivery to PR | workflow-owned branch workspace |
| Did a verified patch's base tree change before integration? | checkout ownership or resume invariant was broken | fail with `stale_base`; restart explicitly from a fresh owned base |
| Did independent mechanical patches overlap? | migration shards touched the same lines | named conflict resolver with strict paths and human fallback |
| Did a leased or remote branch change outside the run? | another actor moved workflow-owned Git state | fail closed or ask a human; never choose an automatic resolver |
| Are many items independent? | review files or migrate packages | `parallel` with stable item keys |
| Must each item build on the previous one? | ordered package upgrade | `sequence` |
| Does each item pass through several stages independently? | find → refute → classify | `pipeline` |
| Is the reused logic part of this run? | shared build/review routine | `defineRecipe` |
| Does it need separate lifecycle, budget, or tasks? | security audit or deployment | child `defineWorkflow` |
| Is the answer deterministic command evidence? | test, lint, policy scan | `defineCheck` / suite |
| Can a policy authorize it? | ordinary risk-based operation | `ctx.gate` |
| Must a person decide? | legal, production, plan sign-off | `ctx.human.*` |
| Will completion arrive later? | CI, deployment, external job | `poll` locally or `signal` through a host |

## Concept-to-work index

This index is the API map, but every entry points back to a developer job rather than standing alone.

| Weft concept | What it contributes | Story |
|---|---|---|
| `defineWorkflow` | Typed durable unit and registry boundary | Feature delivery, security audit, task delivery |
| Input/output Zod schemas | Reject invalid work requests and incomplete results | Bug fix, all child workflows |
| Stable `key` | Replay identity for an effect | Every story; especially rework and resume |
| `label` | Human-readable run-tree name | Bug fix, security audit |
| `prompt` / `definePrompt` | Inline or reusable model instruction | Bug fix, PR review |
| `defineAgent` | Reusable typed role with routing defaults | PR review |
| Provider object and options | Cross-vendor selection without flattening vendor settings | PR review, security audit |
| `ctx.agent` / `AgentResult<T>` | One result containing value, files, patch, usage, attempts, session ID, and goal verdict | Bug fix, review, migration, feature build |
| Strict `write` scope | Enforce intended edit boundary | Bug fix, feature delivery, migration |
| `ctx.integrate` / `discard` | Resolve patch ownership explicitly | Bug fix, migration |
| Exact-base integration guard | Bind a patch to `baseTree` and fail closed if the integration checkout drifted | Bug fix |
| Named conflict resolver | Make provider, prompt, context, attempts, and human fallback explicit for mechanical overlaps | Migration, upstream sync |
| Global worktree bootstrap | Make every engine-created worktree usable from one inspectable repository/host policy | Bug fix, feature delivery, migration, dependency upgrade |
| Managed isolated writer | Keep one agent worktree and toolchain through its goal attempts, then capture only an accepted patch | Bug fix |
| Managed candidate workspace | Apply edits, compose patches, and verify one disposable tree before promotion | Migration, dependency upgrade |
| Workflow `workspace` declaration | Run the entire workflow in a detached patch worktree or a named branch worktree | Feature delivery, rework |
| Nested `ctx.workspace.with` | Compose and verify patches in a disposable detached worktree | Migration, dependency upgrade |
| Existing-checkout lease | Safely use an unreconstructable local environment | Feature delivery fallback |
| `ctx.phase` | Nested run-tree structure and key namespace | Feature delivery, rework |
| `ctx.scope` | Inherited provider, task, and parallel defaults | Security audit |
| Normal `await`, `if`, bounded loop | Sequential, conditional, and repeated work | All stories; rework and CI polling |
| `ctx.sequence` | Ordered item traversal with stable item context | Monorepo verification |
| `ctx.parallel` | Bounded independent lanes | PR review, migration |
| `ctx.pipeline` | Independent multi-stage lanes | PR review |
| `ctx.all` | Required all-or-fail collection after settlement | PR review, migration |
| `ctx.successes` | Explicit tolerant collection with recorded drops | Optional migration |
| `defineRecipe` / `ctx.recipe` | Schema-backed transparent reuse in one run | Migration |
| `defineCheck` / `ctx.check` | Deterministic command or function evidence | Bug fix, dependency upgrade |
| `defineCheckSuite` | Parameterized group of independently visible checks | Dependency upgrade, release |
| Check defaults and `parse` | Reuse timeout policy and interpret structured command output | Dependency upgrade |
| Ordered multi-component agent goal | Run checks, then named agent reviews, then human reviews; continue the owning implementation agent from structured rejection evidence | Bug fix, feature delivery, dependency upgrade, plan approval |
| Generation-scoped check result | Bind evidence to the exact workspace tree that produced it and stale it after edits | Bug fix, rework, migration |
| Standalone check response | Route evidence without an owning agent to investigation, waiver, terminal report, or an explicitly named role | Migration, release |
| Promotion check gate | Prevent capture, commit, or push until the current generation satisfies required checks | Bug fix, feature delivery, migration |
| `ctx.human.ask` | Validated general human input | Feature intake variants |
| `ctx.human.approve` | Unconditionally human authorization | Production release |
| `ctx.human.review` / `HumanReviewResult<T>` | One review API returning the typed decision, reviewer identity, file/artifact edit metadata, comments, and timing | Plan review |
| `ctx.human.editFile` | Edit-only file interaction without fake decision schema | Release notes |
| `ctx.gate` | Policy or human authorization separated from execution | Push and release |
| `ctx.fs` | Journaled file reads, globs, and stats | Plans, migration discovery |
| `ctx.exec` / `ctx.bash` | Journaled process effects | Checks, PR creation, deployment |
| `ctx.fetch` | Journaled validated network reads | CI investigation |
| `ctx.env` / `ctx.secret` | Environment reads and opaque credentials | Release |
| `ctx.git` | Typed, journaled branch/diff/commit/push work | Feature, review, release |
| `defineTaskContract` | Workflow-specific typed work metadata | Delivery and security audit |
| `tasks.upsert` | Converge the same logical ticket across runs | Engineering work tracking |
| `tasks.observe` | Replay-stable decision snapshot | Engineering work tracking |
| `tasks.update` / `setCriterion` | Optimistic lifecycle and evidence updates | Engineering work tracking |
| `defineUiView` | Schema-backed interactive presentation | Plan review |
| `defineResultView` | Schema-backed completion presentation | Release |
| `ctx.signal` | Durable host-delivered event | Connected CI completion |
| proposed `ctx.poll` | Durable local polling with preserved deadline | CI and release |
| `ctx.sleep` | Durable wake-up without keeping the process alive | CI polling |
| `ctx.now/random/uuid` | Journaled deterministic replacements for globals | CI and generated identifiers |
| `onError: "null"` | Explicit optional failure producing `AgentResult<T> | null` | Best-effort enrichment only |
| `ctx.workflow` | Child durable run | Security audit |
| `ctx.budget` | Inspect and enforce token/USD ceilings | Security audit |
| `ctx.note` | Durable claim, decision, or risk evidence | Bug fix, CI, rework |
| `ctx.run` | Run identity, cwd, base, and depth | Task updates and release audit |
| `runWorkflow` | Deterministic workflow test harness | Automation maintenance |
| CLI and Workflow Manager | Discover, answer, inspect, resume, and report | Workflow operation |

## Intended API changes illustrated by the stories

These are the proposed DX changes used above, collected here for implementation planning:

1. Keep one agent API: accept one object in `ctx.agent({ key, label, prompt | agent, input, schema,
   provider, write, goal, ... })` and always return `AgentResult<T>`. Remove `ctx.agent.detailed` and the
   bare-`T` return form. `AgentResult<T>` contains `value`, `files`, usage, attempts, optional session ID,
   and an accepted goal verdict when declared. On a plain context, a call declaring `write` uses an
   isolated writer and returns `PatchAgentResult<T>` with a required patch. On a workspace-bound context,
   it writes through that context and returns `WorkspaceWriteAgentResult<T>` with no outstanding patch to
   integrate. Remove `.agent.inPlace`; the context determines the target. `onError: "null"` returns the
   corresponding result type or `null`.
2. Make `provider` a discriminated object containing `id`, shared `model`/`effort`, and typed vendor
   `options`. Keep workflow safety outside provider options.
3. Let `defineAgent` accept either a static prompt string or `definePrompt`.
4. Let `sequence` and `parallel` accept compatible agent/recipe definitions directly, and automatically
   namespace their local step keys under the item identity.
5. Remove deprecated `defineStep`; retain schema-backed `defineRecipe` for transparent composition.
6. Add definition-level check defaults and a structured `parse()` hook; invocation may override
   operational values but cannot weaken required policy.
7. Add `defineGoal` and `goal: { definition, input, ...overrides }` to agent invocation options. Support
   named `components: (input, use) => ({ ... })` with `use.check`, `use.agentReview`, and
   `use.humanReview` builders. Always execute component stages as programmatic checks, named read-only
   agent reviews, then human reviews; never request a later stage while an earlier one fails. Preserve
   `check`, `agentReview`, and `humanReview` as concise one-component aliases. A rejection continues the
   owning implementation agent and restarts evaluation from checks against its next workspace generation.
   Expose typed component-keyed `results`, attempt `history`, and aggregate evidence on `AgentResult`.
   Distinguish negative verdicts from execution errors and fail rather than falsely succeed when proposal
   limits expire. Implement a goal-backed agent as replayable nested attempt/component substeps, retaining
   its provider continuation and workspace checkpoint through human suspension and resume. Apply global
   worktree bootstrap before the first turn and capture an isolated writer's patch only after every goal
   component passes on the accepted generation.
8. Bind check results and required-failure state to a workspace generation/tree hash rather than the whole
   run. Mutations stale prior passes; failed older generations remain evidence but do not block a later
   passing generation. Make `capture`, commit, and push enforce the current generation's required checks.
9. Keep one `human.review({ ... })` API and always return `HumanReviewResult<T>` containing the typed
   answer, attributable reviewer, subject edit hashes/application state, and timing. Remove
   `human.review.detailed`, expand review to multiple structured comments and artifacts, and add edit-only
   `human.editFile`.
10. Type `defineUiView` and `defineResultView` with Zod props/answer schemas.
11. Unify isolated and durable write locations behind one internal workspace manager while keeping patch
   ownership and branch ownership explicit in the public API.
12. Replace the opaque `onConflict: "agent"` route across patch integration and upstream Git sync with an
    explicit resolver contract containing a named agent definition, journaled context, bounded attempts,
    and `ask`/`fail` fallback for controlled mechanical overlaps. Add `baseTree` to captured patches and
    make ordinary single-writer integration fail with `stale_base` before applying when the owned
    integration tree changed; do not automatically reinterpret verified intent against that unknown base.
13. Add a workflow-level `workspace` declaration. `workspace: true` creates a detached worktree whose
    successful final diff becomes a run patch artifact; a factory returning `{ branch, from? }` creates a
    workflow-owned branch worktree and requires a clean committed tree at success. Infer worktree and
    ownership semantics rather than exposing `strategy`, `checkout`, or `ownership` boilerplate. Retain
    `ctx.workspace.with({ key, from? }, callback)` only for nested detached patch candidates, and add a
    strictly leased existing-checkout fallback as a separate exceptional API. Workspace and phase
    contexts inherit the active write target, so their ordinary `ctx.agent({ write })` calls edit it
    directly; reject concurrent direct writers targeting the same workspace.
14. Extend `.weft/config.json` with one validated worktree-bootstrap policy that the internal workspace
    manager applies to every worktree it creates. Journal its resolved config, input fingerprints, command
    evidence, and completion; distinguish bootstrap failures from goal failures; expose no per-workflow
    preparation override.
15. Add callback phases for lexical nesting while preserving the current returned-context form.
16. Add `ctx.poll` for local-machine waits; keep `ctx.signal` for host-delivered events.

The unifying principle is simple: TypeScript expresses the work, schemas define trustworthy boundaries,
and every effect that matters goes through a durable context. The journal is what turns those ordinary
developer jobs into workflows that can pause, resume, explain themselves, and finish with evidence.
