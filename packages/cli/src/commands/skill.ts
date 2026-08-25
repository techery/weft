/**
 * `weft skill` — the document an agent should read before it writes or runs a workflow.
 * It is a Claude Code / Codex skill: YAML frontmatter plus the whole authoring surface,
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
  Author, run, resume, and debug Weft workflows — durable, journaled, schema-validated
  multi-agent coding workflows written as ordinary TypeScript. Use when the repo has a
  \`.weft/\` directory, when editing anything under \`.weft/workflows/\`, when the \`weft\`
  CLI or \`@techery/weft-sdk\` / \`-core\` / \`-stdlib\` / \`-testing\` appears, or when asked to
  orchestrate several agents over a codebase durably rather than in one session.
---

# Weft

A workflow is an ordinary TypeScript program. \`await\` is a sequential edge, \`ctx.parallel\`
fans out and joins, \`ctx.pipeline\` runs independent lanes, \`if\` on a typed field is a
conditional edge, \`while\` is a bounded loop. There is no graph DSL to keep in sync.

Everything that leaves the sandbox is a **step**: the engine executes it, appends the
outcome to an append-only journal, and hands your code a schema-validated value. Resume
re-executes the program from the top and serves completed steps out of the journal — so a
run survives a crash, a reboot, or an overnight wait on a person, and picks up where it
stopped.

Two things break workflows more often than everything else combined. Read
[Determinism](#determinism) and [Keys and replay](#keys-and-replay) before writing code.

## Layout

\`\`\`text
.weft/
  config.json              # optional; defaults, providers, limits, approvalPolicy, workflows.dir
  workflows/<name>.ts      # the registry — one workflow per file, name = filename
  workflows/schemas.ts     # shared schemas; relative imports are bundled and hashed with the script
  runs/<id>/
    journal.jsonl          # the truth — every step, request, answer, patch (secrets redacted)
    script.ts              # what ran, bundled, with a source map back to your .ts lines
    blobs/<hash>           # patches, transcripts, large step outputs
    state.json             # projection: status, steps, scopes, checks
    tree.json              # projection: the live tree the UIs render
    report.md              # projection: outcome, changes, checks, ledger, remaining risk
\`\`\`

Only \`journal.jsonl\` has to survive. Every other file in a run directory is rebuilt from
it, so never hand-edit one and never treat one as input.

## Author a workflow

\`weft new <name>\` scaffolds a file that already passes \`weft check\`. The shape:

\`\`\`ts
import { defineWorkflow, z } from "@techery/weft-sdk";
import { Finding } from "./schemas.ts";          // explicit .ts extension, always

export default defineWorkflow(
  {
    // \`name\` derives from the filename — do not set meta.name in a registry file.
    description: "Review changed files; keep only findings that survive refutation",
    input: z.object({ base: z.string().default("main") }),   // becomes --base main
    output: z.object({ confirmed: z.array(Finding) }),       // validated on the way out
    defaults: { provider: "claude", effort: "high" },        // per-step opts still win
  },
  async (ctx, { base }) => {
    ctx.phase("Scope");                                      // phases group steps in the tree
    const { files } = await ctx.git.changedSince(base);
    const paths = files.filter((f) => f.status !== "D").map((f) => f.path);

    ctx.phase("Find");
    const found = ctx.ok(                                    // Settled<T>[] -> T[], drops recorded
      await ctx.parallel(
        paths.map((file) => () =>                            // a THUNK, so \`concurrency\` applies
          ctx.agent(\`Review \${file} for correctness bugs. Cite file:line.\`, {
            schema: z.object({ findings: z.array(Finding) }), // required on every agent step
            key: \`find:\${file}\`,                             // stable identity for replay
          }),
        ),
        { concurrency: 4 },
      ),
    );

    return { confirmed: found.flatMap((r) => r.findings) };
  },
);
\`\`\`

\`schema\` is required on \`ctx.agent\`, on every \`ctx.human.*\`, and on the workflow's own
\`input\`/\`output\`. Invalid model output is repaired in the same session with the validation
errors fed back, not thrown away. Zod is the default; any Standard Schema V1 library works.

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

Run \`weft check\` after every edit. It bundles and instantiates every \`.ts\` file in the
workflow directory exactly the way a run would, so a banned global hiding in \`./schemas.ts\`
fails there instead of three agent steps in, then runs \`tsc --noEmit\` (which is what
catches a missing \`schema:\`).

## Keys and replay

A step's identity is its **kind + payload + schema + \`key\`**. That is the whole cache key.

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
| \`ctx.agent(prompt, { schema, key, label, provider, model, effort, isolation, write, maxTurns, timeout, retry, repair, onMaxTurns, onError })\` | the validated value |
| \`ctx.agent.detailed(prompt, opts)\` | \`{ value, usage, files, patch, attempts, sessionId }\` |
| \`ctx.parallel(tasks, { concurrency })\` | \`Settled<T>[]\`, in input order |
| \`ctx.pipeline(items).step(fn).filter(fn).map(fn).run({ concurrency })\` | \`Settled<T>[]\` |
| \`ctx.ok(settled)\` | \`T[]\` — narrows, and records what it dropped |
| \`ctx.workflow(def \\| name, input, { budget, key, label })\` | the child's output |

\`effort\` is \`low \\| medium \\| high \\| xhigh \\| max\`; \`provider\` is \`"claude"\` or \`"codex"\`
(one option on one step is all a cross-vendor panel takes). \`onError: "null"\` resolves to
\`T | null\` instead of throwing \`StepError\`.

Prefer \`ctx.pipeline\` over two \`ctx.parallel\` calls: a pipeline has no barrier between
stages, so lane A can be in stage 3 while lane B is still in stage 1. Reach for the barrier
only when a stage genuinely needs every prior result at once (dedup across all of them, an
early exit on a total count, a prompt that compares findings to each other).

**Humans** — durable suspensions. The answer can arrive hours later, from another process.

| Call | Returns |
| --- | --- |
| \`ctx.gate({ action, risk, detail })\` | \`{ approved, note?, answeredBy: "human" \\| "policy" \\| "timeout" }\` |
| \`ctx.human.ask({ question, schema, detail, timeout, onTimeout })\` | the validated answer |
| \`ctx.human.approve({ action, detail, timeout, onTimeout })\` | \`{ approved, note? }\` |
| \`ctx.human.review({ artifact, question, schema, timeout, onTimeout })\` | the validated answer |

\`risk\` is \`low \\| medium \\| high \\| irreversible\`; \`low\` auto-approves by policy and is
still recorded. \`onTimeout\` is \`"deny"\`, \`"escalate"\`, or \`{ default: <value> }\`.

**Side effects**

| Call | Returns |
| --- | --- |
| \`ctx.fs.read(path)\` · \`ctx.fs.glob(patterns)\` · \`ctx.fs.stat(path)\` | content + sha256 · paths · stat |
| \`ctx.exec(file, args, opts)\` · \`ctx.bash(command, opts)\` | \`{ exitCode, stdout, stderr }\` |
| the same with \`{ schema }\` | JSON stdout, parsed and validated |
| \`ctx.fetch(url, init)\` | \`{ status, headers, body }\`; with \`{ schema }\`, a validated 2xx body |
| \`ctx.env.get(name)\` · \`ctx.secret(name)\` | the value · an opaque handle, journaled as \`<redacted>\` |
| \`ctx.git.*\` | typed git; reads are free, writes carry fixed risk tiers |

\`exec\`/\`bash\` take \`{ cwd, timeout, env, risk, key }\` — \`risk\` routes the call through the
approval gate. Git reads: \`status\`, \`head\`, \`branches\`, \`mergeBase\`, \`changedSince\`, \`diff\`,
\`log\`, \`show\`, \`blame\`, \`fileAt\`, \`snapshot\`. Git writes (\`commit\`, \`push\`, \`reset\`,
\`tag\`, \`branch.*\`, \`stash.*\`, \`clean\`, …) have a fixed tier you can raise with \`{ risk }\`,
never lower.

**Checks, integration, ledger**

| Call | Returns |
| --- | --- |
| \`ctx.check(name, { exec, fn, required, trustPrior, timeout })\` | \`{ status, evidence? }\` |
| \`ctx.integrate(results, { order, onConflict })\` | \`{ merged, conflicts, quarantined, skipped }\` |
| \`ctx.discard(results)\` | void — the explicit "these patches are not landing" |
| \`ctx.note({ kind: "decision" \\| "claim" \\| "risk", text, evidence })\` | void; shows up in the report |

\`check\` status is \`pass \\| fail \\| trust-prior \\| skipped\`, and a failing \`required: true\`
check gates the run's completion. The ledger's arrays hold **step keys**, not file paths.

**Waits, journaled globals, structure**

\`ctx.signal(name, schema, { timeout })\` parks until something outside delivers it.
\`ctx.sleep(duration)\` is durable — the process may exit and resume later.
\`ctx.now()\`, \`ctx.random()\`, \`ctx.uuid()\` are the journaled replacements for the banned
globals. \`ctx.phase(name)\` groups the tree, \`ctx.log(message)\` narrates it, \`ctx.budget\`
is \`{ spent, remaining }\` (\`null\` means unlimited on that axis), and \`ctx.run\` is
\`{ id, cwd, baseRef?, depth }\`.

## Write steps

A write step does not mutate the tree. Declaring \`write:\` makes the step a write step: it
gets its own git worktree, its diff is captured as a patch blob, out-of-scope files are
flagged, and **nothing lands until \`ctx.integrate()\`**.

\`\`\`ts
const fixes = ctx.ok(
  await ctx.parallel(
    bugs.map((bug) => () =>
      ctx.agent.detailed(\`Fix and add a focused test: \${bug.claim} (\${bug.file}:\${bug.line})\`, {
        schema: FixResult,
        isolation: "worktree",
        write: { paths: [bug.file, "**/*.test.ts"], also: ["pnpm-lock.yaml"], mode: "warn" },
        key: \`fix:\${bug.file}\`,
      }),
    ),
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
\`ctx.workflow(def, input)\` is typed from the definition; \`ctx.workflow("name", input)\`
resolves through the registry and returns \`unknown\` — prefer the definition.

## Stdlib patterns

\`@techery/weft-stdlib\` holds patterns worth not rewriting. Each takes \`ctx\` first, spawns
ordinary keyed steps, and returns plain typed data — nothing is engine-privileged, so they
replay and inspect exactly like hand-written code.

| Function | What it does |
| --- | --- |
| \`adversarialVerify(ctx, { claims, describe, refuters, keyFor })\` | N refuters per claim; a strict majority kills it. Returns \`{ survived, refuted }\` |
| \`judgePanel(ctx, { task, angles, attemptSchema, keyPrefix })\` | independent attempts from different angles, scored, best synthesized |
| \`loopUntilDry(ctx, { find, keyOf, dryRounds, maxRounds })\` | keep finding until K consecutive rounds turn up nothing new |
| \`multiModalSweep(ctx, { subject, modes, schema, keyPrefix })\` | one agent per lens, each blind to the others |
| \`completenessCritic(ctx, { produced, instructions })\` | "what is missing" — its answer is the next round of work |
| \`finalReport(ctx, { title, sections })\` | a markdown report string, logged as it is built |

Each also exports a schema builder (\`adversarialVerifyResultSchema(Claim)\`, …) so the
pattern's shape can be a workflow's \`output:\` directly.

## CLI

Global flags: \`--cwd <dir>\` (repo root), \`--mock\` (wire the fixture provider instead of
Claude/Codex — an agent step then fails loudly without a fixture rather than inventing an
answer, so it is for agent-less workflows and smoke tests).

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
| \`weft check [name]\` | gate + \`tsc --noEmit\` over the workflow directory. \`--no-tsc\` |
| \`weft new <name>\` | scaffold \`<name>.ts\` (+ \`schemas.ts\`); never overwrites |
| \`weft skill\` | print this document |
| \`weft doctor\` | node, git, \`.weft\` layout, provider credentials, every workflow |
| \`weft ui\` | serve the local web UI. \`--port\` (default 4781) |

\`weft run\` and \`weft resume\` return when the run **settles or suspends**: a completed run
prints its output, a failed one exits 1 with the step key and the \`weft explain\` line, and
a run that parks on a person prints the exact \`weft answer <run> <id> '<json>'\` command and
exits. Parking is not losing — answer it, then \`weft resume <run>\`.

The typical loop:

\`\`\`bash
weft check review                          # gate + types, before anything costs money
weft run review --base main --watch        # live tree until it settles or suspends
weft answer 9c4f1a7e h1 '{"approved":true}'  # if it parked on a person
weft resume 9c4f1a7e                        # continue from the journal
weft report 9c4f1a7e                        # outcome, changes, checks, ledger, risk
weft explain 9c4f1a7e find:src/auth.ts      # why did that agent say that
\`\`\`

## From inside a Claude Code or Codex session (MCP)

\`\`\`json
{ "mcpServers": { "weft": { "command": "npx", "args": ["-y", "@techery/weft-mcp"] } } }
\`\`\`

1. \`weft_run { workflow | source, input }\` returns \`{ runId }\` immediately; the run
   continues in the background.
2. \`weft_wait { runId }\` long-polls and returns the next change.
3. \`{ awaiting: { runId, id, question, schema } }\` means put that question to **your** user,
   then \`weft_answer\` on \`awaiting.runId\` (the request's *owning* run — often a child of the
   one you waited on; request ids are run-local) and wait again on the original \`runId\`.
   Never answer on the user's behalf.
4. \`{ status: "complete", output }\` ends the loop. \`{ status: "running" }\` only means the
   poll timed out — wait again.

\`weft_report\`, \`weft_list\`, \`weft_resume\`, and \`weft_types\` (the SDK source, for writing an
inline \`source\` workflow) round it out. Every reply is JSON: read its fields rather than
summarizing prose.

## Testing

Workflow tests run with zero model calls. Fixtures match on the step key, receive the real
request, and go through the engine's normal schema validation — a fixture that would not
pass in production fails the test.

\`\`\`ts
import { mock, runWorkflow } from "@techery/weft-testing";
import review from "../.weft/workflows/review.ts";

const { output, journal } = await runWorkflow(review, {
  input: { base: "main" },
  provider: mock().on({ key: "find:*" }, (req) => ({
    findings: req.prompt.includes("a.ts") ? [{ file: "a.ts", line: 3, claim: "off-by-one" }] : [],
  })),
  git: { changedSince: { files: [{ path: "a.ts", status: "M" }] } },
});

expect(output.confirmed).toHaveLength(1);
expect(journal.steps({ kind: "agent" })).toHaveLength(1);
expect(journal.step("find:a.ts").prompt).toContain("Cite file:line");
\`\`\`

Fixture keys are plain globs, not path patterns: \`*\` matches any characters, \`/\` included,
so \`find:*\` matches \`find:src/auth/login.ts\`. \`runWorkflow\` also takes \`exec\`, \`bash\`,
\`fetch\`, \`env\`, \`answers\`, \`budget\`, \`config\` and \`cwd\` fixtures, so a workflow with
human steps and shell checks runs end to end in a unit test. An un-fixtured step fails
loudly; it is never invented.

## Failure modes worth knowing

- **A step with no \`key\` in a fan-out.** It replays as a miss and costs money again. Key
  everything you fan out, from the item rather than the index.
- **A missing \`schema:\`.** The gate's AST rules will not catch it; \`weft check\`'s \`tsc\` pass
  will. Run \`weft check\`, not just the gate.
- **Promises instead of thunks in \`ctx.parallel\`.** A promise has already started, so
  \`concurrency\` cannot cap it. Pass \`() => ctx.agent(…)\`.
- **Un-integrated patches.** The run fails at the end. \`ctx.integrate\` or \`ctx.discard\`.
- **Reading \`ledger.merged\` as file paths.** They are step keys.
- **A bare import you "need".** Put the helper in a relative file, or add the package to
  \`workflows.allowBare\` in \`.weft/config.json\` — do not work around the gate.
- **Editing a run directory.** Everything but \`journal.jsonl\` is a projection and is
  overwritten on the next command.
- **Guessing at a human answer.** \`weft answer\` validates against the journaled schema and
  tells you what it wanted; a gate exists because someone has to decide.`;
