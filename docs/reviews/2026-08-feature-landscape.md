# Weft — feature landscape, competitive comparison, and what to build next

**Written:** 2026-08-24, against `da85488` on `main` (`Fix critical defects in budget, replay, and concurrency handling (#3)`).
**Measured baseline, this checkout:** `pnpm install` ✓ · `pnpm test` ✓ **694 passed (694), 41 files, 48.8 s** · 16 packages, 140 TypeScript source files, ~37.0k lines.
**Scope:** everything weft ships, compared against **84 open-source projects** across six clusters, followed by a ranked build list.
**Companion:** [DX and Architecture Review](./2026-08-dx-and-architecture.md), which audits *quality*. This document is about *surface* — what exists, what the field has, what is missing.

---

**Contents** — [Verdict](#verdict-in-one-page) · [Method](#method-and-how-much-to-trust-each-claim) · [1 What weft is](#part-1--what-weft-actually-is) · [2 The field (84 projects)](#part-2--the-field) · [3 Feature comparison (18 dimensions)](#part-3--feature-comparison) · [4 Closest competitors](#part-4--the-eight-projects-weft-is-actually-competing-with) · [5 Strengths & gaps](#part-5--what-is-genuinely-wefts-own-and-what-is-missing) · [6 What to build](#part-6--what-to-build) · [7 What the critic cut](#part-7--what-the-critic-cut) · [8 Sequencing](#part-8--sequencing) · [9 The strategic question](#part-9--the-strategic-question-this-report-cannot-answer) · [Appendices](#appendix-a--full-feature-inventory)

## Verdict in one page

Weft is a **library-shaped durable execution engine that happens to know about git, money, and people**. That combination does not exist anywhere else. Every individual piece does.

The three-line version:

1. **The mechanism design is ahead of the ecosystem.** Two capabilities were found in *no other project in the survey*: `verifyServe` (refusing to serve a journaled side effect whose result no longer holds in the world) and `ctx.integrate()` as a journaled merge gate with per-patch snapshot/apply sub-steps. Hard **token *and* USD** ceilings inherited across a run tree with concurrency-aware admission are matched only partially, by Pydantic AI (tokens, no USD, no inheritance) and SWE-agent (per-instance USD, no inheritance).
2. **The surface area is well behind it.** The gate that suspends durably reaches no one — grep confirms zero Slack, email, webhook, or push code in `packages/*/src`. The richest per-step record in the field emits **one OpenTelemetry span per run**. All 14 CLI verbs print ANSI-painted prose and nothing else. `write: { mode: "strict" }` means live tool-gating on Claude and post-hoc diffing on Codex, behind one advertised interface with no conformance suite.
3. **The competition it must actually survive is not the one it was designed against.** Claude Code ships dynamic workflows with byte-identical caps, free, inside a CLI at 142.9k stars. Vercel shipped Workflow DevKit — the same "durable execution as a language-level concern in plain TypeScript" thesis — under a major vendor. Neither has schema-validated steps, durable humans, or a patch-then-integrate model. Both have distribution weft has not started on.

**The honest positioning:** weft makes an agent's change to a repository *reviewable and re-derivable* — every step schema-validated, every diff a scoped patch that lands only where you said it could, every run replayable from a journal after the session is gone. It is a credible reference implementation of that idea whose edges are not finished.

**If only three things get built:** a notifier seam so a durable gate reaches a person; `--json` on every CLI verb; per-step OTel spans. Those three convert existing mechanism into usable product for roughly two weeks of work. Full ranked list in [Part 6](#part-6--what-to-build).

---

## Method, and how much to trust each claim

| Layer | How it was produced | Confidence |
| --- | --- | --- |
| Weft's own features and limits | Three agents read every package's source and reported `file:line` for each claim; spot-checked by hand against the tree; `pnpm test` run to confirm the baseline | **High** — verifiable in this repo |
| The 84-project landscape | Six agents fetched READMEs, docs sites and GitHub API responses on 2026-08-24; star counts marked verified only where the API was read directly | **Medium** — external, dated, and moving |
| Comparison ratings | One synthesis pass over both, with `unknown` used rather than guessing | **Medium** |
| Ideas | Three lenses, then an adversarial critic that cut 7 as already-shipped, flagged 12 as weak, and added 8 nobody proposed | **Mixed by item** — see [Part 7](#part-7--what-the-critic-cut) |

Totals: 14 agents, 569 tool calls, 3.1M tokens. **Anything sourced only from the web is dated 2026-08-24 and should be re-checked before it drives a decision.** Where the research could not confirm something, this report says `unverified` rather than filling the gap.

---

## Part 1 — What weft actually is

140 distinct capabilities were inventoried with `file:line` evidence, across three areas. 131 are **solid** (complete and tested), 6 **partial**, and the README's own "honest deviations" section names 6 more that are design-only. What follows is the shape of it; the full list with evidence is in [Appendix A](#appendix-a--full-feature-inventory).

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

**3 — `verifyServe`: the journal is checked against the world.** A step spec may supply `verifyServe(journaled)`; a false verdict consumes the entry, journals `replay.diverged`, and re-executes with `io.reExecuting = true`. `git.commit` checks the sha is still an ancestor of HEAD; `git.checkout` checks HEAD is still on the ref; `git.tag` checks the tag still peels to the journaled sha; `ctx.integrate` checks tree hashes and reverse-apply. **No other replay engine in the survey does this at all** — Temporal, Restate, DBOS, Inngest, Vercel WDK, LangGraph and MAF all serve a journaled result unconditionally.

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

## Part 2 — The field

84 projects, six clusters. Star counts were read from the GitHub API on **2026-08-24** unless marked `(unverified)`; treat every number here as a snapshot, not a fact with a long shelf life.

### Durable execution engines

The durability lineage weft draws on. None of them knows what git, a schema, or a dollar is.

| Project | Lang | License | Stars | Positioning |
| --- | --- | --- | --- | --- |
| **Temporal (server + TypeScript SDK + AI/agent integrat…** | Go (server); TypeScri… | MIT (both temporalio/temp… | 22,502 | The canonical event-sourced durable execution platform. Workflow-as-code where the whole workflow function is deterministically re-executed against a… |
| **Restate** | Rust (server); SDKs i… | Server: Business Source L… | 4,338 | A single-binary durable execution server that sits in front of ordinary functions running in your own process. Restate owns the journal, the schedule… |
| **DBOS Transact (TypeScript)** | TypeScript (sibling S… | MIT (verified on the GitH… | 1,328 | A library, not a server. Durable workflows implemented as checkpoint rows in YOUR Postgres. Lowest operational footprint in the cluster — no broker,… |
| **Inngest (+ AgentKit)** | Go (server/executor);… | Server and CLI: Server Si… | 5,761 | Event-driven durable step functions delivered over HTTP, designed to run on serverless/edge. AgentKit layers a real multi-agent abstraction (Agent /… |
| **Trigger.dev (v3/v4)** | TypeScript | Apache 2.0 (verified on t… | 16,108 | Managed (and self-hostable) platform for long-running TypeScript tasks and AI agents, with no timeouts. Fundamentally different durability mechanism… |
| **Windmill** | Rust (server + worker… | AGPL-3.0 for the communit… | 17,661 | A self-hostable developer platform where scripts become webhooks, flows and auto-generated UIs. The flow engine is a declarative DAG advanced through… |
| **Hatchet** | Go (engine); SDKs in… | MIT (verified on the GitH… | 7,785 | A Postgres-backed distributed task queue that grew into a durable-execution and DAG orchestrator, now explicitly targeting long-running AI agents. It… |
| **Resonate HQ** | Rust (server); SDKs i… | Apache 2.0 (verified from… | 656 | 'Distributed async await'. Durable execution modelled as an addressable SET of durable promises rather than an ordered event log — a deliberate theor… |
| **Golem Cloud** | Rust (worker executor… | Business Source License 1… | 1,535 | An 'agent-native' durable computing platform that makes the WASM RUNTIME durable rather than journaling user-declared steps. Durability lives below t… |

### TypeScript agent frameworks

weft's own language and the layer it would be shelved next to.

| Project | Lang | License | Stars | Positioning |
| --- | --- | --- | --- | --- |
| **LangGraph.js** | TypeScript | MIT | 3,231 | "Framework to build resilient language agents as graphs." The reference graph-DSL orchestrator: you declare a typed state channel schema, register no… |
| **Mastra** | TypeScript | Dual: Apache-2.0 for the… | 27,437 (unverified) | "Mastra is the modern TypeScript framework for AI-powered applications and agents." The batteries-included TypeScript answer to LangGraph — agents, a… |
| **VoltAgent** | TypeScript | MIT | 10,409 | "AI Agent Engineering Platform built on an Open Source TypeScript AI Agent Framework." Deliberately framed as framework-plus-console: `@voltagent/cor… |
| **Motia → iii** | Rust engine with Type… | Split: engine under Elast… | 18,624 | MAJOR 2026 CHANGE — VERIFY BEFORE RECOMMENDING: Motia is winding down and has been rebranded/succeeded by iii ("three eye"), announced on motia.dev a… |
| **Inngest AgentKit** | TypeScript | Apache-2.0 | 922 (unverified) | "AgentKit: Build multi-agent networks in TypeScript with deterministic routing and rich tooling via MCP." A thin agent layer over Inngest's durable s… |
| **OpenAI Agents SDK for TypeScript** | TypeScript | MIT | 3,698 | "A lightweight, powerful framework for multi-agent workflows and voice agents." Deliberately minimal — four primitives (Agents, Handoffs, Guardrails,… |
| **Vercel AI SDK (v6) + AI Elements** | TypeScript | Apache-2.0 (GitHub report… | 26,393 | "The AI Toolkit for TypeScript." Primarily a provider-abstraction and UI-streaming layer rather than an orchestrator, but v6 pushed decisively into a… |
| **Vercel Workflow DevKit (WDK)** | TypeScript | Apache-2.0 | 2,346 | "Workflow SDK: Build durable, reliable, and observable apps and AI Agents in TypeScript." Vercel's bet that durable execution should be a language-le… |
| **Cloudflare Agents SDK** | TypeScript | MIT | 5,485 | "Build and deploy AI Agents on Cloudflare." Not a workflow DSL — an agent *runtime primitive*: each agent is a Durable Object with its own isolated S… |
| **Trigger.dev** | TypeScript | Apache-2.0 | 16,108 | "Trigger.dev – build and deploy fully-managed AI agents and workflows." A durable background-job platform that has repositioned around AI agents. The… |
| **LlamaIndex Workflows (TypeScript)** | TypeScript | MIT (per repo; verified a… | 257 | "Simple, event-driven and stream oriented workflow for TypeScript." The TS sibling of LlamaIndex's Python Workflows: no graph DSL, no builder — steps… |

### Python agent frameworks

The mindshare competition. Different language, same job description.

| Project | Lang | License | Stars | Positioning |
| --- | --- | --- | --- | --- |
| **LangGraph** | Python (parallel Type… | MIT for the core library.… | 40.4k | "Low-level orchestration framework for building stateful agents." Deliberately unopinionated graph runtime beneath LangChain's `create_agent`, Deep A… |
| **CrewAI** | Python | MIT (the OSS framework).… | 57.6k | "Open-source Python framework with high-level abstractions and low-level APIs for building production-ready multi-agent workflows." Two products in o… |
| **Microsoft Agent Framework (MAF)** | Python and .NET as fi… | MIT | 13.1k | The merged successor to AutoGen (multi-agent orchestration) and Semantic Kernel (enterprise kernel/plugins/connectors). Sells itself as the productio… |
| **AutoGen (microsoft/autogen, legacy)** | Python (with a .NET p… | MIT for code, CC-BY-4.0 f… | 60.6k | Historically the conversational multi-agent research framework (v0.4 rearchitected around an actor/event-driven core: AgentChat on top of autogen-cor… |
| **AG2 (AutoGen fork, ag2ai/ag2)** | Python | Apache-2.0 | 4.9k | Community fork of AutoGen (by original AutoGen authors) after the Microsoft rearchitecture, self-described as an 'open-source AgentOS'. AG2 v1.0 (`im… |
| **Google ADK (Agent Development Kit)** | Python (sibling adk-j… | Apache-2.0 | 21.3k | "A flexible and modular framework that applies software development principles to AI agent creation." Code-first, model-agnostic in principle but Gem… |
| **LlamaIndex Workflows (llama-index-workflows / run-lla…** | Python | MIT | 442 | "An event-driven, async-first, step-based way to control the execution flow of AI applications like agents." Explicitly anti-DSL: 'branch, loop, para… |
| **Pydantic AI (+ pydantic-graph, + Temporal / DBOS / Pr…** | Python | MIT | 19.5k | "How Python does AI: agents, realtime voice, image generation, embeddings. Every model, every interface, typed end to end." FastAPI-for-agents positi… |
| **Burr (Apache Burr, DAGWorks)** | Python | Apache-2.0 (now an Apache… | 2.5k | Build decision-making applications (chatbots, agents, simulations) as explicit state machines, with a strong bias toward monitoring, tracing, and inf… |
| **PocketFlow** | Python (core is 100 l… | MIT | 11.1k | "100-line minimalist LLM framework. Let Agents build Agents!" Explicitly anti-framework — the pitch is that LangChain is 405K lines of vendor lock-in… |
| **Prefect (and ControlFlow → Marvin)** | Python | Apache-2.0 (all three) | 23.7k | Prefect: "Workflow orchestration framework for building resilient data pipelines in Python" — a mature general-purpose durable orchestrator that pred… |
| **Dify** | Python backend, TypeS… | Dify Open Source License… | 153.4k | "An open-source LLM app development platform" — a full product, not a library: visual workflow canvas, RAG pipeline, agent nodes, prompt IDE, model m… |
| **Flowise** | TypeScript/JavaScript… | Apache-2.0 | 55.4k | Was: "Build AI Agents, Visually" — the TypeScript-native drag-and-drop counterpart to Dify, with Agentflow v2 as its agent-orchestration canvas. Now:… |

### Coding-agent harnesses and orchestrators

The closest competitors **by use case** — and where the distribution is.

| Project | Lang | License | Stars | Positioning |
| --- | --- | --- | --- | --- |
| **Claude Code (dynamic workflows, subagents, agent team…** | TypeScript/Node (CLI… | Proprietary / source-unav… | 142,871 | The reference agentic coding harness. As of 2026 it is no longer a single-agent REPL: it ships a full orchestration stack — subagents, agent teams, g… |
| **OpenHands (ex OpenDevin) + software-agent-sdk + Agent…** | TypeScript (frontend/… | MIT | 84,976 | Pivoted decisively in 2026 from 'autonomous SWE agent' to platform: Agent Canvas is 'the self-hosted developer control center for coding agents and a… |
| **SWE-agent (+ mini-swe-agent, EnIGMA)** | Python | MIT | 20,122 | The benchmark-driven research harness: take a GitHub issue, autonomously fix it, measured on SWE-bench. Entirely config-driven — 'governed by a singl… |
| **Aider** | Python | Apache-2.0 | 48,461 | The original git-native terminal pair programmer. Its enduring contribution is that every AI change is a git commit with a sensible message, so revie… |
| **Cline (+ Cline SDK multi-agent teams, Cline CLI)** | TypeScript | Apache-2.0 | 66,780 | The most direct open-source competitor to weft's orchestration layer that is ALSO a mainstream daily-driver agent. Cline now ships an SDK with multi-… |
| **Roo Code (ARCHIVED) / Zoo Code (community successor)** | TypeScript | Apache-2.0 | 24,328 | Historically the most important prior art for weft's orchestration model: Roo Code's Orchestrator (formerly 'Boomerang') mode popularized decomposing… |
| **opencode** | TypeScript | MIT | 200,999 (unverified) | The breakout open-source terminal agent of 2026 and the most credible model-agnostic alternative to Claude Code. Client/server by design: `opencode s… |
| **goose (Block → Agentic AI Foundation / Linux Foundati…** | Rust | Apache-2.0 | 53,385 | The general-purpose on-machine agent, not code-specific — but its Recipes system is the most complete DECLARATIVE workflow spec in this cluster, and… |
| **OpenAI Codex CLI (+ Codex app, subagents)** | Rust (codex-rs; with… | Apache-2.0 | 116,959 | OpenAI's terminal coding agent, and — with weft — one half of the multi-provider story: weft's AgentProvider puts Codex and Claude behind one interfa… |
| **Gemini CLI** | TypeScript | Apache-2.0 | 106,664 | Google's open-source terminal agent, notable for being the only major vendor CLI released under Apache-2.0 with the full source in the open (Claude C… |
| **container-use (Dagger)** | Go | Apache-2.0 | 4,016 | Not an agent — an isolation SUBSTRATE for agents, delivered as an MCP server so any MCP-capable agent (Claude Code, Codex, Cursor, goose) gains conta… |
| **Sculptor (Imbue)** | Python | MIT (verified by fetching… | 218 | A desktop workspace for parallel, container-isolated coding agents from research lab Imbue. Its distinctive contributions are containers-not-just-wor… |
| **claude-squad** | Go | AGPL-3.0 | 8,361 | A terminal multiplexer for parallel coding agents: tmux session + git worktree per agent, agent-agnostic (Claude Code, Codex, Gemini, OpenCode, Amp,… |
| **Crystal (now Nimbalyst)** | TypeScript (Electron… | MIT | 3,109 | A desktop app for running multiple Codex and Claude Code sessions in parallel git worktrees, with an explicit emphasis on COMPARING approaches — run… |
| **Vibe Kanban** | Rust | Apache-2.0 | 27,903 | A kanban board over coding agents: plan work as issues, create isolated workspaces where any of 10+ agents execute, review diffs inline, and ship via… |
| **uzi** | Go | MIT | 582 | 'CLI for running large numbers of coding agents in parallel with git worktrees.' Its distinguishing bet was SCALE: not 3-5 agents but many, launched… |
| **Conductor (Melty Labs)** | Swift/TypeScript (mac… | Proprietary, closed sourc… | Star count: not applicable (no public r… | The polished commercial answer to claude-squad: a free Mac app that runs multiple Claude Code and Codex agents in parallel, each in its own git workt… |

### Typed-LLM-IO and observability/eval tooling

The layers weft bundles into its steps, done as dedicated products.

| Project | Lang | License | Stars | Positioning |
| --- | --- | --- | --- | --- |
| **Instructor** | Python (ports: TypeSc… | MIT | 13.8k (unverified) | The canonical retry-based structured-output library: patch any LLM client so it returns a validated Pydantic (or Zod) object instead of a string. Del… |
| **BAML (BoundaryML)** | Rust core; generates… | Apache-2.0 | 9.1k | Was a DSL for typed LLM functions; as of 2026 the repo and homepage position BAML as 'the programming language for agents' — v1 is a separate, fully… |
| **Outlines (.txt / dottxt-ai)** | Python (with a Rust c… | Apache-2.0 | 15.7k | The constrained-decoding camp: 'guarantees structured outputs during generation'. Rather than parsing or repairing after the fact, it masks logits so… |
| **DSPy** | Python | MIT | 37.6k (unverified) | 'Programming — not prompting — language models.' Prompts are not authored; they are *compiled* by optimizers against a metric and a dataset. The decl… |
| **Microsoft TypeChat** | TypeScript (with Pyth… | MIT | 8.7k | 'Replace prompt engineering with schema engineering.' The most direct ancestor of weft's step contract in the TypeScript world: a TypeScript type *is… |
| **Marvin (PrefectHQ)** | Python | Apache-2.0 | 6.2k | 'An ambient intelligence library.' Marvin 3.0 merged the ergonomic one-liner AI functions of Marvin 2.0 with the agentic orchestration engine of Cont… |
| **Guardrails AI** | Python | Apache-2.0 | 7.3k | A validation and risk-mitigation firewall around LLM calls: input Guards and output Guards composed from reusable Validators, with a rich taxonomy of… |
| **Langfuse** | TypeScript (Next.js w… | MIT for the repository ex… | 33.6k | The default self-hostable LLM engineering platform: tracing + prompt management + evals + datasets + cost, MIT-licensed with a genuinely usable free… |
| **LangSmith (OSS surface only)** | Python and JavaScript… | MIT for the SDK. The Lang… | 1.0k | The commercial counter-example in this cluster: a mature, deeply integrated tracing/eval platform whose *client* is open source and whose *server* is… |
| **Arize Phoenix** | Python (server and SD… | Elastic License 2.0 (ELv2… | 11.2k | The OpenTelemetry-purist observability platform: everything is OTel spans following OpenInference semantic conventions, so Phoenix is a *backend* for… |
| **Braintrust (OSS components)** | TypeScript/JavaScript… | Apache-2.0 (SDKs, autoeva… | 27 | An eval-first commercial platform (evals as the primary artifact, tracing secondary) that open-sources its client SDKs, its scorer library, its LLM p… |
| **Opik (Comet)** | Java backend, TypeScr… | Apache-2.0 (full platform… | 21.6k | The most permissively licensed full platform in this cluster: Apache-2.0 end to end, self-hostable via Docker Compose or Helm with no feature gating,… |
| **Helicone** | TypeScript/JavaScript… | Apache-2.0 | 6.1k (unverified) | The gateway-first take: sit in the request path rather than instrument the code. Change your `baseURL` and you get logging, caching, rate limiting, c… |
| **OpenInference (Arize)** | Python, TypeScript/Ja… | Apache-2.0 | 1.2k | A specification plus instrumentation libraries that layer AI-specific conventions on top of OpenTelemetry. Explicitly complementary to OTel — spans a… |
| **OpenTelemetry GenAI Semantic Conventions** | YAML models compiled… | Apache-2.0 | 279 | The official, vendor-neutral OpenTelemetry standard for GenAI telemetry. As of 2026 it has been split out of the main semantic-conventions repo into… |

### HITL, sandboxing, standards, and CI-native runners

The edges weft has not built, done well by others.

| Project | Lang | License | Stars | Positioning |
| --- | --- | --- | --- | --- |
| **HumanLayer / CodeLayer** | Python + TypeScript S… | Apache-2.0 (SDK and CodeL… | 11.3k | Started as the canonical 'human-in-the-loop as an API' layer: wrap any high-stakes tool call in require_approval() and route the approval to Slack/em… |
| **Dagger Container Use** | Go | Apache-2.0 | 4k | The closest thing in this cluster to weft's git-worktree write-step model, but delivered as an MCP server rather than an engine. Every coding agent g… |
| **E2B** | TypeScript and Python… | Apache-2.0 (SDK and infra) | 13.5k | The default 'secure sandbox as a service, with a real self-host path' for running AI-generated code. Firecracker microVMs give a hardware-enforced bo… |
| **Daytona** | Python, TypeScript/Ja… | Open-source license file… | 71.9k (unverified) | An 'elastic infrastructure runtime for AI-generated code execution and agent workflows' — sandboxes advertised as full isolated computers (own kernel… |
| **Modal Sandboxes** | Python SDK (client op… | Client library Apache-2.0… | Widely adopted commercial platform; Mod… | Serverless-compute-first sandboxing: Sandboxes are 'secure containers for executing untrusted user or agent code', built on gVisor with additional cu… |
| **microsandbox** | Rust (SDKs for TypeSc… | Apache-2.0 | 7.9k | 'Easy, fast, local microVMs for untrusted workloads' — libkrun-based microVMs launched as ordinary child processes, no cluster, no cloud account. Thi… |
| **gVisor** | Go | Apache-2.0 | 19.1k | Not an agent tool — the isolation primitive several agent sandboxes are built on. A userspace application kernel (Sentry) written in memory-safe Go t… |
| **Anthropic sandbox-runtime (srt)** | TypeScript / Node (wi… | Apache-2.0 | 5.1k | OS-level sandboxing for agents without containers: bubblewrap on Linux, Seatbelt (sandbox-exec) on macOS, a dedicated sandbox account with WFP egress… |
| **Model Context Protocol (MCP)** | Spec in TypeScript sc… | MIT (spec and reference S… | The dominant agent-tooling standard; ad… | The interop substrate for tools/context, and — as of the Tasks extension — increasingly a substrate for *durable, long-running, human-gated* operatio… |
| **Agent2Agent (A2A)** | Spec (JSON-RPC 2.0 ov… | Apache-2.0 | Reported to have surpassed 22,000 GitHu… | The complement to MCP: MCP connects an agent to tools, A2A connects an agent to another *opaque* agent that will not expose its internal state, memor… |
| **AGENTS.md** | Markdown convention | Open/permissive (spec sit… | Over 60,000 open-source projects report… | The de facto configuration format for the whole 'run an agent on my repo' category — a README for agents, holding build commands, test commands, conv… |
| **Agent Client Protocol (ACP)** | Rust (official librar… | Apache-2.0 | 4.1k | Standardizes the editor↔agent boundary the way LSP standardized editor↔language-server: JSON-RPC over stdio for local agents (agent runs as an editor… |
| **GitHub Agentic Workflows (gh-aw)** | Go | MIT | 5,000 | The most direct competitor to weft on the 'declare a repeatable agent workflow over my repo' job, and the strongest security architecture in the CI-n… |
| **Claude Code Action** | TypeScript | MIT | 8.7k | The reference way to put Claude Code into GitHub Actions: @claude mentions in issues/PRs, issue assignment, or explicit prompts in a workflow file. C… |
| **GitHub Copilot coding agent / Agent HQ** | N/A (hosted service) | Proprietary, commercial (… | Bundled with GitHub Copilot subscriptio… | The platform-incumbent answer to 'run an agent workflow on my repo', and the biggest structural threat to every project in this cluster. Agent HQ (an… |
| **OpenAI Codex Cloud** | N/A (hosted); Codex C… | Proprietary service; Code… | Bundled with ChatGPT paid plans; the Co… | Cloud-hosted, task-parallel coding agent: each task runs in its own isolated sandboxed container preloaded with your repo, configured by AGENTS.md an… |
| **Google Jules** | N/A (hosted); Action… | Proprietary service; the… | Launched as a Google Labs experiment De… | Asynchronous coding agent: clones your repo into an ephemeral Google Cloud VM, writes a plan, executes multi-file changes, runs tests, and opens a PR… |
| **AgentOps** | Python | MIT | 5.8k | Observability and cost tracking for agents: two lines of code to instrument, then session replay with step-by-step execution graphs, per-provider spe… |
| **Linear Agent Sessions (Agent Interaction Protocol)** | N/A (GraphQL API + we… | Proprietary | Linear is widely used for issue trackin… | Not a workflow engine — the best-designed *host surface* for agent work in a tool humans already use. The Agent Session model makes an agent a delega… |


---

## Part 3 — Feature comparison

18 dimensions chosen because they *discriminate* — every one of them separates these tools rather than describing all of them. Where the research could not establish a project's behaviour, the rating is `unknown` and it is omitted rather than guessed.

### Where weft stands, at a glance

| # | Dimension | Weft's standing | The short reason |
| --- | --- | --- | --- |
| 1 | Durability mechanism | **Competitive** | Correct design, library footprint; the server-backed engines are more battle-tested |
| 2 | Edit-tolerant replay | **Leads** | Content-addressed salvage + body-hash guard; only Inngest and Resonate are in the conversation |
| 3 | Determinism enforcement | **Competitive** | Two-layer fence, but *bans* what Temporal and Golem *record* |
| 4 | Typed step I/O + repair | **Competitive** | Required schema everywhere is stricter than anyone; the repair mechanism is behind BAML |
| 5 | HITL durability | **Leads** | Reject-and-reopen, `answeredBy` provenance, cross-process CAS delivery |
| 6 | HITL reach | **Absent** | Zero notification code. The single largest mechanism-to-promise gap |
| 7 | Git isolation + gated integration | **Leads** | `ctx.integrate()` has no equivalent; container-use isolates deeper but has no workflow layer |
| 8 | Multi-provider routing | **Behind** | Three provider ids, Claude-only price table, and Claude/Codex enforce `strict` differently |
| 9 | Hard budget ceilings | **Leads** | Tokens *and* USD, inherited across the run tree, admission-controlled |
| 10 | Concurrency & fairness | **Behind** | A global semaphore; no keys, queues, priorities or rate limits |
| 11 | Testing without model calls | **Competitive** | Excellent harness; no time-skipping, no golden-trace conformance, no corpus replay gate |
| 12 | Observability depth | **Behind** | The richest per-step record in the field, emitted as one span per run |
| 13 | Authoring model | **Leads (jointly)** | Plain TS; Vercel WDK, Trigger.dev, Inngest and DBOS share the thesis |
| 14 | Security boundary | **Absent** | Explicitly disclaimed, and `fetchAllow` is undefined by default |
| 15 | Ownership, fencing, crash safety | **Leads (among libraries)** | Everyone else who has this bought a server for it |
| 16 | Fork / time-travel / operator verbs | **Absent** | Three recovery verbs and no exploration; DBOS, LangGraph and Burr all ship fork |
| 17 | Deployment footprint | **Leads** | No server, no database, no account — matched only by DBOS and Burr |
| 18 | Maturity & adoption | **Absent** | Design preview, unpublished, zero users |

Seven leads, four competitive, three behind, four absent. **Every "absent" is at an edge, not in the engine** — which is the whole diagnosis of this report.

### The dimensions in detail

#### 1. Durability mechanism

**Weft.** Append-only JSONL journal per run is the sole source of truth; state.json, tree.json, report.md and the sqlite index are all pure folds over it (projections.ts). FsJournalStore appends under a cross-process lock with double on-disk reconcile, torn-tail truncation, writeSync-to-completion and fsync; blobs are content-addressed and sha256-verified on read. Resume re-executes the workflow body and serves completed steps from the journal.

| | Project | How they do it |
| --- | --- | --- |
| 🟩 strong | Temporal | Event-sourced Event History persisted server-side; replay rebuilds in-memory state. The reference implementation, but requires a server + persistence store. |
| 🟩 strong | Vercel Workflow DevKit | Same thesis independently: journaled event log of step inputs/outputs, function replayed from top, completed steps return journaled values. Pluggable `World` backend, Postgres self-host. |
| 🟩 strong | Restate | Server-owned journal (Rust/RocksDB) of ctx.run/sleep/RPC/state; handlers suspend rather than block. BSL 1.1 server. |
| 🟩 strong | DBOS Transact | Checkpoint rows in your own Postgres, queryable with SQL and transactable with app writes. Library, not server — closest footprint peer. |
| 🟩 strong | Inngest | Step memoization keyed on step id + occurrence counter over managed state; function body re-executes from top on every step. |
| 🟩 strong | Trigger.dev | Different mechanism: CRIU process checkpoint/restore, so no journal of step results exists at all — but runs genuinely survive arbitrary waits. |
| 🟩 strong | OpenHands software-agent-sdk | Closest architectural twin: base_state.json plus numbered per-event JSON files (event-00000-abc.json). But it restores state rather than replaying, so no salvage. |
| 🟨 partial | Mastra | Snapshot-per-run through a storage adapter; a resumed step re-runs from its start. Checkpoint, not event log. |
| 🟨 partial | LangGraph.js | Checkpointer snapshots channel state at superstep boundaries. Granularity is the node — any code before an interrupt re-executes. |
| 🟨 partial | Cline agent teams | task-board.json / mailbox.json / mission-log.json persist to ~/.cline/data/teams/ and survive restarts — but that is coordination state, not step results. |
| 🟥 none | Claude Code dynamic workflows | Workflow resume is process-scoped: "If you exit Claude Code while a workflow is running, the next session starts the workflow fresh." Conversation transcripts are durable; workflow runs are not. |

#### 2. Edit-tolerant replay (changing the workflow mid-run)

**Weft.** Identity is sha256(canonicalJson{kind, payload, schema, key}) — content, not position. matchStep tries three tiers: same seq + same hash, then any unconsumed same-hash entry (salvage, journaling replay.salvaged), then under --reuse key an unconsumed same-key entry. run.created stamps bodyHash = sha256(name + def.run.toString()) plus an optional bundle defHash; when they disagree positionsTrusted=false and a keyless step matching several journaled entries re-runs with an "ambiguous keyless identity" divergence rather than guessing. Unmatched steps re-run live inside history.

| | Project | How they do it |
| --- | --- | --- |
| 🟩 strong | Inngest | Publishes the compatibility matrix as a contract: body change → memoized, add → runs on reach, remove → orphan ignored, reorder → warn but still serves by hash, id change → re-runs. Deliberately no version pinning. |
| 🟩 strong | Resonate HQ | Durable promises form an unsequenced addressable SET, so insert/remove/reorder yields different id lookups rather than a positional mismatch. The clearest published theory for why this works — but 57 stars on the TS SDK. |
| 🟨 partial | DBOS Transact | forkWorkflow(id, startStep, {applicationVersion, replacementChildren}) is explicit and operator-driven, and applicationVersion defaults to a hash of workflow source with recovery fenced to matching versions. But step identity is name/position based, so automatic tolerance is weaker. |
| 🟨 partial | Temporal | patched()/deprecatePatch markers written into history, plus Worker Deployment Versioning with pinned/auto-upgrade, ramping and rollback. Explicit and auditable, but requires author scaffolding and leaves permanent conditional scar tissue. |
| 🟨 partial | Golem Cloud | Author-written save-snapshot/load-snapshot migration, applied only when the worker is idle, with automatic revert if load fails. Plus a best-effort automatic-update mode documented as safe only for minor changes. |
| 🟥 none | Vercel Workflow DevKit | Journaled replay with no content-addressed salvage — the classic replay-versioning problem, unaddressed. |
| 🟥 none | Restate | An in-place edit that reorders/adds/removes SDK calls yields error RT0016 on replay; the answer is immutable deployments, and the vendor concedes long-running handlers are "still a headache". |
| 🟥 none | LangGraph | Checkpoints assume the same graph topology; edit the graph and in-flight threads are unreliable at best. |
| 🟥 none | Microsoft Agent Framework | Docs are explicit: topology AND executor identity must match, and stale checkpoints "cannot be repaired" — start a new lineage. |
| 🟥 none | Google ADK | Documented limitation: "you cannot modify the workflow before resuming it." |
| 🟥 none | Trigger.dev | A run locks to the environment version at start and never changes, including across retries. The only recourse is Replay — a brand-new run from the beginning, discarding every completed step. |
| 🟥 none | Hatchet | No versioning, no pinning, no fork verb; deploying mid-run is undefined behaviour you reason about yourself. |

#### 3. Determinism enforcement

**Weft.** Two layers, and the README concedes it is a fence rather than a boundary. (1) Eleven AST rules parsed with the TS compiler API, applied via an esbuild onLoad plugin to EVERY module the bundle pulls in — no-date-now, no-argless-date, no-math-random, no-timers, no-global-fetch, no-process-env, no-require, no-gc-globals, no-locale, no-intl, no-bare-import — each with a ctx-naming fix-it, surfaced by `weft check`. (2) A node:vm context with replaced globals that throw, catching the computed form (globalThis["Da"+"te"]) the AST layer deliberately cannot see. Notably: banning, not recording — there is no journaled Date.now, only ctx.now().

| | Project | How they do it |
| --- | --- | --- |
| 🟩 strong | Temporal | vm sandbox with a seeded PRNG for Math.random, Date pinned to last task completion, timers routed to durable timers, WeakRef/FinalizationRegistry removed. Violations fail loudly at replay with DeterminismViolationError — but no authoring-time static gate. |
| 🟩 strong | Vercel Workflow DevKit | Strictly friendlier design: the sandbox makes Math.random and Date replay-STABLE rather than unavailable, so ordinary code keeps working. weft bans what WDK records. |
| 🟩 strong | Golem Cloud | The inverse approach and arguably the best: every WASI host-function result — clocks, randomness, I/O, network — is recorded in the oplog and replayed, so user code needs no determinism discipline at all. |
| 🟨 partial | Claude Code dynamic workflows | The orchestration script sandbox forbids import(), filesystem and shell access (only agents touch the world), but there are no determinism rules — Date.now and Math.random are fine. |
| 🟥 none | Restate | No sandbox, no static gate; non-determinism surfaces only as a replay mismatch after the fact. |
| 🟥 none | DBOS Transact | Pure honor system — docs state workflows "should invoke the same steps with the same inputs in the same order" with zero enforcement and no divergence error. |
| 🟥 none | Inngest | Non-deterministic code outside step.run is a documented footgun with no sandbox and no detection. |
| 🟥 none | Trigger.dev | None needed, and that is the point: CRIU checkpointing means no replay ever happens, so Date.now/Math.random/open handles are all fine anywhere. |
| 🟥 none | LangGraph.js | Nothing prevents clocks, randomness or network inside a node; replay fidelity is convention only. |
| 🟥 none | Mastra | No determinism enforcement of any kind. |
| 🟥 none | Hatchet | No sandbox, no static gate, no divergence error — the weakest of the durable engines on this axis. |

#### 4. Typed step I/O with in-session schema repair

**Weft.** `schema` is required on agent, human.*, and workflow I/O. Zod → JSON Schema via z.toJSONSchema({io:"input"}), with any non-object root wrapped as {value} because providers demand an object root, unwrapped symmetrically on return. runProviderWithRepair validates the unwrapped value against the REAL schema and, on failure, journals a step.attempt ("schema repair n/max") and calls provider.repair(sessionId, req, issues) in the SAME provider session up to limits.repair (default 2) before throwing schema_repair_exhausted. Usage accumulates per turn with per-turn non-negative normalization and rides the error so a resume restores the spend. Honest limit: a non-Zod Standard Schema degrades to a permissive {value:{}} carrier with no shape guidance at all.

| | Project | How they do it |
| --- | --- | --- |
| 🟩 strong | Pydantic AI | output_type + automatic ModelRetry feeding the specific validation error back, bounded by `retries`, plus @agent.output_validator for custom post-validation that can also raise ModelRetry. The closest peer. |
| 🟩 strong | Instructor | The canonical implementation: the failed assistant message plus the literal validation error text are appended and re-issued up to max_retries. Also has validation_context, letting validators assert runtime facts — something weft's structural Zod pass cannot express. |
| 🟩 strong | BAML | Schema-Aligned Parsing coerces malformed output (fences, prose, wrong scalar types, near-miss keys) in one sub-10ms Rust pass with no extra model call. Published BFCL numbers show large first-pass gains. Strictly cheaper than weft's repair round-trip. |
| 🟩 strong | Mastra | createStep({inputSchema, outputSchema}) validated at every boundary via Standard Schema (Zod/Valibot/ArkType). Closest in spirit to weft, but repair on failure is not a documented first-class loop. |
| 🟩 strong | Vercel AI SDK | generateObject with Zod, malformed-JSON repair hook and retry; v6 added Output.object/array/choice composable with tool calling in one loop. |
| 🟩 strong | Microsoft TypeChat | Uses the TypeScript compiler itself as validator and its diagnostics as the repair prompt — better error text than Zod issue paths, bounded by maxRepairAttempts. |
| 🟨 partial | goose Recipes | response.json_schema enforces structured output for the whole run, and retry{max_retries, checks} validates with shell commands — but repair is a whole-run retry, not in-session. |
| 🟨 partial | Claude Code dynamic workflows | agent(prompt, {schema}) resolves to a parsed object, but there is no documented repair loop — it resolves to null on failure and you .filter(Boolean). |
| 🟨 partial | LangGraph | create_agent's ToolStrategy has an in-loop repair path with configurable handle_errors, but graph-step state itself is only as validated as the state schema. |
| 🟥 none | Temporal | Payloads pass through a DataConverter; type safety is TypeScript compile-time only, with no runtime enforcement and no repair. |
| 🟥 none | Vercel Workflow DevKit | The clearest gap versus weft: step inputs/outputs need only be serializable, with no per-step schema and no runtime check. Pass-by-value mutation silently does nothing. |
| 🟥 none | Restate / DBOS / Inngest | No engine-level validation of step results in any of the three; Inngest validates event payloads only. |

#### 5. Human-in-the-loop durability

**Weft.** A human step is a journaled step whose provider is a person. runHuman hashes {kind, question, detail, schema, risk, artifact, timeout} and matches a journaled request, serving a standing answer in journaled order or re-surfacing the same request id. Engine.answer serializes per runId::requestId and appends via journal.appendIf under a re-fold loop, so a standing answer, a terminal event or a lost CAS refuses the caller — safe across processes. The answer is validated against the step's authoritative Standard Schema; a failure journals human.rejected and REOPENS the request rather than failing the run. Deadlines arm chunked timers with deny / escalate / {default} policies (defaults pre-validated at request time, not at the deadline). Risk-tier + glob approval policy auto-approves with answeredBy:"policy" recorded, and irreversible+ask demands a confirm:<sha256(action)[0:8]> token.

| | Project | How they do it |
| --- | --- | --- |
| 🟩 strong | Trigger.dev | wait.createToken → {id, webhook URL, browser-safe publicAccessToken} with timeout and tags; because it checkpoints rather than replays, code before the wait does not re-execute — a real advantage over LangGraph. |
| 🟩 strong | Windmill | Richest configuration anywhere: N-of-M required approvals, schema-backed approval forms whose fields arrive as resume['field'], group restriction, no-self-approval, continue-on-disapproval as a typed branch, recorded approvers array, native Slack/Teams. |
| 🟩 strong | Microsoft Agent Framework | Pending requests AND responses are part of the checkpoint payload, with an entry checkpoint written when responses are delivered — so a crash mid-request is genuinely recoverable, not just resumable forward. |
| 🟩 strong | Mastra | suspend() persists the snapshot with typed suspendSchema AND resumeSchema, so both directions are checked contracts. But the resumed step re-runs from its start. |
| 🟩 strong | Pydantic AI | Deferred tools terminate the run with DeferredToolRequests; resume is message_history + DeferredToolResults keyed by tool-call id, and the resume payload can carry an exception (ModelRetry/ToolFailed) as well as a value. |
| 🟩 strong | Restate | ctx.awakeable() mints an id resolvable by any process at any time; a suspended handler holds zero compute. |
| 🟩 strong | Temporal | Signals/Queries/Updates are history events, with Updates carrying validators. Durable and battle-tested, but no approval semantics, identity, or N-of-M — you build all of that. |
| 🟨 partial | LangGraph | interrupt()/Command(resume) is durable, but the WHOLE NODE re-executes on resume and the docs push idempotency onto the author. Multiple interrupts in one node match resume values strictly by index. |
| 🟨 partial | HumanLayer | Richest routing and escalation in existence, but approval state lives in a vendor backend and the surrounding agent run is not durable — a crash after approval loses everything downstream. |
| 🟨 partial | Cline / opencode / Codex CLI | Excellent per-action approval UX (diff preview, permission matrices), but in-process — kill the process and the pending prompt is gone. |
| 🟥 none | Claude Code dynamic workflows | Explicit: "No mid-run user input. Only agent permission prompts can pause a run." AskUserQuestion is stripped from every subagent. Multi-stage sign-off requires splitting into separate workflows. |
| 🟥 none | gh-aw | No blocking gate at all; safety is structural (read-only agent, validated safe outputs applied by a separate job). |

#### 6. HITL reach — how the human actually finds out

**Weft.** Nothing. Verified by grep across packages/*/src: no Slack, no email, no webhook, no push, no notification of any kind. A pending request is discoverable only by `weft status` (which prints the exact `weft answer` command), the loopback-only daemon page, or the MCP weft_wait long-poll. The run blocks durably and indefinitely; nobody is told. This is the single largest gap between weft's mechanism and its promise that "the answer can arrive hours later".

| | Project | How they do it |
| --- | --- | --- |
| 🟩 strong | HumanLayer | Contact-channel objects per call — Slack (channelOrUserId + contextAboutChannelOrUser) or email (address + contextAboutUser) — with escalation paths, timeouts, and granular routing to a team vs an individual. |
| 🟩 strong | Windmill | getResumeUrls() yields signed resume/cancel/approval-page URLs to mail to a reviewer who never touches the engine, plus native interactive Slack and Microsoft Teams approvals. |
| 🟩 strong | Trigger.dev | The token carries a webhook URL and a browser-safe public token usable from a page with CORS; React Realtime hooks render the approval UI; tags make pending approvals filterable in the dashboard. |
| 🟩 strong | Linear Agent Sessions | Elicitation renders as an activity inline in the issue thread that motivated the work, answered by replying in that thread — the lowest-friction design in the landscape. |
| 🟩 strong | OpenAI Codex Cloud | Tasks are initiated and results delivered through GitHub PRs, GitLab MRs, Linear issues and Slack — the human never context-switches. |
| 🟩 strong | GitHub Copilot Agent HQ | Mission control on web, VS Code and mobile, so a gate can be answered from a phone. |
| 🟨 partial | Claude Code Action | A live-updating comment with checkboxes in the issue/PR thread — presentation only (no mid-run gate), but it reaches the human where they already are. |
| 🟨 partial | A2A | Push notifications to a caller-supplied webhook on task state change, so no held connection is required. |
| 🟨 partial | MCP Tasks | input_required status with an inputRequests map, but actually surfacing it to a person is the client's job. |
| 🟥 none | Temporal / Vercel WDK / Mastra / LangGraph | All have durable pause primitives and none has a delivery channel — the same gap as weft, and equally load-bearing in practice. |

#### 7. Git isolation, patch capture and gated integration

**Weft.** A write step gets a per-ATTEMPT worktree at tmpdir/weft-worktrees/<runId>/<seq>.<attempt> (per-attempt so a retry never deletes a directory a hung attempt still writes to), pre-pruned, and seeded from integrationBaseCommit — a dangling ref-pinned commit of the current tracked+untracked tree — so later writers build on earlier ctx.integrate() results rather than HEAD. capturePatch stages everything, force-adds in-scope gitignored outputs, refuses accidental gitlinks, and emits diff --cached --binary --no-renames -z. scopeMatcher compiles includes and !-excludes as TWO picomatch matchers (array semantics fail open twice) and is shared verbatim with Claude's live canUseTool gate. Out-of-scope files journal scope.violation and quarantine under strict. ctx.integrate() is the only merge point: an outer journaled step per patch wrapping nested snapshot and apply sub-steps, onConflict fail/agent/ask, and a verifyServe idempotency chain (result tree hash → reverse-apply --check → later merge's baseTree → forward-apply --check). A run ending with un-integrated, un-discarded patches fails with unintegrated_patches.

| | Project | How they do it |
| --- | --- | --- |
| 🟩 strong | container-use (Dagger) | Stronger on isolation, weaker on review: branch AND container per agent, so environment (deps, ports, services) is isolated too — the hole weft's worktrees leave open. But no patch object, no scope checking, no integrate gate; review is `git checkout` afterwards. |
| 🟩 strong | Claude Code | Stronger enforcement, weaker composition: statically blocks Edit/Write into the main checkout, Bash whose cwd resolves there, git -C / --git-dir / GIT_DIR / GIT_WORK_TREE / preceding cd, and any command shape it cannot prove stays inside (brace expansion, unquoted heredocs). But work lands as commits on a branch, not… |
| 🟩 strong | OpenAI Codex CLI | Automatic worktree per subagent PLUS an OS sandbox (Seatbelt/Landlock/WFP), with .git protected even in workspace-write mode. No patch/integrate model. |
| 🟩 strong | gh-aw | Structurally different and arguably safer: the agent job is read-only and can only emit schema-validated "safe outputs" (create-pull-request, push-to-branch, …) applied by a separately permissioned job, with per-type max limits and required-label filters. |
| 🟨 partial | Cline | Shadow git repository committing a full tree snapshot after every tool use gives file-level undo including untracked files — but team specialists appear to share one working tree, so concurrent edits collide. |
| 🟨 partial | claude-squad / Crystal / Conductor / uzi / Vi… | All do worktree+branch per agent with a human as scheduler. None does scope checking, patch objects, conflict policy, or a gated integrate — the worktree is now table stakes; the patch model is not. |
| 🟨 partial | Sculptor | Worktree + experimental container per workspace, plus Pairing Mode syncing isolated work back to the local checkout so a human can run and edit it — the review affordance weft's patch model lacks. |
| 🟥 none | Aider | Strongest git INTEGRATION (every edit is an auto-commit, /undo is a revert), weakest git ISOLATION — it edits your working tree directly. |
| 🟥 none | Temporal / Restate / DBOS / Inngest / WDK / M… | Zero git awareness across the entire durable-execution and TS-agent-framework space. This is where weft has no peer among engines. |

#### 8. Multi-provider / per-step routing

**Weft.** A frozen AgentProvider interface (id, capabilities(), run, repair) with Claude, Codex and mock adapters; routing resolves step opts → workflow defaults → engine config, and a configured default model applies only when the step actually routes to the provider that default was written for. Per-step provider/model/effort makes a cross-vendor panel one option on one step. Real asymmetry underneath: Claude enforces write scope LIVE via canUseTool while Codex has no permission hook (sandbox only, filesTouched: [], maxTurns/onMaxTurns/tools.deny ignored); ProviderHitl.onAsk is declared and fenced but never called by any shipped adapter; and there is NO AgentProvider conformance suite despite the README's package table implying one.

| | Project | How they do it |
| --- | --- | --- |
| 🟩 strong | opencode | Models.dev-backed provider catalogue, OAuth flows, per-agent model override, ACP support. The strongest genuinely model-agnostic story in the landscape. |
| 🟩 strong | OpenHands | A superset of weft's idea: LiteLLM for models, and Agent-Client Protocol so whole third-party AGENTS (Claude Code, Codex, Gemini CLI) are pluggable, not just model APIs. |
| 🟩 strong | Vercel AI SDK | ~30+ providers behind one LanguageModelV2, string-addressable via the gateway, with middleware and provider-specific tools exposed uniformly. Model-level, not agent-level. |
| 🟩 strong | Cline | Anthropic, OpenAI, Gemini, 200+ via OpenRouter, Bedrock, Vertex, Ollama/LM Studio, with per-mode and per-specialist model selection. |
| 🟩 strong | BAML | Adds something weft lacks: `client` blocks compose into strategy clients with retry_policy, fallback chains and round-robin, declared rather than written at the call site. |
| 🟩 strong | Pydantic AI | Full provider matrix plus FallbackModel — an ordered chain that fails over automatically on provider error. |
| 🟩 strong | gh-aw | Copilot, Claude Code, Codex, Gemini and Pi selected in frontmatter — but per workflow, not per step. |
| 🟩 strong | GitHub Copilot Agent HQ | Copilot, Claude and Codex agents under one control plane with one review surface — per task, at the largest installed base in the category. |
| 🟩 strong | Roo Code (archived) | Per-mode model + API profile was the cleanest per-step routing UX shipped by anyone; the project archived 2026-05-15. |
| 🟨 partial | Claude Code | Per-subagent model routing (sonnet/opus/haiku/claude-opus-5/inherit) and per-invocation overrides — but strictly inside the Anthropic family. Cannot put Codex behind the same step. |
| 🟨 partial | OpenAI Codex CLI | Per-subagent model AND reasoning effort with [agents] defaults and parent inheritance — the effort axis weft treats as opaque — but OpenAI models only in practice. |

#### 9. Hard budget ceilings (tokens and USD)

**Weft.** Budget.charge sums non-negative input+output tokens and usd and propagates up the parent chain; remainingTokens/remainingUsd take min(own, ancestor headroom); checkBeforeStep throws BudgetExceededError once either axis hits zero, and budget_exceeded is explicitly non-retryable. Child budgets are created by fraction-of-remaining or absolute cap and are ALWAYS parent-linked. reserveCall is a concurrency-aware admission test that PARKS rather than refuses: admits() requires (inflight+1) × (spent/samples) to fit, serializes calls one at a time while no cost sample exists, and wakes parked callers on every charge or release. Missing USD is priced from config.providers[id].prices[model] or DEFAULT_PRICES, and a USD-only ceiling with a provider that reports no usd and has no configured price is REFUSED before dispatch. Resume restores max(journaled usage sum, last budget.sampled) plus a recursive walk of parentage-verified descendant journals. Honest limits: admission is a heuristic using observed average cost and undercounts zombie in-flight attempts, so the ceiling can overshoot by one call; a crash between a charge and both the terminal record and any sample loses that spend; DEFAULT_PRICES is Claude-only.

| | Project | How they do it |
| --- | --- | --- |
| 🟩 strong | Helicone | Enforced at a different layer and the closest thing to weft's rigor: rate limits expressible in requests, TOKENS, or DOLLARS, per user / per team / globally, backed by an open 300+ model pricing database. A gateway, not a workflow engine — and the project is now in maintenance mode after the Mintlify acquisition. |
| 🟨 partial | Pydantic AI | The only framework peer with real enforcement: UsageLimits(request_limit, input/output/total_tokens_limit) raises UsageLimitExceeded. But token-only, no USD, per-run, and it does NOT automatically propagate into sub-agent runs — you thread it through yourself. |
| 🟨 partial | SWE-agent | --agent.model.per_instance_cost_limit genuinely stops an instance, hardened by running thousands of instances. Per-instance and total, but no parent/child inheritance model. |
| 🟨 partial | Trigger.dev | Org-level spend cap that PAUSES and queues rather than fails, with alerts at 75/90/100/200/500% — the graceful-degradation half weft lacks, but coarse and not per-run. |
| 🟥 none | Claude Code | The docs are explicit: past 25 scheduled agents or 1.5M projected tokens, "The warning is advisory: it doesn't pause or limit the run." Bounds are structural only (16 concurrent, 1,000 agents per run). |
| 🟥 none | CrewAI | The cautionary case: max_iter and max_rpm only, with a documented uncapped crew loop reaching $414 in a single run. |
| 🟥 none | Temporal / Restate / DBOS / Inngest / Hatchet… | No token or USD concept exists at the engine level in any of them. Governance is namespace/queue rate limiting — throughput, not spend. |
| 🟥 none | LangGraph | recursionLimit caps supersteps, not spend; enforcing a USD ceiling means writing your own accumulator plus a conditional edge. |
| 🟥 none | Mastra / VoltAgent / Google ADK / Microsoft A… | Cost is a derived dashboard metric in all four — observed, never enforced. |
| 🟥 none | Langfuse / Phoenix / Opik / AgentOps | Best-in-class cost ACCOUNTING (maintained pricing tables, per-dimension rollups) and zero enforcement. They tell you after you spent it. |
| 🟥 none | goose / opencode / Codex CLI | max_turns, max steps and reasoning-effort tiers are structural iteration caps, not spend ceilings. |

#### 10. Concurrency control, fairness and rate limiting

**Weft.** A FIFO counting Semaphore with abort-aware acquire; the global limiter defaults to min(16, cpus-2) and wraps the entire agent lane including worktree creation, plus exec/bash/fetch/check spawns, with a per-provider Semaphore stacked on top for model calls. fanoutMax caps items at 4096. Documented trades: Semaphore.with releases on abort as well as settlement, so the cap can be exceeded by timed-out-but-still-running steps (deliberate, to avoid deadlock from a zombie); ctx.parallel's concurrency option is silently ignored unless EVERY task is a thunk; pipeline.run() defaults to concurrency = items.length, i.e. no pipeline-level cap. There is no per-key fairness, no rate limiting, no queues, no priorities.

| | Project | How they do it |
| --- | --- | --- |
| 🟩 strong | Hatchet | Best in the landscape: concurrency keys with FAIRNESS strategies (round-robin across tenant keys rather than a plain global cap), rate limits modelled as declarative consumable resources, priorities, sticky assignment. |
| 🟩 strong | Inngest | Concurrency with DYNAMIC keys ({key: 'event.data.userId', limit: 1}), throttle, rate limit, debounce and priority declared per function — per-key limit:1 also doubles as an integration lock. |
| 🟩 strong | Trigger.dev | Named queues with per-queue concurrency limits and priorities, per-task machine sizing, and maxDuration. |
| 🟩 strong | DBOS Transact | Durable queues with concurrency limits, rate limits, priority and partition keys. |
| 🟩 strong | Temporal | Task queues and worker fleets with maxConcurrentActivityTaskExecutions, plus per-namespace rate limits preventing noisy-neighbour effects. |
| 🟨 partial | Windmill | Explicit per-loop parallelism cap, a squash-onto-one-worker locality option, and worker groups/tags routing steps to machine pools. |
| 🟨 partial | Claude Code | 16 concurrent (fewer on low-CPU or in containers), 1,000 agents per run, plus prompt-cache-aware stagger (CLAUDE_CODE_WORKFLOW_PREFIX_STAGGER_MS, default 5000ms) so siblings share the cached prefix — a cost optimization nobody else does. |
| 🟨 partial | OpenAI Codex CLI | agents.max_concurrent_threads_per_session bounds subagent fan-out. |
| 🟥 none | Mastra / LangGraph.js / VoltAgent / opencode… | In-process Promise concurrency with no fairness, no rate limits, no queues. |

#### 11. Testing without model calls

**Weft.** runWorkflow drives a workflow to a terminal state on a private in-memory engine (MemoryJournalStore + MemoryBlobStore, the mock builder registered under both claude and codex) and returns {output, journal, state, runId}. mock().on({key／label／prompt}, responder, opts) matches by glob or substring/RegExp and its responses go through the engine's NORMAL schema validation and journaling — "a fixture that would not pass in production fails the test". buildTestHooks stubs git/exec/bash/fetch/env and hook results are journaled exactly as real side effects would be. journal.toJSON() is a snapshot-stable projection with no timestamps or ids. Store conformance suites exist for JournalStore and BlobStore. Gaps: no AgentProvider conformance suite, no bulk/corpus replay --dry assertion for CI, runWorkflow refuses workflows blocked on ctx.signal, no time-skipping for ctx.sleep, and verifyServe is disabled entirely whenever testHooks are configured — so fixture-driven runs never exercise the effect-still-holds re-check.

| | Project | How they do it |
| --- | --- | --- |
| 🟩 strong | Temporal | Best in class and clearly ahead: TestWorkflowEnvironment.createTimeSkipping() fast-forwards durable timers so a 30-day sleep completes instantly, plus Worker.runReplayHistory() feeding RECORDED PRODUCTION histories through new code and throwing DeterminismViolationError — a genuine CI gate for replay safety. |
| 🟩 strong | Google ADK | `adk conformance` records a scenario's LLM requests, responses and tool calls into golden YAML, then defaults to Replay Mode where any deviation FAILS the command — designed to block a PR. Nearly free for weft to copy given the journal already is this recording. |
| 🟩 strong | Pydantic AI | TestModel auto-generates schema-VALID responses with no fixture authoring, FunctionModel scripts them, and ALLOW_MODEL_REQUESTS=False is a global kill switch so an under-mocked test fails loudly instead of burning tokens. |
| 🟩 strong | Inngest | InngestTestEngine with execute() and executeStep(), plus MockedStep injecting PRIOR step state — testing one step given a synthetic journal prefix, which weft cannot do. |
| 🟩 strong | Vercel AI SDK | MockLanguageModelV2 and simulateReadableStream shipped as supported public API, not internal test scaffolding. |
| 🟩 strong | Braintrust | Different axis: evals as versioned *.eval.ts source files run by a CLI, with a GitHub Action commenting score diffs on the PR — quality regression, which weft has no answer for. |
| 🟨 partial | AutoGen (maintenance mode) | ReplayChatCompletionClient returns a scripted list — the same idea as a provider-shaped stub, which is the cleanest framing. |
| 🟥 none | Mastra / VoltAgent / LangGraph.js | No shipped mock-step harness; you inject a mock model provider yourself. Evals/scorers exist but are model-backed. |
| 🟥 none | Restate / DBOS / Hatchet / Vercel WDK / Trigg… | No deterministic test harness, no time skipping, no replay-divergence detection across all five. |
| 🟥 none | Claude Code dynamic workflows | No offline or mocked execution mode — every workflow run spends tokens. |

#### 12. Observability depth and trace granularity

**Weft.** The journal folds into three projections plus a derived index: reduceState, renderTree (nesting by parentSeq into phases with a "(no phase)" bucket), and renderReport (status/cost, outcome JSON, changes with captured-but-not-integrated warnings, a checks table, ledger notes, failures and drops, remaining risk, and the exact `weft answer` command for the first pending request). CLI surfaces status / explain / diff / report / replay --dry, with --watch re-rendering a live tree every 500ms. The daemon streams the journal over SSE with descendant fan-in. The hard limit, admitted in the README: ONE OpenTelemetry span per run with the run id as the trace id — no per-step spans, so step latency has to come from the journal. Also: no --json on any command, a single hand-written HTML page with no step-level detail, no cost dashboards, and a 200-record tail cap.

| | Project | How they do it |
| --- | --- | --- |
| 🟩 strong | Langfuse | OTel-native nested spans typed span/generation/event with model, params, token counts and cost; sessions, users, tags and environments as dimensions; cost from a maintained pricing table aggregated up the trace tree; annotation queues; datasets seeded from production traces. MIT with a real self-host path. |
| 🟩 strong | Arize Phoenix | OpenInference span kinds (LLM/CHAIN/TOOL/AGENT/RETRIEVER/GUARDRAIL/EVALUATOR) give the UI enough type information to render each node purposefully — exactly the vocabulary weft's journal already has and does not emit. Runs locally on SQLite. |
| 🟩 strong | Opik | Apache-2.0 end to end with first-party OTel ingest as a peer to its SDKs, agent-graph view, online evaluation rules on sampled production traffic, and G-Eval. |
| 🟩 strong | Mastra | Native OTel AI tracing with trace-correlated logs, auto-derived cost/token metrics, and human feedback attached to individual spans, exportable to Langfuse/Datadog/Arize. |
| 🟩 strong | Trigger.dev | Live OTel-powered span tree rendered as it executes, per-step inputs/outputs, run tags and filters, alerts, and one-click replay of a historical run. |
| 🟩 strong | Claude Code | /workflows TUI with phase tree, per-agent token totals and elapsed time, drill-in to any agent's prompt and tool calls, and — crucially — pause run, kill one agent, RESTART one agent in place. |
| 🟩 strong | Temporal | Web UI showing the full Event History per execution, pending-activity state, and stack traces of blocked workflows; the per-run history is the best forensic artifact in the durability cluster. |
| 🟩 strong | Restate | Per-invocation journal viewer rendering each entry in order with its recorded value — the same artifact weft has, rendered as a product surface. |
| 🟩 strong | Burr | Fully self-hosted OSS tracking server and UI over every state transition, with no SaaS dependency — the closest validation of weft's daemon UI as a differentiator. |
| 🟩 strong | AgentOps | Session replay with step-by-step execution graphs and normalized cross-provider cost — the visualization weft's journal is uniquely equipped to produce and does not. |
| 🟨 partial | Vercel Workflow DevKit | `npx workflow web` gives a local observability UI with runs, steps, retry attempts and inter-step data — no cloud required, but shallower than the platforms. |

#### 13. Authoring model

**Weft.** Plain TypeScript with no DSL, no graph builder, no decorators and no compiler directives: `await` is a sequential edge, ctx.parallel fans out and joins, ctx.pipeline runs independent lanes, `if` on a typed field is a conditional edge, `while` is a bounded loop. The cost of that purity is the fence: the file must pass 11 AST rules (including no-bare-import, so only @techery/weft-sdk and zod are importable by default) and runs bundled inside a node:vm sandbox with replaced globals.

| | Project | How they do it |
| --- | --- | --- |
| 🟩 strong | Vercel Workflow DevKit | The closest peer and a major-vendor validation of the same thesis: "use workflow" / "use step" directives over plain TS with real if/for/try/await, and step bodies get the full Node runtime and npm. |
| 🟩 strong | Trigger.dev | task({id, run}) over ordinary async TS with no directives and no determinism constraint — the most permissive authoring model, bought with heavier infrastructure. |
| 🟩 strong | Inngest | Plain TS with explicit step.run(id, fn) calls; the ids are the price of memoization. |
| 🟩 strong | DBOS Transact | registerWorkflow + runStep over plain functions; the lowest conceptual overhead in the durable cluster. |
| 🟩 strong | Claude Code dynamic workflows | Plain JS with top-level await and agent()/pipeline() globals — and uniquely, the MODEL writes the script from a natural-language task, you approve the phase list, then press `s` to freeze it into a reusable command. Removes the blank-page tax weft imposes. |
| 🟩 strong | Prefect | @flow/@task decorators over plain Python with a runtime-discovered DAG — a decade of production hardening behind the same 'code is the graph' bet. |
| 🟨 partial | Temporal | Plain async TS, but the workflow sandbox forbids Node built-ins, fs, network and child processes entirely, so every real action must be an Activity — heavyweight for coding steps that want to shell out. |
| 🟨 partial | Mastra | A fluent builder (.then/.parallel/.branch/.dowhile/.commit) over typed step objects. Linear-reading, but control flow still cannot be plain if/for. |
| 🟨 partial | Hatchet | Plain TS, but DAG edges are DECLARED via `parents: [...]` rather than inferred from await — more verbose and less refactor-safe. |
| 🟥 none | LangGraph | Explicit node/edge graph DSL with reducer-typed state channels; loops, try/catch and early return must be re-expressed as edges and state. The direct antithesis. |
| 🟥 none | goose / gh-aw / Windmill / Dify | YAML, Markdown frontmatter or a visual canvas. No typed values between steps, no real control flow — the complexity ceiling Flowise named when it shut down: "the typical rigid workflow low-code approach quickly hit its limits." |

#### 14. Security boundary for agent execution

**Weft.** Explicitly none, and the README says so: node:vm with replaced globals is "a determinism fence, not a security boundary", with worker_threads or isolated-vm named as the upgrade path behind the same seam. The AGENT's process is not sandboxed at all — worktrees isolate files by convention, so a step can write outside its worktree and weft learns about it only from provider self-reported filesTouched (posix-only detection: isAbsolute ／／ startsWith("../")). ctx.fetch allows EVERY host unless fetchAllow is explicitly configured, and the field is optional and undefined by default; the hardened manual redirect path is skipped entirely with no allow-list and no credential-shaped header. Claude's tool gate does real live screening (scope-matched edits with symlink-escape realpath, a read-only bash allow-list, strict-mode traversal/computed-token/shared-git-metadata denial, risky-command brokering) — but only for Claude, mostly only in strict mode, and its terminal clause allows every tool it does not recognize (WebFetch, Task spawning, other MCP servers).

| | Project | How they do it |
| --- | --- | --- |
| 🟩 strong | E2B | Firecracker microVMs with their own guest kernel — hardware virtualization, the correct answer for model-generated code. Apache-2.0 with a real self-host path, though that means operating Nomad + Consul. |
| 🟩 strong | microsandbox | The best fit for weft's local-first posture: libkrun microVMs as ordinary child processes (KVM / Hypervisor.framework / WHP), <100ms boot, TypeScript SDK, no control plane. Beta. |
| 🟩 strong | Anthropic sandbox-runtime | Exactly the boundary weft needs and does not have: bubblewrap/Seatbelt/WFP process-tree scoping with reads deny-then-allow, writes ALLOW-ONLY, network deny-all behind a host proxy domain allowlist. No container, no VM, no daemon. |
| 🟩 strong | OpenAI Codex CLI | sandbox_mode (read-only / workspace-write / danger-full-access) via Seatbelt/Landlock/seccomp, .git and .codex protected even in writable modes, and approval_policy as an ORTHOGONAL axis to capability. |
| 🟩 strong | gVisor | Userspace application kernel in memory-safe Go; workload syscalls never reach the host kernel. Also the model for honest threat-model docs — its "what it isn't" section is the standard weft's README partially emulates. |
| 🟩 strong | container-use | Container per agent, so installs, daemons and env mutations are discarded with the step — the environment hole weft's worktrees leave wide open. |
| 🟩 strong | gh-aw | Structural rather than sandboxed: the agent job holds no write credentials, plus a companion Agent Workflow Firewall for egress. A compromised prompt produces a rejected output, not a force-push. |
| 🟩 strong | GitHub Copilot Agent HQ | Network firewall on by default with a configurable allowlist and a hard 59-minute session cap — safe defaults most self-hosted setups never configure. |
| 🟨 partial | Claude Code | Static command analysis is thorough but is a screen, not a sandbox: a destination the shell computes at run time is invisible to it. |
| 🟨 partial | Temporal | The workflow sandbox is a hard cage but exists for determinism; Activities — where all real work happens — are unsandboxed. |
| 🟥 none | Mastra / LangGraph / Inngest / Vercel WDK / R… | No security boundary of any kind; steps run in the host process. |

#### 15. Cross-process ownership, fencing and crash safety

**Weft.** Unusually rigorous for a library with a filesystem store. acquireRun claims a run before execution (fs store: owner.json with a 15s TTL under an owner.lock CAS); the engine renews every 5s and FENCES the runtime on a lost claim or 3 consecutive refresh failures — refusing all further appends, disarming deadline timers, rejecting pending waits, and aborting step work WITHOUT journaling a terminal event, so nothing lies about the outcome. appendTerminal lands run.completed/failed/cancelled through appendIf so a cancellation committed in the tailer's blind spot converts the outcome instead of being overridden. Appends take a cross-process lock with 2.5s mtime renewal, 10s staleness with identity-safe rename-aside steal, a DOUBLE on-disk reconcile so a stolen lock's committed records are never truncated, torn-tail-only truncation, writeSync-to-completion and fsync. Honest limits: the lock is best-effort (a SIGSTOPped holder can be stolen from; acquisition gives up at 30s), appendIf/acquireRun are OPTIONAL on the store interface with a documented no-guard fallback, and after a bounded cancel or shutdown the lease is deliberately NOT released so the run stays claimed until TTL.

| | Project | How they do it |
| --- | --- | --- |
| 🟩 strong | Temporal | The server owns execution ownership, task dispatch and fencing — it is the thing you are buying, and it is battle-tested at enterprise scale. |
| 🟩 strong | Restate | Raft-replicated single-binary server; Virtual Objects give a single-writer-per-key guarantee that is effectively a durable distributed mutex — the primitive weft would need for 'only one run may integrate into this repo'. |
| 🟩 strong | DBOS Transact | Postgres owns it, with applicationVersion fencing so old-code runs are never silently resumed by new-code workers. |
| 🟩 strong | Trigger.dev / Inngest / Hatchet | All three have a server or database owning run ownership, heartbeat/reaping and retry semantics. |
| 🟩 strong | Golem Cloud | The worker executor owns the oplog and worker lifecycle; idle workers suspend to zero and are resurrected by replay. |
| 🟨 partial | Microsoft Agent Framework | Checkpoint storage is pluggable (InMemory/File/Cosmos) but ownership and fencing are the host's problem. |
| 🟨 partial | OpenHands software-agent-sdk | A persistence directory per conversation with documented pause/resume, but no lease or fencing story. |
| 🟥 none | LangGraph.js / Mastra / VoltAgent | Checkpointers persist state; nothing fences a second writer, so two processes resuming the same thread is undefined. |
| 🟥 none | Claude Code / opencode / Cline | Process-scoped throughout; there is no notion of another process contending for a run. |

#### 16. Fork, time-travel and operator recovery verbs

**Weft.** None. `weft replay --dry` is a genuinely good cost-free divergence report (hits / salvaged / diverged step refs / still-pending request ids / would-it-complete) — but it does not compute positionsTrusted, ignores opts.defHash, and resets the budget and agent counter to empty, so its report can differ from an actual resume of an edited script, which is exactly the case it exists for. `weft resume` continues and `weft cancel` stops; there is no fork-from-step, no branch-a-run, no rewind-and-edit-a-value, no per-step re-run, no bulk recovery, and no rm/prune. The journal is used only for recovery, never for exploration.

| | Project | How they do it |
| --- | --- | --- |
| 🟩 strong | DBOS Transact | The best operator verb in the landscape: forkWorkflow(workflowID, startStep, {newWorkflowID, applicationVersion, queueName, replacementChildren}) — plus BULK fork from the Conductor UI, turning 'we shipped a bug and 4,000 runs are wedged at step 7' into a UI action. |
| 🟩 strong | LangGraph | update_state() writes a new checkpoint on the parent and invoking with a checkpoint_id forks an alternate timeline; Studio exposes rewind-to-superstep-N, edit the recorded state, and re-run as a branch. |
| 🟩 strong | Burr | fork_from_app_id + fork_from_partition_key + fork_from_sequence_id as a first-class API, and the tracker doubles as the persister so you can resume directly from a recorded production trace. |
| 🟨 partial | CrewAI Flows | restore_from_state_id forks with a fresh state.id preserving the parent lineage, distinct from kickoff(inputs={'id'}) which resumes and extends — a thoughtful API split weft lacks entirely. |
| 🟨 partial | Hatchet | Full task history retained by default with per-task replay from the dashboard — 'replay just this one step' as a UI action. |
| 🟨 partial | Inngest | Bulk Replay of historical runs from the dashboard, plus Dev Server replay-from-step locally. |
| 🟨 partial | Mastra | restart() for one run and restartAllActiveWorkflowRuns() for every in-flight run after a deploy — fleet-level recovery weft has no equivalent of. |
| 🟨 partial | Restate | Explicit operator verbs: `restate invocations pause <id>` then `resume <id> --deployment <new-id>` to migrate a specific stuck run onto fixed code. |
| 🟨 partial | Trigger.dev | Replay a historical run with its original payload from the dashboard — but it is a brand-new run from the beginning, discarding all completed work. |
| 🟨 partial | Temporal | Deployment Versioning with pinned vs auto-upgrade, percentage ramping and instant rollback repositions in-flight runs onto chosen code — a fleet version policy rather than fork-a-run-from-step-N. |
| 🟨 partial | Claude Code | Not fork, but per-agent restart-in-place (r) and kill (x) from the /workflows panel — the surgical retry weft cannot do. |

#### 17. Deployment footprint and operational cost

**Weft.** A library and a CLI. Sixteen packages, ESM-only, Node ≥22.12, no server, no database, no broker, no container, no account. State is <cwd>/.weft — one journal.jsonl per run, content-addressed blobs, and an optional node:sqlite index. `weft ui` starts a Hono daemon on 127.0.0.1:4781. Cost is model spend plus your own machine. Caveats: no repo-root discovery (running from a subdirectory silently targets a different, empty .weft rather than erroring — verified); no blob garbage collection at all, so transcripts, patches and artifacts accumulate indefinitely under .weft/blobs; and a run blocked on a human holds a process and a lease rather than suspending to zero.

| | Project | How they do it |
| --- | --- | --- |
| 🟩 strong | DBOS Transact | The closest peer: a library plus a Postgres schema. No orchestrator process, no broker, no sandbox — the easiest thing in the cluster to embed. |
| 🟩 strong | Burr | Library plus SQLite plus a self-hosted OSS tracking UI launched by a CLI — no SaaS anywhere. |
| 🟩 strong | Arize Phoenix | Single local process on SQLite, or in a notebook, scaling to Postgres only when needed — validating weft's local-first posture and suggesting the journal store should be swappable the same way. |
| 🟩 strong | Claude Code / opencode / Codex CLI / goose | Single npm install or binary, entirely local — and this is the bar weft is actually competing against for a developer's attention. |
| 🟨 partial | Vercel Workflow DevKit | Local `npx workflow web` with a Postgres backend or a custom World — genuinely self-hostable, but the ergonomics clearly favour Vercel. |
| 🟨 partial | Restate | One Rust binary with an embedded store, no external database — excellent footprint, but BSL 1.1 makes the server not open source. |
| 🟨 partial | Windmill | Postgres-only, no Redis and no broker — but AGPL-3.0 with scale features (distributed workers, autoscaling, SSO) behind the Enterprise license. |
| 🟥 none | Temporal | Server plus a persistence store plus Elasticsearch, or pay for Temporal Cloud. The heaviest option in the durability cluster. |
| 🟥 none | Trigger.dev | CRIU checkpoint/restore needs container infrastructure; self-hosting means Docker/K8s plus object storage plus Postgres plus Redis. |
| 🟥 none | Langfuse | Postgres + ClickHouse + Redis + S3 + web + worker for the self-hosted stack. |
| 🟥 none | Opik | ClickHouse + MySQL + Redis + a Java backend, despite being fully Apache-2.0. |

#### 18. Maturity, ecosystem and adoption

**Weft.** Design preview, not published. The README says so plainly ("Not on npm yet"). The engineering discipline around it is real: 16 packages versioned together, a release pipeline with version:set / sync:meta --check / verify:packing / verify:install (which installs the tarballs into a scratch project and drives a real weft-mcp initialize handshake as compiled ESM), CI across node 22 and 24 with biome, strict tsc, seven runnable examples and `weft check` in the smoke job, a tag-guarded trusted-publishing release, and a 758-line adversarial self-review at a named commit with several findings visibly closed. Against that: zero external users, zero third-party integrations, no AGENTS.md ingestion, provider-mock has no test directory, two declared StepErrorCodes are never produced, IntegrateOptions.order is declared and never read, and the README's package table claims provider adapters sit "behind a shared conformance suite" that does not exist.

| | Project | How they do it |
| --- | --- | --- |
| 🟩 strong | opencode | 201k stars, MIT, ~8M reported MAU, daily development — the largest in the coding-harness cluster. |
| 🟩 strong | Claude Code | 142.9k stars with a bundled subagent/skill/plugin/marketplace ecosystem. Closed source with no license on the repo, but distribution is overwhelming. |
| 🟩 strong | Temporal | 22.5k stars on the server, MIT, the largest enterprise adoption in durable execution, with an official @temporalio/ai-sdk package shipped January 2026. |
| 🟩 strong | Trigger.dev | 16.1k stars, Apache-2.0, genuinely self-hostable, daily commits. |
| 🟩 strong | Mastra | 27.4k stars and the most active TS agent framework — but with an enterprise-only ee/ directory and heavy version churn. |
| 🟩 strong | goose | 53.4k stars and, uniquely, vendor-neutral Linux Foundation (AAIF) governance — a real procurement advantage for a layer that brokers competing vendors. |
| 🟩 strong | OpenHands | 85k stars, MIT, fully self-hostable — but the 2026 pivot to Agent Canvas has spread SDK, legacy app, Agent Server, Automation Server and Canvas across uneven documentation. |
| 🟨 partial | Vercel Workflow DevKit | The most direct architectural competitor and also young: 2.3k stars, repo created 2025-10, 349 open issues, rapid API churn, docs reorganizing. |
| 🟨 partial | LangGraph.js | 3.2k stars and trailing its Python sibling (40.4k) materially on features and docs; the deployment server is Elastic-licensed, not OSI-open. |
| 🟥 none | Inngest AgentKit | No push for ~4 months, npm release ~7 months stale, 49 open issues — the riskiest bet in the TS cluster despite good design. |
| 🟥 none | Flowise / Roo Code / Vibe Kanban / Motia / Ll… | Category attrition worth naming: 55.4k-star Flowise archived 2026-08, 24.3k-star Roo Code archived 2026-05, 27.9k-star Vibe Kanban sunsetting, Motia wound down into iii, workflows-ts archived. Stars are not survival. |


---

## Part 4 — The eight projects weft is actually competing with

Ordered by how much of weft's job they already do.

### Vercel Workflow DevKit (WDK) + @ai-sdk/workflow

**Overlap.** The same thesis, arrived at independently by a major vendor: durable execution as a language-level concern in plain TypeScript, backed by a journaled event log of step inputs and outputs, with the function replayed from the top and completed steps returning journaled values. Both run workflow bodies in a sandbox with replaced globals; both are Apache-2.0/MIT-shaped libraries rather than servers; both make `await` the edge rather than a graph DSL. WorkflowAgent/DurableAgent turns AI SDK tool calls into retryable resumable steps, which is structurally weft's ctx.agent.

**Where they diverge.** Four things weft has that WDK does not: (1) schema validation at step boundaries with in-session repair — WDK step contracts are TypeScript types plus serializability, with no runtime check, and pass-by-value mutation silently does nothing; (2) content-addressed salvage, so WDK hits the classic replay-versioning problem on any mid-flight edit; (3) any git, patch or integrate awareness at all; (4) token/USD ceilings. Three things WDK has that weft does not: steps compiled into separately deployed auto-scaling worker processes (real isolation and elastic parallelism from plain Promise.all), zero-compute suspension so a week-long human gate costs nothing, and a sandbox that makes Math.random/Date replay-STABLE rather than banned — a strictly friendlier answer than weft's 11 AST prohibitions. WDK is also younger and churnier (349 open issues) but carries Vercel's distribution.

### Claude Code dynamic workflows

**Overlap.** The closest competitor by use case, and it is bundled free with the agent weft depends on. It is code-as-orchestration (plain JS with top-level await), schema-typed agent calls (agent(prompt, {schema}) resolving to a parsed object), fan-out via pipeline(list, fn), git-worktree isolation per subagent, resumable runs, and a live orchestration TUI — the same feature vocabulary as weft, shipped, at 142.9k stars.

**Where they diverge.** weft wins on durability and control: Claude Code's workflow resume is process-scoped ("If you exit Claude Code while a workflow is running, the next session starts the workflow fresh"), its replay is order-based so stopping mid fan-out re-runs every agent that started after the first unfinished one even if it completed, it has NO human-in-the-loop inside a workflow (AskUserQuestion is stripped from every subagent), no hard cost ceiling (the large-workflow warning is explicitly "advisory: it doesn't pause or limit the run"), and it is Anthropic-only, closed source, with no license on the repo. Claude Code wins on everything around the engine: enforced worktree isolation via static bash analysis (blocking git -C, GIT_DIR, cd-escapes, heredocs), a far better observability TUI with per-agent restart-in-place, prompt-cache-aware fan-out staggering, and model-AUTHORED orchestration that removes weft's blank-page tax entirely.

### Temporal (+ TypeScript SDK)

**Overlap.** The durability lineage weft draws on and the most battle-tested implementation of the same core idea: an append-only event record as the authority, deterministic replay to rebuild state, workflow-as-code in plain async TypeScript, and a vm sandbox with replaced globals to keep replay honest. Both treat a durable wait on a human as a first-class event rather than in-process state.

**Where they diverge.** Temporal is better at durable execution itself and worse at everything weft is actually for. Better: determinism violations fail loudly with DeterminismViolationError instead of being silently salvaged; time-skipping test server plus Worker.runReplayHistory() as a real CI gate; two mature mid-run-edit answers (patched() markers and Deployment Versioning with ramping and rollback); real multi-tenancy via namespaces and Nexus. Worse for coding workflows: no schema validation or repair of step outputs, no token or USD budget of any kind, zero git awareness, a workflow sandbox so strict that every shell-out must become an Activity, history size limits forcing continueAsNew, and an operational footprint of server + persistence store + Elasticsearch versus weft's `.weft` directory.

### Mastra

**Overlap.** The nearest TypeScript agent framework by philosophy on the typing axis: createStep({inputSchema, outputSchema, execute}) validated at every boundary via Standard Schema, workflow-level input/output schemas, and typed suspend/resume with suspendSchema and resumeSchema — the same instinct as weft's schema-validated humans-as-steps. Both are TS-native libraries with per-step model routing, and both ship a CLI plus a local UI.

**Where they diverge.** Mastra's durability is snapshot-per-run through a storage adapter, so a resumed step re-runs from its start and there is no content-addressed salvage or edit tolerance. It has no determinism enforcement, no cost ceilings (spend is a derived dashboard metric), and nothing repo-aware — no worktrees, no patches, no integrate. What Mastra has that weft badly lacks: OTel AI tracing with per-step spans, trace-correlated logs, auto-derived cost/token metrics, resumable output streams (run.resumeStream()), and restartAllActiveWorkflowRuns() for fleet recovery after a deploy. It also has 27.4k stars and daily commits against weft's zero users.

### OpenHands software-agent-sdk

**Overlap.** The closest architectural twin on durability shape and the closest by use case in Python: an append-only per-event store (numbered event-00000-{hash}.json files plus a base_state.json sidecar), justified in its own docs exactly as weft would justify JSONL — "Fast event appends: No need to rewrite the entire history." Both are engines for coding agents with pluggable providers, a conversation/run identity that survives process death, and an explicit resume path.

**Where they diverge.** OpenHands restores state rather than replaying, so there is no salvage and no edit tolerance. Its sub-agent delegation is explicitly "designed for sequential blocking tasks" — no real fan-out inside a conversation. It has no git-worktree isolation and no patch-then-integrate model (isolation is container/volume level), no hard USD/token ceiling in the SDK (budgets are a cloud org feature), and no schema-validated step contracts. What it has that weft should study: ConfirmRisky with an out-of-band LLMSecurityAnalyzer classifying each action LOW/MEDIUM/HIGH so only genuinely risky actions interrupt a human; WAITING_FOR_CONFIRMATION as an explicit polled state; Agent-Client Protocol making whole third-party agents pluggable rather than just model APIs; and counting auxiliary LLM spend (condenser, classifier) in the same rollup — an accounting bug weft's schema-repair calls could easily reproduce.

### Inngest (+ AgentKit)

**Overlap.** The closest philosophical match on edit-tolerant replay: Inngest deliberately does NOT pin versions, memoizes by hashing a step's declared id together with an occurrence counter, and publishes the compatibility matrix as a contract (body change safe, add runs on reach, remove ignored, reorder warns, id change re-runs). Both bet that tolerance beats pinning. Both are TS-native with plain-code authoring and a durable event wait as the human primitive.

**Where they diverge.** weft's content hash over {kind, payload, schema, key} plus a workflow-body hash guard is a stronger mechanism than id-plus-counter — Inngest's flip side is that a reordering edit returns memoized values in the wrong logical position with only a warning, which is silent wrongness where Temporal hard-fails. But Inngest is far ahead on flow control (dynamic concurrency keys, throttle, rate limit, debounce, priority — weft has none of this), on step.ai.infer() offloading the model call to the engine so the run holds no process during inference, and on distribution. AgentKit itself is ~4 months stale with a ~7-month-old npm release; the server is SSPL, not OSI-open.

### container-use (Dagger)

**Overlap.** The purest expression of weft's isolation idea, delivered as an MCP server rather than an engine: every agent gets its own git branch AND its own container, review is `cu diff` / `cu log` / `cu merge`, and discarding a failure is deleting a branch. Same conviction that agent writes must be quarantined before they touch the tree.

**Where they diverge.** container-use isolates one layer deeper than weft — the container means installs, daemons, ports and env mutations are discarded with the step, which weft's worktrees do not do at all. But it has no workflow layer whatsoever: no steps, no ordering, no schema, no journal, no resume, no cost tracking, and no blocking gate (review is after the fact). weft's differentiators against it are the patch as a typed value, scope checking with quarantine, ctx.integrate() with conflict policies and resume-idempotency proofs, and the journal. The right reading is that these are complementary: container-use is the environment boundary weft should adopt underneath its worktrees, not a competitor to the integrate gate.

### goose Recipes

**Overlap.** The declarative equivalent of weft's whole proposition, from a Linux Foundation project at 53.4k stars: response.json_schema ENFORCES structured output from a run (arrived at independently — the same schema-per-step thesis), retry{max_retries, checks} where checks are shell commands is a declarative acceptance test bound to the workflow, sub_recipes compose, per-recipe provider/model settings give routing, and a cron scheduler turns recipes into recurring runs.

**Where they diverge.** YAML is the ceiling. goose recipes cannot express conditionals, loops over computed data, or typed values passed between sub-recipes — precisely the wall weft's plain-TypeScript model is designed to break through. goose also has no step-level journal, no crash resume mid-run, no git/worktree isolation, no patch model, and retry is whole-run rather than in-session repair. What it does better: sequential_when_repeated letting a callee declare its own concurrency constraint, least-privilege tool declaration (naming an extensions block EXCLUDES the defaults), typed user-promptable parameters, a built-in scheduler, and vendor-neutral foundation governance.


---

## Part 5 — What is genuinely weft's own, and what is missing

### Unique strengths

Each claim is paired with who else has it, because most "unique" features in this category are not.

**verifyServe — refusing to serve a journaled effect whose result no longer holds in the world.** A StepSpec may supply verifyServe(journaled); a false verdict consumes the entry, journals replay.diverged, and re-executes with io.reExecuting=true so recovery paths can treat an existing branch or tag as their own prior work rather than a collision. Used by git.commit (ancestor-of-HEAD), git.checkout (HEAD still on the ref, branch-vs-detached aware), git.tag (tag still peels to the journaled sha), branch.create, and ctx.integrate (tree hash → reverse-apply → mergedBaseTrees → forward-apply).

> *Who else has it:* Nobody found in the entire landscape. Every other replay engine — Temporal, WDK, Restate, DBOS, Inngest, LangGraph, MAF, ADK — assumes a journaled result is still true and serves it unconditionally. This is the single most defensible mechanism in weft, and it exists because weft's steps mutate a git repository rather than a database. Caveat: it covers only commit, non-discard checkout, tag, branch.create, function checks, sub-workflows and integrate — add, fetch, pull, push, reset, apply, stash.*, branch.delete, clean and discard-checkouts have no verifier — and it is disabled entirely whenever testHooks are configured.

**ctx.integrate() as a journaled merge gate:** an outer step per patch wrapping nested snapshot and apply sub-steps (so a resume mid-ask reuses the PRE-conflict snapshot rather than snapshotting conflict markers and stacking a second apply), with onConflict fail / agent / ask, an agent resolver whose `resolved: true` self-report is not trusted (conflictMarkersIn re-reads each file against /^<{7}(?: |$)/m), and a run that ends with un-integrated, un-discarded patches failing with unintegrated_patches.

> *Who else has it:* Nobody. gh-aw's read-only-agent-plus-safe-outputs is the nearest philosophical cousin — deferred, validated application by a differently-privileged actor — but it has no diff, conflict or tree semantics. Every worktree-based coding tool (Claude Code, container-use, claude-squad, Crystal, Conductor, Codex CLI, Sculptor, Vibe Kanban) produces branches or commits and leaves merging to git and a human. weft is alone in making the merge itself a resumable, journaled, policy-driven step.

**Hard token AND USD ceilings that are inherited by sub-workflows and admission-controlled across concurrency.** remainingTokens/Usd take min(own, ancestor headroom); reserveCall PARKS rather than refuses, requiring (inflight+1) × (spent/samples) to fit and serializing calls one at a time until a cost sample exists; a USD-only ceiling with a provider that neither reports usd nor has configured pricing is refused before dispatch rather than running unbounded; resume restores max(journaled sum, last budget.sampled) plus a parentage-verified walk of descendant journals.

> *Who else has it:* Partially: Pydantic AI's UsageLimits enforces token limits per run but has no USD axis and does not propagate to sub-agents; SWE-agent's per_instance_cost_limit genuinely stops an instance but has no inheritance; Helicone enforces dollars and tokens per user/team/global but at a gateway, not inside a workflow, and is now in maintenance mode after acquisition. Nobody combines both axes, inheritance across a run tree, and concurrency admission. Every durable-execution engine (Temporal, Restate, DBOS, Inngest, Hatchet, Windmill, WDK) has literally no token or USD concept, and every observability platform accounts without enforcing. CrewAI's documented $414 runaway is the shape of what this prevents.

**Schema-validated human answers through the SAME machinery as model outputs, with reject-and-reopen instead of run failure, and cross-process CAS-guarded delivery.** An answer is checked against the step's authoritative Standard Schema; a failure journals human.rejected, reopens the request, and waits for a replacement. Engine.answer chains per runId::requestId and appends via journal.appendIf under a re-fold loop so a standing answer, a terminal event or a lost CAS refuses the caller. Deadlines carry deny/escalate/{default} policies with the default pre-validated at request time, and irreversible+ask demands a confirm:<sha256(action)[0:8]> token.

> *Who else has it:* Partially: Mastra has typed suspendSchema/resumeSchema and Windmill has schema-backed approval forms whose fields arrive as resume['field'] — both validate the human. Neither reopens on rejection; a bad answer is an error. The cross-process CAS on answer delivery (so a CLI, a daemon and an MCP client racing to answer the same request cannot corrupt the journal) appears unique among library-shaped engines. Windmill's approval configuration matrix — N-of-M, group restriction, no-self-approval, continue-on-disapproval as a typed branch, recorded approvers — is still materially richer than weft's.

**Cross-process ownership, fencing, and torn-tail-safe fsynced JSONL appends implemented in a library with a filesystem store:** owner.json under an owner.lock CAS with a 15s TTL and 5s renewal, fencing that refuses all further appends and aborts step work WITHOUT journaling a terminal event, appendTerminal through appendIf so a cancellation in the tailer's blind spot converts the outcome, and an append path with double on-disk reconcile so a stolen lock's committed records are never truncated.

> *Who else has it:* Everyone who has this bought a server for it — Temporal, Restate, DBOS, Inngest, Trigger.dev, Hatchet, Golem. Among libraries, LangGraph.js, Mastra and VoltAgent persist checkpoints but nothing fences a second writer. This is genuinely unusual engineering for something you `npm i`. It is also the least legible strength: nobody chooses a workflow engine for its lock protocol, and the guarantee degrades silently to nothing on a store that omits the optional appendIf/acquireRun.

**The combination, and only the combination:** journal + schema validation with in-session repair + durable typed humans + worktree patches gated by integrate + inherited USD ceilings + a static determinism gate + one Engine behind CLI, MCP and daemon — all in one npm-installable library with no server.

> *Who else has it:* Every individual piece is common and weft should not claim otherwise. Plain-code authoring: WDK, Trigger.dev, Inngest, DBOS, Restate, Prefect, Pydantic AI. Journaled durability: Temporal, WDK, Restate, DBOS, Inngest, OpenHands. Schema-validated output with repair: Instructor, Pydantic AI, BAML, Mastra, Vercel AI SDK, TypeChat. Worktree isolation: Claude Code, container-use, Codex CLI, claude-squad, Crystal, Conductor, Sculptor, uzi, Vibe Kanban — this is now table stakes, not a differentiator. Zero-model-call testing: Pydantic AI, Vercel AI SDK, Inngest, AutoGen. One engine behind several surfaces: opencode (OpenAPI + SSE), Cline (extension + CLI + SDK). What no single project assembles is all of them at once, which is a real but fragile position — it is defensible only until one of the well-funded engines adds the two or three pieces it is missing.

### Gaps, ranked by severity

🔴 `CRITICAL` · **A durable human gate that nobody is told about.** Verified by grep: no Slack, email, webhook, or push notification exists anywhere in packages/*/src. A pending request is discoverable only by running `weft status`, opening the loopback-only daemon page, or holding an MCP weft_wait long-poll. The README's promise that "the answer can arrive hours later" is technically true and operationally hollow — durability solves the waiting problem and does nothing about the noticing problem.

> *Done better by:* HumanLayer (Slack/email contact-channel objects with per-call context strings, escalation ladders, timeouts), Windmill (getResumeUrls() signed approval links plus native interactive Slack and Teams), Trigger.dev (token carries a webhook URL and a browser-safe public token, with tags making pending approvals filterable), Linear Agent Sessions (elicitation rendered inline in the issue thread that caused the work), OpenAI Codex Cloud (GitHub PR / GitLab MR / Linear / Slack as both trigger and delivery)

🔴 `CRITICAL` · **No security boundary, and no network egress control by default.** The README correctly disclaims node:vm as a determinism fence — but the agent's own process is entirely unsandboxed, worktree isolation is convention (a step can fs.writeFile anywhere and weft learns about it only from provider-self-reported filesTouched, with posix-only escape detection), and ctx.fetch allows EVERY host unless fetchAllow is explicitly configured, which it is not by default. The hardened per-hop redirect validation is skipped entirely when there is no allow-list and no credential-shaped header.

> *Done better by:* Anthropic sandbox-runtime (bubblewrap/Seatbelt/WFP process-tree scoping, writes allow-only, network deny-all behind a host proxy domain allowlist — exactly the shape weft needs and could adopt without containers), OpenAI Codex CLI (Seatbelt/Landlock/seccomp with .git protected even in workspace-write), gh-aw (read-only agent + egress firewall), GitHub Copilot Agent HQ (firewall on by default with allowlist), microsandbox (local libkrun microVMs as child processes, <100ms boot, TS SDK), E2B, gVisor, container-use

🔴 `CRITICAL` · **Provider asymmetry silently breaks a headline guarantee.** `write: { mode: "strict" }` means live canUseTool enforcement on Claude (scope-matched edits with symlink-escape realpath, read-only bash allow-list, traversal and shared-git-metadata denial, risky-command brokering) and post-hoc worktree diffing only on Codex, which has no permission hook at all, returns filesTouched: [], and silently ignores maxTurns, onMaxTurns and tools.deny. Meanwhile ProviderHitl.onAsk is declared and fenced but never called by any shipped adapter, and the README's package table claims provider adapters sit "behind a shared conformance suite" that does not exist — the two adapters are tested against different bespoke expectations (~40 cases vs ~24).

> *Done better by:* OpenAI Codex CLI (uniform OS-level sandbox_mode inherited by every subagent, verified in v0.115.0 to inherit sandbox and network rules from the parent), OpenHands via ACP (one protocol contract per agent rather than per-vendor adapters), and — on the honesty axis — anyone who does not claim a conformance suite they have not written

🟠 `HIGH` · **OpenTelemetry covers runs, not steps—** one span per run with the run id as trace id (verified: a single tracer.startSpan in engine.ts:789). weft's journal is the richest per-step record in this entire landscape (inputs, outputs, model, effort, per-attempt usage, repair attempts, scope violations, gate decisions, patch refs) and none of it is legible to any tool a team already runs. Mapping journal events onto nested GenAI spans is close to mechanical and would buy an entire trace UI for near-zero build cost.

> *Done better by:* Langfuse (OTel-native nested generation spans with cost from a maintained pricing table), Arize Phoenix (OpenInference span kinds — LLM/CHAIN/TOOL/AGENT/GUARDRAIL/EVALUATOR — so each node renders purposefully; weft already knows every step's kind), Opik (first-party OTLP ingest as a peer to its SDKs), Mastra, Trigger.dev, AgentOps, and the OTel GenAI semantic conventions themselves, which now define invoke_agent and execute_tool operations plus cache-read/cache-write/reasoning token breakouts weft's USD ceiling arguably needs to price correctly

🟠 `HIGH` · **Step outputs are journaled verbatim.** Secret redaction covers only env maps and fetch header names/values passed as SecretHandles; exec/bash stdout+stderr, fetch response bodies and headers, agent prompts, and ctx.env.get's actual value all land in the journal unredacted. The journal is simultaneously weft's core asset, its debugging surface, and the artifact a user would share — and it accumulates repository content and whatever a shell command printed.

> *Done better by:* OpenInference (attribute masking/privacy controls applied at instrumentation time), OTel GenAI conventions (instrumentation-level filtering and truncation of captured message content as an explicit expectation), Google ADK (state key scope prefixes where `temp:` is never persisted — a sanctioned escape hatch weft has no equivalent of), Microsoft Agent Framework (treats checkpoint storage as an explicit trust boundary with a documented threat model and a type allowlist)

🟠 `HIGH` · **The journal is used only for recovery, never for exploration.** There is no fork-from-step, no branch-a-run, no rewind-and-edit-a-recorded-value, no per-step re-run, no bulk recovery after a bad change, and no rm/prune. `weft replay --dry` is the only introspection verb and it does not model the case it exists for — it skips positionsTrusted, ignores opts.defHash, and resets the budget and agent counter to empty, so its divergence report can differ from an actual resume of an edited script.

> *Done better by:* DBOS Transact (forkWorkflow with startStep, applicationVersion and replacementChildren, plus BULK fork from the Conductor UI), LangGraph (update_state + fork-by-checkpoint_id with Studio exposing rewind/edit/re-run), Burr ((app_id, partition_key, sequence_id) as a universal fork address, with the tracker doubling as the persister), Claude Code (restart one agent in place from the workflow panel), Hatchet and Inngest (per-task and bulk replay from the dashboard), Mastra (restartAllActiveWorkflowRuns)

🟠 `HIGH` · **No machine-readable output anywhere.** All 14 CLI verbs emit ANSI-painted human text only — no --json on ls, status, report, replay --dry, explain or diff — so scripting weft into CI means parsing terminal output. Missing verbs compound it: no `weft signal` (the daemon exposes POST /api/runs/:id/signal with no CLI peer), no reindex or search despite index-sqlite implementing search(), no way to view a step transcript or a captured patch blob, no --version.

> *Done better by:* Essentially the whole field. Temporal, Restate and Trigger.dev all have CLI verbs designed for automation; gh-aw compiles to a checked-in artifact CI consumes directly; Braintrust runs evals through a CLI whose output a GitHub Action turns into PR comments. For a tool whose pitch is unattended durable runs, being unscriptable is a structural adoption blocker

🟠 `HIGH` · **A run blocked on a human holds a process and a lease rather than suspending to zero.** There is no hibernation, no checkpoint-and-exit, no rehydrate-on-answer. Combined with the deliberate choice not to release the lease after a bounded cancel or shutdown, a backlog of pending reviews scales linearly in resident processes and blocks takeover until TTL expiry.

> *Done better by:* Restate (a handler parked on an awakeable holds zero compute and is re-invoked on completion), Prefect (suspend_flow_run exits the process entirely and reschedules on resume, as a distinct primitive from pause_flow_run), Golem (idle workers suspend to zero memory and are resurrected by oplog replay), Cloudflare Agents (hibernation evicts an idle agent while keeping WebSockets alive), Vercel WDK (sleep() and createWebhook() free the process entirely), Trigger.dev (CRIU freeze so pre-wait code never re-runs)

🟠 `HIGH` · **Replay identity does not include the world.** A step hashes kind, payload, schema and key — what the step could READ (the working tree an agent greps) is not in it, and declared read scopes are unbuilt (README deviation #5). The two guards are real but narrow: keyless ambiguity re-runs, and a workflow-body hash sets positionsTrusted. verifyServe mitigates for a handful of git ops, but most git writes have no verifier at all (add, fetch, pull, push, reset, apply, stash.*, branch.delete, clean, discard-checkout) and verifyServe is disabled entirely whenever testHooks are configured — so no fixture-driven test ever exercises it.

> *Done better by:* Nobody solves this cleanly, which is worth saying — but Burr's statically validated reads=[]/writes=[] declarations show the shape of the answer, and PocketFlow's prep/exec/post contract (where exec is structurally forbidden from touching shared state, making retry safe by construction) is the idea weft's AST gate is best positioned to enforce as a checked property rather than an author's promise

🟡 `MEDIUM` · **The daemon and web UI are observation-only and unauthenticated.** There is no POST /api/runs, so the browser surface cannot start a run; the only guard is a loopback plus Host/Origin check, so anything that can make a loopback-looking request to port 4781 can answer, cancel and resume every run in the repo; startDaemon has no port fallback; and the page is one hand-written HTML file with no step-level detail, no run-to-run diff, no patch or transcript viewer, no filtering, and a 200-record journal tail cap (README deviation #3).

> *Done better by:* Trigger.dev (run explorer with timelines, payload/output inspection, tags, alerts, one-click replay), Burr (fully self-hosted OSS tracking UI over every state transition, no SaaS), Langfuse and Opik (full platforms), Windmill (per-flow graph with per-iteration results and step-level re-run), Claude Code (/workflows with per-agent drill-in and per-agent restart)

🟡 `MEDIUM` · **No concurrency fairness, rate limiting, queues or priorities—** and two silent footguns in the fan-out primitives: ctx.parallel's `concurrency` option is ignored unless EVERY task is a thunk (promise-form tasks fall through to Promise.all with no lane cap), and pipeline.run() defaults to concurrency = items.length, i.e. no pipeline-level cap at all. Only the global min(16, cpus-2) limiter bounds real work, and Semaphore.with releases on abort so timed-out-but-running steps can exceed it.

> *Done better by:* Hatchet (concurrency keys with round-robin fairness strategies, rate limits as declarative consumable resources, priorities), Inngest (dynamic concurrency keys, throttle, rate limit, debounce, priority per function), Trigger.dev (named queues with per-queue limits and machine sizing), DBOS (durable queues with concurrency, rate limits, priority, partition keys), Temporal (task queues with per-namespace rate limits)

🟡 `MEDIUM` · **Only three provider ids exist (claude, codex, mock) and the built-in price table is Claude-only, so a USD-only budget routed to Codex is refused at dispatch unless the host configures pricing.** ProviderId is typed as "claude" | "codex" | (string & {}), so a third id typechecks and then fails at dispatch with a registry miss.

> *Done better by:* opencode (Models.dev catalogue with OAuth and per-agent override), Cline (200+ models via OpenRouter plus Bedrock, Vertex, Ollama), OpenHands (LiteLLM for models and ACP for whole third-party agents), Vercel AI SDK (~30+ providers behind one interface), gh-aw and Copilot Agent HQ (Copilot/Claude/Codex/Gemini selectable), Helicone (an open, maintained 300+ model pricing database — the thing weft's USD ceiling actually depends on being current)

🟡 `MEDIUM` · **No quality signal at all—** validation is purely structural. weft can prove a step returned the declared shape and cannot say anything about whether the output was any good, whether a prompt change regressed the review step, or whether a run took the expected path. Given that the journal already IS a complete recording of every model interaction, a golden-trace conformance mode would be close to free.

> *Done better by:* Google ADK (`adk conformance` records LLM requests/responses/tool calls into golden YAML and FAILS the command on deviation, designed to block a PR — the highest-leverage idea in the landscape for weft specifically), Braintrust (evals as versioned *.eval.ts source run by a CLI with a GitHub Action commenting score diffs, plus autoevals and trajectory-level agentbehavior specs), Langfuse and Opik (datasets seeded from production traces, online eval rules, G-Eval), Temporal (runReplayHistory as a determinism CI gate)

🟡 `MEDIUM` · **Every Claude step pays an SDK-MCP tool round trip because native JSON mode is not wired up (README deviation #2).** The schema lint that flags what the native path would reject exists; the native branch does not. Weft's own budget ceilings make this cost visible and then charge it on every single agent step.

> *Done better by:* BAML (Schema-Aligned Parsing recovers valid structure from raw output in a sub-10ms Rust pass with zero extra model calls), Outlines (constrained decoding makes invalid output unrepresentable where logits are reachable), LangGraph's create_agent (ProviderStrategy auto-selecting native constrained decoding when the provider supports it, falling back to ToolStrategy), Vercel AI SDK, Codex adapter within weft itself — which already uses native outputSchema

🟡 `MEDIUM` · **No AGENTS.md ingestion.** A weft write step hands an agent a fresh worktree stripped of the repository conventions every other runner in the ecosystem reads by default — a convention now under Linux Foundation AAIF governance and honored by Codex, Claude Code, Copilot, Cursor, Aider, Jules, VS Code and 60,000+ repositories.

> *Done better by:* OpenAI Codex, Claude Code, GitHub Copilot coding agent, Google Jules, goose, Cursor, Aider — effectively everyone. This is free interop weft is declining

⚪ `LOW` · **Declared-but-dead surface and small correctness debt:** IntegrateOptions.order?: "sequential" is in the public API and never read; StepErrorCodes max_turns and git_failed are never produced anywhere (a GitError becomes code "internal"); human_denied appears only in a retry predicate; a duplicate explicit step key is logged rather than rejected, so two steps sharing a key both run and both become --reuse key candidates; provider-mock is the one package with no test directory; and the mock's glob matcher (* crosses /) differs from the testing package's picomatch fixture matcher (* stops at /), so the same pattern means two things depending on which table it is written in.

> *Done better by:* Not a competitive gap so much as a credibility one — for a project whose entire pitch is that the plumbing between steps is typed rather than parsed, declared-and-unimplemented API surface is the wrong kind of detail to leave lying around

⚪ `LOW` · **No blob garbage collection.** BlobStore exposes only put/get/getText/has, so transcripts, patches, review artifacts and every >64KB step output accumulate indefinitely under .weft/blobs with no prune verb and no retention policy. Also no repo-root discovery: running any command from a subdirectory silently targets a different, empty .weft rather than erroring (verified).

> *Done better by:* Trigger.dev, Langfuse and Temporal all have retention policies; every git-adjacent tool resolves the repo root by walking upward. Both are small fixes that currently make weft feel like a preview rather than a tool

---

## Part 6 — What to build

42 ideas were generated across three lenses (engine/durability, agents/providers, human/product/ecosystem). An adversarial critic then cut 7 as things weft already has, flagged 12 as weak or non-compiling, and added 8 nobody had proposed. What follows is what survived, ranked.

The ranking is deliberately unromantic. **Nine of the top ten are edges, not engine.** Weft's engine is the part that is finished.

### The build order

#### 1 — Notifier seam: make a durable gate reach a person · **M · transformative**

**Problem.** Grep across `packages/*/src`: no Slack, email, webhook, or push code anywhere. A `human.requested` event lands in the journal and the run parks durably — but the only ways to discover it are `weft status`, the loopback-only daemon page, or an MCP `weft_wait` long-poll. **Durability solves waiting, not noticing.** Every other capability weft has — budget ceilings, patch quarantine, timeout policies — assumes a human eventually shows up.

**Proposal.** A leaf package `@techery/weft-notify`: a `Notifier` interface plus a journal-tailing dispatcher the host wires in. `HumanRequestEvent` already carries everything a message needs — id, kind, question, detail, artifactRef, schema, risk, deadline, `onTimeout`, `confirmToken`. Ship `webhook`, `slack`, `desktop`, and a `command` channel that shells out so anyone can add one in five lines. Because `human.answered` already carries `channel?: string` and `Engine.answer` already accepts `{ channel }` (`engine.ts:1347`), a reply that comes back through a channel is journaled with its provenance for free.

```jsonc
// .weft/config.json
{ "notify": {
    "channels": { "team": { "kind": "slack", "botTokenEnv": "SLACK_BOT_TOKEN", "channel": "C09ABC" } },
    "on": { "human.requested": ["team"], "run.failed": ["team"], "budget.threshold": ["team"] },
    "budgetThresholdPct": 80 } }
```

**Prior art.** HumanLayer (contact-channel objects with escalation ladders and per-call context strings), Windmill (`getResumeUrls()` signed approval links, native Slack/Teams interactive approvals), Trigger.dev (`wait.createToken()` returns a webhook URL plus tags), Linear Agent Sessions (elicitation renders inline in the issue thread — the lowest-friction design in the field). Novu (39.7k stars, self-hostable, explicitly positions as "communication infrastructure for agents") is the obvious backend rather than writing four adapters.

**Caveats worth taking seriously.** Config must take an env var *name*, never a literal token. At-least-once delivery means duplicate messages after a crash — dedup on `(runId, requestId, channel)` in a sidecar. A 40-way fan-out with per-step gates is a self-inflicted DoS: per-run coalescing is required from day one. **The engine does not change at all** — the dispatcher is a pure consumer of `engine.watch()` and the store. One real caveat the critic caught: both watch APIs are *per-run*, so the dispatcher is necessarily a `list()` poll loop opening one watcher per discovered run, or the store gains a watch-all method first.

#### 2 — Journal format version + tolerant reader · **S · high**

**Problem.** Verified absent: no `schemaVersion`, `journalVersion` or `formatVersion` anywhere in `packages/core/src/events.ts` or `packages/store-fs/src/journal.ts`. The journal is the *only* source of truth for a product whose entire pitch is that a run survives its process — and it has no version field. Roughly a third of the ideas below add an event type, and every one of them silently breaks cross-version journal reads today.

**Proposal.** ~50 lines. Add `v: 1` to `run.created` and a matching constant in core. Readers refuse an unknown *major* with an error naming the weft version that wrote it; reducers and `ReplayIndex.fromRecords` skip unknown event `type`s instead of assuming exhaustiveness (`projections.ts:319` already has a `default:` branch; `replay.ts` needs auditing for the same). `weft doctor` reports the version distribution across `.weft/runs`. Document the rule: new event types are additive-minor and must be ignorable; changing an existing event's shape is a major.

**Why it ranks this high.** It is a prerequisite, not a feature. Everything downstream is cheaper once it exists and more expensive once journals are in the wild without it.

#### 3 — Machine-readable CLI: `--json` everywhere, documented exit codes, four missing verbs · **S · high**

**Problem.** All 14 verbs emit ANSI-painted prose. For a tool whose pitch is unattended, hours-long runs, being unscriptable is a structural adoption blocker. The gaps compound: no `weft signal` though the daemon exposes `POST /api/runs/:id/signal`; no `search`/`reindex` though `@techery/weft-index-sqlite` implements `search()` and `weft.reindex()` exists and **is reachable from no host at all**; no way to pipe a captured patch to `git apply`; no `--version`.

**Proposal.** One JSON view module shared by the CLI and the daemon's REST responses, so `weft status --json` and `GET /api/runs/:id` return the same shape. `--json` on `ls`, `status`, `report`, `explain`, `diff`, `replay --dry`, `check`, `doctor`. Four new verbs: `weft signal`, `weft search`/`weft reindex`, `weft cat <run> <step> [--patch|--transcript|--output]`, and `--version`. **Exit codes become a contract**: `0` success, `1` failure, `2` suspended-on-human, `3` budget-exceeded — so CI can branch on "needs a human" without parsing anything.

```console
$ weft ls --json --status suspended | jq -r '.runs[] | "\(.runId) \(.pending[0].question)"'
$ weft cat 7f3a2b1c fix:src/api.ts --patch | git apply --check -
$ weft run audit-and-fix --json; case $? in 2) echo "needs a human" ;; 3) echo "budget" ;; esac
```

The shared view types belong in `@techery/weft-sdk` so the daemon can import them without depending on the CLI, and the shape needs a `schemaVersion` on day one — it becomes an API the moment someone scripts against it. `--version` in particular is a two-line change: `bin/weft.js` already reads its own manifest at startup.

#### 4 — `AgentProvider` conformance suite · **S · high**

**Problem.** The README's package table says the adapters sit "behind a shared conformance suite". **There is none.** `@techery/weft-testing/conformance` exports only `journalStoreConformance` and `blobStoreConformance`. The two adapters are verified by mutually inconsistent hand-written tests (~40 cases for Claude, ~24 for Codex), and the consequence is not cosmetic: `write: { mode: "strict" }` means live `canUseTool` enforcement on Claude — scope-matched edits, symlink-escape realpath checks, a read-only bash allow-list — and on Codex means *nothing live at all*, only a post-hoc worktree diff. Codex also silently ignores `maxTurns`, `onMaxTurns` and `tools.deny`, and always returns `filesTouched: []`.

**Proposal.** `agentProviderConformance(name, expectations)` as a third `describe()` block, encoding what the engine actually relies on: `run()` returns output the declared wire schema accepts or throws; `repair()` re-prompts the same session when `sessionResume` is true; an already-aborted signal throws rather than dispatching; usage is non-negative per turn; a declared write scope is enforced *by the stated mechanism*. weft's own store conformance suites are the template.

**Why it ranks here.** It converts a README falsehood into a red build, and it forces the honest fix — or the honest documentation — of the provider asymmetry, which is currently a **critical** gap hiding behind one advertised interface.

#### 5 — Per-step OpenTelemetry spans with GenAI + OpenInference attributes · **M · high**

**Problem.** `engine.ts:789` is the only `tracer.startSpan` in the repo. Weft's journal is the richest per-step record in this entire landscape — kind, key, phase, route, effort, per-attempt input/output/cached usage, USD, repair attempts, scope violations, gate decisions, patch refs, `childRunId` — and **none of it is legible to any tool a team already runs**.

**Proposal.** `@techery/weft-otel`: a pure fold from journal records to spans, usable live (an observer that opens a span on `step.scheduled`, nesting by the `parentSeq` the journal already records) *and* retroactively (`weft otel export <run>` re-folds a finished journal into an OTLP batch, so runs that predate any collector are still exportable). Attributes follow the OTel GenAI conventions — `gen_ai.operation.name`, `gen_ai.provider.name`, `gen_ai.request.model`, and the token breakdown including `gen_ai.usage.cache_read.input_tokens` weft already collects — plus OpenInference `openinference.span.kind` so Phoenix/Langfuse/Opik render each node purposefully. Mapping `agent`→LLM, `check`→EVALUATOR, `gate`/`human`→GUARDRAIL, `workflow`→CHAIN, `exec`/`bash`/`git`→TOOL is a switch statement.

```jsonc
{ "gen_ai.operation.name": "invoke_agent", "gen_ai.request.model": "claude-opus-5",
  "gen_ai.usage.cache_read.input_tokens": 16100, "openinference.span.kind": "LLM",
  "weft.step.key": "review:src/api.ts", "weft.step.repair": 1, "weft.cost.usd": 0.184 }
```

**The hazard is content capture.** These spans would carry source and diffs from private repos. `captureContent` must default to **off**, not "redacted" — and it needs the redaction pass (idea 13) behind it before it is ever anything else. Sampling belongs in the config from the start: a 4096-wide fan-out is a lot of spans.

#### 6 — Schema-aligned coercion before spending a repair turn · **S · high**

**Problem.** `runProviderWithRepair` (`ctx.ts:813-882`) goes straight from a failed `validateSchema` to `provider.repair(...)` — a full extra model turn, charged to the budget, up to `limits.repair` times, and on exhaustion the whole paid step dies with `schema_repair_exhausted`. A large share of real failures are fences, prose wrappers, and near-miss scalars.

**Proposal.** One pure, zero-model-call pass between `unwrapWireValue` and the repair loop. `coerceToSchema(value, wireSchema)` attempts a bounded, schema-directed set of edits and returns `{ changed, value, applied }`. Because the engine re-validates against the **real** Standard Schema afterwards, coercion can never widen the contract — it can only turn a near-miss into a candidate the authoritative schema still has final say over. Each applied fix is journaled, so nothing happens invisibly.

**Prior art.** BAML's Schema-Aligned Parsing is exactly this: a schema-aware least-edit-distance coercion in Rust, claimed sub-10ms, with published BFCL numbers. This is the single cheapest quality-per-line item on the list.

#### 7 — `weft fork <run> --from <step>` · **M · high**

**Problem.** Weft spent enormous effort on content-addressed identity, three-tier salvage and a version stamp — and exposes three verbs over the journal, all recovery-only. When a 40-step run produces a bad plan at step 3, the options are resume (which serves the bad plan) or start over (which re-pays for steps 1-2). **Every checkpoint-based competitor, with strictly less information than weft has, ships this.**

**Proposal.** Copy records up to and including the chosen step's `step.completed` into a new run id, with a fresh `run.created` carrying `forkedFrom: { runId, seq }` and the current stamps; optionally rewrite that step's output with `--set`, validated against the step's *journaled* schema first so a hand-edited value cannot be less valid than a model's. Then resume normally — the existing salvage machinery serves the copied prefix with **no new replay code**. `weft diff <a> <b>` already compares two runs by keyed step outputs, so a fork is immediately comparable against its parent.

**The honest complication:** patches. A fork inherits `patch.captured` blob refs safely (blobs are content-addressed and immutable), but any `patch.merged` after the fork point must be dropped — and `ctx.integrate`'s `verifyServe` chain already knows how to detect a tree that does not contain a patch it thought it merged.

**Prior art.** DBOS `forkWorkflow(id, startStep, { applicationVersion, replacementChildren })` plus bulk fork from its UI; LangGraph `update_state()` + fork-by-`checkpoint_id` with Studio rewind; Burr's `fork_from_app_id` / `fork_from_sequence_id` triple.

#### 8 — Cross-run gate inbox · **S · high**

**Problem.** Every pending surface is keyed by `runId`. There is no way to answer the only question a human ever actually has: *what is waiting on me?*

**Proposal.** `weft inbox`, `GET /api/pending`, and `weft_pending` over MCP — one queue across every run in `.weft`, sorted by deadline, each row carrying the exact `weft answer` command. This is the natural payload source for the notifier at rank 1 rather than a competing feature, and it is a fold over data the store already has.

#### 9 — `reads:` scopes and a world-hash in step identity · **L · transformative**

**Problem.** Step identity is `sha256(canonicalJson{kind, payload, schema, key})`. **The working tree an agent greps is not in it** — README deviation #5 says so outright. So a resume after the repo changed happily serves a journaled answer computed against a repo that no longer exists, and every cross-run cache or distribution idea is unsound until this lands.

**Proposal.** `reads?: ReadScope` alongside `write`. Before dispatch, compute a `worldHash` over the read scope — `git ls-files -s -z` plus `--others --exclude-standard -z` against the `integrationBaseCommit` the engine already produces, filtered through the existing `scopeMatcher`, sha256 over sorted `(path, mode, blobOid)` triples — and fold it into the identity hash. On Claude, `strict` additionally denies reads outside the scope through the same `canUseTool` seam `write` already uses.

**Prior art.** Burr declares `reads=[...]`/`writes=[...]` per action and validates statically. Bazel, Nix, Nx and Turborepo hash declared inputs to decide what may be reused — weft currently sits *below* Turborepo on cache-key soundness, because an agent step declares no inputs at all. Dagster's `code_version` + `data_version` staleness computation is the closest thing to a finished answer. No durable-execution engine does this.

**This is the one item on weft's own honest-deviations list that changes what the product *is*.** It is also L effort and touches the hottest path in the engine, which is why it sits at 9 rather than 1.

#### 10 — Default-deny egress now; an OS sandbox for write steps later · **S then XL · high**

**Problem.** `fetchAllow` is optional and **undefined by default** (`core/src/config.ts`), so a default install lets model-generated workflow code reach any host — and skips the hardened per-hop redirect validation entirely when there is no allow-list and no credential-shaped header. Separately, and larger: the agent's own process is not sandboxed at all. Worktree isolation is a *convention*; a step can write outside its worktree and weft learns about it only from provider self-reported `filesTouched`. The Claude gate's `commandEscapesWorktree` is documented as a lexical screen, not a sandbox.

**Proposal, in two very different sizes.** First, flip the default: deny egress unless `fetchAllow` names hosts. One line, outsized value, and it is the honest down-payment. Then, behind the same `isolation:` seam that already accepts `"worktree" | "none"`, add `"sandbox"` backed by an OS mechanism — Anthropic's own `sandbox-runtime` (bubblewrap / Seatbelt / WFP process-tree scoping, writes allow-only, network deny-all behind a proxy allowlist) is exactly the shape weft needs and is Apache-2.0. microsandbox (libkrun microVMs as ordinary child processes, <100 ms boot) fits the local-first posture; container-use proves the container-per-agent model but discards the workflow layer.

**Why the split matters.** The egress default is S and shippable this week. The sandbox is XL, cross-platform, and touches every provider adapter — proposing them as one item is how it never gets done.

### The rest of the catalogue

Everything that survived the critic and did not make the top ten, grouped by theme. `⚠️ weak` marks an idea the critic found flawed as proposed — the underlying problem is usually real even where the mechanism is not; see [Part 7](#part-7--what-the-critic-cut).

#### Humans

| Idea | Size | Impact | The problem it solves | Prior art |
| --- | --- | --- | --- | --- |
| **Daemon UI as a real review surface: schema-driven forms, patc…** | M | high | The web UI is one hand-written HTML file (ui.ts:12, INDEX_HTML) whose detail pane is state + tree + pending + report and nothing else. There is no per-step prompt/payload/output view (the CLI's `weft explain` has one and the UI d… | Vibe Kanban's inline diff commenting with a preview browser was the best review UX in the coding-agent cluster (and the project is sunsetting, so the… |
| **Gate bridge: answer a weft gate from a GitHub PR, Linear issu…** | L | transformative | Even with notifications, answering requires a terminal on the machine holding the journal, or a browser on 127.0.0.1. `weft answer` is a durable, CAS-guarded, schema-validating entry point (engine.ts:1343-1467, with cross-descend… | Linear Agent Sessions renders elicitation as an activity inline in the issue thread that motivated the work, with the agent as delegate rather than a… |

#### Observability

| Idea | Size | Impact | The problem it solves | Prior art |
| --- | --- | --- | --- | --- |
| **Incremental event index and `weft query`** ⚠️ | M | high | Nothing in core calls `indexRun` — the sqlite index is only ever rebuilt wholesale by the host (host/weft.ts:122-141), so rows are stale between rebuilds, and `search()` is an unranked LIKE scan with a default limit of 50. The in… | DBOS stores workflow status, inputs, and step outputs as ordinary relational rows you can query with SQL and join against your own tables — explicitl… |
| **Live step-progress channel: see inside a running agent step** | M | medium | An agent step is a black box for its entire duration — which, at `limits.stepTimeoutMs` default of 20 minutes, is a long time. Both adapters already accumulate transcript lines as the stream arrives (`assistant:`, `assistant → to… | Agent Client Protocol (Zed) streams tool-call updates carrying status AND the file locations touched, which is what turns a log wall into supervision… |

#### Agents & providers

| Idea | Size | Impact | The problem it solves | Prior art |
| --- | --- | --- | --- | --- |
| **Attempt checkpointing: keep the provider session across a tim…** | S | high | When a step times out, `withTimeout` aborts the attempt, drains 5s to harvest late usage, and fails (runtime.ts:763-834). The retry starts a brand-new provider session from turn 0 — every token of the aborted attempt's context is… | E2B pauses a sandbox with a full memory snapshot (~1s resume) so a long agent session is frozen rather than restarted. Claude Code's session transcri… |
| **stdlib: escalate() — a cost ladder with a declared acceptance…** | S | medium | weft has per-step routing and hard USD ceilings but no shipped pattern that uses one to protect the other. Today the author picks a model per call site at authoring time, which means either paying Opus prices for steps a Haiku co… | Aider's architect/editor split is per-role routing with a demonstrated cost/quality win (expensive model plans, cheap model applies). DSPy's `TwoStep… |
| **Route policies with typed fallback chains** | M | high | Routing today is a three-way merge of step opts → workflow defaults → config.defaults, resolved inline in `agentImpl` (ctx.ts:269-277). It is per-call-site and static: there is no way to say "all `review:*` steps go to Opus, fall… | BAML composes `client` blocks into strategy clients with `retry_policy`, `fallback` chains and round-robin, declared once rather than at each call si… |
| **Native structured-output path with per-provider output-mode n…** | M | high | `ProviderCapabilities.structured` is declared as `"native" ／ "tool"` (provider.ts:65) but the Claude adapter hard-codes `structured: "tool"` and every single step pays an sdk-mcp round trip: a `weft` MCP server is spun up per str… | LangGraph's `create_agent` auto-selects `ProviderStrategy` (native constrained decoding on OpenAI/Anthropic/Gemini/xAI) versus `ToolStrategy` (schema… |
| **Per-step tool surface: MCP servers plus an allow/deny matrix** | M | high | `ToolPolicy` is `{ allowEdits: boolean; deny?: string[] }` (provider.ts:8-13) and that is the entire tool surface a weft step can express. Two consequences. First, a step cannot be GIVEN a tool it does not already have — no Linea… | opencode declares a permission matrix per agent — read/edit/bash/glob/grep/task each set to allow／ask／deny — far more expressive than a mode. goose's… |
| **stdlib: bestOfPatch() — N candidate patches, verified in thei…** | L | high | weft has the only assembly in the landscape that could make best-of-N rigorous for code — per-attempt worktrees, captured patches as typed values, `ctx.check`, and a gated `ctx.integrate()` — and ships none of it. `judgePanel` ex… | Crystal (now Nimbalyst) was built explicitly for running several attempts at one task and comparing them, with per-session run scripts to verify a ch… |

#### Authoring & DX

| Idea | Size | Impact | The problem it solves | Prior art |
| --- | --- | --- | --- | --- |
| **AGENTS.md ingestion as a journaled context step** | S | medium | AGENTS.md is now read by Codex, Claude Code, Copilot, Cursor, Aider, Jules, VS Code and goose — 60,000+ repositories, under Linux Foundation AAIF governance. weft reads none of it. A weft write step hands an agent a freshly creat… | AGENTS.md itself — originated by OpenAI Codex, now an AAIF/Linux Foundation project, honoured by Codex, Claude Code, GitHub Copilot coding agent, Goo… |
| **Record-and-replay the nondeterministic globals instead of ban…** ⚠️ | M | high | The gate bans `Date.now`, `new Date()`, `Math.random`, timers, `Intl`, and locale methods across eleven AST rules (gate/rules.ts:57-72) and the node:vm sandbox makes them throw. The replacements are `ctx.now()`, `ctx.random()`, `… | Temporal's TS SDK replaces Math.random with a seeded PRNG and pins Date.now to the last Workflow Task completion time; Vercel Workflow DevKit documen… |
| **`ctx.await({ any: [...] })` — composable durable wait conditi…** ⚠️ | M | high | weft has three durable waits — `ctx.signal(name, schema, {timeout})`, `ctx.sleep(d)`, and human steps with deadlines — and no way to compose them. "Wait for the CI signal, or a human override, or 24 hours, whichever comes first"… | Hatchet's `ctx.waitFor(Or(UserEventCondition(...), SleepCondition('24h')))` composes event waits and timeouts into one durable primitive; arrays mean… |
| **Speculative fan-out with preemption and automatic patch lifec…** | M | high | `ctx.parallel` runs different work; there is no primitive for running the *same* work k ways and keeping the best. Doing it by hand today is a trap: k write steps produce k patches, and a run that ends with un-integrated, un-disc… | uzi launches dozens of agents on one task and lets a human pick — and its documented failure is exactly the missing evaluation step. Crystal/Nimbalys… |
| **Session handoff: continue a prior step's provider session ins…** | M | high | `DetailedAgentResult.sessionId` is returned by the engine and journaled on `step.completed`, both adapters implement session resume, and `capabilities().sessionResume` is true for Claude, Codex and mock — but nothing in the autho… | Aider's architect/editor split is the canonical shape — an expensive reasoning model plans, a cheaper model with its own edit format applies — a docu… |
| **`ctx.spawn` — non-blocking, durable sub-workflow handles** | L | high | `ctx.workflow` is a blocking call whose step deliberately never serves from the journal (`verifyServe: async () => false`, ctx.ts:1053-1059), so every resume re-enters the child run and relies on the child's own journal to avoid… | Temporal splits `startChild` (handle) from `executeChild` (blocking), and Nexus for cross-namespace calls. DBOS `startWorkflow` returns handles for b… |
| **Self-improving workflows: a journal-mined hint bank with huma…** | L | transformative | weft journals every schema-repair attempt (`step.attempt "schema repair n/max"`), every `schema_repair_exhausted`, every failed required check, every scope violation and every `drop`, across every run in `.weft/runs`. That is a d… | DSPy's optimizers (MIPROv2, GEPA reflective prompt evolution, BootstrapFewShot) automatically search instructions and few-shot demos against a metric… |

#### Testing & quality

| Idea | Size | Impact | The problem it solves | Prior art |
| --- | --- | --- | --- | --- |
| **Make `replay --dry` faithful, then make it a CI gate** | S | high | `replayDry` is the tool for "what would happen if I resume this edited script" and it does not model that case: it never computes `positionsTrusted`, ignores `opts.defHash`, and constructs `new Budget({})` with `agentCounter: { c… | Temporal's `Worker.runReplayHistory()` / `runReplayHistories()` feeds recorded production histories through new code and throws `DeterminismViolation… |
| **`weft conformance`: pin a run's agent trace as a golden file…** | M | transformative | weft can prove a step returned the declared shape and can say nothing about whether the output was any good or whether the run took the expected path. The journal is already a complete, structured recording of every model interac… | Google ADK's `adk conformance` records a scenario's LLM requests, responses and tool calls into generated-recordings.yaml + generated-session.yaml go… |

#### Engine & durability

| Idea | Size | Impact | The problem it solves | Prior art |
| --- | --- | --- | --- | --- |
| **Retry policies as declared objects, with resumable backoff** | S | high | `retry` is `{ attempts, backoffMs? }` and the delay scales linearly (runtime.ts:726-751). The non-retryable set is hardcoded (`cancelled`, `budget_exceeded`, `gate_denied`, `human_denied`) — a workflow cannot say "retry a `fetch_… | Temporal's RetryPolicy with initialInterval / backoffCoefficient / maximumInterval / nonRetryableErrorTypes. Cloudflare Workflows' declarative `retri… |
| **Prompt-prefix cache-aware fan-out scheduling** ⚠️ | S | medium | A keyed `ctx.parallel` fan-out — the canonical weft shape, and what `.weft/workflows/review.ts` does — launches N agent steps sharing a long identical prefix (system framing, the write-scope paragraph appended at ctx.ts:485-493,… | Claude Code's dynamic workflows do exactly this and ship the knob: same-prefix agents are deliberately staggered up to `CLAUDE_CODE_WORKFLOW_PREFIX_S… |
| **Repo-root discovery, blob GC, and `weft doctor --fix`** | S | medium | Three small things that each make weft feel like a preview. (1) Verified: `--cwd` defaults to `process.cwd()` and `.weft` is always `<cwd>/.weft` with no walk toward a parent (context.ts:24, weft.ts:85), so running any command fr… | Repo-root discovery is universal in git-adjacent tooling (git itself, npm, cargo, biome — weft's own biome.json honours .gitignore from the root). Re… |
| **Checkpoint records, journal compaction, and blob GC** | M | medium | `ReplayIndex.fromRecords` folds the entire journal from record 0 on every resume, every `weft status`, every daemon read, and every projection refresh (replay.ts:90-238, store-fs/journal.ts:467-520). A long-lived run — a week-lon… | Temporal's Event History has hard size/count limits and forces `continueAsNew` to bound it. Microsoft Agent Framework writes an entry checkpoint befo… |
| **Cross-run step cache keyed on {identity, worldHash}** | L | transformative | Salvage only works *within* one run's journal (replay.ts:248-301). Running the same review workflow over 20 PRs, or re-running it on an unchanged repo after a failure, re-pays for every read-only analysis step. The engine already… | LangGraph's node-level `CachePolicy(cache_key, ttl)`; Hatchet's `ctx.memo` as a lighter tier than a full checkpoint; Helicone's response cache at the… |
| **Park and wake: suspend a waiting run to zero** ⚠️ | L | transformative | A run blocked on a human holds a Node process, a worktree, and an ownership lease. Cancel and shutdown deliberately do *not* release the lease (engine.ts:1623-1631, 1696-1701) so the run stays claimed until TTL expiry, and there… | Prefect distinguishes `pause_flow_run` (blocks in place) from `suspend_flow_run` (exits the process entirely, reschedules on resume) — two primitives… |
| **Multi-worker execution: the journal as a work queue** ⚠️ | XL | transformative | A run is single-process by construction: `acquireRun` claims it, one RunRuntime executes every step, and the global limiter caps concurrency at `min(16, cpus-2)` on that one machine (config.ts:66-68, engine.ts:249-256). A 200-way… | Windmill: stateless API servers advance flow state in Postgres while stateless workers pull individual job rows, with dead workers detected via `work… |

#### Isolation & security

| Idea | Size | Impact | The problem it solves | Prior art |
| --- | --- | --- | --- | --- |
| **Redaction pass over everything that leaves the journal** | M | high | Secret redaction covers only env maps and fetch header names/values passed as SecretHandles (ctx.ts:109-158). Step outputs are journaled verbatim: exec/bash stdout+stderr, fetch response bodies and headers, agent prompts, and `ct… | OpenInference specifies attribute masking/privacy controls applied at instrumentation time, and the OTel GenAI conventions make instrumentation-level… |

#### Ecosystem & distribution

| Idea | Size | Impact | The problem it solves | Prior art |
| --- | --- | --- | --- | --- |
| **Claude Code integration kit: make weft the thing Claude Code…** | S | high | weft's authoring model is plain TypeScript, which is maximally flexible and therefore maximally blank-page — and the agent most likely to write a weft workflow is Claude Code, which knows nothing about weft. Meanwhile weft's MCP… | microsandbox and Claude Code both ship MCP servers exposing their own primitives so external agents can drive them. Windmill generates LLM tool JSON… |
| **Workflow packages: `weft add`, npm distribution, and a lockfi…** ⚠️ | M | high | The registry is a directory of `*.ts` files (`packages/gate/src/registry.ts`) keyed by basename or `meta.name`, cached by bundle hash. That is a good local design and a dead end for sharing: there is no way to install someone els… | Claude Code's plugin/marketplace model bundles agents, skills, hooks, workflows and commands as installable units. goose's Recipe Cookbook distribute… |
| **ctx.memory — a durable, journal-honest knowledge store across…** ⚠️ | L | transformative | Every weft run starts from nothing. A write step's worktree is seeded from the integration commit and handed to an agent with no accumulated understanding of the repository — which modules are owned by whom, which tests are flaky… | LangGraph separates thread-scoped checkpoints from a cross-thread `store` for long-term memory — "Stores persist application-defined data outside the… |
| **CI-native weft: a GitHub Action, PR-comment reports, and gate…** | L | high | weft's strongest properties — a durable journal, a cost ceiling, a patch that lands only at an explicit integrate — are exactly what a CI-run agent needs, and there is no CI story at all. No action, no documented exit codes, no a… | gh-aw compiles Markdown+YAML into ordinary GitHub Actions and enforces that the agent job is read-only while writes go through schema-validated safe… |

#### Added by the critic — nobody else proposed these

| Idea | The proposal |
| --- | --- |
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

## Part 8 — Sequencing

The top ten is a ranking, not a plan. Grouped into what can actually ship together:

### Sprint 1 — make the mechanism usable (≈ 2 weeks, all S/M, no engine changes)

`--json` on every verb + documented exit codes + the four missing commands · the notifier seam with a webhook and a Slack channel · the cross-run gate inbox that feeds it · the journal format version · `AgentProvider` conformance · schema-aligned coercion · default-deny egress · `--version` · repo-root discovery.

Nothing here touches `packages/core`'s hot paths. Together they close **two of the three critical gaps** and the loudest of the high ones. The credibility items (dead API surface, the `audit-and-fix` panel that is not actually cross-vendor, the README's conformance-suite claim) belong in this sprint too — they cost hours and they are the first things a careful reader checks.

### Sprint 2 — make the record legible (≈ 3 weeks)

Per-step OTel spans with GenAI + OpenInference attributes, gated behind `captureContent: "off"` · the redaction pass that has to exist before content capture is ever anything else · `weft fork` · `weft why <run> <step>` (explain the replay decision — a projection over `replay.salvaged` / `replay.diverged` events that already exist) · `weft describe` with schema-rendered `--help` · the daemon UI as a real review surface, with `POST /api/runs` so the browser can start a run at all.

### Then — the two that change what weft is

`reads:` scopes with a world-hash in step identity (L, and the only item on the honest-deviations list that changes the product's *guarantees*), and `isolation: "sandbox"` over an OS boundary (XL, cross-platform, touches every adapter). Both are worth doing. Neither should block the first two sprints, and neither should be started while the edges are still open.

### Explicitly not now

Multi-worker distributed execution (breaks per-process budget admission and the whole ownership model, XL, and nobody is asking for it at this scale), `ctx.memory` (weakens the property weft exists to provide), self-improving prompt banks (puts mutable model-generated text into the step identity hash), and CI-native weft over GitHub Actions artifacts (a journal that lives only in a 90-day artifact is not durable in any meaningful sense — it needs `weft export`/`import` and a real store first).

---

## Part 9 — The strategic question this report cannot answer

Seven leads on mechanism, and zero users. The 2026 attrition in this category is worth naming plainly: **Flowise archived at 55.4k stars, Roo Code archived at 24.3k, Vibe Kanban sunsetting at 27.9k.** Being right about the mechanism is not what determined those outcomes.

Three things follow from the comparison that are decisions rather than tasks:

**Lead with the write model, not the orchestration.** The fan-out surface (`parallel`, `pipeline`, `phase`, worktree isolation, token budgets) is commoditised — Claude Code ships it free with byte-identical caps, and the README currently spends its best real estate defending it. What nobody else has is `ctx.integrate()`, `verifyServe`, and a schema-validated durable human. The one sentence that should be at the top of the README is closer to: *weft makes an agent's change to your repo reviewable — every step schema-validated, every diff a scoped patch that lands only where you said it could, every run replayable from a journal after the session is gone.*

**The cross-vendor pitch needs repair before it needs marketing.** `PANEL = ["claude", "codex", "claude"]` with a `>= 2` majority means Codex's vote is never decisive, and the refuter is handed the finder's evidence — which the closest published work deliberately withholds to avoid anchoring. Both are one-line fixes in `.weft/workflows/audit-and-fix.ts`. Until they land, the flagship example does not implement the claim it exists to demonstrate. The defensible version of the pitch is narrower and true: *weft makes the refutation gate a typed, journaled, replayable part of the program, and lets you swap the vendor if you want to.*

**Decide whether weft is a library or a product.** As a library it is nearly finished and needs Sprint 1 plus an npm publish. As a product it needs the notifier, the inbox, the bridge into GitHub/Linear/Slack, and a review UI — and it is then competing with Agent HQ, Codex Cloud and Jules on their turf, from zero. The comparison suggests the library answer: DBOS and Burr both prove that "a library plus a local store plus a self-hosted UI" is a viable shape, and it is the shape weft already has.

---

## Appendix A — Full feature inventory

The complete 140-feature inventory with `file:line` evidence, the 71 proven limitations, the 84-project landscape, all 42 raw ideas with their API sketches, and the critic's full output are checked in as JSON under [`data/2026-08-feature-landscape/`](./data/2026-08-feature-landscape/) — every claim in this report is traceable to a record there. The condensed capability map:

| Area | Capabilities | Notable mechanisms |
| --- | --- | --- |
| **Journal & replay** | 12 | Canonical-JSON identity, three-tier matching, keyless-ambiguity guard, `OrderedDelivery` with a turn-counted (not wall-clock) stall watchdog, `verifyServe`, `replay --dry` |
| **Budget** | 5 | Token + USD ledger, parent-linked child pools, concurrency-aware admission, resume restoration from descendant journals, USD-only ceiling refusal |
| **Humans & gates** | 7 | Journaled human steps, reject-and-reopen, per-request CAS delivery, deny/escalate/default timeouts, risk tiers with typed confirmation, in-agent permission asks routed to the broker |
| **Isolation & patches** | 10 | Per-attempt worktrees from `integrationBaseCommit`, patch capture with `--no-renames`/`--binary`, scope check + quarantine, in-place enforcement with ignored-tree manifests, `ctx.integrate` with three conflict strategies, `restorePatchFiles` rollback |
| **Storage & ownership** | 9 | Locked fsynced JSONL with torn-tail recovery, absence-vs-fault discipline, leases + fencing, content-addressed blobs, derived self-healing SQLite index |
| **Providers** | 13 | Frozen `AgentProvider` contract, Claude terminating-tool structured output + live `canUseTool` scope gate + Bash screening, Codex native structured output + sandbox, mock fixtures |
| **Git** | 4 | 25 typed operations, fixed risk tiers, CLI hardening, gc-safe `snapshot()` |
| **CLI / MCP / daemon** | 30 | 14 verbs, 7 MCP tools, HTTP + SSE API, live tree renderer, dual-shape `bin/weft.js` |
| **Gate & sandbox** | 6 | 11 AST rules with fix-its, esbuild bundling with in-build gating, content hash, `node:vm` global replacement, file registry |
| **Testing** | 5 | `runWorkflow`, mock builder, side-effect fixtures, journal assertions, store conformance suites |
| **stdlib** | 6 | `adversarialVerify`, `judgePanel`, `loopUntilDry`, `completenessCritic`, `multiModalSweep`, `finalReport` |
| **Config, host, packaging** | 33 | `createWeft` assembly, config discovery, workflow ref resolution, release pipeline with `verify:packing`/`verify:install`, CI on node 22 + 24 |

## Appendix B — Reading this report against the last one

The [DX and Architecture Review](./2026-08-dx-and-architecture.md) audited quality at `ad5ecae`/`c0e5e50`. Since then `da85488` landed. Checked against the current tree while writing this report:

| Then | Now |
| --- | --- |
| No LICENSE file | ✅ Present, MIT |
| No build scripts, no `publishConfig`, name taken on npm | ✅ Fixed — packages are `@techery/weft-*`, every manifest has `build`, `files`, `publishConfig.access`, `repository`, and there is a tag-driven release workflow with `verify:packing`/`verify:install` |
| A mistyped input flag silently ran the wrong thing | ✅ Fixed — each candidate key is probed against the schema twice and only a key that changes nothing under both is called unknown |
| Budget ceiling destroyed parallel fan-out | ✅ Fixed — `reserveCall` parks for a slot instead of refusing one |
| A salvage cache hit could lie | ✅ Guarded — a workflow-body hash gates position trust, and an ambiguous keyless step re-runs |
| Replayer used a wall-clock watchdog | ✅ Fixed — the stall test counts drained event-loop turns |
| `weft run <name> --help` does not show the workflow's flags | ❌ Still open — verified: `--base` is not listed |
| No `--json` on any verb | ❌ Still open |
| `audit-and-fix` panel is not actually cross-vendor | ❌ Still open — `PANEL = ["claude", "codex", "claude"]`, `>= 2` |
| No corpus replay assertion in `@techery/weft-testing` | ❌ Still open |
| Declared `reads:` inputs | ❌ Still open (idea 9 above) |
