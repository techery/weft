/**
 * `weft skill` — the document an agent should read before it writes or runs a workflow.
 * It is a portable Agent Skill: YAML frontmatter plus the whole authoring surface,
 * so the useful thing to do with it is redirect it somewhere an agent will find it
 * (`weft skill > .claude/skills/weft/SKILL.md`).
 *
 * Nothing but the document goes to stdout — no header, no "next:" hint — because every
 * line this command prints is a line of the file someone is piping it into. It is also the
 * one command that never opens the engine: the skill is what you read *before* there is a
 * `.weft/` to open.
 *
 * The content is a template literal, so every backtick in the markdown is escaped (`\``)
 * and every interpolation an example shows is written `\${…}` — same convention as the
 * scaffold templates in `new.ts`.
 */
import { Command } from "commander";
import { type CliIo, say } from "../io.ts";

export function skillCommand(io: CliIo): Command {
  return new Command("skill")
    .description("print the agent skill for authoring and running weft workflows")
    .addHelpText(
      "after",
      [
        "",
        "The output is a SKILL.md — frontmatter included — so put it where an agent reads:",
        "  weft skill > .agents/skills/weft/SKILL.md  # Codex (repository skill)",
        "  weft skill > .claude/skills/weft/SKILL.md",
        "  weft skill | pbcopy",
      ].join("\n"),
    )
    .action(() => {
      say(io, ...SKILL_MD.split("\n"));
    });
}

/**
 * Static on purpose. This describes the engine's contract, not this repo's contents —
 * `weft ls`, `weft check` and the UI are what report the latter, and a skill that changed
 * shape with the working directory could not be checked into one.
 */
const SKILL_MD = `---
name: weft
description: >-
  Author, check, run, resume, replay, test, and diagnose durable Weft workflows written
  in TypeScript. Use for repositories with Weft workflow source, the \`weft\` CLI, or
  \`@techery/weft-*\` packages; do not use for generic one-session agent delegation.
---

# Weft

A workflow is an ordinary TypeScript program. \`await\` is a sequential edge, \`ctx.sequence\`
walks stable keyed items in order, \`ctx.parallel\` fans out and joins, \`ctx.pipeline\` runs
independent lanes, and \`if\` on a typed field is a conditional edge. Use ordinary TypeScript
loops, but give them an explicit bound or a journaled stopping condition. There is no graph
DSL to keep in sync.

Everything that leaves the sandbox is a **step**: the engine executes it, appends the
outcome to an append-only journal, and hands your code a schema-validated value. Resume
re-executes the program from the top and serves completed steps out of the journal — so a
run survives a crash, a reboot, or an overnight wait on a person, and picks up where it
stopped.

Two things break workflows more often than everything else combined. Read
[Determinism](#determinism) and [Keys and replay](#keys-and-replay) before writing code.

## Establish what is actually available

Treat source, registration, and tests as implementation evidence; treat README and design
documents as explanations that can lag. This checkout currently labels Weft a design preview
and says its packages are not published to npm. Use \`node packages/cli/bin/weft.js …\` in a
Weft checkout, or a locally linked \`weft …\`. Use \`npx @techery/weft\` or
\`@techery/weft-mcp\` only after independently confirming that the required package/version
is published and installed.

Keep claims proportional to evidence:

- \`weft check\`, a typecheck, and unit tests prove only those static or fixture-backed checks.
- A completed local run and its journal/report prove that run, not package publication or a
  deployed host.
- Claim provider, daemon, browser, or custom-view behavior only after exercising that path.
- Keep roadmap/design claims labelled as such; never present them as current runtime behavior.

## Choose the authoring surface

Weft has two related TypeScript surfaces. Identify which package the task targets before
copying syntax:

| Surface | Status | Use it for |
| --- | --- | --- |
| \`@techery/weft-sdk\` | Runnable in the current engine | Authoring workflows that \`weft check\`, \`weft run\`, tests, and the Workflow Manager execute |
| \`@techery/weft-dsl-proto\` | Declaration-only prototype in this checkout | Compile-time API design, type fixtures, and future-host contracts; it has no workflow engine or runtime exports |

The rest of this skill describes the runnable SDK unless a section is explicitly labelled
**DSL prototype**. Never copy prototype syntax into an SDK workflow and claim it runs. Never
rewrite SDK examples merely because the prototype has a smaller proposed API.

<!-- weft-dsl-proto-reference:start -->
### DSL prototype complete reference

The root package exports these authoring values. Builders declare inert reusable definitions;
the host starts durable work only when a workflow invokes the matching \`ctx\` call.

| Family | Public values | Consumed by |
| --- | --- | --- |
| Workflows | \`defineWorkflow\` | host entrypoint, \`ctx.workflow\`, or \`ctx.workflow.detailed\` |
| Agents | \`defineAgent\` | \`ctx.agent\` |
| Prompt definitions | \`definePrompt\` | the typed \`prompt\` field of \`defineAgent\` |
| Prompt helpers | \`prompt\`, \`prompt.section\`, \`prompt.json\`, \`renderPrompt\`, \`renderPromptDefinition\` | compose prompt parts or preview a prompt without starting durable work |
| Goals | \`defineGoal\`, \`bindGoal\` | the \`goal\` option of \`ctx.agent\` |
| Artifacts | \`defineArtifact\` | \`ctx.artifact\` |
| Checks | \`defineCheck\`, \`defineCheckSuite\` | \`ctx.check\` |
| Context sources | \`defineContextSource\` | \`ctx.context\` |
| Observers | \`defineObserver\` | \`ctx.observe\` or \`ctx.observe.detailed\` |
| Reviews | \`defineReview\` | \`ctx.review\` |
| Operations | \`defineOperation\`, \`withRecovery\` | \`ctx.operation\` |
| Deliveries | \`defineDelivery\` | \`ctx.delivery\` |
| Path policies | \`definePathPolicy\` | \`ctx.paths.resolve\` |
| Procedures | \`defineProcedure\` | \`ctx.procedure\` or \`ctx.procedure.detailed\` |
| Human UI | \`defineUiView\`, \`defineResultView\` | \`ctx.human.ask\`, \`ctx.human.review\`, and \`ctx.ui.render\` |
| Task state | \`defineTaskContract\` | the workflow's \`tasks\` metadata and \`ctx.tasks\` API |
| Admission | \`defineTrigger\` | host registration; admitted provenance is readable at \`ctx.run.trigger\` |

\`z\` is the package schema helper. The root is the package's only authoring entrypoint;
there is no second advanced workflow context or speculative testing subpath.

Define reusable agents at module scope, then execute them through the single \`ctx.agent\`
function:

\`\`\`ts
import { defineAgent, definePathPolicy, definePrompt, z } from "@techery/weft-dsl-proto";

const Issue = z.object({ title: z.string() });
const Plan = z.object({ summary: z.string(), paths: z.array(z.string()) });

const planner = defineAgent({
  name: "planner",
  prompt: definePrompt({
    name: "plan-issue",
    input: Issue,
    render: ({ title }) => \`Plan a minimal fix for: \${title}\`,
  }),
  schema: Plan,
});

const writePolicy = definePathPolicy({
  name: "source-writes",
  revision: "v1",
  roots: ["src"],
  grantTtl: "15m",
});
\`\`\`

The prototype uses one agent function. The options say what changes: \`write\` grants a bounded
edit, and \`failure: "return"\` makes failure a typed \`AgentOutcome\` instead of an exception.

\`\`\`ts
const plan = await ctx.agent(planner, issue, { key: "plan" });

const writeScope = await ctx.paths.resolve(
  writePolicy,
  { proposedPaths: plan.value.paths },
  { key: "write-paths" },
);

const implementation = await ctx.agent(
  {
    prompt: \`Implement: \${plan.value.summary}\`,
    schema: z.object({ summary: z.string() }),
  },
  { key: "implement", write: writeScope },
);

const optionalReview = await ctx.agent(
  {
    prompt: \`Review: \${implementation.value.summary}\`,
    schema: z.object({ approved: z.boolean() }),
  },
  { key: "optional-review", failure: "return" },
);
\`\`\`

Inputless definitions omit the input argument. One-off calls put \`{ prompt, schema }\` in the
definition position. There are no separate prototype \`agent.run\`, \`agent.write\`, or
\`agent.try\` methods.

The prototype has no step, stage, or phase abstraction. Plain functions and bounded
\`for...of\` loops handle same-run reuse and sequential traversal, while explicit effect keys
retain replay identity. \`ctx.scope(...)\` changes inherited agent, task, parallel, or budget
defaults; it does not organize keys or create workflow structure. \`ctx.parallel.all/settled\`
owns keyed fan-out because concurrency needs engine-controlled lane identity.

When a reusable helper deserves a name, schemas, and a place in a workflow view, promote it to
\`defineProcedure\` and call it through \`ctx.procedure\`:

\`\`\`ts
const redBaseline = defineProcedure({
  name: "red-baseline",
  revision: "v1",
  input: z.object({ testCommand: z.array(z.string()).min(1) }),
  output: z.object({ head: z.string(), redEvidence: z.string() }),
  run: async (ctx: Pick<WorkspaceCtx, "git" | "exec">, input) => {
    const [program = "npm", ...args] = input.testCommand;
    const head = await ctx.git.head({ key: "head" });
    const tests = await ctx.exec(program, args, { key: "tests" });
    return { head: head.sha, redEvidence: tests.stdout.slice(0, 400) };
  },
});

const baseline = await ctx.procedure(redBaseline, { testCommand }, { key: "baseline" });
\`\`\`

A procedure is durable rather than decorative: its validated output is recorded under one key so
replay returns the recorded result instead of re-entering the body, \`revision\` invalidates that
record when the body changes meaning, and its status and timing are recorded at the boundary.
Durable keys written inside the body are local to one invocation, so a named helper never threads
a caller-supplied key prefix through its signature. The \`run\` context parameter is annotated with
exactly the capabilities the body consumes, and that requirement is contravariant, so a body
needing \`Pick<WorkspaceCtx, "git">\` cannot be invoked from a read-only workflow context.

A procedure is not a child workflow. It shares the caller's run, workspace, budget, and
cancellation, so it mints no run identity, and for that reason its output must be
schema-expressible. Helpers that thread proofs, evidence refs, or snapshots stay plain functions
or become \`ctx.workflow\` children, because crossing a run boundary requires re-minted evidence.
A future phase would still need lifecycle semantics of its own to earn a place.

Workspace language follows the value's role:

\`\`\`ts
const candidate = ctx.workspace.snapshot;

const checks = await ctx.check(quality, {
  key: "quality",
  candidate,
});

const review = await ctx.review(candidateReview, reviewInput, {
  key: "review",
  candidate,
});

if (!checks.passed || review.status !== "accepted") {
  throw new Error("Candidate is not ready for delivery");
}

const receipt = await ctx.delivery(
  pullRequestDelivery,
  deliveryInput,
  {
    key: "deliver",
    candidate,
    proofs: [checks.proof, review.proof],
    authorization: { detail: "Publish the checked and reviewed candidate" },
  },
);
\`\`\`

\`snapshot\` means the current engine-minted workspace generation. \`candidate\` means that
exact snapshot is being checked, reviewed, captured, or delivered. Candidate-bound host
operations must atomically reject stale candidates and evidence from another candidate, so
ordinary prototype workflows do not call manual sameness or freshness assertions.
The future host performs those comparisons internally. Delivery bindings must also correlate
provider responses to the frozen request; provider output should contain new remote facts because
the receipt already carries candidate identity. A \`subject\` is simply the thing a human decision, observation, or
generic evidence record is about. That word remains useful for those APIs, but it is not the
ordinary workspace API name.

Prototype task contracts are intentionally run-scoped and small:

\`\`\`ts
const tasks = defineTaskContract({
  schema: TaskExtensions,
  agentAccess: "read",
});
\`\`\`

They expose no author-maintained task-contract version, revision, or migration chain. A task
row still has an engine-owned numeric revision for optimistic updates, and \`dedupeKey\` still
makes retried upserts converge. If an old run cannot resume with the exact workflow build that
created it, the future host must fail closed or restart it.

#### Complete ordinary \`ctx\` surface

These are all root-package calls and readable context properties. Every independently replayable
effect takes a stable \`key\`, including filesystem, process, network, wait, and randomness calls.

| Area | Complete surface | Meaning |
| --- | --- | --- |
| Definitions and children | \`ctx.agent\`, \`ctx.artifact\`, \`ctx.context\`, \`ctx.workflow\`, \`ctx.workflow.detailed\` | Run reusable definitions; \`detailed\` retains nominal child-run evidence |
| Fan-out | \`ctx.parallel.all\`, \`ctx.parallel.settled\` | Required fan-out or explicitly inspected failures |
| Named bodies | \`ctx.procedure\`, \`ctx.procedure.detailed\` | Run a named, revisioned, schema-validated body in this run; \`detailed\` reports digests and whether replay reused a recorded result |
| Inherited defaults | \`ctx.scope\` | Set inherited agent, task, parallel, or budget defaults without creating workflow structure or authority |
| Lane context | \`lane.itemKey\` | Stable per-item identity; durable calls through the lane use lane-local keys |
| Decisions and people | \`ctx.policy.decide\`, \`ctx.human.ask\`, \`ctx.human.confirm\`, \`ctx.human.review\`, \`ctx.human.editFile\` | Branching answers and human-authored input; none grants effect authority |
| Observation | \`ctx.observe\`, \`ctx.observe.detailed\` | Wait for an observer definition, optionally retaining provenance |
| Checks and reviews | \`ctx.check\`, \`ctx.check.authorizeWaiver\`, \`ctx.review\` | Run checks/reviews and mint an exact failed-check waiver |
| Protected effects | \`ctx.operation\`, \`ctx.delivery\`, \`ctx.paths.resolve\` | The definition selects direct/protected/recoverable operation behavior; delivery requires a verified candidate |
| Custom UI | \`ctx.ui.render\` | Render a result view; human input views attach to human calls |
| Filesystem | \`ctx.fs.read\`, \`ctx.fs.glob\`, \`ctx.fs.stat\` | Journaled repository reads |
| Process and network | \`ctx.exec\`, \`ctx.fetch\`, \`ctx.env.get\`, \`ctx.secret\` | Journaled process/network/config effects; secrets remain opaque handles |
| Git reads | \`ctx.git.status\`, \`ctx.git.head\`, \`ctx.git.branches\`, \`ctx.git.mergeBase\`, \`ctx.git.changedSince\`, \`ctx.git.diff\`, \`ctx.git.log\`, \`ctx.git.show\`, \`ctx.git.blame\`, \`ctx.git.fileAt\`, \`ctx.git.snapshot\`, \`ctx.git.compare\`, \`ctx.git.fetch\` | Available in read-only and writable workflow contexts |
| Git writes | \`ctx.git.add\`, \`ctx.git.commit\`, \`ctx.git.checkout\`, \`ctx.git.rebase\`, \`ctx.git.reset\`, \`ctx.git.apply\`, \`ctx.git.branch.create\`, \`ctx.git.branch.delete\`, \`ctx.git.stash.push\`, \`ctx.git.stash.pop\`, \`ctx.git.stash.drop\`, \`ctx.git.clean\` | Available only in \`WorkspaceCtx\` and candidate workspaces |
| Patch and report state | \`ctx.integrate\`, \`ctx.discard\`, \`ctx.note\` | Land/discard patch refs or retain durable evidence notes |
| Tasks | \`ctx.tasks.observe\`, \`ctx.tasks.upsert\`, \`ctx.tasks.update\`, \`ctx.tasks.note\`, \`ctx.tasks.setCriterion\` | Workflow-owned short-lived task context |
| Nested workspaces | \`ctx.workspace.with\` | Disposable candidate tree for direct mutation and patch capture |
| Active workspace identity | \`ctx.workspace.snapshot\`, \`ctx.workspace.id\`, \`ctx.workspace.path\`, \`ctx.workspace.branch\`, \`ctx.workspace.head\`, \`ctx.workspace.tree\`, \`ctx.workspace.generation\` | Present on \`WorkspaceCtx\`; read-only workflows expose only nested-workspace creation |
| Candidate callback | \`candidate.apply\`, \`candidate.capture\` | Compose patches in a candidate workspace and capture the result |
| Waiting | \`ctx.sleep\` | Durable timers; reusable observation belongs in \`defineObserver\` and \`ctx.observe\` |
| Cancellation | \`ctx.cancellation.signal\`, \`ctx.cancellation.reason\`, \`ctx.cancellation.throwIfRequested\` | Cooperate with, inspect, or throw the engine-owned cancellation decision |
| Journaled values | \`ctx.now\`, \`ctx.random\`, \`ctx.uuid\` | Replay-stable clock, random, and UUID values |
| Diagnostics | \`ctx.log\`, \`ctx.budget\`, \`ctx.run\` | Narration, budget view, and run/provenance metadata |

\`WorkflowCtx\` has read-only Git plus nested workspaces. \`WorkspaceCtx\` adds direct Git
mutation and active workspace identity. A candidate callback has the full \`WorkspaceCtx\`
surface plus \`candidate.apply\` and \`candidate.capture\`.

#### Restricted review context

A \`defineReview\` evaluator receives \`ReviewCtx\`, not full workflow authority:

| Area | Complete surface |
| --- | --- |
| Agent/context | \`reviewCtx.agent\`, \`reviewCtx.context\`, \`reviewCtx.observe\`, \`reviewCtx.observe.detailed\` |
| Fan-out | \`reviewCtx.parallel.all\`, \`reviewCtx.parallel.settled\` |
| Files | \`reviewCtx.fs.read\`, \`reviewCtx.fs.glob\`, \`reviewCtx.fs.stat\` |
| Git reads | \`reviewCtx.git.status\`, \`reviewCtx.git.head\`, \`reviewCtx.git.branches\`, \`reviewCtx.git.mergeBase\`, \`reviewCtx.git.changedSince\`, \`reviewCtx.git.diff\`, \`reviewCtx.git.log\`, \`reviewCtx.git.show\`, \`reviewCtx.git.blame\`, \`reviewCtx.git.fileAt\`, \`reviewCtx.git.snapshot\`, \`reviewCtx.git.compare\`, \`reviewCtx.git.fetch\` |
| Cancellation | \`reviewCtx.cancellation.signal\`, \`reviewCtx.cancellation.reason\`, \`reviewCtx.cancellation.throwIfRequested\` |
| Diagnostics | \`reviewCtx.log\`, \`reviewCtx.budget\`, \`reviewCtx.run\` |

It cannot mutate files, deliver, authorize operations, or write task state.

#### Complete callback contexts

A review fan-out callback receives a \`reviewLane\`. It has the same restricted capabilities
as \`reviewCtx\`, plus stable per-item identity:

| Area | Complete review-lane surface |
| --- | --- |
| Agent/context | \`reviewLane.agent\`, \`reviewLane.context\`, \`reviewLane.observe\`, \`reviewLane.observe.detailed\` |
| Nested fan-out | \`reviewLane.parallel.all\`, \`reviewLane.parallel.settled\` |
| Files | \`reviewLane.fs.read\`, \`reviewLane.fs.glob\`, \`reviewLane.fs.stat\` |
| Git reads | \`reviewLane.git.status\`, \`reviewLane.git.head\`, \`reviewLane.git.branches\`, \`reviewLane.git.mergeBase\`, \`reviewLane.git.changedSince\`, \`reviewLane.git.diff\`, \`reviewLane.git.log\`, \`reviewLane.git.show\`, \`reviewLane.git.blame\`, \`reviewLane.git.fileAt\`, \`reviewLane.git.snapshot\`, \`reviewLane.git.compare\`, \`reviewLane.git.fetch\` |
| Cancellation | \`reviewLane.cancellation.signal\`, \`reviewLane.cancellation.reason\`, \`reviewLane.cancellation.throwIfRequested\` |
| Identity and diagnostics | \`reviewLane.itemKey\`, \`reviewLane.log\`, \`reviewLane.budget\`, \`reviewLane.run\` |

Three builder callbacks receive deliberately tiny execution contexts rather than a workflow
\`ctx\`: an implemented operation gets \`operationCtx.signal\` and \`operationCtx.attempt\`;
an implemented polling observer gets \`observerCtx.signal\` and \`observerCtx.attempt\`; and a
function-backed check gets \`checkCtx.signal\`. They support cancellation and bounded-attempt
reporting, but cannot start nested effects.

<!-- weft-dsl-proto-reference:end -->

## Layout

\`\`\`text
.weft/
  config.json              # optional; defaults, providers, limits, approvalPolicy, workflows.dir
  workflows/<name>/        # one self-contained package; directory = workflow name
    main.ts                # the only registry entry point
    lib/                   # schemas and supporting TypeScript
    tests/                 # workflow-owned tests
    CHANGELOG.md           # workflow-owned release history
  tasks/<workflow>/<id>.json # durable context shared by a workflow's steps and runs
  blobs/<aa>/<hash>         # content-addressed patches, transcripts, and large outputs
  runs/<id>/
    journal.jsonl          # the truth — every step, request, answer, patch (secrets redacted)
    script.ts              # persisted provenance for inline workflows, when applicable
    workflow.json          # persisted path provenance, when applicable
    state.json             # projection: status, steps, scopes, checks
    tree.json              # projection: the live tree the UIs render
    report.md              # projection: outcome, changes, checks, ledger, remaining risk
\`\`\`

\`state.json\`, \`tree.json\`, and \`report.md\` are rebuildable journal projections; do not
hand-edit them. Preserve the journal, shared blobs, and persisted workflow/UI provenance
needed to resume inline or path-based runs.

## Author a workflow

\`weft new <name>\` uses the default \`review\` template and scaffolds
\`.weft/workflows/<name>/\` with \`main.ts\`, \`lib/\`, \`tests/\`, and \`CHANGELOG.md\`; it
already passes \`weft check\`. Choose the smallest supported
starting point explicitly when review fan-out is not the job:

- \`weft new <name> --template simple\` creates one typed agent step.
- \`weft new <name> --template review\` creates the default find/refute workflow and creates
  \`lib/schemas.ts\`.
- \`weft new <name> --template task\` creates a task-aware workflow using
  \`defineTaskContract\`.

No template overwrites an existing workflow package. Here is an independently
authored review workflow that also demonstrates defaults and typed task extensions:

### Workflow package contract

Treat the package boundary as part of the executable workflow contract:

- The directory basename is the callable registry name. Omit \`meta.name\`, or repeat the
  directory name exactly; a mismatch is rejected.
- \`main.ts\` is the only registry entry point. Put schemas and other implementation code
  under \`lib/\`; imports from \`main.ts\` are bundled and content-hashed with the workflow.
- Keep workflow-owned tests under \`tests/\`. With no pattern, \`weft test\` runs every
  \`.weft/workflows/*/tests/**/*.test.ts\` using Node's test runner. \`weft check\` also
  enforces Weft's fixed TypeScript and replay-safety lint rules over every workflow package;
  repository linter configuration does not change that contract. Use \`weft lint --fix\`
  only for a focused lint pass with safe automatic fixes.
- Record behavior and contract changes in the package's \`CHANGELOG.md\`.
- \`weft workflow list\`, \`weft check\`, and \`weft doctor\` fail closed on flat \`*.ts\`
  entries, missing required package members, or name mismatches.

To migrate a flat \`.weft/workflows/review.ts\`, create
\`.weft/workflows/review/{lib,tests}/\`, move the entry to \`review/main.ts\`, move supporting
modules under \`review/lib/\` and update relative imports, move its tests under
\`review/tests/\`, and add \`review/CHANGELOG.md\`. Then run \`weft check review\` and
\`weft test .weft/workflows/review/tests\`.

A repeatable \`--extra-workflow-dir\` may point to a registry root containing named packages
or directly to one complete package; run/task/config state still belongs to the primary
\`--cwd\`. A direct \`weft run ./path/to/file.ts\` is an ad-hoc path run, not a registered
workflow package, so do not use it as evidence that registry discovery accepts the layout.

\`\`\`ts
import { defineWorkflow, z } from "@techery/weft-sdk";
import { Finding } from "./lib/schemas.ts";      // explicit .ts extension, always

export default defineWorkflow(
  {
    id: "review",                                           // stable durable task namespace
    // \`name\` derives from the package directory — omit meta.name or repeat it exactly.
    description: "Review changed files; keep only findings that survive refutation",
    input: z.object({ base: z.string().default("main") }),   // becomes --base main
    output: z.object({ confirmed: z.array(Finding) }),       // validated on the way out
    defaults: { provider: "claude", effort: "high" },        // per-step opts still win
    tasks: {
      extensions: z.object({ ownerTeam: z.string() }),
      semanticRevision: "review-task-fields-v1",
    }, // optional typed task fields
  },
  async (ctx, { base }) => {
    ctx.phase("Scope");                                      // phases group steps in the tree
    const { files } = await ctx.git.changedSince(base);
    const paths = files.filter((f) => f.status !== "D").map((f) => f.path);

    ctx.phase("Find");
    const found = ctx.all(                                   // every lane must succeed
      await ctx.parallel(
        paths,
        (file) =>
          ctx.agent(\`Review \${file} for correctness bugs. Cite file:line.\`, {
            schema: z.object({ findings: z.array(Finding) }), // required on every agent step
            key: \`find:\${file}\`,                             // stable identity for replay
          }),
        { concurrency: 4, errors: "throw" },
      ),
    );

    const findings = found.flatMap((r) => r.findings);

    ctx.phase("Verify");
    const confirmed = ctx.all(
      await ctx.pipeline(findings)
        .step((finding) =>
          ctx.agent(
            \`Try to refute this finding: \${finding.claim} (\${finding.file}:\${finding.line})\`,
            {
              schema: z.object({ survives: z.boolean(), why: z.string() }),
              key: \`refute:\${finding.file}:\${finding.line}:\${finding.claim}\`,
            },
          ),
        )
        .filter((verdict) => verdict.survives)
        .map((_verdict, finding) => finding)
        .run({ concurrency: 4, errors: "throw" }),
    );

    ctx.phase("Report");
    return { confirmed };
  },
);
\`\`\`

\`schema\` is required on \`ctx.agent\`, \`ctx.human.ask/review\`, and the workflow's own
\`input\`/\`output\`; \`ctx.gate\` and \`ctx.human.approve\` have fixed result shapes. Invalid
model output is repaired in the same session with the validation errors fed back, not
thrown away. Zod is the default; any Standard Schema V1 library works.

### Reusable SDK agents

The runnable SDK also exports \`defineAgent\`. It is a top-level builder, not a \`ctx\` method:
\`defineAgent\` declares a reusable role and \`ctx.agent\` runs it. Unlike the prototype, the
SDK builder requires a prompt created with \`definePrompt\`, and a normal call returns the
validated value directly.

\`\`\`ts
import { defineAgent, definePrompt, z } from "@techery/weft-sdk";

const Issue = z.object({ title: z.string() });
const Plan = z.object({ summary: z.string() });

const planner = defineAgent({
  name: "planner",
  prompt: definePrompt({
    name: "plan-issue",
    input: Issue,
    render: ({ title }) => \`Plan a minimal fix for: \${title}\`,
  }),
  schema: Plan,
  defaults: { effort: "high" },
});

const plan = await ctx.agent(planner, { title: "Login fails" }, { key: "plan" });
// plan.summary is available directly. Use ctx.agent.detailed(...) for usage or patch metadata.
\`\`\`

## Determinism

Workflow code must be side-effect free on its own: every clock read, random draw, timer,
network call, and environment read goes through \`ctx\` so the engine can journal it and
serve it back on replay. The gate rejects the raw form at parse time with a fix-it, and the
sandbox replaces the globals so the computed form (\`globalThis["Da" + "te"]\`) fails too.

| Rejected in workflow code | Use instead |
| --- | --- |
| \`Date.now()\`, argless \`new Date()\` | \`await ctx.now()\` — \`new Date(value)\` is fine |
| \`Math.random()\` | \`await ctx.random()\`, \`await ctx.uuid()\` |
| \`setTimeout\` / \`setInterval\` / \`setImmediate\` | \`await ctx.sleep("10m")\` — a durable wait |
| global \`fetch()\` | \`ctx.fetch(url, { schema })\` |
| \`process.env\` | \`ctx.env.get(name)\`, \`ctx.secret(name)\` |
| \`require()\` | a relative import; helpers belong beside the workflow |
| \`WeakRef\`, \`FinalizationRegistry\` | nothing — GC timing is not replayable |
| \`toLocale*\`, \`localeCompare\`, \`Intl\` | \`toFixed\`, \`toISOString\`, an explicit comparator |
| bare imports beyond \`@techery/weft-sdk\` and \`zod\` | relative imports (bundled and hashed) |

There is no scope analysis: a local variable named \`fetch\` is still a finding. Rename it —
the false positive is cheaper than the miss. Extra bare imports go in \`.weft/config.json\`
under \`workflows.allowBare\`; \`@techery/weft-sdk\` is always allowed and cannot be removed.

Run \`weft check\` after every edit. Its gate bundles and instantiates workflow candidates
the way a run would, so gate, bundle, custom-UI compile, and banned-global errors fail before
provider work. It then attempts a standalone \`tsc --noEmit\` pass: an unavailable compiler
or SDK is a visible non-failing skip, but actionable TypeScript diagnostics fail the command.
Also run the repository's real typecheck and tests because the standalone pass synthesizes
flags instead of adopting the repository's full TypeScript and test configuration.

## Keys and replay

A step's identity is its **kind + payload + schema + \`key\`**. That is the whole cache key.

- The runtime enforces one shared explicit-key namespace for \`ctx.agent\`, \`ctx.workflow\`,
  \`ctx.exec\`/\`ctx.bash\`, and \`ctx.fetch\`. Reusing a key across those calls or kinds in
  one run fails with \`invalid_input\` before the second step dispatches.
- \`ctx.human.ask\`/\`approve\`/\`review\` keys are replay identities too, but human requests
  are not included in that duplicate-key guard. Keep them distinct from every other keyed
  call; do not rely on cross-kind rejection to catch a collision.
- Without a \`key\`, identity is content alone. The auto label (\`Find/agent#2\`) is cosmetic
  and identity ignores it — so two call sites that can produce the same prompt, schema and
  routing are indistinguishable on replay, and the engine **re-runs both** rather than
  guessing which journaled answer belongs to which.
- Give every fan-out call a distinct \`key\`. Derive it from the item
  (\`refute:\${f.file}:\${f.line}\`), not from a loop counter — an index shifts when the
  list ahead of it changes, and every step after the shift becomes a miss.
- Reordering steps is free. Rewording a prompt re-runs that step and whatever depended on
  it. A cache miss re-runs; it never serves a stale answer.
- \`--reuse content\` (the default) re-runs a step whose prompt or options moved.
  \`--reuse key\` keeps it by identity — fast iteration on the code around a settled step.
- \`weft replay --dry <run>\` prints hits / salvaged / diverged before a single provider call.
  Run it before a resume you are not sure about.
- The world is not in the key. What a step could *read* — the tree an agent greps — is not
  hashed. That is the trade edit-tolerant replay makes; do not rely on a resume noticing
  that the working tree moved under it.

## The \`ctx\` surface

Durations are \`"250ms"\`, \`"90s"\`, \`"10m"\`, \`"2h"\`, \`"7d"\`, or a number of milliseconds.

**Steps**

| Call | Returns |
| --- | --- |
| \`ctx.agent(prompt, { schema, key, label, provider, providerOptions, providerRequirements, model, effort, isolation, write, maxTurns, timeout, retry, repair, onMaxTurns, onError })\` | the validated value |
| \`ctx.agent(definition, input, { key, ...overrides })\` | the reusable \`defineAgent\` role's validated value |
| \`ctx.agent.detailed(prompt, opts)\` | \`{ value, usage, files, patch, attempts, sessionId }\` |
| \`ctx.agent.detailed(definition, input, opts)\` | the same detailed envelope for a reusable role |
| \`ctx.sequence(items, { key, keyOf, phase? }, run)\` | sequential results with one globally namespaced keyed scope per item |
| \`ctx.parallel(tasks, { errors })\` | eager/mixed tasks as \`Settled<T>[]\`; no concurrency cap |
| \`ctx.parallel(thunks, { concurrency, errors })\` | bounded thunk fan-out as \`Settled<T>[]\` |
| \`ctx.parallel(items, mapper, { concurrency, errors })\` | bounded mapper fan-out as \`Settled<T>[]\` |
| \`ctx.pipeline(items)\` | a lazy lane pipeline; no work starts until \`run\` |
| \`ctx.pipeline.step(fn)\` | transform each surviving lane asynchronously |
| \`ctx.pipeline.filter(fn)\` | drop lanes whose verdict is false |
| \`ctx.pipeline.map(fn)\` | map each surviving lane while retaining its original item |
| \`ctx.pipeline.run({ concurrency, errors })\` | execute the pipeline as \`Settled<T>[]\` |
| \`ctx.successes(settled)\` | \`T[]\` — tolerant; records dropped failures |
| \`ctx.all(settled)\` | \`T[]\` or throws the first failure after all lanes settle |
| \`ctx.workflow(def \\| name, input, { budget, key, label })\` | the child's output |

\`effort\` is \`low \\| medium \\| high \\| xhigh \\| max\`. The standard host wires
\`"claude"\` and \`"codex"\` (and a fail-loud \`"mock"\` fixture route); the SDK's
\`ProviderId\` also permits host-registered strings. \`onError: "null"\` resolves to \`T | null\`
instead of throwing \`StepError\`.

Provider mechanics are adapter-specific, so namespace them by provider. Weft selects and
validates only the routed provider's entry, and rejects unmet capability requirements before
creating a worktree or spending a provider turn:

\`\`\`ts
await ctx.agent("Review without editing files", {
  key: "review:auth",
  provider: "codex",
  providerOptions: {
    claude: { permissionMode: "dontAsk" },
    codex: { sandboxMode: "read-only", networkAccess: false, webSearch: "cached" },
  },
  providerRequirements: { structured: "native", sessionResume: true },
  schema: z.object({ findings: z.array(Finding) }),
});
\`\`\`

Built-in Claude options currently expose \`permissionMode: "default" | "dontAsk"\`.
Built-in Codex options expose \`sandboxMode\`, \`networkAccess\`, and \`webSearch\`.
Provider options may narrow execution, but never widen Weft's engine-owned edit boundary:
a read-only step stays read-only even if Codex requests \`workspace-write\`.

Use \`ctx.sequence\` when items intentionally share one workspace or another ordered resource.
It computes and checks every item key before the first callback runs; duplicate or invalid keys
fail without partial effects. Build nested step keys from the supplied scope rather than an
array index:

\`\`\`ts
const reviewed = await ctx.sequence(
  items,
  { key: "review", keyOf: (item) => item.id, phase: (item) => \`Review \${item.id}\` },
  (item, scope) =>
    scope.ctx.agent(\`Review \${item.path}\`, {
      key: scope.key("review"),
      schema: ReviewResult,
    }),
);
\`\`\`

\`errors: "settle"\` is the default; \`"throw"\` surfaces a failed lane after every lane has
settled. A concurrency cap works with mapper form or thunks, not promises that have already
started. Prefer \`ctx.pipeline\` over two \`ctx.parallel\` calls: a pipeline has no barrier
between stages, so lane A can be in stage 3 while lane B is still in stage 1. Reach for the
barrier only when a stage genuinely needs every prior result at once (dedup across all of
them, an early exit on a total count, a prompt that compares findings to each other).

**Reusable composition**

| Call | Returns |
| --- | --- |
| \`ctx.scope({ agent?, tasks?, parallel? })\` | an immutable derived context whose nested calls inherit those defaults |
| \`ctx.recipe(definition, input)\` | validated output from a schema-backed transparent recipe; nested effects stay visible |
| \`ctx.step(definition, input)\` | output from the legacy transparent step definition; deprecated in favor of \`ctx.recipe\` |

**Humans** — durable suspensions. The answer can arrive hours later, from another process.

| Call | Returns |
| --- | --- |
| \`ctx.gate({ action, risk, detail })\` | \`{ approved, note?, answeredBy: "human" \\| "policy" \\| "timeout" }\` |
| \`ctx.human.ask({ question, schema, detail, timeout, onTimeout })\` | the validated answer |
| \`ctx.human.approve({ action, detail, timeout, onTimeout })\` | \`{ approved, note? }\` |
| \`ctx.human.review({ artifact | subject, attachments?, question, schema, timeout, onTimeout })\` | the validated answer |
| \`ctx.human.review.detailed(opts)\` | answer plus immutable artifact metadata or file before/after hashes |

\`risk\` is \`low \\| medium \\| high \\| irreversible\`. By default, \`low\` auto-approves
and is still recorded; configured action-pattern or risk-tier approval policies can require
a human instead. \`onTimeout\` is \`"deny"\`, \`"escalate"\`, or \`{ default: <value> }\`.

A review subject is either an immutable artifact
(\`{ kind: "artifact", content, mediaType?, label? }\`) or an existing repository-relative
file (\`{ kind: "file", path, mode: "view" | "edit" }\`). Attachments are immutable artifacts.
In file edit mode, the Workflow Manager loads the journaled snapshot into a text editor and
submits the draft with its opening hash. The engine applies it atomically only when the file
still matches that revision; path traversal and symlink escapes outside the run cwd fail closed.
Use \`review.detailed\` when later workflow logic needs the accepted blob reference or hashes.

**Side effects**

| Call | Returns |
| --- | --- |
| \`ctx.fs.read(path)\` | \`{ content, sha256, size }\` |
| \`ctx.fs.glob(patterns, { cwd? })\` | sorted repository-relative \`{ paths }\` |
| \`ctx.fs.stat(path)\` | \`{ exists, size?, mtimeMs?, isFile?, isDirectory? }\` |
| \`ctx.exec(file, args, opts)\` | \`{ exitCode, stdout, stderr }\`; with \`schema\`, validated JSON stdout |
| \`ctx.bash(command, opts)\` | the same result and optional schema behavior through a shell command |
| \`ctx.fetch(url, init)\` | \`{ status, headers, body }\`; with \`{ schema }\`, a validated 2xx body |
| \`ctx.env.get(name)\` | a journaled environment value or \`undefined\` |
| \`ctx.secret(name)\` | an opaque handle resolved only inside an effect and journaled as \`<redacted>\` |

\`exec\`/\`bash\` take \`{ cwd, timeout, env, risk, key }\` — \`risk\` routes the call through the
approval gate.

**Git reads** — journaled without an approval gate.

| Call | Returns |
| --- | --- |
| \`ctx.git.status()\` | branch plus clean, staged, unstaged, and untracked paths |
| \`ctx.git.head()\` | \`{ sha }\` |
| \`ctx.git.branches()\` | \`{ current, all }\` |
| \`ctx.git.mergeBase(a, b)\` | \`{ sha }\` |
| \`ctx.git.changedSince(ref)\` | \`{ files: [{ path, status }] }\` |
| \`ctx.git.diff(range?)\` | \`{ patch, stats, ref? }\` |
| \`ctx.git.log({ from?, to?, paths?, max? })\` | \`{ commits }\` |
| \`ctx.git.show(ref)\` | \`{ content }\` |
| \`ctx.git.blame(path, { lines? })\` | structured blame lines |
| \`ctx.git.fileAt(ref, path)\` | \`{ content }\` from that revision |
| \`ctx.git.snapshot()\` | \`{ ref }\` for the current tree state |

**Git writes** — journaled and idempotency-checked on resume. Their fixed risk tier may be
raised with \`{ risk }\`, never lowered.

| Call | Returns |
| --- | --- |
| \`ctx.git.add({ paths, risk? })\` | void |
| \`ctx.git.commit({ message, paths?, risk? })\` | \`{ sha }\` |
| \`ctx.git.checkout(ref, { discard?, risk? })\` | void |
| \`ctx.git.fetch({ remote?, risk? })\` | void |
| \`ctx.git.pull({ rebase?, remote?, branch?, risk? })\` | void |
| \`ctx.git.push({ remote?, branch?, setUpstream?, force?, risk? })\` | void |
| \`ctx.git.reset({ to, mode?, risk? })\` | void |
| \`ctx.git.apply({ patch, threeWay?, risk? })\` | void |
| \`ctx.git.tag(name, { ref?, risk? })\` | \`{ sha }\` of the tagged commit |
| \`ctx.git.branch.create(name, { from?, checkout?, risk? })\` | void |
| \`ctx.git.branch.delete(name, { force?, risk? })\` | void |
| \`ctx.git.stash.push({ message?, risk? })\` | void |
| \`ctx.git.stash.pop({ risk? })\` | void |
| \`ctx.git.stash.drop({ risk? })\` | void |
| \`ctx.git.clean({ force?, risk? })\` | void |

**Checks, integration, ledger**

| Call | Returns |
| --- | --- |
| \`ctx.check(name, { exec \\| fn \\| trustPrior \\| skip, required, timeout })\` | \`{ status, evidence? }\` |
| \`ctx.check.exec(name, command, opts?)\` | legacy command-backed check result |
| \`ctx.check.fn(name, run, opts?)\` | legacy callback-backed check result |
| \`ctx.check.trust(name, prior, opts?)\` | legacy result trusted from a prior run |
| \`ctx.check.skip(name, reason, opts?)\` | legacy explicit skipped/waived result |
| \`ctx.check(defineCheck(…), input?, { key, policy, timeout, trust, waive })\` | run a reusable static or schema-backed check |
| \`ctx.check(defineCheckSuite(…), { keyPrefix, concurrency })\` | run reusable static checks; returns \`{ passed, results }\` while journaling each member |
| \`ctx.integrate(results, { order, onConflict })\` | \`{ merged, conflicts, quarantined, skipped }\` |
| \`ctx.discard(results)\` | void — the explicit "these patches are not landing" |
| \`ctx.note({ kind: "decision" \\| "claim" \\| "risk", text, evidence })\` | void; shows up in the report |

\`check\` status is \`pass \\| fail\`; \`disposition\` records \`executed \\| trusted \\| waived\`. A failing
\`policy: "required"\` check gates completion. The ledger's arrays hold **step keys**, not file paths.
Parameterized reusable checks declare \`input: z.object(…)\`; Weft infers the invocation type and validates it
before passing parsed input directly to \`run(input, { signal })\` or \`command(input)\`.

**Workflow tasks** — durable context shared by runs in the workflow's stable \`meta.id\`
namespace.

| Call | Returns |
| --- | --- |
| \`ctx.tasks.observe(selector, { key })\` | replay-stable \`{ total, truncated, tasks }\` snapshot |
| \`ctx.tasks.upsert({ dedupeKey, key, set, note? })\` | void; recurring create/update is atomic |
| \`ctx.tasks.update(id, patch, { key })\` | void |
| \`ctx.tasks.note(id, text, { key, ifRevision? })\` | void; appends context |
| \`ctx.tasks.setCriterion(id, criterionId, met, { key, ifRevision? })\` | void |

Workflows that configure \`meta.tasks\` give agent steps a bounded read-only task snapshot by
default. Set \`meta.tasks.agentAccess: "write"\` only when some agent step may mutate tasks, then
opt that particular step into \`tasks: { mode: "write" }\`; a step can narrow but never exceed the
workflow contract. Use \`tasks: false\` to omit context, or pass an explicit read selector such as
\`tasks: { mode: "read", statuses: ["blocked"] }\`.
The engine validates, journals, and applies structured
\`taskOperations\` idempotently only after a write-authorized step succeeds; in read mode that
array must be empty. Use workflow-owned \`ctx.tasks\` calls when the program, rather than the
provider, owns the lifecycle transition.

Task core fields remain engine-owned. Optional \`meta.tasks.extensions\` adds typed workflow
context and requires a stable \`semanticRevision\`; configuring tasks also requires a stable
\`meta.id\`. Write the fields directly or use
\`defineTaskContract({ schema, revision, version?, agentAccess?, migrate? })\`. Change the
semantic revision when validation,
defaults, transforms, refinements, or migration behavior changes. Increment
\`schemaVersion\` only when persisted representation changes, and supply
\`migrate(value, fromVersion)\` for older values. Keep \`meta.id\` stable across file/name
changes; recovery fails closed if the exact executable extension contract is unavailable.

**Custom workflow UI** — optional browser presentation, never workflow authority.

- Import a directly referenced \`.ui.tsx\` token. Define it with \`defineUiView\` (human input)
  or \`defineResultView\` (read-only output) from \`@techery/weft-sdk/ui\`.
- Publish a display view with \`await ctx.ui.render({ key, slot?, view, props })\`; attach an
  input view with \`ctx.human.ask({ key, question, schema, ui: { view, props } })\`.
- Props must be bounded JSON. An input component can only \`propose(answer)\`; host-owned
  controls validate and submit it. The standard form/raw result remains the fallback.
- Browser assets have their own compile/import policy. A source check proves compilation,
  not that the frame painted or accepted a candidate; verify the daemon/browser path when
  making a UI claim.

**Waits, journaled globals, structure**

| Call or property | Meaning |
| --- | --- |
| \`ctx.signal(name, schema, { timeout? })\` | park until an external validated payload arrives |
| \`ctx.sleep(duration)\` | durable wait; the process may exit and resume later |
| \`ctx.now()\` | journaled epoch milliseconds |
| \`ctx.random()\` | journaled random number |
| \`ctx.uuid()\` | journaled UUID |
| \`ctx.phase(name)\` | announce a phase and return an immutable context bound to it |
| \`ctx.log(message)\` | add workflow narration to the run |
| \`ctx.budget\` | \`{ spent, remaining }\`; \`null\` means unlimited on that remaining axis |
| \`ctx.run\` | \`{ id, cwd, baseRef?, depth }\` |

## Write steps

A write step does not mutate the tree. Declaring \`write:\` makes the step a write step: it
gets its own git worktree, its diff is captured as a patch blob, out-of-scope files are
flagged, and **nothing lands until \`ctx.integrate()\`**.

Do not model a shared-checkout implementation/review loop by omitting \`write\`: omission makes
the provider read-only. Weft currently has no public durable in-place workspace lease, and the
\`sessionId\` returned by \`agent.detailed\` is diagnostic metadata rather than a cross-step
continuation handle. For implementation followed by independent review, use a patch-first
boundary: run the writer with declared \`write\`, inspect/integrate its patch, then review the
integrated tree. A later repair is another explicitly scoped write step.

\`\`\`ts
const fixes = ctx.all(
  await ctx.parallel(
    bugs,
    (bug) =>
      ctx.agent.detailed(\`Fix and add a focused test: \${bug.claim} (\${bug.file}:\${bug.line})\`, {
        schema: FixResult,
        isolation: "worktree",
        write: { paths: [bug.file, "**/*.test.ts"], also: ["pnpm-lock.yaml"], mode: "warn" },
        key: \`fix:\${bug.file}\`,
      }),
    { concurrency: 4, errors: "throw" },
  ),
);
const ledger = await ctx.integrate(fixes, { order: "sequential", onConflict: "ask" });
const merged = new Set(ledger.merged);        // step keys: "fix:src/auth.ts"
\`\`\`

Use \`ctx.agent.detailed\` for write steps — the plain form returns only the value, and
\`integrate\` needs the result (or its \`PatchRef\`). \`mode: "warn"\` lands the patch and flags
the out-of-scope files in the report; \`"strict"\` quarantines the patch instead. \`also\`
covers incidental files like lockfiles. **A run that ends with un-integrated patches
fails** — integrate them or \`ctx.discard\` them.

## Budget and sub-workflows

Tokens and USD come from real provider usage and enforce hard ceilings shared with
sub-workflows. \`weft run --budget "500k,$5"\`; a child takes \`{ budget: { fraction: 0.3 } }\`
or an absolute slice, and the call that would overrun is refused rather than truncated.
\`ctx.workflow(def, input)\` is typed from the definition. A directly supplied child
definition must declare a stable \`meta.id\` or \`meta.name\`; prefer \`meta.id\` for replay
identity. \`ctx.workflow("name", input)\` resolves through the registry and returns \`unknown\`
— prefer the definition when it has that stable identity.

## Stdlib patterns

\`@techery/weft-stdlib\` holds patterns worth not rewriting. Each takes \`ctx\` first, spawns
ordinary keyed steps, and returns plain typed data — nothing is engine-privileged, so they
replay and inspect exactly like hand-written code.

| Function | What it does |
| --- | --- |
| \`adversarialVerify(ctx, { claims, describe, refuters, keyFor })\` | N refuters per claim; a strict majority kills it. Returns \`{ survived, refuted }\` |
| \`judgePanel(ctx, { task, angles, attemptSchema, keyPrefix })\` | independent attempts from different angles, panel-scored; highest-ranked existing attempt returned |
| \`loopUntilDry(ctx, { find, keyOf, dryRounds, maxRounds })\` | keep finding until K consecutive rounds turn up nothing new |
| \`multiModalSweep(ctx, { subject, modes, schema, keyPrefix })\` | one agent per lens, each blind to the others |
| \`completenessCritic(ctx, { produced, instructions })\` | "what is missing" — its answer is the next round of work |
| \`finalReport(ctx, { title, sections })\` | a markdown report string, logged as it is built |

Result-schema builders are exported for \`adversarialVerify\`, \`judgePanel\`, and
\`multiModalSweep\` (for example \`adversarialVerifyResultSchema(Claim)\`).
\`completenessCritic\` has the fixed \`CompletenessGapsSchema\`; \`finalReport\` exports
\`FinalReportOptionsSchema\` and \`ReportSectionSchema\` for its inputs. \`loopUntilDry\` has no
result-schema export, so declare the enclosing workflow's actual output schema yourself.

## CLI

Global flags: \`--cwd <dir>\` (repo root), repeatable \`--extra-workflow-dir <dir>\` (add
workflow registries without moving run/task state), and \`--mock\` (wire the fixture provider
instead of Claude/Codex — an agent step then fails loudly without a fixture rather than
inventing an answer, so it is for agent-less workflows and smoke tests).

Every registry contains named workflow package directories. Each package must contain
\`main.ts\`, \`lib/\`, \`tests/\`, and \`CHANGELOG.md\`. An extra workflow directory may point
either to a registry root containing those packages or directly to one complete package.

| Command | |
| --- | --- |
| \`weft run <name\\|file\\|->\` | start a run. Input fields become flags; \`--args '{…}'\` first, then \`--flag value\` merges over it. \`--budget "500k,$5"\`, \`--reuse content\\|key\`, \`--watch\`. \`-\` reads a script from stdin |
| \`weft resume <run>\` | replay the journal and continue. \`--reuse\`, \`--watch\` |
| \`weft ls\` | runs, newest first. \`--status\`, \`--workflow\`, \`--limit\` |
| \`weft status <run>\` | one run: status, cost, tree, what it is waiting on |
| \`weft answer <run> [req] [json]\` | answer a pending human step; interactive when no JSON is given |
| \`weft cancel <run>\` | abort in-flight work; the run stays resumable |
| \`weft replay --dry <run>\` | what would replay, what diverged — no providers, no writes |
| \`weft report <run>\` | the generated markdown report |
| \`weft explain <run> <key\\|seq>\` | one step: route, exact prompt, output, usage, attempts |
| \`weft diff <a> <b>\` | two runs' step outputs, matched by key — field-level, not prose |
| \`weft check [name]\` | unified fixed lint, gate, bundle, schema/UI, and \`tsc --noEmit\` validation. \`--no-tsc\` |
| \`weft lint [name]\` | focused lint-only subset of \`check\`; \`--fix\` applies safe general-rule fixes |
| \`weft test [pattern]\` | run workflow tests with Vitest, Bun, or Node's \`node:test\`. With no pattern, runs \`.weft/workflows/*/tests/**/*.test.ts\` using Node; \`--runner\`, \`--watch\`, \`--coverage\` |
| \`weft new <name> [--template simple\\|review\\|task]\` | scaffold \`<name>/{main.ts,lib/,tests/,CHANGELOG.md}\`; never overwrites |
| \`weft workflow list\` (alias \`ls\`) | list loadable definitions and rejected workflow files |
| \`weft workflow inspect <name-or-id> [--json]\` | print the input/output/task/default contract by callable name or stable id; \`--json\` also exposes UI metadata in the complete machine-readable contract |
| \`weft task --workflow <id> …\` | durable task context: \`schema/list/show/create/upsert/update/note/accept/unaccept/remove\`; mutations support explicit clearing/guards |
| \`weft skill\` | print this document |
| \`weft doctor\` | node, git, \`.weft\` layout, provider credentials, every workflow |
| \`weft ui\` | serve the local web UI. \`--port\` (default 4781) |

\`weft run\` and \`weft resume\` return when the run **settles or suspends**: a completed run
prints its output, a failed one exits 1 with the step key and the \`weft explain\` line, and
a run that parks on a person prints the exact \`weft answer <run> <id> '<json>'\` command and
exits. Parking is not losing — answer it, then \`weft resume <run>\`.

The task CLI is for human/operator mutations. Providers do not invoke it; they request
validated structured operations through the agent result envelope. Use \`--json\` for
machine-readable task output, \`--if-revision\` where offered to avoid overwriting a newer
record, and \`remove --yes\` only for a task with no dependents.

The typical loop:

\`\`\`bash
weft check review                          # lint + gate + bundle + schemas + types
weft run review --base main --watch        # live tree until it settles or suspends
weft answer 9c4f1a7e h1 '{"approved":true}'  # if it parked on a person
weft resume 9c4f1a7e                        # continue from the journal
weft report 9c4f1a7e                        # outcome, changes, checks, ledger, risk
weft explain 9c4f1a7e find:src/auth.ts      # why did that agent say that
\`\`\`

## Optional MCP host loop

Use this only when a callable Weft MCP server is actually installed or built; an MCP config
snippet is configuration, not publication or runtime proof. The implemented tool loop is
vendor-neutral:

1. \`weft_run { workflow | source, input }\` returns \`{ runId }\` immediately; the run
   continues in the background.
2. \`weft_wait { runId }\` long-polls and returns the next change.
3. \`{ awaiting: { runId, id, question, schema } }\` means put that question to **your** user,
   then \`weft_answer\` on \`awaiting.runId\` (the request's *owning* run — often a child of the
   one you waited on; request ids are run-local) and wait again on the original \`runId\`.
   Never answer on the user's behalf.
4. \`{ status: "complete", output }\` ends successfully. \`{ status: "failed", error }\` and
   \`{ status: "cancelled" }\` are also terminal: report the failure or cancellation and stop.
   \`{ status: "running" }\` only means the poll timed out — wait again.

\`weft_report\`, \`weft_list\`, \`weft_resume\`, and \`weft_types\` (the SDK source, for writing an
inline \`source\` workflow) round it out. Every reply is JSON: read its fields rather than
summarizing prose.

## Distribute this skill

\`weft skill\` writes only this complete document to stdout and does not need \`.weft\`
state. Choose a destination owned by the consuming agent/repository and create it outside
this command when desired, for example:

\`\`\`bash
weft skill > .agents/skills/weft/SKILL.md  # Codex repository skill
weft skill > .claude/skills/weft/SKILL.md
\`\`\`

These are distribution examples, not directories Weft creates or owns. The document uses
only ordinary source inspection, shell commands, CLI/MCP interfaces, and Agent Skills
frontmatter; no private vendor tool is required.

## Testing

\`runWorkflow\` tests run with zero model calls. Fixtures match on the step key, receive the real
request, and go through the engine's normal schema validation — a fixture that would not
pass in production fails the test.

\`\`\`ts
import { fixture, mock, runWorkflow } from "@techery/weft-testing";
import review from "../.weft/workflows/review/main.ts";

const { output, journal } = await runWorkflow(review, {
  input: { base: "main" },
  fs: { "src/a.ts": "export const n = 1;\\n" },
  provider: mock({ strict: true, profile: "claude" })
    .on({ key: "find:*" }, (req) => ({
      findings: req.prompt.includes("a.ts")
        ? [{ file: "a.ts", line: 3, claim: "off-by-one", severity: "medium" }]
        : [],
    }))
    .on(
      { key: "refute:*" },
      fixture.sequence([{ survives: true, why: "verified from the source" }]),
    ),
  git: { changedSince: { files: [{ path: "a.ts", status: "M" }] } },
});

expect(output.confirmed).toHaveLength(1);
expect(journal.steps({ kind: "agent" })).toHaveLength(2);
expect(journal.step("find:a.ts").prompt).toContain("Cite file:line");
expect(journal.ran("find:a.ts")).toBe(true);
expect(journal.neverRan("fix:a.ts")).toBe(true);
\`\`\`

Fixture keys are plain globs, not path patterns: \`*\` matches any characters, \`/\` included,
so \`find:*\` matches \`find:src/auth/login.ts\`. \`runWorkflow\` also takes \`exec\`, \`bash\`,
\`fetch\`, \`env\`, \`answers\`, \`signals\`, \`taskSeeds\`, \`budget\`, \`config\`, \`fs\`, and
\`cwd\` fixtures; \`config: { path }\` loads a repository-relative JSON fixture. Its result
includes the effective \`cwd\` and final typed \`tasks\` snapshot. \`fixture.sequence\` is the
explicit stateful responder for repeated matches; an array passed directly to \`mock.on\`
remains an ordinary schema value.

Use \`mock({ strict: true })\` for mutation workflows. It rejects fixture writes from
read-only steps, workspace escapes, protected paths, and files outside the declared write
scope before writing any fixture file. A \`profile: "claude" | "codex"\` advertises that
provider's real capabilities so \`providerRequirements\` are exercised in tests. Journal
views expose \`payload\`, \`scope\`, \`ran(key)\`, and \`neverRan(key)\` for focused assertions.
Thus workflows with human steps, signals, task state, and shell checks can run end to end in
a unit test when the needed fixtures are supplied.

The mock agent is fail-closed, and a missing human answer or signal also fails loudly.
Side-effect fixture tables are interceptors, not a host sandbox: an unmatched \`git\`,
\`exec\`, \`bash\`, or \`fetch\` fixture falls through to the real host implementation, and
omitting the \`env\` table reads \`process.env\`. Fixture every effect the test must isolate and
use an appropriate temporary \`cwd\`. This proves the in-memory engine path with the supplied
fixtures. It does not prove real provider credentials, subprocess/network availability, the
filesystem host, MCP transport, daemon routes, or browser rendering; exercise those paths
separately when the requested claim depends on them.

## Failure modes worth knowing

- **A step with no \`key\` in a fan-out.** It replays as a miss and costs money again. Key
  everything you fan out, from the item rather than the index.
- **A missing \`schema:\`.** The AST gate does not catch it; \`weft check\` catches the
  TypeScript error when its compiler/SDK pass is available. Treat a visible skip as incomplete
  evidence and run the repository's real typecheck.
- **Promises instead of thunks in \`ctx.parallel\`.** A promise has already started, so
  \`concurrency\` cannot cap it. Pass items plus a mapper, or \`() => ctx.agent(…)\` thunks.
- **Un-integrated patches.** The run fails at the end. \`ctx.integrate\` or \`ctx.discard\`.
- **Treating a read-only agent as an implementation step.** Without \`write\`, provider edits
  are denied; with \`write\`, changes stay in an isolated worktree until explicit integration.
- **Reading \`ledger.merged\` as file paths.** They are step keys.
- **A bare import you "need".** Put the helper in a relative file, or add the package to
  \`workflows.allowBare\` in \`.weft/config.json\` — do not work around the gate.
- **Editing run state.** Do not hand-edit the journal or its projections; preserve shared
  blobs and persisted workflow/UI provenance needed for replay.
- **Guessing at a human answer.** \`weft answer\` validates against the journaled schema and
  tells you what it wanted; a gate exists because someone has to decide.`;
