# Weft — coding-workflow landscape, competitive comparison, and what to build next

**Written:** 2026-08-24, revised 2026-08-25 to correct a framing error (see [Method](#method-and-a-correction)).
**Against:** `da85488` on `main`. **Measured baseline, this checkout:** `pnpm install` ✓ · `pnpm test` ✓ **694 passed (694), 41 files, 48.8 s** · 16 packages, 140 source files, ~37.0k lines.
**Scope:** everything weft ships, compared against the open-source tools that do the same *job* — help a team run repeatable, reviewable multi-agent work on a repository — on 18 dimensions, followed by a ranked build list.
**Companion:** [DX and Architecture Review](./2026-08-dx-and-architecture.md), which audits *quality*. This document is about *surface*.

---

**Contents** — [Verdict](#verdict-in-one-page) · [Method](#method-and-a-correction) · [1 What weft is](#part-1--what-weft-actually-is) · [2 The field](#part-2--the-field) · [3 Comparison](#part-3--the-comparison) · [4 Closest rivals](#part-4--the-eight-tools-weft-is-actually-competing-with) · [5 Strengths & gaps](#part-5--what-is-genuinely-wefts-own-and-what-is-missing) · [6 What to build](#part-6--what-to-build) · [7 What the critic cut](#part-7--what-the-critic-cut) · [8 Sequencing](#part-8--sequencing) · [9 Strategy](#part-9--the-strategic-question-this-report-cannot-answer) · [Appendices](#appendix-a--capability-map)

## Verdict in one page

Weft is a way to **write a coding workflow down as a program** — review, audit-and-fix, migrate, triage — so that the process itself is checked in, reviewed, tested, and repeatable, and so that what the agents do to the repository is scoped, verified, and reversible.

The three-line version:

1. **Its differentiator is typed hand-off, not durability.** Of every coding-agent harness surveyed, *not one* has a typed step-to-step contract — the research notes read "no typed step-result contract" for Cline, Codex CLI, opencode, OpenHands, Aider, SWE-agent, and the worktree managers alike. goose Recipes validates the whole run's output; Claude Code's dynamic workflows validate one agent call and hand you `null` on failure. Weft requires a schema on every step, validates engine-side, and repairs in-session. That, plus a zero-token test harness for the workflow itself — which **nothing else in this field has at all** — is the actual moat.
2. **The write model is the other half, and it is genuinely unmatched.** Declared `write:` scopes enforced live, patches captured rather than applied, and `ctx.integrate()` as a journaled merge gate with a conflict policy and a ledger. Worktree isolation is now table stakes — Claude Code, Codex CLI, container-use, claude-squad, Crystal, Conductor, uzi and Vibe Kanban all have it. *Scoped patches that land only where you said they could* is weft's alone.
3. **It loses on interop, on evidence, and on distribution.** It reads no `AGENTS.md`, so a write step starts stripped of the conventions every other runner ingests by default — free interop, declined. Its stdlib review patterns have never been measured, while CodeRabbit and Qodo publish F1 numbers. And it is competing for a developer's attention with GitHub Spec Kit at **131.2k stars** and Claude Code's skills-and-plugins ecosystem at **142.9k**, having published nothing.

**A note on posture.** Weft is designed to run on a developer's own machine — no server, no account, no code leaving the laptop, using the credentials already in the shell. That is the same bet Claude Code, Codex CLI, opencode, goose and Aider make, and this report treats it as a design choice rather than a gap. The bill for it is local-tool basics that are still unpaid: no repo-root discovery, no blob GC, and no repo-level mutex, so two runs sharing a working tree is undefined behaviour. The security story matters *more* under this posture, not less — model-generated code runs unsandboxed against your real checkout and your real credentials, and `ctx.fetch` allows every host by default.

**The honest positioning:** weft is the only tool here that treats a coding workflow as a *program you test* and an agent's diff as a *patch you gate*. That is a real and unoccupied position. What it lacks is the evidence that its patterns are better and the small courtesies that make a local tool feel finished.

**If only three things get built:** ingest `AGENTS.md`/`CLAUDE.md` into agent steps; measure the stdlib review patterns against a real benchmark; and make the CLI compose with a developer's own tooling (`--json`, exit codes, `weft cat <run> <step> --patch | git apply`). Those three move weft from "correct" to "usable by someone else." Full list in [Part 6](#part-6--what-to-build).

## Method, and a correction

**The correction.** The first draft of this report compared weft against durable-execution engines — Temporal, Restate, DBOS, Inngest, Vercel Workflow DevKit — and rated it on durability dimensions. That was wrong. Durability is an *instrument* weft uses so an overnight audit or a gate waiting on a person survives the session; it is not what weft is for, and a task queue is not a competitor to a code-review workflow. Those engines have been demoted to [Appendix B](#appendix-b--where-the-durability-machinery-came-from), as prior art for the machinery. The comparison in Part 3 is rebuilt on coding-workflow dimensions, and durability appears once, as dimension 14, framed as what it is.

| Layer | How it was produced | Confidence |
| --- | --- | --- |
| Weft's features and limits | Every package's source read with `file:line` evidence recorded per claim; spot-checked by hand; `pnpm test` run to confirm the baseline | **High** — verifiable in this repo |
| The field | READMEs, docs sites and repo pages fetched 2026-08-24; Spec Kit, PR-Agent, gh-aw and the AI-code-review market re-verified 2026-08-25. Star counts marked `unverified` where not read directly | **Medium** — external, dated, moving |
| Comparison ratings | Authored from that research; a project is omitted from a dimension rather than guessed at | **Medium** |
| Ideas | Three lenses, then an adversarial critic that cut 7 as already-shipped, flagged 12 as weak, and added 8 nobody proposed | **Mixed by item** — see [Part 7](#part-7--what-the-critic-cut) |

**Anything sourced only from the web is dated and should be re-checked before it drives a decision.** Source data is checked in under [`data/2026-08-feature-landscape/`](./data/2026-08-feature-landscape/); note that `landscape.json` and `comparison.json` there are the *first-draft* artifacts and still carry the durable-execution framing this revision corrects.

## Part 1 — What weft actually is

140 distinct capabilities were inventoried with `file:line` evidence, across three areas. 131 are **solid** (complete and tested), 6 **partial**, and the README's own "honest deviations" section names 6 more that are design-only. What follows is the shape of it; the full list with evidence is in [Appendix A](#appendix-a--capability-map).

### The authoring surface

Everything a workflow touches comes through one `ctx` object (`packages/sdk/src/types.ts`, 911 lines for the whole SDK). There is no DSL, no graph builder, no decorators:

```ts
export default defineWorkflow(
  { description: "…", input: z.object({ base: z.string().default("main") }), output: … },
  async (ctx, { base }) => {
    ctx.phase("Scope");
    const { files } = await ctx.git.changedSince(base);   // journaled, replayed
    const found = ctx.ok(await ctx.parallel(files.map(f => ctx.agent(`Review ${f.path}`, {
      schema: Findings, key: `review:${f.path}`,
    }))));
    …
  },
);
```

`await` is a sequential edge. `ctx.parallel` fans out and joins (returns `Settled<T>[]`). `ctx.pipeline` runs independent lanes with no barrier between stages. `if` on a typed field is a conditional edge. `while` is a bounded loop. The graph is discovered by execution, not declared.

**Steps:** `agent` (+ `agent.detailed`), `parallel`, `pipeline`, `ok`, `workflow` (sub-runs). **Humans:** `gate`, `human.ask/approve/review`. **Effects:** `fs.read/glob/stat`, `exec`, `bash`, `fetch`, `env`, `secret`, and 25 typed `git` operations. **Ledger:** `check`, `integrate`, `discard`, `note`. **Durable waits:** `signal`, `sleep`. **Journaled replacements for banned globals:** `now`, `random`, `uuid`. **Structure:** `phase`, `log`, `budget`, `run`.

### Six mechanisms that carry the product

**1 — The journal is the only truth.** A run is a sequence of `{ i, at, ev }` records. `state.json`, `tree.json`, `report.md` and the SQLite index are pure folds over it (`packages/core/src/projections.ts`). Delete them and they rebuild. The event union covers run lifecycle, steps (`scheduled`/`attempt`/`completed`/`failed`), humans (`requested`/`answered`/`rejected`), signals, timers, patches (`captured`/`merged`/`discarded`), `scope.violation`, checks, notes, drops, `budget.sampled`, phases, logs, and `replay.salvaged`/`replay.diverged`.

**2 — Replay is content-addressed and edit-tolerant.** Step identity is `sha256(canonicalJson{kind, payload, schema, key})` — content, not position. `matchStep` tries three tiers: same seq + same hash → any unconsumed same-hash entry (salvage) → under `--reuse key`, any unconsumed same-key entry. `run.created` stamps `bodyHash = sha256(name + def.run.toString())` plus the host's bundle `defHash`; when the stamps disagree, `positionsTrusted = false` and a keyless step matching several journaled entries **re-runs** with an `ambiguous keyless identity` divergence rather than guessing. Measured in `examples/04`: an unchanged resume costs **0 provider calls**; rewording one step costs exactly **1**; `weft replay --dry` names the diverging step before a model is called.

**3 — `verifyServe`: the journal is checked against the world.** A step spec may supply `verifyServe(journaled)`; a false verdict consumes the entry, journals `replay.diverged`, and re-executes with `io.reExecuting = true`. `git.commit` checks the sha is still an ancestor of HEAD; `git.checkout` checks HEAD is still on the ref; `git.tag` checks the tag still peels to the journaled sha; `ctx.integrate` checks tree hashes and reverse-apply. This exists because weft's steps mutate a git repository rather than a database — a journaled `git commit` is only still true if the sha is still reachable. It is unusual machinery (no replay engine surveyed re-checks the world before serving), but it is plumbing in service of the coding model, not a feature anyone would choose weft for.

**4 — Write steps produce patches, not mutations.** A write step gets a *per-attempt* worktree at `tmpdir/weft-worktrees/<runId>/<seq>.<attempt>`, seeded from `integrationBaseCommit` — a dangling-ref-pinned commit of the current tracked + untracked tree, so later writers build on earlier `ctx.integrate()` results rather than HEAD. `capturePatch` force-stages in-scope gitignored outputs, uses `--no-renames` so a `git mv` out of scope decomposes into a checkable delete + add, and `--binary` so binary edits survive. Out-of-scope files are flagged (`warn`) or the patch quarantined (`strict`). Nothing lands until `ctx.integrate()`, and **a run that ends with un-integrated patches fails** (`engine.ts:687-692`).

**5 — Humans are steps.** A human step is a journaled step whose provider is a person. `Engine.answer` serializes per `runId::requestId` and appends via `journal.appendIf` under a re-fold loop, so a standing answer, a terminal event, or a lost CAS refuses the caller — safe across processes. The answer is validated against the step's authoritative Standard Schema; a failure journals `human.rejected` and **reopens** the request rather than failing the run. Provenance is first-class: `answeredBy: "human" | "policy" | "timeout"`. Timeout policy is `deny` / `escalate` / `{ default }`.

**6 — Money is enforced, not observed.** `Budget.charge` propagates up the parent chain; `remainingTokens`/`remainingUsd` take `min(own, ancestor headroom)`; `checkBeforeStep` throws once either axis hits zero. `reserveCall` is concurrency-aware admission that **parks** rather than refuses — it requires `(inflight + 1) × (spent / samples)` to fit, serializes while no cost sample exists, and wakes parked callers on every charge. `reportsUsd` is a provider capability: when a run has a USD-only ceiling, a provider that reports no cost, *and* no price entry for the model, weft **refuses the dispatch** rather than silently charging $0.

### The hosts, and the fence

One `Engine` class; three thin shells over it.

| Host | Surface |
| --- | --- |
| **CLI** (`@techery/weft`) | 14 verbs: `run` `resume` `ls` `status` `answer` `cancel` `replay` `report` `explain` `diff` `check` `new` `doctor` `ui`. Input fields become flags automatically, and an unrecognised flag is now **refused** (each candidate key is probed against the schema twice — removed, and replaced with a value nothing accepts). |
| **MCP** (`@techery/weft-mcp`) | 7 tools: `weft_run` `weft_wait` `weft_answer` `weft_resume` `weft_list` `weft_report` `weft_types`. `weft_wait` long-polls and returns on the next reportable change, including "a person must answer" with the request's schema. |
| **Daemon** (`@techery/weft-daemon`) | Hono app: `GET /api/runs`, `/:id`, `/report`, `/tree`, `/pending`, SSE `/events`; `POST /:id/answer`, `/signal`, `/cancel`, `/resume`. Single self-contained HTML page, loopback + DNS-rebinding guard. |

The **determinism gate** (`@techery/weft-gate`) is two-layered by design. Eleven AST rules parsed with the TypeScript compiler API, applied through an esbuild `onLoad` plugin to every module the bundle pulls in — `no-date-now`, `no-argless-date`, `no-math-random`, `no-timers`, `no-global-fetch`, `no-process-env`, `no-require`, `no-gc-globals`, `no-locale`, `no-intl`, `no-bare-import` — each with a `ctx`-naming fix-it and real source positions through the bundle. Then a `node:vm` context with replaced globals catches the computed form (`globalThis["Da"+"te"]`) the AST layer deliberately cannot see. The README is explicit that this is **a determinism fence, not a security boundary**.

**Testing runs with zero model calls.** `runWorkflow` drives a workflow to a terminal state on a private in-memory engine; `mock().on({ key | label | prompt }, responder)` fixtures go through the engine's *normal* schema validation and journaling — "a fixture that would not pass in production fails the test". `exec`, `bash`, `fetch`, `env` and `answers` fixtures let a workflow with human steps and shell checks run end-to-end in a unit test.

### What the inventory found missing

71 proven limitations, of which these recur throughout the comparison:

- **No notification of any kind.** No Slack, email, webhook, or push code exists in the repo.
- **No `--json` on any CLI verb.** Scripting weft into CI means parsing terminal output.
- **One OTel span per run** — a single `tracer.startSpan` at `engine.ts:789` is the whole implementation.
- **Step outputs are journaled verbatim.** Redaction covers only `SecretHandle` env maps and fetch headers; `exec`/`bash` stdout+stderr, fetch bodies, agent prompts and `ctx.env.get` values all land unredacted.
- **No fork, no per-step re-run, no rewind.** Three verbs over the journal, all recovery-only.
- **No journal format version.** No `schemaVersion`/`journalVersion` field anywhere.
- **No blob GC.** `BlobStore` is `put`/`get`/`getText`/`has`; transcripts and patches accumulate forever.
- **No repo-root discovery.** Running from a subdirectory silently targets a different, empty `.weft`.
- **No `AgentProvider` conformance suite**, despite the README's package table claiming one.
- **Declared-but-dead API:** `IntegrateOptions.order?: "sequential"` is never read; `StepErrorCode`s `max_turns` and `git_failed` are never produced.
- **`ctx.parallel`'s `concurrency` option is silently ignored** unless *every* task is a thunk.
- **The repo's own flagship example still fails its pitch:** `PANEL = ["claude", "codex", "claude"]` with a `>= 2` majority means Claude alone carries a verdict, and the refuter is still handed the finder's `evidence` (`.weft/workflows/audit-and-fix.ts:15, 44`).

---

---

## Part 2 — The field

Grouped by the **job each tool does**, not by its architecture. A project appears in more than one group where it genuinely does more than one job. Star counts read 2026-08-24/25; `?` marks a figure that could not be verified directly.

### Tools for expressing a coding workflow

**weft's actual group.** How a team writes a repeatable coding process down so it can be run again, by someone else, next month.

| Project | Lang | License | Stars | What it is |
| --- | --- | --- | --- | --- |
| **GitHub Spec Kit** | Python | MIT | 131.2k | Spec-driven development as a checked-in artifact: /speckit.constitution → specify → plan → tasks → implement → converge, driving 30+ coding agents. The spec is the unit of work; code is the build output. |
| **Claude Code** | TypeScript/Node (CL… | Proprietary / source-un… | 142,871 | The reference agentic coding harness. As of 2026 it is no longer a single-agent REPL: it ships a full orchestration stack — subagents, agent teams, git-worktree isolation, hooks, skills, plugins, checkpointing — and, most importantly for w… |
| **goose** | Rust | Apache-2.0 | 53,385 | The general-purpose on-machine agent, not code-specific — but its Recipes system is the most complete DECLARATIVE workflow spec in this cluster, and the only one besides weft with structured output schemas, retry-with-validation, sub-workf… |
| **GitHub Agentic Workflows** | Go | MIT | 5,000 | The most direct competitor to weft on the 'declare a repeatable agent workflow over my repo' job, and the strongest security architecture in the CI-native group. Workflows are Markdown files with YAML frontmatter, compiled by `gh aw compil… |
| **OpenAI Codex CLI** | Rust (codex-rs; wit… | Apache-2.0 | 116,959 | OpenAI's terminal coding agent, and — with weft — one half of the multi-provider story: weft's AgentProvider puts Codex and Claude behind one interface, so Codex is simultaneously a competitor and a dependency. Its 2026 additions of TOML-d… |
| **opencode** | TypeScript | MIT | 200,999 *?* | The breakout open-source terminal agent of 2026 and the most credible model-agnostic alternative to Claude Code. Client/server by design: `opencode serve` is a headless HTTP server with an OpenAPI 3.1 spec and an SSE event bus, and the TUI… |
| **Cline** | TypeScript | Apache-2.0 | 66,780 | The most direct open-source competitor to weft's orchestration layer that is ALSO a mainstream daily-driver agent. Cline now ships an SDK with multi-agent teams: a coordinator agent that spawns specialists, coordinating through a persisted… |
| **Roo Code** | TypeScript | Apache-2.0 | 24,328 | Historically the most important prior art for weft's orchestration model: Roo Code's Orchestrator (formerly 'Boomerang') mode popularized decomposing a task into subtasks, dispatching each to a specialized mode with its OWN model and tool… |
| **SWE-agent** | Python | MIT | 20,122 | The benchmark-driven research harness: take a GitHub issue, autonomously fix it, measured on SWE-bench. Entirely config-driven — 'governed by a single yaml file'. Where weft optimizes for a human's production workflow, SWE-agent optimizes… |

### The agents that do the work

Weft calls these rather than replacing them — `provider: "claude" | "codex"` is an adapter over two of them. Their orchestration features are what weft competes with; their editing ability is what it depends on.

| Project | Lang | License | Stars | What it is |
| --- | --- | --- | --- | --- |
| **Claude Code** | TypeScript/Node (CL… | Proprietary / source-un… | 142,871 | The reference agentic coding harness. As of 2026 it is no longer a single-agent REPL: it ships a full orchestration stack — subagents, agent teams, git-worktree isolation, hooks, skills, plugins, checkpointing — and, most importantly for w… |
| **OpenAI Codex CLI** | Rust (codex-rs; wit… | Apache-2.0 | 116,959 | OpenAI's terminal coding agent, and — with weft — one half of the multi-provider story: weft's AgentProvider puts Codex and Claude behind one interface, so Codex is simultaneously a competitor and a dependency. Its 2026 additions of TOML-d… |
| **Cline** | TypeScript | Apache-2.0 | 66,780 | The most direct open-source competitor to weft's orchestration layer that is ALSO a mainstream daily-driver agent. Cline now ships an SDK with multi-agent teams: a coordinator agent that spawns specialists, coordinating through a persisted… |
| **opencode** | TypeScript | MIT | 200,999 *?* | The breakout open-source terminal agent of 2026 and the most credible model-agnostic alternative to Claude Code. Client/server by design: `opencode serve` is a headless HTTP server with an OpenAPI 3.1 spec and an SSE event bus, and the TUI… |
| **Aider** | Python | Apache-2.0 | 48,461 | The original git-native terminal pair programmer. Its enduring contribution is that every AI change is a git commit with a sensible message, so review and undo are just git — a philosophy weft inherits and extends with worktree-scoped patc… |
| **OpenHands** | TypeScript (fronten… | MIT | 84,976 | Pivoted decisively in 2026 from 'autonomous SWE agent' to platform: Agent Canvas is 'the self-hosted developer control center for coding agents and automations', running OpenHands, Claude Code, Codex, Gemini or any Agent-Client-Protocol ag… |
| **goose** | Rust | Apache-2.0 | 53,385 | The general-purpose on-machine agent, not code-specific — but its Recipes system is the most complete DECLARATIVE workflow spec in this cluster, and the only one besides weft with structured output schemas, retry-with-validation, sub-workf… |
| **Gemini CLI** | TypeScript | Apache-2.0 | 106,664 | Google's open-source terminal agent, notable for being the only major vendor CLI released under Apache-2.0 with the full source in the open (Claude Code's CLI is closed; Codex is open but OpenAI-model-bound). Relevant to weft mainly as a t… |
| **SWE-agent** | Python | MIT | 20,122 | The benchmark-driven research harness: take a GitHub issue, autonomously fix it, measured on SWE-bench. Entirely config-driven — 'governed by a single yaml file'. Where weft optimizes for a human's production workflow, SWE-agent optimizes… |

### Review, as a product

What weft's flagship `review.ts` example competes with. These already do find-then-verify, at scale, with published precision numbers — which weft has never measured for its own stdlib.

| Project | Lang | License | Stars | What it is |
| --- | --- | --- | --- | --- |
| **Qodo PR-Agent / Qodo Merge** | Python | Apache-2.0 | 12.7k | Open-source PR review agent: /describe, /review, /improve, /ask over GitHub, GitLab, Bitbucket, Azure DevOps and Gitea. Community-owned since April 2026, reverted from AGPL-3.0 to Apache-2.0. Reads AGENTS.md and SKILL.md. |
| **CodeRabbit** | — | Proprietary | — | AI review layered over 40+ bundled deterministic linters and SAST scanners; natural-language config in .coderabbit.yaml. Topped Martian's independent 2026 benchmark at 51.2% F1 with the broadest platform coverage. $24/user/month. |
| **Greptile** | — | Proprietary | — | Indexes the entire codebase before commenting on a single diff — a whole-repo-context bet rather than a panel-structure one. 82% bug-catch claimed in its own July 2025 test. |
| **Sourcery** | Python | Proprietary | — | Fast and cheap, optimised for Python refactoring and review with real-time quality suggestions and duplicate detection. Shallow by comparison. |
| **Claude Code Action** | TypeScript | MIT | 8.7k | The reference way to put Claude Code into GitHub Actions: @claude mentions in issues/PRs, issue assignment, or explicit prompts in a workflow file. Competes with weft for 'run an agent workflow on my repo' but at a much lower level of stru… |

### Parallel isolation and the review surface

Worktree-per-agent is now table stakes. What distinguishes them is what happens to the diff afterwards.

| Project | Lang | License | Stars | What it is |
| --- | --- | --- | --- | --- |
| **container-use** | Go | Apache-2.0 | 4,016 | Not an agent — an isolation SUBSTRATE for agents, delivered as an MCP server so any MCP-capable agent (Claude Code, Codex, Cursor, goose) gains containerized, branch-isolated environments without changing the agent. The purest expression o… |
| **Sculptor** | Python | MIT (verified by fetchi… | 218 | A desktop workspace for parallel, container-isolated coding agents from research lab Imbue. Its distinctive contributions are containers-not-just-worktrees per agent, and 'Pairing Mode' — syncing an agent's isolated container work back to… |
| **claude-squad** | Go | AGPL-3.0 | 8,361 | A terminal multiplexer for parallel coding agents: tmux session + git worktree per agent, agent-agnostic (Claude Code, Codex, Gemini, OpenCode, Amp, Aider). It solves the same isolation problem as weft's worktree-per-write-step but with ze… |
| **Crystal** | TypeScript (Electro… | MIT | 3,109 | A desktop app for running multiple Codex and Claude Code sessions in parallel git worktrees, with an explicit emphasis on COMPARING approaches — run the same task several ways and diff the outcomes. That comparison framing is its distincti… |
| **Vibe Kanban** | Rust | Apache-2.0 | 27,903 | A kanban board over coding agents: plan work as issues, create isolated workspaces where any of 10+ agents execute, review diffs inline, and ship via PR. It was the most-adopted attempt at a task-management-shaped orchestration layer, and… |
| **uzi** | Go | MIT | 582 | 'CLI for running large numbers of coding agents in parallel with git worktrees.' Its distinguishing bet was SCALE: not 3-5 agents but many, launched from one command with a single prompt broadcast across them, then compared. |
| **Conductor** | Swift/TypeScript (m… | Proprietary, closed sou… | — | The polished commercial answer to claude-squad: a free Mac app that runs multiple Claude Code and Codex agents in parallel, each in its own git worktree on its own branch, with a workspace-centric UI. Relevant to weft as the benchmark for… |

### The other posture — CI and cloud

Not competitors on the same terms: these run without a developer present, on someone else's machine. Weft is deliberately local. They are here because they bound what a local tool should and should not try to be — and because Qodo PR-Agent shows the two postures are not exclusive.

| Project | Lang | License | Stars | What it is |
| --- | --- | --- | --- | --- |
| **GitHub Agentic Workflows** | Go | MIT | 5,000 | The most direct competitor to weft on the 'declare a repeatable agent workflow over my repo' job, and the strongest security architecture in the CI-native group. Workflows are Markdown files with YAML frontmatter, compiled by `gh aw compil… |
| **Claude Code Action** | TypeScript | MIT | 8.7k | The reference way to put Claude Code into GitHub Actions: @claude mentions in issues/PRs, issue assignment, or explicit prompts in a workflow file. Competes with weft for 'run an agent workflow on my repo' but at a much lower level of stru… |
| **GitHub Copilot coding agent / Agent HQ** | N/A (hosted service) | Proprietary, commercial… | — | The platform-incumbent answer to 'run an agent workflow on my repo', and the biggest structural threat to every project in this cluster. Agent HQ (announced late 2025, expanded through 2026) is mission control: assign tasks to Copilot, Cla… |
| **OpenAI Codex Cloud** | N/A (hosted); Codex… | Proprietary service; Co… | — | Cloud-hosted, task-parallel coding agent: each task runs in its own isolated sandboxed container preloaded with your repo, configured by AGENTS.md and setup scripts. Tasks start from the web, GitHub PRs, GitLab MRs, Linear issues, or Slack… |
| **Google Jules** | N/A (hosted); Actio… | Proprietary service; th… | — | Asynchronous coding agent: clones your repo into an ephemeral Google Cloud VM, writes a plan, executes multi-file changes, runs tests, and opens a PR — then destroys the VM. Notable contrast with Codex Cloud: Jules keeps network access on… |

### Standards and conventions

The interop weft is largely declining. `AGENTS.md` in particular is free, universal, and unread by weft — a local tool has no excuse for ignoring the file sitting in the repo it is already standing in.

| Project | Lang | License | Stars | What it is |
| --- | --- | --- | --- | --- |
| **AGENTS.md** | Markdown convention | Open/permissive (spec s… | — | The de facto configuration format for the whole 'run an agent on my repo' category — a README for agents, holding build commands, test commands, conventions, and security notes. It is the one interchange format every competitor in this clu… |
| **Model Context Protocol** | Spec in TypeScript… | MIT (spec and reference… | — | The interop substrate for tools/context, and — as of the Tasks extension — increasingly a substrate for *durable, long-running, human-gated* operations. weft already ships an MCP server; the strategic question is whether weft's gates, jour… |
| **Agent Client Protocol** | Rust (official libr… | Apache-2.0 | 4.1k | Standardizes the editor↔agent boundary the way LSP standardized editor↔language-server: JSON-RPC over stdio for local agents (agent runs as an editor subprocess), HTTP/WebSocket for remote (WIP). Reuses MCP's JSON representations where pos… |
| **Agent2Agent** | Spec (JSON-RPC 2.0… | Apache-2.0 | — | The complement to MCP: MCP connects an agent to tools, A2A connects an agent to another *opaque* agent that will not expose its internal state, memory, or tools. Relevant to weft as the standard shape for sub-workflow delegation across a t… |
| **Anthropic sandbox-runtime** | TypeScript / Node (… | Apache-2.0 | 5.1k | OS-level sandboxing for agents without containers: bubblewrap on Linux, Seatbelt (sandbox-exec) on macOS, a dedicated sandbox account with WFP egress filtering on Windows — plus a host-side proxy that enforces a network domain allowlist. T… |
| **Linear Agent Sessions** | N/A (GraphQL API +… | Proprietary | — | Not a workflow engine — the best-designed *host surface* for agent work in a tool humans already use. The Agent Session model makes an agent a delegate on an issue, with its lifecycle rendered inline in the issue thread. This is the answer… |

> **Not in this comparison:** Temporal, Restate, DBOS, Inngest, Trigger.dev, Vercel Workflow DevKit, Windmill, Hatchet, Golem and the rest of the durable-execution field. They are prior art for the journaling machinery weft uses, not competitors for the job it does — see [Appendix B](#appendix-b--where-the-durability-machinery-came-from). The same goes for the general agent frameworks (LangGraph, Mastra, CrewAI, AutoGen, Google ADK, Pydantic AI): none of them is repo-aware, and a team choosing how to run coding work is not choosing between weft and LangGraph.

---

## Part 3 — The comparison

18 dimensions, chosen because they separate tools that do this job rather than describing all of them. Durability sits at #14, as the instrument it is.

### Where weft stands

| # | Dimension | Standing | The short reason |
| --- | --- | --- | --- |
| 1 | What a workflow *is* | **Competitive** | Plain TS is the most expressive option; Spec Kit, goose and gh-aw got to 'checked-in artifact' first and with far less ceremony |
| 2 | Reviewable, versioned, diffable | **Leads** | A .ts file under code review, gated by `weft check` before it spends anything |
| 3 | Testable without spending tokens | **Leads** | `runWorkflow` + fixtures through real validation. **No other coding tool has this at all** |
| 4 | Typed hand-off between steps | **Leads** | Required schema + engine-side repair. Every coding harness surveyed says 'no typed step-result contract' |
| 5 | Repo conventions ingested | **Absent** | A write step gets a worktree stripped of AGENTS.md. Everyone else reads it by default |
| 6 | Change isolation | **Competitive** | Per-attempt worktrees are solid; container-use isolates the environment too, and Codex adds an OS sandbox |
| 7 | Write-scope enforcement | **Leads** | Declared paths, live denial, patch partition, quarantine. Only Roo's fileRegex came close, and it is archived |
| 8 | How the change lands | **Leads** | `ctx.integrate()` has no equivalent anywhere. It lands in your working tree — right for a local tool — but no verb takes it further |
| 9 | Test-gated completion | **Leads** | A required `ctx.check` gates run completion, and costs no model call |
| 10 | Built-in review patterns | **Competitive** | A real pattern library — against products publishing F1 numbers weft has never measured |
| 11 | Cross-vendor second opinion | **Competitive** | Per-step routing is the right shape; three provider ids and a Claude-only price table is not the right coverage |
| 12 | Mid-run human approval | **Leads** | Durable, schema-validated, reject-and-reopen. Every rival's approval dies with the process |
| 13 | Cost control per task | **Leads** | Hard token AND USD ceilings inherited across a run tree. SWE-agent is the only real peer |
| 14 | Long-task survival | **Leads** | The instrument, and it works — but it only pays off on workflows that outlive a session |
| 15 | Audit trail | **Competitive** | The richest record in the field, in a format only weft can read |
| 16 | Parallel throughput across tasks | **Behind** | Good inside one run; two runs sharing a tree is undefined behaviour |
| 17 | Where it runs, and what that costs | **By design** | Local-first is the posture, and it is the same one the harnesses it competes with take. The unpaid costs are local-tool basics: repo-root discovery, blob GC, a repo mutex |
| 18 | Distribution and practice | **Absent** | Unpublished, zero users, against 131.2k and 142.9k |

**Nine leads, five competitive, one behind, one by design, two absent** — and the shape is the finding. Weft leads on everything about *the workflow as an engineering artifact*: typed hand-off, testability, scoped writes, gated integration, test-gated completion, durable humans, hard cost ceilings. It is absent on everything about *fitting into the world it runs in*: the conventions file sitting in the repo, and anyone having heard of it.

### The dimensions in detail

#### 1. What a workflow *is*

**Weft.** A checked-in TypeScript program with a typed `input`/`output` schema. `await` is a sequential edge, `ctx.parallel` fans out, `ctx.pipeline` runs lanes, `if` on a typed field is a conditional edge. No DSL, no YAML, no graph builder — and no separate artifact to keep in sync with the program.

| | Project | How they do it |
| --- | --- | --- |
| 🟩 strong | GitHub Spec Kit | Markdown specs driven by slash commands — `/speckit.specify` → `plan` → `tasks` → `implement`, plus `analyze` and `converge` — over 30+ coding agents. The spec is the artifact, code is the build output. 131.2k stars, MIT. |
| 🟩 strong | Claude Code | Three stacked layers: Skills (markdown + frontmatter, loaded when relevant), slash commands, and subagents with their own context and tool permissions. Plus dynamic workflows, where the MODEL writes the JS orchestration from a natural-language task and you approve the phase list. |
| 🟩 strong | goose Recipes | YAML: title, instructions, typed `parameters` with Jinja substitution, sub-recipes, `retry.checks` as shell commands, and `response.json_schema`. The most complete declarative coding-workflow spec anyone ships. |
| 🟩 strong | gh-aw | YAML frontmatter (triggers, permissions, tools, engine) plus a markdown body telling the agent what to do; `gh aw compile` emits a checked-in `.lock.yml` Actions file. |
| 🟨 partial | OpenAI Codex CLI | TOML subagent files in `.codex/agents/`, each with name, description, model and effort. Composition is the model calling subagents, not declared control flow. |
| 🟨 partial | opencode | Agents as JSON blocks in `opencode.json` or markdown files in `.opencode/agents/` (filename becomes the id). Per-agent, not per-workflow. |
| 🟨 partial | Cline | `.clinerules` files plus agent-team config plus a TypeScript SDK. Three surfaces, no single workflow artifact. |
| 🟨 partial | Qodo PR-Agent | Fixed commands — `/describe`, `/review`, `/improve`, `/ask` — configured by file, not composed. The workflow is the product's, not yours. |
| 🟨 partial | SWE-agent | Declarative YAML configures the agent, its tools, the parser and templates — one agent loop, not a multi-step workflow. |
| 🟥 none | Aider | Chat commands in a REPL, with `--message` for one-shot batch use. Nothing to check in. |
| 🟥 none | container-use | An MCP server plus a `cu` CLI. Deliberately no workflow layer — it isolates and reviews, it does not orchestrate. |
| 🟥 none | Worktree managers | claude-squad, Crystal, Conductor, uzi, Vibe Kanban: a human moves cards or presses keys. No orchestration logic at all. |

#### 2. Is the workflow reviewable, versioned, diffable

**Weft.** It is a `.ts` file in `.weft/workflows/`. It goes through code review, `git blame` works on it, and `weft check` gates it (11 AST rules plus a best-effort `tsc` pass) before a run spends anything.

| | Project | How they do it |
| --- | --- | --- |
| 🟩 strong | GitHub Spec Kit | Specs, plans and task lists are checked-in markdown — the whole method is that they are reviewed artifacts. |
| 🟩 strong | gh-aw | Both the source markdown and the compiled `.lock.yml` are committed, so a reviewer sees exactly what CI will run. |
| 🟩 strong | goose Recipes | A YAML file in the repo, parameterised and shareable. |
| 🟩 strong | Claude Code (skills/commands) | Skills, commands and subagent definitions are files, distributable as plugins through a marketplace. |
| 🟩 strong | opencode / Codex CLI / Cline | Agent definitions and rules are all committed files. |
| 🟥 none | Claude Code (dynamic workflows) | The script is model-authored per task and essentially disposable. Nothing is reviewed except the phase list, in the moment. |
| 🟥 none | Aider / worktree managers / container-use | There is no workflow artifact to review. |

#### 3. Testable without spending tokens

**Weft.** `runWorkflow` drives the workflow to a terminal state on a private in-memory engine; `mock().on({ key }, responder)` fixtures pass through the engine's NORMAL schema validation and journaling — a fixture that would not pass in production fails the test. `exec`, `bash`, `fetch`, `env` and `answers` fixtures included, so a workflow with human steps and shell checks runs end to end in CI.

| | Project | How they do it |
| --- | --- | --- |
| 🟨 partial | SWE-agent | The strongest EVALUATION story anywhere — SWE-bench, SWE-smith, a stable trajectory format — but that is benchmark measurement, not unit testing, and it spends tokens. |
| 🟥 none | Claude Code | Explicitly no offline or mocked execution mode. Every workflow run spends tokens. |
| 🟥 none | goose Recipes | No mocked-run mode; `retry.checks` verify the OUTPUT of a real run. |
| 🟥 none | gh-aw | `gh aw compile` validates the workflow's shape, not its behaviour. |
| 🟥 none | Cline | The SDK makes programmatic driving possible — the raw material for a harness — but nothing is published. |
| 🟥 none | OpenHands | Conventional pytest plus benchmark harnesses; no published zero-model-call replay. |
| 🟥 none | Spec Kit / opencode / Codex CLI / Aider / PR-Agent | No harness in any of them. |

#### 4. Typed hand-off between steps

**Weft.** `schema` is REQUIRED on every `agent` and `human.*` call and on workflow I/O. The provider returns raw; the ENGINE validates against the real Standard Schema and, on failure, calls `provider.repair()` in the SAME session with the validation errors, up to `limits.repair`. A `z.string()` field is still prose — the guarantee is that what flows BETWEEN steps has a shape you declared.

| | Project | How they do it |
| --- | --- | --- |
| 🟨 partial | Claude Code (dynamic workflows) | `agent(prompt, { schema })` resolves to a parsed object validated at the tool-call layer — the closest thing to weft here. But there is no documented repair loop: it resolves to `null` on failure and the caller does `.filter(Boolean)`, which erases the reason. |
| 🟨 partial | goose Recipes | `response.json_schema` enforces structured output for the WHOLE RUN — the same instinct, arrived at independently, but one schema at the boundary rather than a contract between steps. |
| 🟨 partial | Qodo PR-Agent | JSON-based prompting produces structured findings the tool then renders; the contract is internal to the product, not something you compose against. |
| 🟥 none | Cline | Tool-call schemas validated per the provider's function-calling contract, with retry on malformed XML. No typed step-result contract across a workflow. |
| 🟥 none | Codex CLI | Subagent results return to the main thread as SUMMARIES; no structured output contract for a subagent. |
| 🟥 none | opencode | Tool schemas validated per provider; step-level structured output is not a documented primitive. |
| 🟥 none | OpenHands | Pydantic models validate the EVENT envelope and tool arguments — not 'this step must return a value of this shape'. |
| 🟥 none | Aider | Edits are validated structurally by edit format with retry on malformed diffs. That validates the DIFF, not a step result. |
| 🟥 none | SWE-agent | The unit is the action, not the step result. |
| 🟥 none | Spec Kit | Specs, plans and tasks are prose markdown all the way down. The hand-off between phases is a document. |
| 🟥 none | container-use / worktree managers | No workflow layer, so nothing to type. |

#### 5. Repo conventions ingested (AGENTS.md, CLAUDE.md, rules)

**Weft.** **None.** A weft write step hands an agent a fresh worktree stripped of the conventions every other runner in the ecosystem reads by default. `ctx.fs.read` exists, so a workflow author can pass conventions in by hand, but nothing does it for you and no example does it.

| | Project | How they do it |
| --- | --- | --- |
| 🟩 strong | Claude Code | CLAUDE.md at every level, plus skills, plus output styles. |
| 🟩 strong | OpenAI Codex CLI | AGENTS.md — the convention Codex popularised and now shared across vendors. |
| 🟩 strong | Gemini CLI | GEMINI.md and AGENTS.md. |
| 🟩 strong | Cline | `.clinerules` for coding standards and architecture constraints. |
| 🟩 strong | Qodo PR-Agent | Reads repository `AGENTS.md` files and `SKILL.md` definitions to steer review. |
| 🟩 strong | GitHub Spec Kit | `/speckit.constitution` makes project principles an explicit, versioned input to every later phase. |
| 🟩 strong | opencode / goose / Aider | Rules files, `.goosehints`, and Aider's tree-sitter repo-map respectively — different mechanisms, same job. |
| 🟩 strong | gh-aw | The markdown body is where conventions go, and the repo is right there. |

#### 6. Change isolation

**Weft.** A write step gets a PER-ATTEMPT worktree at `tmpdir/weft-worktrees/<runId>/<seq>.<attempt>`, seeded from `integrationBaseCommit` — a dangling-ref-pinned commit of the current tracked+untracked tree — so later writers build on earlier `ctx.integrate()` results rather than on HEAD.

| | Project | How they do it |
| --- | --- | --- |
| 🟩 strong | container-use (Dagger) | The best in the field: DUAL isolation — a git worktree/branch for the code AND a Dagger container for the process, so installs, daemons, ports and env mutations are discarded with the step. The hole every worktree-only tool leaves open. |
| 🟩 strong | OpenAI Codex CLI | Worktree per subagent PLUS an OS sandbox (Seatbelt/Landlock/WFP), with `.git` protected even in workspace-write mode. |
| 🟩 strong | Claude Code | `claude --worktree <name>` on branch `worktree-<name>`, with base controlled by `worktree.baseRef`. Enforced, not advisory. |
| 🟩 strong | Worktree managers | claude-squad, Crystal, Conductor, uzi, Vibe Kanban — worktree + branch per agent is literally the product; uzi also allocates per-agent dev-server ports. |
| 🟩 strong | SWE-agent | Docker container per instance via SWE-ReX, each with its own checkout; output is a unified diff per instance. |
| 🟩 strong | OpenHands | Workspace as an abstraction — local, Docker, Kubernetes or remote — with ephemeral per-agent workspaces. |
| 🟩 strong | Sculptor | Worktree + branch per workspace with an experimental container backend, plus Pairing Mode syncing isolated work back to the local checkout. |
| 🟨 partial | Cline agent teams | Shadow-git checkpoints isolate HISTORY, not the tree — team specialists share `cwd`, so parallel members can clobber each other. |
| 🟥 none | Aider / goose / opencode | Operate directly on the working tree. |

#### 7. Write-scope enforcement

**Weft.** `write: { paths: [...], also: [...], mode: 'warn' | 'strict' }` makes a step a write step. On Claude the scope is enforced LIVE through `canUseTool` — scope-matched edits, symlink-escape realpath checks, a read-only bash allow-list, traversal and shared-git-metadata denial — and post-hoc by partitioning the captured patch, with `strict` quarantining an out-of-scope patch. **Asymmetric:** Codex has no permission hook, so there `strict` means post-hoc diffing only.

| | Project | How they do it |
| --- | --- | --- |
| 🟩 strong | gh-aw | Structurally rather than by policy: the agent job holds NO write credentials, and can only emit schema-validated 'safe outputs' that a separate, differently-privileged job applies. A compromised agent cannot write. |
| 🟨 partial | Roo Code (archived) | `fileRegex` write restrictions per custom mode — a mode could be forbidden from touching anything but `*.md`. The closest prior art for path-scoped writes, and the project archived 2026-05. |
| 🟨 partial | opencode | Per-agent permission map over read / edit / bash / glob / grep / task, each `allow ／ ask ／ deny`. Capability-level, not path-level. |
| 🟨 partial | OpenAI Codex CLI | `sandbox_mode` confines writes to the workspace with `.git` protected — coarse-grained, and uniform across subagents. |
| 🟨 partial | Claude Code | Statically blocks edits into the main checkout when running in a worktree, and screens Bash for escapes. A screen, not a path-scope declaration. |
| 🟥 none | Aider / Cline / goose / worktree managers | No path scoping. |

#### 8. How the change lands

**Weft.** It does not, until you say so. A write step returns a PATCH blob; out-of-scope files are flagged or quarantined; nothing touches the integration tree until `ctx.integrate()`, which is itself a journaled step with `onConflict: 'ask' | 'fail' | 'agent'` and returns a ledger. **A run that ends with un-integrated, un-discarded patches fails.** What weft does NOT do: open a pull request.

| | Project | How they do it |
| --- | --- | --- |
| 🟩 strong | gh-aw | Safe outputs include `create-pull-request` and `push-to-branch`, applied by a separate job. The change lands where review already happens. |
| 🟩 strong | Copilot coding agent / Codex Cloud / Jules | A pull request is the unit of delivery and the review surface, on the largest installed bases in the category. |
| 🟩 strong | Qodo PR-Agent / CodeRabbit | Land as review comments and committable suggestions on an existing PR — the whole product is the last mile weft skips. |
| 🟨 partial | Sculptor / Conductor | Built-in review UI with PR creation from the workspace. |
| 🟨 partial | container-use / worktree managers | A branch, and a human merges it. `cu diff` / `cu merge` / `cu apply` are good verbs, but there is no policy and no ledger. |
| 🟨 partial | Aider | Every edit is an auto-commit with a sensible message and `/undo` reverts — the strongest git INTEGRATION and the weakest isolation. |
| 🟥 none | Cline / opencode / goose | Edits land in the working tree as they happen. |

#### 9. Test-gated completion

**Weft.** `ctx.check(name, { exec: ['pnpm','test'], required: true })` is a journaled step returning `{ status, evidence }`; a failing REQUIRED check gates the run's completion. Checks are free — they are shell, not a paid subagent turn.

| | Project | How they do it |
| --- | --- | --- |
| 🟩 strong | goose Recipes | `retry { max_retries, checks }` where checks are shell commands validating the run's output — declarative success criteria, and the closest peer to `ctx.check`. |
| 🟩 strong | Aider | `--test-cmd` and `--lint-cmd` run after every change and feed failures back for automatic fixing. The tightest edit→verify loop in the field. |
| 🟩 strong | gh-aw | It is a GitHub Actions job: the rest of the pipeline is right there, and a failing job blocks the safe-output apply. |
| 🟨 partial | SWE-agent | Tests decide the benchmark score, but they are the harness around the agent, not a gate inside its loop. |
| 🟨 partial | Claude Code | Run tests by spending a subagent turn; the documented 'run tsc until it passes' pattern pays a model call every round. No engine-level gate. |
| 🟥 none | Codex CLI / Cline / opencode / OpenHands | Running tests is something the agent may choose to do, not something that gates anything. |

#### 10. Built-in review patterns (find→refute, judge panel, best-of-N)

**Weft.** `@techery/weft-stdlib` ships `adversarialVerify` (strict majority so an even panel does not kill on a tie), `judgePanel` (best-votes with a mean-score tiebreak, judge schema pinned to the attempt count), `loopUntilDry`, `completenessCritic` and `multiModalSweep` — as ordinary keyed steps, so they replay and test like anything else. **Unproven:** weft publishes no precision number for any of them.

| | Project | How they do it |
| --- | --- | --- |
| 🟩 strong | Qodo Merge / PR-Agent | Multi-agent architecture with specialised reviewers running simultaneously rather than one generalist pass — and a published F1 of 60.1% across eight tools in its own February 2026 benchmark. |
| 🟩 strong | CodeRabbit | AI layered over 40+ bundled deterministic linters and SAST scanners; topped Martian's independent 2026 benchmark at 51.2% F1 with the broadest platform coverage. |
| 🟩 strong | Greptile | Indexes the entire codebase before commenting on a diff — a different bet (whole-repo context over panel structure) with 82% bug-catch claimed in its own July 2025 test. |
| 🟨 partial | Claude Code | `/code-review` and ultrareview are agentic review passes with real structure, but they are commands, not composable patterns you build a workflow from. |
| 🟨 partial | SWE-agent | The research lineage that established find-then-verify — as benchmark methodology rather than a shipped library. |
| 🟥 none | goose / Cline / opencode / Codex CLI / Aider | Review is whatever you prompt for. |

#### 11. Cross-vendor second opinion

**Weft.** One option on one step: `ctx.agent(prompt, { provider: 'codex', ... })`. A cross-vendor refutation panel is a per-step routing choice, and the engine — not the vendor — validates what comes back. **Caveat:** only `claude`, `codex` and `mock` exist, the built-in price table is Claude-only, and `strict` scopes mean different things per provider.

| | Project | How they do it |
| --- | --- | --- |
| 🟩 strong | Cline | Anthropic, OpenAI, Gemini, 200+ via OpenRouter, Bedrock, Vertex, Ollama/LM Studio, with per-mode and per-specialist model selection. |
| 🟩 strong | opencode | Models.dev-backed catalogue with OAuth flows and per-agent overrides — the strongest genuinely model-agnostic story in the field. |
| 🟩 strong | OpenHands | A superset: LiteLLM for models, and Agent Client Protocol so whole third-party AGENTS (Claude Code, Codex, Gemini CLI) are pluggable. |
| 🟩 strong | Aider | Architect/editor split is real per-role routing with a demonstrated cost/quality win — an expensive model plans, a cheap one applies. |
| 🟩 strong | Qodo PR-Agent | GPT, Claude (incl. Opus 5), Gemini, DeepSeek, Mistral, plus LiteLLM for Bedrock/Vertex/Ollama/OpenRouter. |
| 🟩 strong | Copilot Agent HQ | Copilot, Claude and Codex agents under one control plane with one review surface. |
| 🟨 partial | gh-aw | Copilot, Claude Code, Codex, Gemini and Pi — selected in frontmatter, per workflow rather than per step. |
| 🟨 partial | Claude Code | Per-subagent routing, but strictly inside the Anthropic family. |
| 🟨 partial | OpenAI Codex CLI | Per-subagent model AND reasoning effort, but OpenAI models only. |

#### 12. Mid-run human approval

**Weft.** `ctx.gate` and `ctx.human.ask/approve/review` suspend the run DURABLY. The answer can arrive hours later from the CLI, the web UI, or the session that started the run, and is validated against the step's schema; a bad answer journals `human.rejected` and REOPENS the request rather than failing the run. Provenance is recorded: `answeredBy: human | policy | timeout`.

| | Project | How they do it |
| --- | --- | --- |
| 🟨 partial | OpenHands | The best-designed in-process gating: `AlwaysConfirm()` / `NeverConfirm()` / `ConfirmRisky()` as first-class policy objects. In-process — kill it and the pending confirmation is gone. |
| 🟨 partial | Cline | The best per-action approval UX anywhere: Plan mode explores and asks before Act mode touches anything, every edit and command surfaces with a diff. In-process. |
| 🟨 partial | OpenAI Codex CLI | `approval_policy` with untrusted / on-request / never. In-process. |
| 🟨 partial | opencode | Per-agent `allow ／ ask ／ deny` maps — declarative and fine-grained, still in-process. |
| 🟨 partial | Sculptor / Vibe Kanban | Review-and-commit UIs with inline diff commenting — approval AFTER the work, which is a deliberate and defensible different bet. |
| 🟨 partial | container-use | Explicitly review-after rather than approve-during: let the agent run fully isolated, then `cu diff`. |
| 🟥 none | Claude Code (dynamic workflows) | Documented: 'No mid-run user input. Only agent permission prompts can pause a run.' Multi-stage sign-off means splitting into separate workflows. |
| 🟥 none | gh-aw | No blocking gate; safety is structural instead. |

#### 13. Cost control per task

**Weft.** `Budget.charge` propagates up the parent chain; `remainingTokens`/`remainingUsd` take `min(own, ancestor headroom)`; a run tree shares one ceiling and `reserveCall` PARKS rather than refusing when a lane would overrun. A USD-only ceiling with a provider that reports no cost and has no configured price REFUSES the dispatch rather than charging $0 silently.

| | Project | How they do it |
| --- | --- | --- |
| 🟩 strong | SWE-agent | `--agent.model.per_instance_cost_limit` genuinely stops an instance, hardened across thousands of benchmark runs. Per-instance and total, but no parent/child inheritance. |
| 🟨 partial | goose Recipes | `max_turns` is an enforced structural cap on iterations — not a spend ceiling. |
| 🟨 partial | OpenAI Codex CLI | Reasoning-effort tiers, cheaper model variants, and a concurrency cap on subagents. Structural levers, not a ceiling. |
| 🟨 partial | Roo Code (archived) | A cost ARCHITECTURE rather than a cap: subtasks return summaries not transcripts, keeping the orchestrator's context small. |
| 🟥 none | Claude Code | Documented as advisory: past 25 scheduled agents or 1.5M projected tokens, 'the warning does not pause or limit the run'. |
| 🟥 none | Cline / opencode / Aider / OpenHands | Detailed per-task token and USD accounting, zero enforcement. They tell you after you spent it. |

#### 14. Does a long task survive the session (the instrument)

**Weft.** Every step is journaled; a resume re-executes the workflow body and serves completed steps from the journal, matching by CONTENT so editing the script between runs is tolerated. This is plumbing, not the product — it earns its keep exactly when a workflow is long enough or blocked long enough to outlive the session that started it, which is the case for an overnight audit or a gate waiting on a person.

| | Project | How they do it |
| --- | --- | --- |
| 🟩 strong | Codex Cloud / Copilot coding agent / Jules | Server-side execution: the task survives your laptop closing because it was never on your laptop. |
| 🟨 partial | OpenHands | A persistence directory per conversation with documented pause/resume — state restoration rather than replay, so no step-level salvage. |
| 🟨 partial | Cline agent teams | `task-board.json` / `mailbox.json` persist and survive restarts, but that is coordination state, not step results. |
| 🟥 none | Claude Code | Explicit: 'If you exit Claude Code while a workflow is running, the next session starts the workflow fresh.' Transcripts are durable; workflow runs are not. |
| 🟥 none | goose / Aider / opencode / Codex CLI / container-use | Kill the process and the work in flight is gone. |

#### 15. Audit trail of what the agent actually did

**Weft.** The journal plus two generated records: `report.md` (Outcome / Changes / Checks / Ledger / Failures & drops / Remaining risk / Next step) and the live tree. `weft explain <run> <step>` shows one step's route, prompt, output, usage and attempts; `weft diff <a> <b>` compares two runs by keyed step output.

| | Project | How they do it |
| --- | --- | --- |
| 🟩 strong | Aider | Every AI change is a git commit with a sensible message — the simplest and most durable audit trail in the field, and the reason people still reach for it. |
| 🟩 strong | Cline | Shadow-git repository committing a full tree snapshot after every tool use, giving file-level undo including untracked files. |
| 🟩 strong | container-use | `cu log` and `cu diff` per environment: a complete record of what each agent did, discardable by deleting a branch. |
| 🟩 strong | SWE-agent | The trajectory format is a stable, publishable artifact — the reason its results are reproducible. |
| 🟨 partial | Claude Code | `/workflows` shows the phase tree, per-agent tokens and any agent's tool calls live, and can pause a run or restart one agent — a better CONTROL surface than weft's, over a less durable record. |
| 🟨 partial | Worktree managers | A diff view per session, and that is the record. |

#### 16. Parallel throughput across tasks

**Weft.** Within one run: `ctx.parallel` / `ctx.pipeline` with a global semaphore at `min(16, cpus−2)` and a 4096-item fan-out cap. Across runs: nothing. Two runs sharing a working tree both stage and mutate the real tree at `rt.cwd`, and the ownership lease is per-RUN, not per-repo.

| | Project | How they do it |
| --- | --- | --- |
| 🟩 strong | Worktree managers | claude-squad, uzi, Vibe Kanban, Conductor, Crystal exist for exactly this: many agents on many tasks at once, a human as scheduler. uzi even broadcasts one instruction to every running agent. |
| 🟩 strong | Claude Code | 16 concurrent (fewer on low-CPU), 1,000 agents per run, plus prompt-cache-aware stagger so a fan-out pays the system-prompt prefix once. |
| 🟩 strong | Copilot Agent HQ | Mission control across web, VS Code and mobile for many concurrent agent tasks. |
| 🟩 strong | container-use | One environment per agent, unlimited in principle, each fully isolated. |
| 🟨 partial | Cline agent teams | Specialists run in parallel but share `cwd`, so throughput is bought with a clobbering risk. |
| 🟥 none | Aider / goose / opencode | One agent, one tree. |

#### 17. Where it runs — and what that posture costs

**Weft.** **Local, on a developer's own machine, by design.** A CLI plus an MCP server so a Claude Code or Codex session can drive it, plus a loopback-only daemon serving a single-page UI. No server, no database, no account, no code leaving the machine, and the credentials used are the ones already sitting in the developer's shell. State is `<cwd>/.weft`. The costs are real and mostly unpaid: no repo-root discovery (running from a subdirectory silently targets a different, empty `.weft`), no blob GC, and no repo-level mutex, so two runs sharing a working tree is undefined behaviour.

| | Project | How they do it |
| --- | --- | --- |
| 🟩 strong | Claude Code / Codex CLI / opencode / goose / Aider | The same posture and the bar weft is actually competing against for a developer's attention: one install, entirely local, nothing to operate. Several of them also offer a hosted mode, which weft deliberately does not. |
| 🟩 strong | container-use / worktree managers | Local by construction — a laptop, a repo, several agents. |
| 🟩 strong | Spec Kit | A local CLI that bolts onto whichever agent you already run — the least infrastructure of anything here. |
| 🟩 strong | Qodo PR-Agent | Runs both ways: a local CLI and Docker image, or GitHub Actions and webhooks. The clearest demonstration that local-first and CI need not be exclusive. |
| 🟩 strong | Cline / Roo / Continue | IDE-native, which is even closer to where the developer is than a terminal. |
| 🟨 partial | gh-aw | CI-native by construction, which is a genuinely different product: the workflow runs on GitHub's machines against GitHub's checkout, with no developer present. Better for scheduled and event-driven work, unavailable for the thing you want to watch. |
| 🟨 partial | Codex Cloud / Copilot coding agent / Jules | Hosted. The task survives your laptop closing because it was never on it — bought with sending the repo to a vendor and losing local tooling. |

#### 18. Distribution and practice adoption

**Weft.** Design preview. Not on npm. Zero users. The engineering around it is real — 16 packages versioned together, a tag-driven release pipeline with `verify:packing` and `verify:install`, CI on node 22 and 24 — but nothing has shipped.

| | Project | How they do it |
| --- | --- | --- |
| 🟩 strong | GitHub Spec Kit | 131.2k stars, MIT, integrations for 30+ coding agents. The spec-driven method has become a named practice. |
| 🟩 strong | Claude Code | 142.9k stars on the issue tracker; Agent Skills published as an open standard in Oct 2025 with official skill repos past 157k stars, a plugin system and a Skills marketplace launched April 2026. |
| 🟩 strong | opencode | 201k stars, MIT, ~8M reported MAU (unverified). |
| 🟩 strong | goose | 53.4k stars and, uniquely, vendor-neutral Linux Foundation governance — a procurement advantage for a layer that brokers competing vendors. |
| 🟩 strong | Qodo PR-Agent | 12.7k stars, community-owned since April 2026 and reverted from AGPL-3.0 to Apache-2.0. |
| 🟨 partial | gh-aw | 5k stars, MIT, GitHub Next — early but with the strongest possible distribution channel. |
| 🟥 none | Category attrition | Worth naming: Flowise archived at 55.4k, Roo Code archived at 24.3k, Vibe Kanban sunsetting at 27.9k. Being right about the mechanism is not what decided those. |

---

## Part 4 — The eight tools weft is actually competing with

Ordered by how much of weft's job they already do.

### Claude Code — skills, subagents, and dynamic workflows

**Overlap.** The closest competitor by use case, and it is bundled free with one of the two agents weft depends on. It has the whole stack: skills and slash commands as checked-in markdown, subagents with their own context and tool permissions, agent teams, enforced `--worktree` isolation, hooks, plugins, a marketplace, and dynamic workflows with the same vocabulary weft uses — `agent`, `parallel`, `pipeline`, `phase`, `budget`, nested `workflow()`, a `Date.now()`-throws fence, `isolation: 'worktree'` — down to byte-identical caps (16 concurrent, 15 soft / 1000 hard agents, 4096 fan-out).

**Where they diverge.** Two different products wearing similar vocabulary. Claude Code's dynamic workflows are **model-authored per task and disposable**: you approve a phase list, it runs, nothing is checked in. Weft's are human-authored, reviewed, versioned, and unit-tested. Claude Code has no mid-run human input at all ("only agent permission prompts can pause a run"), no offline test mode ("every workflow run spends tokens"), advisory-only cost warnings, and process-scoped resume. Weft has all four and none of the distribution. The other direction is just as real: Claude Code's `/workflows` panel can pause a run, kill an agent, or **restart one agent in place** — a control surface weft has no equivalent for, over a record that does not survive the session.

### GitHub Spec Kit — 131.2k stars, and the practice weft is competing with

**Overlap.** The same core conviction: a coding process should be a checked-in artifact, not a chat transcript. `/speckit.constitution` establishes principles, `specify` defines requirements, `plan` produces a technical strategy, `tasks` breaks it down, `implement` executes, `converge` validates the codebase back against the spec. It is agent-agnostic across 30+ harnesses, MIT, and it turned "spec-driven development" into a named practice in about a year.

**Where they diverge.** Spec Kit's artifacts are **prose all the way down** — the hand-off between phases is a markdown document, and nothing validates that `tasks` actually reflects `plan`. Weft's hand-off is a typed value the engine checks. Spec Kit has no isolation, no scopes, no cost ceilings, no gates, no test harness; it steers an agent, it does not constrain one. But it solved the problem weft has not: a developer can adopt it in ten minutes, on the agent they already use, without learning a new programming model.

### goose Recipes — the declarative version of the same idea

**Overlap.** The closest thing to weft's thesis that already ships, from a Linux Foundation project at 53.4k stars. A recipe is YAML with typed parameters, sub-recipes, `retry { max_retries, checks }` where checks are shell commands, and — arrived at independently — `response.json_schema`, which **enforces structured output** from a run. That is weft's schema conviction and weft's `ctx.check` conviction in a declarative file.

**Where they diverge.** YAML is the ceiling. Recipes cannot express conditionals, loops over computed data, or typed values passed between sub-recipes — precisely the wall weft's plain-TypeScript model exists to break through. `response.json_schema` types the run's boundary, not the seam between steps. And goose runs on your working tree: no worktrees, no scopes, no patch flow, which is its weakest axis against weft.

### Qodo PR-Agent and the review products — what `review.ts` competes with

**Overlap.** Weft's flagship example reviews changed files, finds bugs, and refutes them. PR-Agent (12.7k stars, Apache-2.0, community-owned since April 2026) does `/describe`, `/review`, `/improve`, `/ask` across GitHub, GitLab, Bitbucket, Azure DevOps and Gitea, in ~30 seconds per tool, over any provider via LiteLLM, reading `AGENTS.md` and `SKILL.md` for repo context. Qodo Merge 2.0 runs specialised reviewers in parallel rather than one generalist pass — structurally the same bet as `adversarialVerify`.

**Where they diverge, and it is uncomfortable.** They have **numbers**. Qodo posted 60.1% F1 across eight tools in its February 2026 benchmark; CodeRabbit topped Martian's independent 2026 benchmark at 51.2% F1; Greptile claims 82% bug-catch by indexing the whole codebase first. Weft's `adversarialVerify` has a carefully-designed strict-majority rule, a documented tie-breaking policy, and **no published precision figure at all**. The engineering is better; the evidence does not exist. What weft has that they do not: the pattern is *yours* — you can change the panel, swap a vendor, add a stage, and unit-test the result — where theirs is a product's fixed pipeline.

### gh-aw — the strongest safety architecture in the field

**Overlap.** "Declare a repeatable agent workflow over my repo" in a checked-in file: YAML frontmatter for triggers, permissions, tools and engine; a markdown body for the task; `gh aw compile` producing a `.lock.yml` a reviewer can read.

**Where they diverge.** gh-aw runs in CI without a developer present — a different posture from weft's deliberately local one — and its safety model is structural rather than policy-based: the agent job holds **no write credentials**, and can only emit schema-validated "safe outputs" that a separate, differently-privileged job applies. A compromised agent physically cannot write. Weft's equivalent is a policy enforced by a tool hook that works fully on one provider and not at all on the other. The lesson worth stealing is the shape, not the CI: *the thing that proposes a change should not be the thing that has permission to make it.*

### container-use (Dagger) — the purest expression of weft's isolation idea

**Overlap.** Every agent gets its own git branch **and** its own container; review is `cu diff` / `cu log` / `cu merge`; discarding a failure is deleting a branch. Same conviction that agent writes must be quarantined until a human looks.

**Where they diverge.** It isolates one layer deeper than weft — the container means installs, daemons, ports and env mutations are discarded with the step, a hole weft's worktrees leave wide open — and has no workflow layer whatsoever: no steps, no ordering, no schema, no checks, no cost tracking. It is the missing bottom half of weft's isolation and the missing top half of weft's product, in one MCP server.

### OpenAI Codex CLI — simultaneously a dependency and a rival

**Overlap.** Weft's `AgentProvider` puts Codex behind the same interface as Claude, so it is half the cross-vendor story. Its own 2026 additions overlap directly: TOML-declared subagents with per-agent model and reasoning effort, automatic worktree per subagent, and `max_concurrent_threads_per_session`.

**Where they diverge.** Codex pairs its worktree with a real **OS sandbox** — Seatbelt, Landlock, WFP — with `.git` protected even in workspace-write mode, inherited by every subagent. Weft has no security boundary at all and says so. In the other direction, Codex subagents return **summaries** to the parent thread, with no structured output contract, no checks, and no cost ceiling. And the asymmetry cuts weft: because Codex exposes no permission hook, `write: { mode: "strict" }` means live denial on Claude and post-hoc diffing on Codex — one advertised guarantee, two behaviours.

### Cline agent teams — the mainstream agent growing into an orchestrator

**Overlap.** A coordinator agent spawning specialists that coordinate through persisted `task-board.json` / `mailbox.json` state, available as an extension, a CLI and a TypeScript SDK, with `.clinerules` for conventions and per-specialist model selection across 200+ models. It is the closest thing to weft's orchestration layer that is *also* a tool people use every day.

**Where they diverge.** Specialists share `cwd` — the docs do not specify worktree isolation for team members, so parallel specialists can clobber one another, exactly the failure weft's per-attempt worktrees exist to prevent. There is no typed contract between team members, no test harness, and no hard ceiling on a team run. But Cline's per-action approval UX — Plan mode exploring and asking before Act mode touches anything, every edit surfacing with a diff — is better than anything weft shows a developer today.

---

## Part 5 — What is genuinely weft's own, and what is missing

### Unique strengths

Each is paired with who else has it, because most "unique" features in this category are not.

**A typed contract between steps, enforced by the engine rather than the vendor.** `schema` is required on every `agent` and `human.*` call. The provider returns raw; the engine validates against the real Standard Schema and, on failure, calls `provider.repair()` in the same session with the validation errors. A lying provider cannot smuggle a value past the contract.

> *Who else:* Nobody in the coding field. The research notes read "no typed step-result contract" for Cline, Codex CLI, opencode, OpenHands, Aider, SWE-agent and every worktree manager. goose Recipes types the run's boundary with `response.json_schema`; Claude Code's dynamic workflows type one agent call and resolve to `null` on failure, which erases the reason. The typed-LLM-IO libraries — Instructor, BAML, Pydantic AI — do this half better than weft and do none of the rest.

**A workflow you can unit-test without spending a token.** `runWorkflow` drives the workflow on a private in-memory engine; `mock()` fixtures pass through the engine's *normal* schema validation and journaling, so a fixture that would not pass in production fails the test. `exec`, `bash`, `fetch`, `env` and `answers` fixtures cover the rest.

> *Who else:* **Nothing in this field, at all.** Claude Code is explicit that every workflow run spends tokens. SWE-agent's benchmark harness is the nearest relative and it is measurement, not unit testing. Outside the coding field, Pydantic AI's `TestModel` and Inngest's step-level test engine are the shape of the idea — which makes its absence here more surprising, not less.

**Declared write scopes, enforced live, with the patch as the unit of work.** `write: { paths }` makes a step a write step; on Claude the scope is enforced through `canUseTool` before an edit lands — scope matching, symlink-escape realpath checks, a read-only bash allow-list, traversal and shared-git-metadata denial — and again post-hoc by partitioning the captured patch, with `strict` quarantining an out-of-scope one.

> *Who else:* Roo Code's per-mode `fileRegex` write restrictions were real prior art and the project archived in May 2026. opencode's per-agent `allow | ask | deny` map is capability-level, not path-level. Codex's `workspace-write` sandbox is coarse. Nobody else declares paths. **The caveat is load-bearing:** on Codex there is no permission hook, so `strict` degrades to post-hoc diffing — one advertised guarantee with two behaviours and no conformance suite to catch it.

**`ctx.integrate()` — the merge itself as a resumable, policy-driven step.** An outer step per patch wrapping nested snapshot and apply sub-steps, `onConflict: 'ask' | 'fail' | 'agent'`, an agent resolver whose `resolved: true` self-report is *not trusted* (conflict markers are re-read from disk), and a run that ends with un-integrated, un-discarded patches **fails**.

> *Who else:* Nobody. Every worktree-based tool — Claude Code, container-use, claude-squad, Crystal, Conductor, Codex CLI, Sculptor, Vibe Kanban — produces a branch and leaves merging to git and a human. gh-aw's safe-outputs job is the nearest philosophical cousin (deferred, validated application by a differently-privileged actor) and has no diff, conflict or tree semantics.

**Test-gated completion that costs nothing.** `ctx.check(name, { exec, required: true })` is a journaled step returning `{ status, evidence }`, and a failing required check gates the run's completion. It is shell, not a paid subagent turn.

> *Who else:* goose's `retry.checks` is the same idea declaratively, and Aider's `--test-cmd` feedback loop is the tightest edit→verify cycle in the field. Claude Code's own documented pattern is "run tsc until it passes" — paying a subagent every round for what weft gets free.

**Durable, schema-validated human steps.** `ctx.gate` and `ctx.human.*` suspend the run across process death; the answer is validated against the step's schema, a bad answer journals `human.rejected` and **reopens** the request rather than failing the run, and provenance is recorded as `answeredBy: human | policy | timeout`.

> *Who else:* Nobody in the coding field. Cline, Codex CLI, opencode, Gemini CLI and OpenHands all have excellent per-action approval and all of it dies with the process. Claude Code's dynamic workflows have none at all. container-use and Sculptor make the opposite and defensible bet: review after, not approve during.

**Hard token and USD ceilings, inherited across a run tree.** `remainingTokens`/`remainingUsd` take `min(own, ancestor headroom)`; `reserveCall` parks rather than refusing; a USD-only ceiling with a provider that reports no cost and has no configured price refuses the dispatch rather than charging $0 silently.

> *Who else:* SWE-agent's `per_instance_cost_limit` is the only real peer and has no inheritance. goose's `max_turns` and Codex's effort tiers are structural caps, not spend ceilings. Claude Code is explicit that its warning "does not pause or limit the run". Everyone else accounts and does not enforce.

### Gaps, ranked by severity

🔴 `CRITICAL` — **No repo conventions are ingested.** A weft write step hands an agent a fresh worktree stripped of the `AGENTS.md`, `CLAUDE.md` or rules file that every other runner in the ecosystem reads by default. The agent then writes code that violates house style, and the review step has no idea what house style is. This is free interop, sitting in the repo weft is already standing in.

> *Done better by:* Codex CLI (AGENTS.md, the convention it popularised), Claude Code (CLAUDE.md at every level), Gemini CLI (GEMINI.md), Cline (`.clinerules`), Aider (tree-sitter repo-map), Qodo PR-Agent (reads AGENTS.md *and* SKILL.md to steer review), Spec Kit (`/speckit.constitution` as a versioned input to every phase). Effectively everyone.

🔴 `CRITICAL` — **No security boundary, on the machine where it hurts most.** The README correctly disclaims `node:vm` as a determinism fence. But the *agent's* process is unsandboxed, worktree isolation is convention (a step can write outside its worktree and weft learns of it only from provider-self-reported `filesTouched`), and `ctx.fetch` allows **every host** unless `fetchAllow` is configured, which it is not by default. Under a local-first posture this is worse, not better: the blast radius is a developer's real checkout, real SSH keys, and real cloud credentials.

> *Done better by:* Anthropic's own `sandbox-runtime` (bubblewrap / Seatbelt / WFP process-tree scoping, writes allow-only, network deny-all behind a proxy allowlist — Apache-2.0, and exactly the shape weft needs without containers), OpenAI Codex CLI (Seatbelt/Landlock/seccomp with `.git` protected), container-use (container per agent), microsandbox (libkrun microVMs as ordinary child processes, <100 ms boot), gh-aw (structurally: no write credentials at all).

🟠 `HIGH` — **The review patterns have never been measured.** `adversarialVerify`, `judgePanel`, `completenessCritic` and `multiModalSweep` are carefully designed — strict majority so an even panel does not kill on a tie, best-votes with a mean-score tiebreak so one generous judge cannot carry a weak attempt — and there is no number attached to any of them. Meanwhile the flagship example does not implement its own claim: `PANEL = ["claude", "codex", "claude"]` with a `>= 2` majority means Claude alone carries a verdict, and the refuter is handed the finder's `evidence`, which the closest published work deliberately withholds to avoid anchoring.

> *Done better by:* Qodo (60.1% F1 across eight tools, Feb 2026), CodeRabbit (51.2% F1 on Martian's independent 2026 benchmark), Greptile (82% bug-catch claimed, July 2025). Also Google ADK's `adk conformance`, which records a scenario's LLM requests, responses and tool calls into golden YAML and **fails the command on deviation** — the shape of an answer weft's zero-token harness is one step away from.

🟠 `HIGH` — **Provider asymmetry silently breaks a headline guarantee.** `write: { mode: "strict" }` means live `canUseTool` enforcement on Claude and post-hoc diffing on Codex, which also silently ignores `maxTurns`, `onMaxTurns` and `tools.deny`, and always returns `filesTouched: []`. `ProviderHitl.onAsk` is declared, fenced by the engine, and called by no shipped adapter. And the README's package table claims the adapters sit "behind a shared conformance suite" that **does not exist** — only `journalStoreConformance` and `blobStoreConformance` ship.

> *Done better by:* Codex CLI (uniform OS-level sandbox inherited by every subagent), OpenHands via the Agent Client Protocol (one protocol contract per agent rather than per-vendor adapters), and — on the honesty axis — anyone not claiming a suite they have not written.

🟠 `HIGH` — **The CLI does not compose with a developer's own tooling.** All 14 verbs emit ANSI-painted prose; `grep` for `--json` across `packages/cli/src` returns nothing. There is no way to pipe a captured patch to `git apply`, no `weft signal` though the daemon has the route, no `search`/`reindex` though `@techery/weft-index-sqlite` implements `search()` and **is reachable from no host at all**, and no `--version`. For a local tool whose whole point is fitting into an existing workflow, this is the wrong end to be unfinished.

> *Done better by:* essentially everything a developer already has in their shell. Qodo PR-Agent runs as a CLI, a Docker image, an Action and a webhook from one codebase.

🟡 `MEDIUM` — **Local-tool basics are unpaid.** No repo-root discovery: running any command from a subdirectory silently targets a different, empty `.weft` instead of erroring — a bug every git-adjacent tool solved by walking upward. No blob GC: transcripts, patches and every >64KB step output accumulate forever under `.weft/blobs`. No repo-level mutex: `ctx.integrate()` and `integrationBaseCommit()` both mutate the real tree at `rt.cwd` while the ownership lease is per-*run*, so two concurrent runs in one checkout is undefined behaviour — and running several agents at once is the thing this category exists for.

> *Done better by:* every worktree manager (claude-squad, uzi, Conductor) treats "many agents, one repo" as the primary case; every git-adjacent tool resolves the repo root; Trigger.dev and Temporal have retention policies.

🟡 `MEDIUM` — **The journal is used for recovery, never for exploration.** No fork-from-step, no re-run-one-step, no rewind-and-edit-a-recorded-value. When a 40-step run produces a bad plan at step 3, the options are resume (which serves the bad plan) or start over. Claude Code's `/workflows` panel can restart a single agent in place today.

> *Done better by:* DBOS `forkWorkflow`, LangGraph's fork-by-checkpoint, Burr's `fork_from_sequence_id` — all with strictly less information than weft's journal already holds. And Claude Code, with none of it.

🟡 `MEDIUM` — **Only three provider ids exist**, and the built-in price table is Claude-only, so a USD ceiling routed to Codex is refused at dispatch unless the host configures pricing. No Gemini, no Bedrock/Vertex, no local models — while Cline reaches 200+ via OpenRouter and OpenHands routes whole third-party *agents* through ACP.

> *Done better by:* opencode (Models.dev catalogue with OAuth), Cline, OpenHands, Aider, Qodo PR-Agent — all via LiteLLM or an equivalent.

⚪ `LOW` — **Declared-but-dead API surface.** `IntegrateOptions.order?: "sequential"` is public and never read; `StepErrorCode`s `max_turns` and `git_failed` are never produced anywhere. For a project whose pitch is that the plumbing is typed rather than parsed, declared-and-unimplemented surface is the wrong kind of debt.

> *Done better by:* not a competitive gap so much as a credibility one — and it is the first thing a careful reader checks.

---

## Part 6 — What to build

42 ideas were generated and put through an adversarial critic that cut 7 as things weft already has, flagged 12 as weak, and added 8 nobody proposed. What follows is the surviving set, **re-ranked for a local-first coding tool** rather than for a durable workflow engine.

Two items moved a long way under the corrected frame, and it is worth saying why:

- **Per-step OpenTelemetry spans dropped out of the top ten.** They were ranked 5th when weft was being compared to workflow engines whose users run Langfuse and Phoenix. A developer running a workflow on their own laptop reads `weft report` and `weft explain`, not a trace UI. The spans are still worth emitting — `weft otel export <run>` is a nice retro-fold — but they are no longer close to the front.
- **The notifier moved down from 1st.** Its old justification was "a gate that suspends durably reaches nobody" — true, but written as if the reviewer were on another continent. On a dev machine the reviewer is the person who started the run and walked away. That makes it a desktop notification and a webhook, not a Slack routing system, and it makes it smaller and later.

### The build order

#### 1 — Ingest the repo's own conventions · **S–M · high**

**Problem.** A write step hands an agent a fresh worktree with no `AGENTS.md`, no `CLAUDE.md`, no `.clinerules`. Every other runner in the ecosystem reads that file by default; weft is standing in the same repository and ignores it. The agent then writes code that violates house style, and the review step has no idea what house style is.

**Proposal.** A journaled context step: walk from the step's `cwd` upward collecting `AGENTS.md` (and the vendor-specific names), nearest-wins, and prepend the result to the agent's prompt. Journal *which files were read and their hashes*, so the context is part of the step's identity and a convention change correctly re-runs what depended on it — the same discipline weft already applies to everything else. Opt out per step with `context: { conventions: false }`.

```ts
const fix = await ctx.agent.detailed(`Fix ${f.claim}`, {
  schema: FixResult,
  write: { paths: [f.file] },
  // default: AGENTS.md / CLAUDE.md found by walking up from cwd, hashed into identity
});
```

**Prior art.** `AGENTS.md` as a cross-vendor convention (Codex, Claude Code, Copilot, Jules, goose, Cursor, Aider); Qodo PR-Agent reads it *and* `SKILL.md` to steer review; Spec Kit makes it explicit with `/speckit.constitution`. Aider's tree-sitter repo-map is the more ambitious version of the same instinct.

**Why first.** It is the cheapest item on the list that closes a `CRITICAL` gap, and it is the difference between "an agent working in your repo" and "an agent working in a repo."

#### 2 — Default-deny egress now; an OS sandbox for write steps after · **S then XL · high**

**Problem.** `fetchAllow` is optional and **undefined by default**, so a default install lets model-generated workflow code reach any host, and skips the hardened per-hop redirect validation entirely. Separately and larger: the agent's process is not sandboxed at all. Worktree isolation is a convention; `commandEscapesWorktree` is documented as a lexical screen, not a sandbox. Under a local-first posture the blast radius is a developer's real checkout, real SSH keys, and real cloud credentials.

**Proposal, two very different sizes.** First flip the default: deny egress unless `fetchAllow` names hosts. One line, shippable this week. Then, behind the `isolation:` seam that already accepts `"worktree" | "none"`, add `"sandbox"` over an OS mechanism, journaling a `sandbox.denied` event so a refusal is visible in the report rather than a mystery.

**Prior art.** Anthropic's own `sandbox-runtime` — bubblewrap on Linux, Seatbelt on macOS, WFP on Windows; process-tree scoping, writes allow-only, network deny-all behind a proxy allowlist — is Apache-2.0 and is exactly this shape without requiring containers. Codex CLI ships Seatbelt/Landlock/seccomp with `.git` protected even in workspace-write mode. container-use proves the container-per-agent model. microsandbox (libkrun microVMs as ordinary child processes, <100 ms boot) fits the local posture best of the heavyweight options.

**Do not propose these as one item.** That is how neither gets done.

#### 3 — Measure the review patterns, and fix the flagship · **M · high**

**Problem.** `adversarialVerify` has a strict-majority rule chosen so an even panel does not kill on a tie; `judgePanel` uses best-votes with a mean-score tiebreak so one generous judge cannot carry a weak attempt. Both are good design and **neither has a number**. CodeRabbit publishes 51.2% F1 on an independent benchmark; Qodo publishes 60.1%. Worse, the flagship example does not implement its own claim: `PANEL = ["claude", "codex", "claude"]` with a `>= 2` majority means Claude alone carries a verdict, and the refuter is handed the finder's `evidence`, which the closest published work deliberately withholds to avoid anchoring.

**Proposal.** Two halves, both small. (a) Fix `.weft/workflows/audit-and-fix.ts`: a genuinely cross-vendor panel, and withhold the finder's evidence from the refuter. Two lines. (b) Build an eval: a fixture corpus of PRs with known defects, run `review.ts` over it, report precision/recall, and — because weft's zero-token harness already exists — make it a check that fails when a prompt change regresses the number. Golden-trace conformance is the natural companion: record a scenario's requests, responses and tool calls, then fail on deviation.

**Prior art.** Google ADK's `adk conformance` records into golden YAML and fails the command on deviation. Braintrust runs evals as versioned source files through a CLI with a GitHub Action commenting score diffs. promptfoo (24.5k stars, MIT) is declarative-config evals with first-class CI integration and is structurally close to what a `weft eval` would be.

**Why it ranks here.** Weft's whole argument against the review products is that its pattern is better because it is yours. That argument needs a number, and weft is one small harness away from being able to produce one.

#### 4 — Make the CLI compose with a developer's own tooling · **S · high**

**Problem.** All 14 verbs emit ANSI-painted prose; `grep` for `--json` returns nothing. No way to pipe a captured patch to `git apply`. No `weft signal` though the daemon has the route. No `search`/`reindex` though `@techery/weft-index-sqlite` implements `search()` and is reachable from no host at all. No `--version`. For a local tool whose value is fitting into a workflow that already exists, this is the wrong end to leave unfinished.

**Proposal.** One JSON view module shared by the CLI and the daemon's REST responses. `--json` on `ls`, `status`, `report`, `explain`, `diff`, `replay --dry`, `check`, `doctor`. Four verbs: `weft signal`, `weft search`/`reindex`, `weft cat <run> <step> [--patch|--transcript|--output]`, `--version`. Exit codes as a contract — `0` success, `1` failure, `2` suspended-on-human, `3` budget-exceeded — so a Makefile or a git hook can branch on "needs a human" without parsing anything.

```console
$ weft cat 7f3a2b1c fix:src/api.ts --patch | git apply --check -
$ weft ls --json --status suspended | jq -r '.runs[] | .pending[0].answerCommand'
$ weft run review --json; case $? in 2) echo "needs me" ;; 3) echo "budget" ;; esac
```

`--version` in particular is two lines: `bin/weft.js` already reads its own manifest at startup. The shared view types belong in `@techery/weft-sdk` so the daemon can import them, and the shape needs a `schemaVersion` on day one — it becomes an API the moment someone scripts against it.

#### 5 — `AgentProvider` conformance suite · **S · high**

**Problem.** The README's package table says the adapters sit "behind a shared conformance suite". There is none — only `journalStoreConformance` and `blobStoreConformance` ship, and the adapters are verified by mutually inconsistent hand-written tests (~40 cases for Claude, ~24 for Codex). The consequence is not cosmetic: `write: { mode: "strict" }` means live `canUseTool` enforcement on Claude and *nothing live at all* on Codex, which also silently ignores `maxTurns`, `onMaxTurns` and `tools.deny`, and always returns `filesTouched: []`.

**Proposal.** `agentProviderConformance(name, expectations)` as a third `describe()` block, encoding what the engine actually relies on: structured output the wire schema accepts or a throw; `repair()` re-prompting the same session; an already-aborted signal throwing rather than dispatching; non-negative per-turn usage; and a declared write scope enforced *by the stated mechanism*. weft's own store conformance suites are the template.

It converts a README falsehood into a red build, and forces either the fix or the honest documentation of the asymmetry.

#### 6 — Local-tool basics · **S · medium**

**Problem.** Three things that make weft feel like a preview rather than a tool. Running any command from a subdirectory silently targets a different, empty `.weft` instead of erroring. Blobs accumulate forever — `BlobStore` is `put`/`get`/`getText`/`has` with no prune verb and no retention. And `ctx.integrate()` mutates the real tree at `rt.cwd` while the ownership lease is per-*run*, so two concurrent runs in one checkout is undefined behaviour — in a category that exists for running several agents at once.

**Proposal.** Walk upward for `.weft` like every git-adjacent tool. `weft prune` doing mark-and-sweep over journals to collect `$outputBlob` / patch / transcript refs and delete the remainder, plus compaction by age. A `.weft/repo.lock` acquired with the same CAS + TTL + steal protocol as `owner.lock`, held for the duration of `integrate()` and `integrationBaseCommit()`, keyed on the resolved repo root; a run that cannot acquire it marks itself waiting (reusing `markWaiting`, so it reports as suspended rather than hung).

#### 7 — Schema-aligned coercion before spending a repair turn · **S · high**

**Problem.** `runProviderWithRepair` goes straight from a failed `validateSchema` to `provider.repair(...)` — a full extra model turn, charged to the budget, and on exhaustion the whole paid step dies with `schema_repair_exhausted`. A large share of real failures are fences, prose wrappers and near-miss scalars.

**Proposal.** One pure, zero-model-call pass between `unwrapWireValue` and the repair loop, reusing the keyword walker already in `jsonschema.ts`. Because the engine re-validates against the **real** Standard Schema afterwards, coercion can never widen the contract — only turn a near-miss into a candidate the authoritative schema still judges. Journal each applied fix so nothing happens invisibly.

**Prior art.** BAML's Schema-Aligned Parsing is exactly this: a schema-aware least-edit-distance coercion in Rust, claimed sub-10 ms, with published benchmark numbers. The cheapest quality-per-line item on the list.

#### 8 — `weft fork <run> --from <step>` · **M · medium**

**Problem.** Weft built content-addressed step identity, three-tier salvage and a version stamp, then exposed three verbs over the journal, all recovery-only. When a 40-step run produces a bad plan at step 3, the options are resume (which serves the bad plan) or start over. Claude Code's `/workflows` panel can restart a single agent in place today, with far less information available to it.

**Proposal.** Copy records up to the chosen step's `step.completed` into a new run id with `forkedFrom: { runId, seq }`, optionally rewriting that step's output with `--set` — validated against the step's *journaled* schema first, so a hand-edited value cannot be less valid than a model's. Then resume normally: the existing salvage machinery serves the copied prefix with no new replay code. `weft diff <a> <b>` already compares runs by keyed step output, so a fork is immediately comparable against its parent. Patches need care — inherit `patch.captured` blob refs (content-addressed and immutable, so sharing is safe), drop any `patch.merged` after the fork point, and let `integrate`'s existing `verifyServe` chain detect a tree missing a patch it thought it merged.

**Prior art.** DBOS `forkWorkflow(id, startStep, …)`, LangGraph's fork-by-`checkpoint_id`, Burr's `fork_from_sequence_id`.

#### 9 — Tell the developer who walked away · **S–M · medium**

**Problem.** A `human.requested` event lands in the journal and the run parks durably. There is no notification code anywhere in `packages/*/src`, so the only ways to discover a pending gate are `weft status`, the loopback daemon page, or an MCP long-poll. Durability solves waiting; it does nothing about noticing. On a dev machine that is a smaller problem than it sounds — the person is usually nearby — but "start the audit, go to lunch, come back to a run that has been parked for 40 minutes" is exactly the workflow weft's gates exist for.

**Proposal.** Small and local first: a desktop notification and a `command` channel that shells out, plus `weft inbox` answering the only question a person actually has — *what is waiting on me?* — as one queue across every run in `.weft`, sorted by deadline, each row carrying the exact `weft answer` command. A webhook and Slack channel are a natural third step for teams that want them, not the starting point. `human.answered` already carries `channel?: string` and `Engine.answer` already accepts `{ channel }`, so provenance comes for free. The engine does not change.

**Prior art.** HumanLayer's contact-channel objects with escalation ladders, Windmill's signed approval links and native Slack/Teams approvals, Trigger.dev's tokens with webhook URLs — all built for the remote-team case, which is the version to grow into rather than start from.

#### 10 — `reads:` scopes and a world-hash in step identity · **L · transformative**

**Problem.** Step identity is `sha256(canonicalJson{kind, payload, schema, key})`. **The working tree an agent greps is not in it** — the README's own deviation #5 says so. A resume after the repo changed happily serves an answer computed against a repo that no longer exists.

**Proposal.** `reads?: ReadScope` alongside `write`. Compute a `worldHash` over the read scope — `git ls-files -s -z` plus untracked, against the `integrationBaseCommit` the engine already produces, filtered through the existing `scopeMatcher`, sha256 over sorted `(path, mode, blobOid)` triples — and fold it into the identity hash. On Claude, `strict` additionally denies out-of-scope reads through the same `canUseTool` seam `write` already uses. It also pairs with idea 1: whatever conventions a step reads belong in that hash too.

**Prior art.** Burr declares `reads=`/`writes=` per action and validates statically. Bazel, Nix, Nx and Turborepo hash declared inputs to decide what may be reused — weft currently sits *below* Turborepo on cache-key soundness, because an agent step declares no inputs at all. Dagster's `code_version` + `data_version` staleness computation is the closest finished answer.

**The one item on the honest-deviations list that changes what the product guarantees** — and L effort in the hottest path, which is why it sits at 10 rather than 1.

### The rest of the catalogue

What survived and did not make the top ten. ⚠️ marks an idea the critic found flawed *as proposed* — the underlying problem is usually real even where the mechanism is not; see [Part 7](#part-7--what-the-critic-cut). Several ecosystem items (a GitHub Action, PR-comment reports, workflow packages on npm) are kept for the record but read differently now that weft is explicitly a local tool.

**Agents & providers**

| Idea | Size | Impact | The problem it solves |
| --- | --- | --- | --- |
| **Attempt checkpointing: keep the provider session across a tim…** | S | high | When a step times out, `withTimeout` aborts the attempt, drains 5s to harvest late usage, and fails (runtime.ts:763-834). The retry starts a brand-new provider session from turn 0 — every token of the aborted attempt's context is thrown away and re-… |
| **stdlib: escalate() — a cost ladder with a declared acceptance…** | S | medium | weft has per-step routing and hard USD ceilings but no shipped pattern that uses one to protect the other. Today the author picks a model per call site at authoring time, which means either paying Opus prices for steps a Haiku could have done, or di… |
| **Route policies with typed fallback chains** | M | high | Routing today is a three-way merge of step opts → workflow defaults → config.defaults, resolved inline in `agentImpl` (ctx.ts:269-277). It is per-call-site and static: there is no way to say "all `review:*` steps go to Opus, fall back to Codex on pr… |
| **Native structured-output path with per-provider output-mode n…** | M | high | `ProviderCapabilities.structured` is declared as `"native" ／ "tool"` (provider.ts:65) but the Claude adapter hard-codes `structured: "tool"` and every single step pays an sdk-mcp round trip: a `weft` MCP server is spun up per stream, the model must… |
| **Per-step tool surface: MCP servers plus an allow/deny matrix** | M | high | `ToolPolicy` is `{ allowEdits: boolean; deny?: string[] }` (provider.ts:8-13) and that is the entire tool surface a weft step can express. Two consequences. First, a step cannot be GIVEN a tool it does not already have — no Linear MCP server for a t… |
| **stdlib: bestOfPatch() — N candidate patches, verified in thei…** | L | high | weft has the only assembly in the landscape that could make best-of-N rigorous for code — per-attempt worktrees, captured patches as typed values, `ctx.check`, and a gated `ctx.integrate()` — and ships none of it. `judgePanel` exists but judges pros… |

**Humans**

| Idea | Size | Impact | The problem it solves |
| --- | --- | --- | --- |
| **Daemon UI as a real review surface: schema-driven forms, patc…** | M | high | The web UI is one hand-written HTML file (ui.ts:12, INDEX_HTML) whose detail pane is state + tree + pending + report and nothing else. There is no per-step prompt/payload/output view (the CLI's `weft explain` has one and the UI does not), no patch o… |
| **Gate bridge: answer a weft gate from a GitHub PR, Linear issu…** | L | transformative | Even with notifications, answering requires a terminal on the machine holding the journal, or a browser on 127.0.0.1. `weft answer` is a durable, CAS-guarded, schema-validating entry point (engine.ts:1343-1467, with cross-descendant routing at :1476… |

**Authoring & DX**

| Idea | Size | Impact | The problem it solves |
| --- | --- | --- | --- |
| **Record-and-replay the nondeterministic globals instead of ban…** ⚠️ | M | high | The gate bans `Date.now`, `new Date()`, `Math.random`, timers, `Intl`, and locale methods across eleven AST rules (gate/rules.ts:57-72) and the node:vm sandbox makes them throw. The replacements are `ctx.now()`, `ctx.random()`, `ctx.uuid()` — all as… |
| **`ctx.await({ any: [...] })` — composable durable wait conditi…** ⚠️ | M | high | weft has three durable waits — `ctx.signal(name, schema, {timeout})`, `ctx.sleep(d)`, and human steps with deadlines — and no way to compose them. "Wait for the CI signal, or a human override, or 24 hours, whichever comes first" has no expression. `… |
| **Speculative fan-out with preemption and automatic patch lifec…** | M | high | `ctx.parallel` runs different work; there is no primitive for running the *same* work k ways and keeping the best. Doing it by hand today is a trap: k write steps produce k patches, and a run that ends with un-integrated, un-discarded patches fails… |
| **Session handoff: continue a prior step's provider session ins…** | M | high | `DetailedAgentResult.sessionId` is returned by the engine and journaled on `step.completed`, both adapters implement session resume, and `capabilities().sessionResume` is true for Claude, Codex and mock — but nothing in the authoring surface can use… |
| **`ctx.spawn` — non-blocking, durable sub-workflow handles** | L | high | `ctx.workflow` is a blocking call whose step deliberately never serves from the journal (`verifyServe: async () => false`, ctx.ts:1053-1059), so every resume re-enters the child run and relies on the child's own journal to avoid re-paying. That is c… |
| **Self-improving workflows: a journal-mined hint bank with huma…** | L | transformative | weft journals every schema-repair attempt (`step.attempt "schema repair n/max"`), every `schema_repair_exhausted`, every failed required check, every scope violation and every `drop`, across every run in `.weft/runs`. That is a dense, structured cor… |

**Testing & quality**

| Idea | Size | Impact | The problem it solves |
| --- | --- | --- | --- |
| **Make `replay --dry` faithful, then make it a CI gate** | S | high | `replayDry` is the tool for "what would happen if I resume this edited script" and it does not model that case: it never computes `positionsTrusted`, ignores `opts.defHash`, and constructs `new Budget({})` with `agentCounter: { count: 0 }` (engine.t… |

**Isolation & security**

| Idea | Size | Impact | The problem it solves |
| --- | --- | --- | --- |
| **Redaction pass over everything that leaves the journal** | M | high | Secret redaction covers only env maps and fetch header names/values passed as SecretHandles (ctx.ts:109-158). Step outputs are journaled verbatim: exec/bash stdout+stderr, fetch response bodies and headers, agent prompts, and `ctx.env.get`'s actual… |

**Observability & audit**

| Idea | Size | Impact | The problem it solves |
| --- | --- | --- | --- |
| **Incremental event index and `weft query`** ⚠️ | M | high | Nothing in core calls `indexRun` — the sqlite index is only ever rebuilt wholesale by the host (host/weft.ts:122-141), so rows are stale between rebuilds, and `search()` is an unranked LIKE scan with a default limit of 50. The index also stores one… |
| **Live step-progress channel: see inside a running agent step** | M | medium | An agent step is a black box for its entire duration — which, at `limits.stepTimeoutMs` default of 20 minutes, is a long time. Both adapters already accumulate transcript lines as the stream arrives (`assistant:`, `assistant → tool: <name>`, `exec (… |
| **Per-step OpenTelemetry spans with OpenInference span kinds** | M | high | Verified: `packages/core/src/engine.ts:789` is the only `tracer.startSpan` in the repo — one span per run, run id as trace id. weft's journal is the richest per-step record in this whole landscape (kind, key, phase, route, effort, per-attempt usage… |

**Engine**

| Idea | Size | Impact | The problem it solves |
| --- | --- | --- | --- |
| **Retry policies as declared objects, with resumable backoff** | S | high | `retry` is `{ attempts, backoffMs? }` and the delay scales linearly (runtime.ts:726-751). The non-retryable set is hardcoded (`cancelled`, `budget_exceeded`, `gate_denied`, `human_denied`) — a workflow cannot say "retry a `fetch_failed` five times w… |
| **Prompt-prefix cache-aware fan-out scheduling** ⚠️ | S | medium | A keyed `ctx.parallel` fan-out — the canonical weft shape, and what `.weft/workflows/review.ts` does — launches N agent steps sharing a long identical prefix (system framing, the write-scope paragraph appended at ctx.ts:485-493, the `## Output` sche… |
| **Checkpoint records, journal compaction, and blob GC** | M | medium | `ReplayIndex.fromRecords` folds the entire journal from record 0 on every resume, every `weft status`, every daemon read, and every projection refresh (replay.ts:90-238, store-fs/journal.ts:467-520). A long-lived run — a week-long review loop with 3… |
| **Cross-run step cache keyed on {identity, worldHash}** | L | transformative | Salvage only works *within* one run's journal (replay.ts:248-301). Running the same review workflow over 20 PRs, or re-running it on an unchanged repo after a failure, re-pays for every read-only analysis step. The engine already content-addresses s… |
| **Park and wake: suspend a waiting run to zero** ⚠️ | L | transformative | A run blocked on a human holds a Node process, a worktree, and an ownership lease. Cancel and shutdown deliberately do *not* release the lease (engine.ts:1623-1631, 1696-1701) so the run stays claimed until TTL expiry, and there is no mechanism to p… |
| **Multi-worker execution: the journal as a work queue** ⚠️ | XL | transformative | A run is single-process by construction: `acquireRun` claims it, one RunRuntime executes every step, and the global limiter caps concurrency at `min(16, cpus-2)` on that one machine (config.ts:66-68, engine.ts:249-256). A 200-way `ctx.parallel` fan-… |

**Ecosystem**

| Idea | Size | Impact | The problem it solves |
| --- | --- | --- | --- |
| **Claude Code integration kit: make weft the thing Claude Code…** | S | high | weft's authoring model is plain TypeScript, which is maximally flexible and therefore maximally blank-page — and the agent most likely to write a weft workflow is Claude Code, which knows nothing about weft. Meanwhile weft's MCP server exists but is… |
| **Workflow packages: `weft add`, npm distribution, and a lockfi…** ⚠️ | M | high | The registry is a directory of `*.ts` files (`packages/gate/src/registry.ts`) keyed by basename or `meta.name`, cached by bundle hash. That is a good local design and a dead end for sharing: there is no way to install someone else's workflow, no ver… |
| **ctx.memory — a durable, journal-honest knowledge store across…** ⚠️ | L | transformative | Every weft run starts from nothing. A write step's worktree is seeded from the integration commit and handed to an agent with no accumulated understanding of the repository — which modules are owned by whom, which tests are flaky, which refactor was… |
| **CI-native weft: a GitHub Action, PR-comment reports, and gate…** | L | high | weft's strongest properties — a durable journal, a cost ceiling, a patch that lands only at an explicit integrate — are exactly what a CI-run agent needs, and there is no CI story at all. No action, no documented exit codes, no artifact convention,… |

**Added by the critic — nobody else proposed these**

| Idea | The proposal |
| --- | --- |
| **Journal format version + tolerant reader (prerequisite for a dozen ot…** | Add `v: 1` to `run.created` in packages/core/src/events.ts and a matching constant in core. Readers refuse an unknown MAJOR with an actionable error naming the weft version that wrote it; reducers and `ReplayIndex.fromRecords` skip unknown event `type`s instead of assuming exhaustiveness (packages/core/src/projections.ts already has a `default:` branch at :319 — packages/core/src/replay.ts must be audited for the sa… |
| **`weft describe <workflow>` plus schema-rendered `--help`, `--json` de…** | One projection from `def.meta`: name, description, routing defaults, and the input schema rendered three ways — human (`weft run review --help` lists `--base <string> base ref to diff against` derived from the Zod shape), machine (`weft describe review --json` emits the JSON Schema), and interactive (the daemon and MCP `weft_run` render a form from the same JSON Schema, exactly as `weft answer` already does for huma… |
| **`onExhausted: "suspend"` — turn budget exhaustion into a durable huma…** | Add a run-level (and optionally step-level) policy to the budget config. On `checkBeforeStep` failing, instead of throwing the non-retryable `BudgetExceededError` that fails the run, journal a human request ("this run has spent $5.00 of $5.00; raise the ceiling, or stop") with a schema of `{ action: "raise" ／ "stop"; addUsd?: number; addTokens?: number }`, park exactly like any other human step, and on a `raise` ans… |
| **Repo-level integration mutex** | A `.weft/repo.lock` acquired with the same CAS + TTL + steal protocol as `owner.lock` (packages/store-fs/src/journal.ts:184-262), held for the duration of `ctx.integrate()` and `integrationBaseCommit()`, keyed on the resolved repo root. A run that cannot acquire it within a bound marks itself waiting (reusing `markWaiting`, so it reports as suspended rather than hung) and retries. |
| **`weft why <run> <step>` — explain the replay decision** | A projection over events that already exist: for each step, report which of the three matching tiers fired (same-seq hash hit, salvage from `replay.salvaged { seq, fromSeq }`, `--reuse key`), or why it re-ran (`replay.diverged { seq, reason }` already carries the reason string, including "ambiguous keyless identity"), plus whether `positionsTrusted` was true and which stamp disagreed (bodyHash vs defHash from `run.c… |
| **`weft export` / `weft import` — make a run a portable artifact** | `weft export <run> [--out run.tgz] [--redact]` writes the journal, every blob it references (walk `$outputBlob`, `patchRef`, `transcriptRef`, artifact refs), and the persisted `script.ts`/`workflow.json` provenance into one tarball; `weft import run.tgz` reconstitutes it under a fresh or preserved run id. Pair with the redaction pass so an exported run is safe to attach to a bug report. |
| **One glob dialect across the product** | Extract a single `matchGlob` (picomatch with `{ dot: true }`, the NFC normalisation and newline stand-in already in packages/isolation/src/scope.ts:17-32) into one module and use it for write scopes, testing fixtures, provider-mock rules, the approval-policy action patterns in packages/core/src/config.ts, and `fetchAllow`. Document the dialect once. Where the existing `*`-crosses-`/` behaviour is genuinely wanted (s… |
| **Prompt-size accounting and a declared truncation policy per step** | Before dispatch, estimate the assembled prompt's token count (a cheap heuristic is fine; providers report real counts afterwards to calibrate) and journal it on `step.scheduled` as `promptTokens`. Add `context?: { max?: number; onOverflow?: "fail" ／ "truncate" ／ "blob" }` to AgentOptions: `truncate` applies a declared strategy to the largest interpolated artifact, `blob` offloads it and passes a reference the agent… |

---

## Part 7 — What the critic cut

An adversarial pass over the 42 raw ideas, checking each against the source. It is included in full because the corrections are more useful than the ideas they correct — most of them are cases where an idea proposed building something weft already ships, or sketched an API that does not compile.

### Cut, or cut down

None of these is a whole feature weft already has — each is a *false premise inside* an otherwise live idea, or a duplicate of another entry. The distinction matters: `escalate()` and `bestOfPatch()` stay in the catalogue above, minus their wrong framing.

| Idea | What was actually wrong |
| --- | --- |
| stdlib: escalate() — the `ctx.budget` accessor it says must be added already… | The idea's `fitsArchitecture` says: "One small core addition: a read-only `ctx.budget` view (`{ remainingTokens, remainingUsd, spent }`) in `sdk/src/types.ts` and `core/src/ctx.ts` — which does not exist today." It does. `BudgetView { spent: {tokens,usd}; remaining: {tokens／null, usd／null} }` is declared in packages/sdk/src/types.ts and is a member of `Ctx`… |
| stdlib: bestOfPatch() — same false premise about ctx.budget | Its risks section says the pattern "should refuse to fan out when remaining headroom cannot cover N candidates … using the same `ctx.budget` view `escalate` needs." That view is shipped (packages/sdk/src/types.ts `BudgetView`; packages/core/src/ctx.ts:2399). The genuinely new part of this idea is `ctx.verify` — keep that, cut the budget framing. |
| `weft fork <run> --from <step>` (HITL category) — duplicated verbatim by "wef… | Two separate entries in the brainstormed set propose the identical command (`weft fork <run> --from <step> [--set …]`), the identical mechanism (copy records up to the cut into a new run id, optionally rewrite the chosen step's output, then resume normally), and the identical prior art (DBOS forkWorkflow, LangGraph update_state, Burr's (app_id, partition_ke… |
| `isolation: "sandbox"` (isolation category) — duplicated by "Declared step ca… | Both propose: a pluggable backend seam, bubblewrap-on-Linux / Seatbelt-on-macOS as backend one, writes allow-only scoped to the worktree, network deny-all behind a host proxy with a per-step domain allowlist, a journaled `sandbox.denied` event, and Anthropic's sandbox-runtime as prior art. They differ only in which package holds the seam (a new `packages/sa… |
| Session handoff (`continueFrom`) — sessionId is already surfaced to workflow… | The idea claims "nothing in the authoring surface can use it. The only consumer is the internal repair loop." Half wrong: `DetailedAgentResult.sessionId?: string` is a public field in packages/sdk/src/types.ts returned by `ctx.agent.detailed`, and it is journaled on `step.completed` (packages/core/src/events.ts). Both adapters already resume by session id (… |
| Retry policies as declared objects — `backoff` is already a Duration and `met… | The idea states "`retry` is `{ attempts, backoffMs? }`". The public shape is `RetryOptions { attempts: number; backoff?: Duration }` (packages/sdk/src/types.ts); `backoffMs` is the internal StepSpec field (packages/core/src/runtime.ts:157) mapped at packages/core/src/ctx.ts:354 via `toMs(opts.retry.backoff, 1_000)`. It also proposes inventing "a workflow-le… |
| Checkpoint records + blob GC — the blob-GC half is duplicated by "Repo-root d… | Both propose `weft prune` doing mark-and-sweep over journals to collect `$outputBlob` / patch / transcript / artifact refs and delete the unreferenced remainder, plus run compaction by age. Only one should ship the verb. The checkpoint-event half (a `checkpoint` event embedding a serialized ReplayIndex digest so `fromRecords` folds from the last checkpoint)… |

### Flagged as weak

The underlying problem is usually real; the proposed mechanism is not.

| Idea | Why it does not survive contact |
| --- | --- |
| Record-and-replay the nondeterministic globals instead of ban… | The proposed API is impossible as written. `createSandbox()` takes no arguments and is called inside `instantiateBundle` at *load* time (packages/gate/src/load.ts:73), long before any run exists — and the registry caches the instantiated `def` per (file, bundleHash) in a Map (packages/gate/src/registry.ts:70-92), so a single sandbox context and its `Date`/`Math` stand-ins are SHARED BY EVERY CONCURRENT RUN of that w… |
| Multi-worker execution: the journal as a work queue | XL, and it breaks the two guarantees weft actually sells. (1) Budget: `reserveCall` admission is per-process state on one `Budget` object (packages/core/src/budget.ts:147-214); N workers each admit against their own view, so the hard USD ceiling — weft's most defensible feature — becomes N× overshootable, and the idea's own mitigation ("a journaled reservation event") puts a locked+fsync'd append on the hot path of… |
| `ctx.await({ any: [...] })` — composable durable wait conditi… | The primitive is right and the hard half is unaddressed. `takeOrAwaitSignal` (packages/core/src/runtime.ts:1310-1373) drains journaled `signal.received` entries, then in-process buffered deliveries, then parks — a signal arm that loses a race has already CONSUMED a buffered delivery, and the idea says nothing about un-consuming it, so the payload is silently lost and a resume cannot re-take it (the `signal.rejected`… |
| Incremental event index and `weft query` | The typed query half is fine; the load-bearing sub-proposal is not. It says "replace best-effort `budget.sampled` with an awaited `usage.charged { seq, usage }` on the charge path — one append per model call." Every fs append takes a cross-process lock, double-reconciles on-disk growth, `writeSync`es to completion and `fsync`s (packages/store-fs/src/journal.ts:104-310). Awaiting one per provider call serializes all… |
| Park and wake: suspend a waiting run to zero | Two problems. (1) It requires releasing the lease at park, reversing a deliberate decision (packages/core/src/engine.ts:1623-1631, 1696-1701) taken because a zombie step may still be writing after a bounded drain — the idea's entire safety argument is the sentence "the safety argument has to actually hold", which is not an argument. (2) It proposes parking as the DEFAULT for CLI runs without `--watch`. That silently… |
| Prompt-prefix cache-aware fan-out scheduling | The release signal is wrong, so the feature would degrade to a flat 5s penalty on every fan-out. The sketch calls `prefixScheduler.release(group)` from `chargeUsage`, but the Claude adapter only extracts usage from `result` messages (packages/provider-claude/src/index.ts usageOf/absorb) — i.e. at the END of the leader's turn, not at its first token. Siblings would therefore always hit the `prefixStaggerMs` cap rathe… |
| ctx.memory — a durable, journal-honest knowledge store across… | L effort for a feature that weakens the property weft exists to provide, and it has an unspecified core semantic: the idea journals the READ as a step (correct) but never says what a `remember` WRITE does on replay — re-write, skip, or write-once? If it re-writes, replaying an old journal mutates present state; if it skips, the memory store and the journal disagree about history. It also opens a prompt-injection cha… |
| Self-improving workflows: journal-mined hint bank with human-… | The hint-bank half puts model-generated text from a mutable external store INTO the step identity hash ("the rendered hints go INTO the identity payload"). That makes a step's content hash depend on machine-local mutable state, so the same workflow on two machines produces different identities and no journal is portable or comparable — which is the exact property content-addressing exists to provide. It also require… |
| Speculative fan-out with preemption (`ctx.speculate`) | The sketch does not compile against the shipped API: it passes `ctx.check(name, { exec: [...], cwd: r.worktree })`, and `CheckOptions` has no `cwd` — `ctx.check`'s exec runs unconditionally at `rt.cwd` (packages/core/src/ctx.ts:1833). Verifying a candidate patch in its own tree is the whole point of the pattern and is not expressible today; that gap is what the `ctx.verify` proposal (in bestOfPatch) exists to fill,… |
| Workflow packages: `weft add`, npm distribution, and a lockfi… | The lockfile's central claim is false. It records a `bundleHash` per workflow "which is the same hash `run.created` stamps as `defHash`" and treats it as pinning the workflow's code — but `bundleWorkflow` passes `external: [...allowBare]` to esbuild (packages/gate/src/bundle.ts:91), so allow-listed bare imports (zod, and anything a package adds to its own allowBare) are NOT in the emitted code and NOT in the hash. A… |
| CI-native weft: GitHub Action, PR-comment reports, gates as r… | It diagnoses its own fatal flaw and then proceeds anyway: "a run whose journal is only in a 90-day artifact is not durable in any meaningful sense". Artifact-based state handoff between jobs is not durability, it is a tarball with an expiry. The `--read-only` integrate refusal also needs a policy layer a workflow cannot override, which weft has no concept of (config is one file, all fields optional, consumed once at… |
| ctx.spawn — non-blocking, durable sub-workflow handles | Admits in its own risks that it is "not worth much" without the park/wake scheduler, which is itself weak (above). Beyond that, `detached: true` breaks two shipped invariants without proposing a replacement: the budget roll-up assumes a parent's spend covers its subtree (packages/core/src/engine.ts:1264-1301 rolls child delta onto the parent step), and `unintegrated_patches` fails a run whose patches were never inte… |

### Factual corrections

Errors the critic found in the research and in the ideas themselves, verified against the source or the GitHub API.

- **Claimed:** Brainstormed ideas "stdlib: escalate()" and "stdlib: bestOfPatch()" both state that a read-only budget view on Ctx "does not exist today" and must be added.
  **Correction:** It exists and is public. `BudgetView { spent: { tokens, usd }; remaining: { tokens: number ／ null; usd: number ／ null } }` is declared in packages/sdk/src/types.ts and `budget: BudgetView` is a member of the `Ctx` interface; it is implemented at packages/core/src/ctx.ts:2399-2401 as `get budget() { return rt.budget.view(); }`. Both ideas' "one small core addition" is already shipped.

- **Claimed:** Idea "Retry policies as declared objects": "`retry` is `{ attempts, backoffMs? }` and the delay scales linearly (runtime.ts:726-751)."
  **Correction:** The PUBLIC shape is `RetryOptions { attempts: number; backoff?: Duration }` (packages/sdk/src/types.ts). `backoffMs` is the internal StepSpec field (packages/core/src/runtime.ts:157), produced by `toMs(opts.retry.backoff, 1_000)` at packages/core/src/ctx.ts:354. Authors already write `retry: { attempts: 3, backoff: "2s" }`; the missing pieces are the strategy, the jitter, the error predicate, and the workflow-level default — not the Duration.

- **Claimed:** Same idea: "a run that crashes mid-backoff re-arms the FULL delay on resume, because the backoff sleep is not a `reuseIncomplete` step."
  **Correction:** The opposite happens. The backoff is an in-process `await sleep(backoff, this.signal)` (packages/core/src/runtime.ts:749) with no journaled timer at all. Agent steps do not set `reuseIncomplete`, so a crash mid-backoff leaves an incomplete `step.scheduled` plus a `step.attempt` and the resumed run re-executes the step IMMEDIATELY with zero delay — it does not re-arm anything. The real defect is that a crash-loop bypasses backoff entirely, which is a worse bug than the one described and argues harder for making the backoff a durable step.

- **Claimed:** Idea "Speculative fan-out with preemption" sketches `ctx.check(\`tests:${r.lane}\`, { exec: ["pnpm", "test"], cwd: r.worktree })`.
  **Correction:** `CheckOptions` has no `cwd` field (packages/sdk/src/types.ts: `{ exec?, fn?, trustPrior?, required?, timeout? }`), and the exec branch runs unconditionally at `rt.cwd` (packages/core/src/ctx.ts:1833). The sketch does not typecheck, and the capability it depends on — running a check inside a candidate's worktree — does not exist in any form.

- **Claimed:** Idea "Session handoff": "`DetailedAgentResult.sessionId` … nothing in the authoring surface can use it. The only consumer is the internal repair loop."
  **Correction:** `sessionId?: string` is a public field on `DetailedAgentResult` in packages/sdk/src/types.ts, returned by `ctx.agent.detailed`, and journaled on `step.completed` (packages/core/src/events.ts). A workflow can already read it; what is missing is only the inbound direction (`AgentRequest.resume`) and the digest fallback. The idea is right that the capability is unusable and wrong that the value is hidden — which changes its size from L to roughly S.

- **Claimed:** The internal inventory's feature list for the engine (`@techery/weft-core` + sdk) enumerates the Ctx surface.
  **Correction:** It omits `ctx.fs` entirely. `FsApi { read(path) -> { content, sha256, size }; glob(patterns, { cwd }) -> { paths }; stat(path) -> { exists, size, mtimeMs, isFile, isDirectory } }` is declared in packages/sdk/src/types.ts and is a member of `Ctx`. Three brainstormed ideas reason about what a workflow can and cannot read from disk without knowing this API exists — notably the `reads:` scope idea, whose world-hash would need to cover `ctx.fs.read` results too, and the AGENTS.md idea, which proposes a new `ctx.context.repo()` when `ctx.fs.read` plus a nearest-wins walk may be sufficient.

- **Claimed:** Idea "Notifier seam": "a journal-tailing dispatcher … subscribes to `engine.watch(runId)` (already public, engine.ts:1778) for every active run and to `store.list()` for runs it did not start."
  **Correction:** Both watch APIs are per-run: `Engine.watch(runId, opts)` (packages/core/src/engine.ts:1778) and `JournalStore.watch(runId, opts)` (packages/core/src/stores.ts). There is no watch-all-runs stream in either interface, and no `onAppend`/observer registration on the Engine (`onRecords` at engine.ts:882 takes a RunRuntime and is called internally). So the "dispatcher" is necessarily a `list()` poll loop opening one watcher per discovered run, with all the missed-run and duplicate-watcher problems that implies. The idea should either say so or propose the missing store method — the same gap blocks the multi-worker and…

- **Claimed:** Comparison, authoring dimension: the bundle "hash is SHA-256 of the emitted code, which is the version a run pins and covers every bundled module"; idea "Workflow packages" builds a lockfile on that hash.
  **Correction:** True but load-bearingly incomplete: `bundleWorkflow` passes `external: [...allowBare]` to esbuild (packages/gate/src/bundle.ts:91), so allow-listed bare imports — `zod` by default — are NOT in the emitted code and therefore NOT in the hash. A zod major bump changes every schema's JSON-Schema wire form, and every step's identity hash includes that schema, while `defHash` and the registry cache key stay identical. The hash covers every BUNDLED module and says nothing about the externals; a lockfile built on it pins half the code.

- **Claimed:** Landscape, Daytona entry: "Open-source license file present on the repo (AGPL-3.0 historically; verify current — not directly confirmed in this pass)" alongside "71.9k stars".
  **Correction:** Star count verified correct (71,890 via the GitHub API, 2026-08-24), as is the stale push date (2026-07-24). But the API returns NO `license` object for daytonaio/daytona at all, meaning GitHub cannot detect a standard license in the repo. Combined with the "core development moved to a private codebase" notice, the entry should read "license not detected by GitHub; treat as unverified and do not depend on it" rather than implying AGPL.

- **Claimed:** Comparison, deployment dimension: "no `--version` flag on the program" is listed among missing capabilities.
  **Correction:** Correct as a fact, misleading as a cost estimate. `packages/cli/bin/weft.js` already reads its own `package.json` manifest at startup to decide between the published-`dist` and checkout-`src` shapes, so the version string is already in hand — `--version` is a two-line change against existing code, not a new capability, and should not be weighed alongside genuinely missing verbs like `signal` or `search`.

- **Claimed:** Several brainstormed ideas describe the `node:vm` sandbox as something that can be parameterised per run (e.g. `createSandbox(rt)`), and the comparison describes it as "a node:vm context with replaced globals" without noting its lifetime.
  **Correction:** The sandbox context is created once inside `instantiateBundle` (packages/gate/src/load.ts:73) at LOAD time, and the resulting `def` — whose `run` closure captures those globals lexically — is cached per (file, bundleHash) in the registry's Map (packages/gate/src/registry.ts:70-92). One sandbox and one set of `Date`/`Math` stand-ins is therefore shared by every concurrent run of that workflow in the process, including every run served by one daemon. Any design that wants per-run state in a sandbox global must route through AsyncLocalStorage (which packages/core/src/runtime.ts:277 already uses for step context) or…

### Projects the survey should have covered but did not

- Effect / Effect-TS (@effect/workflow, Effect Cluster, Effect Schema) — 15.5k stars, verified via GitHub API 2026-08-24, repo topics literally include workflows, schema, clustering, concurrency, opentelemetry. This is the single largest omission in the whole landscape: it is the TypeScript ecosystem's durable-workflow + typed-schema + structured-concurrency + typed-error stack, and it competes with weft on the author…
- promptfoo — 24.5k stars, verified 2026-08-24, TypeScript, MIT. CLI-first, declarative-config evals with first-class CI/CD integration and an assertions library. Structurally far closer to what `weft eval` / `weft conformance` should look like than Braintrust or Langfuse, because it is a CLI over config files in your repo rather than a SaaS with an SDK. Its assertion vocabulary (contains, javascript, llm-rubric, is-j…
- Plandex — 15.6k stars, verified 2026-08-24, Go, open source. The closest existing analogue to weft's patch-then-integrate model in a shipped coding agent: changes accumulate in a plan sandbox separate from the project files, and you review and apply them explicitly. The coding-harness cluster asserts that no competitor has a patch object and a deferred integrate gate; Plandex is the counter-example and needs to be a…
- Nx (29.3k stars, verified 2026-08-24) and Turborepo / Bazel — content-addressed task caching keyed on declared inputs, with remote cache and affected-project detection from a file-change set. This is the real prior art for the `reads:` scopes and cross-run cache ideas, and it is TypeScript-native. Both ideas cite Bazel in one clause and then design the cache key from scratch; Nx's inputs/namedInputs model and its ca…
- Dagster — 16.1k stars, verified 2026-08-24. Software-defined assets with code_version + data_version staleness computation: the system tells you which assets are stale because their code or their upstream data changed. That is precisely the question the `reads:` world-hash idea is trying to answer, solved and productionised, including the failure mode the idea flags (over-broad inputs make everything permanently sta…
- Jujutsu (jj) — 31.2k stars, verified 2026-08-24, Git-compatible VCS. Its operation log is an append-only journal of every repository operation with `jj op log` / `jj op restore` / `jj op undo`. It is the closest thing in existence to weft's journal applied to a repo rather than a run, and its operation-log UX is exactly the fork/undo/explain vocabulary weft is missing. weft's hand-rolled snapshot pinning under refs/…
- Novu — 39.7k stars, verified 2026-08-24, TypeScript, self-hostable, describes itself as "open-source communication infrastructure for agents and products". Multi-channel (email, SMS, push, in-app, chat) with workflows, digests and preferences. The notifier-seam idea proposes hand-writing Slack/webhook/desktop channels; Novu is the layer that already exists, and a `Notifier` implementation over it is smaller than thr…
- Continue.dev — 35.6k stars, verified 2026-08-24, Apache-2.0, TypeScript, describes itself as "open-source coding agent" with CLI and CI positioning. Larger than most projects in the coding-harness cluster and entirely absent from it.
- Deno — its permission model (`--allow-write=<path>`, `--allow-net=<host>`, `--allow-read`) is a shipped, TypeScript-native, cross-platform capability sandbox with exactly the allow-list granularity both sandbox ideas propose to obtain from bubblewrap/Seatbelt. It deserves evaluation as a backend (run the agent-adjacent process under Deno permissions) and as prior art for the option shape, especially since it works o…
- Standard Schema (standardschema.dev / the @standard-schema spec) — weft's own schema boundary is built on it (`AnySchema`, `InferIn`/`InferOut` in packages/sdk/src/schema.ts) and it is never named as a project. It is the reason Valibot and ArkType work in weft today and the reason the `{value:{}}` degradation for non-Zod vendors exists; the comparison discusses that degradation without naming the spec that causes it.
- mcp-agent (lastmile-ai) — implements Anthropic's "Building Effective Agents" patterns over MCP with optional Temporal-backed durable execution. It is the direct competitor to the combination weft is selling (MCP-native + durable + patterns) and appears nowhere.
- OpenLLMetry / Traceloop and Laminar (lmnr) — OSS OpenTelemetry instrumentation for LLM apps. Mentioned once in passing inside the Helicone entry; both are the obvious consumers of the per-step-spans idea and belong in the observability cluster on their own merits.

### Comparison dimensions that are missing

Nine axes that discriminate and were not measured. Each is a real hole in Part 3.

- Context and prompt management — compaction, truncation, and context-window accounting. Verified absent: `grep -rn "compact／condense／truncat／contextWindow／summariz"` across packages/core/src and packages/provider-*/src returns only scope-manifest truncation, nothing about prompts. weft meters tokens AFTER a call and has no idea how large a prompt is before dispatch, so one oversized `ctx.human.review` artifact or an…
- Trigger surface — how a run STARTS. weft has exactly one: a human typing `weft run`, plus `weft_run` over MCP. No cron, no webhook, no file-watch, no git-event start, and the daemon has no `POST /api/runs` (verified: the route table in packages/daemon/src/app.ts:82-213 has no create route). goose has a built-in scheduler, Windmill has schedules and webhooks, Inngest is event-driven by construction, Temporal has Sche…
- Journal/state format versioning and migration. Verified absent: no `schemaVersion`, `journalVersion`, or `formatVersion` anywhere in packages/core/src/events.ts or packages/store-fs/src/journal.ts. The journal is the sole source of truth and carries no format identifier, so there is no forward/backward compatibility contract and no migration story. This is a dimension on which weft scores worse than every competitor…
- Repo concurrency — what happens when two runs share a working tree. `integrationBaseCommit` and `ctx.integrate()` both mutate the real tree at `rt.cwd`, and the ownership lease is per-RUN, not per-repo. Two weft runs in one checkout can interleave integrates and corrupt each other. Restate's single-writer-per-key Virtual Objects is named in the landscape as an idea to steal and no dimension asks whether any project…
- Auth, authz, and multi-tenancy. Covered only as a per-project footnote (Temporal namespaces, Windmill Enterprise). weft's daemon has a loopback + Host/Origin check and nothing else (packages/daemon/src/app.ts:70-80): no authentication, no authorization, no TLS, and once the proposed patch/transcript blob routes land it is serving repository source code over an unauthenticated port. This deserves its own row.
- Artifact management for non-patch outputs — build logs, coverage reports, screenshots, generated docs. weft has a content-addressed blob store used internally for transcripts and patches, but no first-class artifact concept, no retention, no listing, and no way for a workflow to declare "this is an output of the run". Google ADK's versioned ArtifactService is the reference; the landscape mentions it once inside the…
- Degradation semantics at a limit — what a system does when it hits the ceiling, not just whether it has one. weft throws `BudgetExceededError`, which the retry predicate marks non-retryable (packages/core/src/runtime.ts:726-731), so exhaustion fails the run after spending the entire budget. Trigger.dev pauses and queues; Windmill's disapproval branches; Golem's idempotence mode. The comparison's budget dimension sco…
- Workflow discoverability and parameterisation — how a caller finds out what a workflow accepts. `meta.input` is a REQUIRED Standard Schema on every workflow (packages/sdk/src/define.ts:41-44) and weft renders it nowhere: no `weft describe`, no schema in `weft run <name> --help`, no launch form in the daemon or MCP. Windmill generates input UIs from typed signatures, goose declares typed promptable parameters, Trigge…
- Time-to-first-value / blank-page cost. Every ranking in the comparison is about mechanism; none is about what a new user does in the first ten minutes. Claude Code's model-authored workflows, goose's Recipe Cookbook, Claude Code Action's solution templates, and Windmill's app store are all answers to a dimension weft scores worst on (`weft new` emits one generic two-phase template) and that nobody measured.

---

---

## Part 8 — Sequencing

The top ten is a ranking, not a plan. Grouped into what can ship together.

### Sprint 1 — make it fit the machine it runs on (≈2 weeks, all S/M, no engine hot-path changes)

`AGENTS.md`/`CLAUDE.md` ingestion · default-deny egress · `--json` on every read verb, documented exit codes, `weft cat`, `weft signal`, `weft search`/`reindex`, `--version` · `AgentProvider` conformance suite · repo-root discovery · `weft prune` · schema-aligned coercion · the journal format version (`v: 1` on `run.created` plus a tolerant reader — ~50 lines, and a prerequisite for a third of everything below).

The credibility items belong here too, because they cost hours and they are the first things a careful reader checks: the two-line fix to `audit-and-fix.ts`'s panel, the dead `IntegrateOptions.order` field, the two `StepErrorCode`s nothing produces, and the README's claim about a conformance suite that does not exist.

Together this closes one `CRITICAL` gap outright, halves the other, and turns three `HIGH`s into small ones.

### Sprint 2 — earn the argument (≈3 weeks)

The review eval corpus and `weft eval`, with golden-trace conformance as its companion · the repo-level integration mutex, so several agents in one checkout is defined behaviour · `weft fork` · `weft why <run> <step>` explaining the replay decision from `replay.salvaged` / `replay.diverged` events that already exist · desktop notification plus `weft inbox`.

This is the sprint that produces a number. Until weft can say what its refutation gate buys, the comparison against CodeRabbit and Qodo is an argument from design.

### Then — the two that change what weft is

`reads:` scopes with a world-hash in step identity (L, and the only honest-deviation item that changes the product's *guarantees*), and `isolation: "sandbox"` over an OS boundary (XL, cross-platform, touches every adapter). Both worth doing; neither should block the first two sprints.

### Explicitly not now

Multi-worker distributed execution (breaks per-process budget admission and the ownership model, and is off-posture for a local tool). `ctx.memory` (weakens the property weft exists to provide). Self-improving prompt banks (puts mutable model-generated text into the step identity hash). A CI-native GitHub Action (a journal that lives only in a 90-day artifact is not durable in any meaningful sense — and if weft ever wants CI, `weft export`/`import` and a real store come first). Per-step OTel spans (right idea, wrong audience for a tool a developer runs on their own laptop — revisit if a hosted or team mode ever appears).

---

## Part 9 — The strategic question this report cannot answer

Nine leads on mechanism, and zero users. The 2026 attrition in this category is worth naming plainly: **Flowise archived at 55.4k stars, Roo Code archived at 24.3k, Vibe Kanban sunsetting at 27.9k.** Being right about the mechanism is not what decided those.

Three things follow that are decisions rather than tasks.

### Lead with the write model and the typed contract, not the orchestration

The fan-out surface — `parallel`, `pipeline`, `phase`, worktree isolation, token budgets — is commoditised. Claude Code ships it free, with byte-identical caps, inside a CLI most of the audience already has open. The README currently spends its best real estate defending it. What nobody else has is: a step contract the engine enforces, a workflow you can unit-test with no model calls, declared write scopes, and `ctx.integrate()`.

> **The sentence that should open the README:** *weft makes an agent's change to your repo reviewable — every step schema-validated, every diff a scoped patch that lands only where you said it could, every run replayable from a journal after the session is gone.*

### The cross-vendor pitch needs repair before it needs marketing

`PANEL = ["claude", "codex", "claude"]` with a `>= 2` majority means Codex's vote is never decisive, and the refuter is handed the finder's evidence — which the closest published work deliberately withholds to avoid anchoring. Both are one-line fixes. Until they land, the flagship example does not implement the claim it exists to demonstrate. The defensible version is narrower and true: *weft makes the refutation gate a typed, journaled, replayable part of the program, and lets you swap the vendor if you want to.*

### Decide who the first ten users are

The comparison suggests the answer is not "teams adopting a workflow platform" but **an individual engineer who already runs Claude Code or Codex and wants one specific job done repeatably and safely** — a review that runs the same way every time, an audit that cannot touch files it was not told to, a migration that gates on the test suite. That person needs Sprint 1 and a single genuinely excellent bundled workflow, not a platform. Spec Kit got to 131.2k stars by being adoptable in ten minutes on the agent you already use; that is the bar for the first five minutes with weft, and it is a product problem, not an engineering one.

---

## Appendix A — Capability map

The complete 140-capability inventory with `file:line` evidence, the 71 proven limitations, the researched landscape, all 42 raw ideas with their API sketches, and the critic's full output are checked in as JSON under [`data/2026-08-feature-landscape/`](./data/2026-08-feature-landscape/). Note that `landscape.json` and `comparison.json` there are **first-draft artifacts** and still carry the durable-execution framing this revision corrects; the inventory, ideas and critic files are unaffected by the reframe.

| Area | Capabilities | Notable mechanisms |
| --- | --- | --- |
| Journal & replay | 12 | Canonical-JSON identity, three-tier matching, keyless-ambiguity guard, turn-counted stall watchdog, `verifyServe`, `replay --dry` |
| Budget | 5 | Token + USD ledger, parent-linked child pools, concurrency-aware admission, resume restoration, USD-only ceiling refusal |
| Humans & gates | 7 | Journaled human steps, reject-and-reopen, per-request CAS delivery, deny/escalate/default timeouts, risk tiers with typed confirmation |
| Isolation & patches | 10 | Per-attempt worktrees, patch capture with `--no-renames`/`--binary`, scope check + quarantine, `ctx.integrate` with three conflict strategies, rollback discipline |
| Storage & ownership | 9 | Locked fsynced JSONL with torn-tail recovery, absence-vs-fault discipline, leases + fencing, content-addressed blobs, self-healing SQLite index |
| Providers | 13 | Frozen contract; Claude terminating-tool structured output + live `canUseTool` gate + Bash screening; Codex native structured output + sandbox; mock fixtures |
| Git | 4 | 25 typed operations, fixed risk tiers, CLI hardening, gc-safe `snapshot()` |
| CLI / MCP / daemon | 30 | 14 verbs, 7 MCP tools, HTTP + SSE API, live tree renderer, dual-shape `bin/weft.js` |
| Gate & sandbox | 6 | 11 AST rules with fix-its, esbuild bundling with in-build gating, content hash, `node:vm` global replacement |
| Testing | 5 | `runWorkflow`, mock builder, side-effect fixtures, journal assertions, store conformance suites |
| stdlib | 6 | `adversarialVerify`, `judgePanel`, `loopUntilDry`, `completenessCritic`, `multiModalSweep`, `finalReport` |
| Config, host, packaging | 33 | `createWeft` assembly, config discovery, release pipeline with `verify:packing`/`verify:install`, CI on node 22 + 24 |

---

## Appendix B — Where the durability machinery came from

These are **not competitors.** A team choosing how to run coding work is not choosing between weft and Temporal. They are listed because weft's journal, replay and resume machinery is a re-implementation of ideas this field worked out first, and because two of them solve problems weft will hit.

| Project | The idea weft uses, or should | Relevance |
| --- | --- | --- |
| **Temporal** | Event-sourced history as the authority; deterministic replay; a `vm` sandbox with replaced globals and a seeded PRNG. Also `ContinueAsNew` to cap history growth, and `Worker.runReplayHistories()` as a **CI gate** that bulk-replays production histories | The reference implementation. Its replay-regression gate is the thing weft's `replay --dry` is one step from being |
| **Inngest** | Deliberately *does not* pin versions: memoises on a step's declared id plus an occurrence counter, and publishes the compatibility matrix as a contract (body change safe, add runs on reach, remove ignored, reorder warns) | The closest philosophical match to weft's edit-tolerant replay, and the source of the fix for its one soundness gap — a stable name plus an occurrence index |
| **DBOS Transact** | Checkpoint rows in your own Postgres, plus `forkWorkflow(id, startStep, …)` and `applicationVersion` fencing so old-code runs are never resumed by new-code workers | The prior art for idea 8 (`weft fork`), and proof that a library-plus-local-store shape is viable |
| **Restate** | Server-owned journal; `ctx.awakeable()` mints an id any process can resolve at any time, and a suspended handler holds **zero compute** | The shape of "a gate should not hold a process", if weft ever wants that |
| **Vercel Workflow DevKit** | The same thesis under a major vendor: journaled step inputs/outputs, function replayed from the top. Its sandbox makes `Math.random` and `Date` replay-**stable** rather than unavailable | The friendlier determinism design — weft *bans* what WDK *records* |
| **Golem Cloud** | Records every host-function result — clocks, randomness, I/O, network — in an oplog and replays them, so user code needs no determinism rules at all | The most complete version of record-don't-ban |
| **Trigger.dev / Windmill / Hatchet / Resonate** | CRIU process checkpointing; N-of-M approval configuration with signed resume links; concurrency keys with fairness strategies; durable promises as an addressable set | Each solves one thing weft handles more crudely — worth reading, not worth chasing |

The general-purpose agent frameworks — LangGraph, Mastra, CrewAI, AutoGen, Google ADK, Pydantic AI, LlamaIndex Workflows, Burr — sit in the same category: relevant as prior art (Burr's declared `reads=`/`writes=`, Pydantic AI's `TestModel`, ADK's `adk conformance`), irrelevant as competitors, because none of them knows what a repository is.

---

## Appendix C — Read against the last review

The [DX and Architecture Review](./2026-08-dx-and-architecture.md) audited *quality* at `ad5ecae`/`c0e5e50`. Since then `da85488` landed. Checked against the current tree while writing this report.

| Then | Now |
| --- | --- |
| No LICENSE file | ✅ Present, MIT |
| No build scripts, no `publishConfig`, name taken on npm | ✅ Fixed — packages are `@techery/weft-*`; every manifest has `build`, `files`, `publishConfig.access`, `repository`, plus a tag-driven release workflow with `verify:packing`/`verify:install` |
| A mistyped input flag silently ran the wrong thing | ✅ Fixed — each candidate key is probed against the schema twice; only a key that changes nothing under both is called unknown |
| Budget ceiling destroyed parallel fan-out | ✅ Fixed — `reserveCall` parks for a slot instead of refusing one |
| A salvage cache hit could lie | ✅ Guarded — a workflow-body hash gates position trust; an ambiguous keyless step re-runs |
| Replayer used a wall-clock watchdog | ✅ Fixed — the stall test counts drained event-loop turns |
| `weft run <name> --help` does not show the workflow's flags | ❌ Still open — verified: `--base` is not listed |
| No `--json` on any verb | ❌ Still open (idea 4) |
| `audit-and-fix` panel is not actually cross-vendor | ❌ Still open — `PANEL = ["claude", "codex", "claude"]`, `>= 2` (idea 3) |
| No corpus replay assertion in `@techery/weft-testing` | ❌ Still open (idea 3's companion) |
| Declared `reads:` inputs | ❌ Still open (idea 10) |
