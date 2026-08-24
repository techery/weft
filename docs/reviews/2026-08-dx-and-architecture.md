# Weft — DX and Architecture Review

**Reviewed:** 2026-08-24, at commit `ad5ecae`; re-checked against `c0e5e50` after main
landed the `@techery/weft-*` rename and the structured-output fixes.
**Status:** every finding below has been fixed on
`claude/weft-dx-architecture-review-yzmxo6`, each with a regression test — see
[What was fixed](#what-was-fixed).
**Baseline:** Claude Code's built-in dynamic workflows, plus durable-execution engines (Temporal,
Restate, DBOS, Inngest, Trigger.dev), agent frameworks (LangGraph, Mastra, CrewAI, OpenAI Agents SDK),
and the coding-agent field (Codex cloud, Copilot coding agent, OpenHands, Dagger container-use).

Everything attributed to weft below was verified against the source, by running the code, or by
writing a failing test. Claims sourced from external research that I could not verify locally are
marked as such.

---

## Verdict

Weft is the most carefully engineered thing I have read in this category. The journal model is sound,
the comments explain *why* rather than *what*, the failure paths are thought through further than most
production systems bother with, and on a fresh clone it delivers a clean strict `tsc`, a clean lint,
and **610 passing tests**. It is not a prototype dressed as a library.

It also carries a defect that silently destroys its own flagship workflow, and a soundness gap at the
centre of its headline feature. Both are fixable in days.

The strategic problem is harder. Claude Code now ships dynamic workflows as a built-in tool with the
same vocabulary — `agent`, `parallel`, `pipeline`, `phase`, `log`, `budget`, nested `workflow()`, the
same `Date.now()`-throws fence, the same `isolation: 'worktree'`. This is not convergent evolution.
Weft's own defaults are byte-identical to that tool's documented caps
(`packages/core/src/config.ts:67, 104-106`):

| | Claude Code | weft |
|---|---|---|
| concurrency | `min(16, availableCPUs - 2)` | `Math.max(1, Math.min(16, cpus().length - 2))` |
| soft agent guideline | 15 | `agentGuideline: 15` |
| hard agent cap | 1000 | `agentHard: 1000` |
| fan-out item cap | 4096 | `fanoutMax: 4096` |

Weft was built with that contract in hand. So the useful question is never "does weft have fan-out
too" — it does, slightly better — but **what did weft build that the platform deliberately did not**.

The answer is three things, and they are genuinely defensible:

1. **The write/scope/integrate discipline.** Worktree → patch blob → out-of-scope quarantine → nothing
   lands until `ctx.integrate()`, and a run that ends with a dangling patch *fails*
   (`packages/core/src/engine.ts:687-692`). Vendors ship a `worktree` flag and stop, because the rest
   of it is about distrusting your own agent.
2. **Durable human-in-the-loop.** Claude Code's workflow tool has none — its own guidance for sign-off
   between stages is to run each stage as a separate workflow. Weft suspends across process death and
   validates the human's answer against the same schema as everything else.
3. **Cross-vendor per-step routing with engine-side validation.** Structurally not something Anthropic
   or OpenAI ships.

Everything else — the fan-out primitives, phases, worktree isolation, token budgets, the stdlib
patterns, journaled replay — is already commoditised or is prose in Anthropic's own tool description.

**The one sentence that should be at the top of the README** is not about orchestration, parallelism,
or workflows-as-code. It is something closer to: *weft makes an agent's change to your repo
reviewable — every step schema-validated, every diff a scoped patch that lands only where you said it
could, every run replayable from a journal after the session is gone.*

---

## What was fixed

The findings are kept below as written, because the reasoning is the point. All of them
are now closed, along with a further set found by a follow-up audit of the subsystems this
review had not reached.

| Finding | Fix |
| --- | --- |
| 1 — a budget ceiling destroys fan-out | `Budget.reserveCall` parks for a slot instead of refusing one; refuses only when waiting cannot help. The ceiling stays hard. |
| 2 — a salvage cache hit can lie | Each run stamps a hash of the workflow body; positions are trusted only when the script is unchanged, and an ambiguous keyless step re-runs and records `replay.diverged`. |
| 3 — wall clock in the replayer | The stall test counts drained event-loop turns, and the runtime counts replay-path I/O so a turn cannot read as quiet while a continuation is in flight. |
| 4 — determinism fence gaps | `WeakRef`, `FinalizationRegistry`, `Intl` and the locale-sensitive string methods are rejected at parse time and replaced in the sandbox. |
| 5 — four README claims | Corrected, with two new entries in "honest deviations". |

Found and fixed by the follow-up audit, in rough order of severity:

- **A diff driver could destroy every captured patch.** `GIT_EXTERNAL_DIFF` or a
  repository's `diff.external` replaces git's output with a program's stdout;
  `capturePatch` journaled that, `git apply` refused it, and the work was lost.
- **A nested git repository silently discarded a whole step's output.** Anything that runs
  `git init` in a subdirectory is staged as a commit pointer, so the patch applied cleanly
  and landed none of the files.
- **Write scopes failed open on exclusions.** `["src/**", "!src/secret.ts"]` still
  permitted `src/secret.ts`, and an exclusion-only scope permitted the whole tree — in the
  post-hoc check *and* in the live `canUseTool` gate, which had its own copy of the
  matcher.
- **A hung provider held its concurrency permit forever**, so a couple of unresponsive
  calls wedged a run past any timeout.
- **A fan-out built every worktree before taking a permit** — 50 checkouts to run two.
- **An unreadable blob killed a resumable run** instead of re-running the step, and one
  corrupt journal line hid every healthy run from `weft ls`.
- **A mistyped CLI flag ran the wrong thing.** `--basse release-2.0` reviewed `main`
  silently; values like `1e5`, `1.20` and `007` were coerced to numbers.
- **`toStrictSchema` rewrote the author's own data**, descending into `default`, `const`
  and `enum` values.
- **`@techery/weft-testing` was unimportable from a published install** (`vitest`
  undeclared), and `ctx.pipeline` builders shared one mutable stage array.
- **Under a strict write scope, git ran unwrapped**, so repository-configured
  `textconv`/`diff` drivers executed — a weaker boundary than the read-only gate beside
  it; and an edit tool whose path field wasn't recognised was allowed outright.
- **An out-of-tree write left no record.** `filesTouched` was overwritten by what patch
  capture saw, and capture only ever sees inside the worktree — so `warn` mode, whose
  whole promise is to flag rather than block, flagged nothing.
- **`cancel()` hung forever** on a step that ignored its abort; a corrupt `index.sqlite`
  refused to open with no repair path; and `list()` trusted a projection whose mtime
  merely *equalled* the journal's.
- Two suite defects: a test asserting a capability the product does not have (the harness
  bypassed the validation production performs), and a flaky assertion on git's *optional*
  index refresh.

A Codex deep review of the resulting PR found four more, all in the fixes above, all
valid:

- **`cancel()`'s bounded drain left a zombie.** `fence()` cannot settle the promise
  `def.run` is awaiting, and both cleanup paths hang off it — so a "cancelled" run stayed
  active, renewed its claim forever, and handed every later `resume()` the same pending
  promise. The execution is now retired independently; the lease is deliberately *not*
  released, because the zombie may still write.
- **Rejecting unknown CLI input broke open schemas.** `.passthrough()` and `.catchall()`
  have a `shape` too, so checking against it refused the very fields such a workflow
  exists to receive. The check now asks what validation *did* — which keys came back —
  rather than what the shape lists, which also makes it vendor-neutral.
- **Removing a registered submodule read as an accidental nested repository.** The
  gitlink check matched on `oldMode`, and a deleted submodule is already gone from
  `.gitmodules`; only newly introduced gitlinks are refused now.
- **A busy SQLite index was deleted as if corrupt.** `SQLITE_BUSY`, `EACCES` and other
  transient failures now propagate; only verified corruption discards the file.

A second Codex pass over those fixes found four more — again, every one of them inside a
fix rather than the original code:

- **An unreachable blob store re-ran a completed step.** The blob-loss repair caught
  *every* read failure as a cache miss, and `FsBlobStore` had already flattened EACCES and
  EIO into "not found" before the caller could tell. Only absence and corruption are
  repairable now; a fault propagates rather than duplicating a step's side effects and
  paying for its provider call again.
- **`cancel()`'s drain timer was unreferenced**, so a one-shot process could exit
  mid-wait — before `run.cancelled` was journaled — losing the bounded guarantee in
  exactly the handle-free hang it exists for. The timer is the remaining work, not a
  watcher of it; it is referenced now and cleared as soon as the race settles.
- **The corrupt SQLite file was unlinked with its connection still open.** Corruption
  surfaces from the first PRAGMA, not from `open()`, so the handle is live: on Windows the
  unlink fails and the repair path becomes the failure it prevents.
- **The unknown-flag check refused renaming transforms.** A schema that reads `--base` and
  returns `baseRef` looked like a silently dropped flag; `in` also read inherited names
  like `constructor` as declared. Each candidate key is now probed against the schema
  twice — removed, and replaced with a value nothing accepts — and only a key that changes
  nothing under both is called unknown.

A third pass found five more, four of them again inside earlier fixes:

- **The replay version stamp covered only the root run, and only the body it could see.**
  Child runs created by `ctx.workflow` journaled no version and defaulted to trusting
  positions, so a child's own edit re-opened the exact hole the stamp was added to close.
  And `def.run.toString()` is blind to an edit inside a module the body delegates to —
  identical text, moved call sites — so `positionsTrusted` now folds in the host's bundle
  hash too, plumbed through every resume path.
- **`appendIf` stopped being conditional under a stolen lock.** The count was tested
  against the pre-steal fold; a peer that committed in the window between the two
  reconciles was written straight over. Re-tested after the second fold.
- **A failed cancellation append was reported as success.** With `run.cancelled` lost to
  ENOSPC the journal still said `executing`, the retained claim expired, and the next
  process re-executed a run the caller was told was cancelled.
- **`list()` hid healthy runs on transient I/O** — and `RunIndex.rebuild()` repopulates
  from that list, so a storage hiccup also deleted the row. Now only damaged or deleted
  runs are skipped. (This one was flagged in the previous round's write-up as a design
  question; the index-rebuild consequence settles it.)

A fourth pass found the two paths the version stamp still did not reach, both inside the
fix above:

- **A registry resume passed no bundle hash.** `persistedDefOf` returns undefined for
  registry runs, so the host plumbing skipped exactly the case where the *start* had
  journaled a hash. `WorkflowRegistry` gained an optional `hashOf(name)` and the engine
  asks it directly — which fixes every host at once, including any the plumbing never
  reaches.
- **Children did not inherit the root's disagreement.** A child has only its own body hash
  (nothing resolved and bundled it), so a delegating child body reads identical however
  the helper is edited — even when the root's resume had already seen that same bundle
  move. A child now starts from the root's answer rather than from `true`.

The pattern is the finding. Across four review rounds, the large majority of later defects
lived in the fixes for earlier ones, not in the code originally audited — and the deeper
version of that: a fix aimed at one path leaves the sibling paths untouched, so the
question after every fix is which other callers reach the same code. A fix is new code and
needs the same adversarial pass as anything else.

## Measured baseline

```
pnpm install                 ✓
pnpm typecheck               ✓  tsc --strict, 175 files
pnpm lint                    ✓  biome, 1 info
pnpm test                    ✓  692 passed (692), 41 files, 38.5s
weft doctor                  ✓  ready
weft check                   ✓  all workflows gate clean
npx tsx examples/*/main.ts   ✓  all seven run offline
```

16 packages, ~33.6k lines of TypeScript. Every package except `provider-mock` has tests.

---

## Part 1 — weft versus Claude Code dynamic workflows

| Axis | Claude Code | weft | Winner |
|---|---|---|---|
| **Authoring** | Plain JS; type annotations *fail to parse*. Script is a string. No FS, shell, or module loading — all I/O must go through a paid subagent. | TypeScript strict; typed workflow I/O validated in and out; relative imports bundled and hashed with the script; journaled `fs`/`exec`/`bash`/`fetch`/`git`. | **weft**, and the I/O gap matters more than the types. Claude Code's own "run tsc until it passes" pattern means paying a subagent to run tsc every round; weft runs it as a free journaled `ctx.check`. |
| **Who writes it** | Claude, per task, essentially disposable. | A human, checked in, reviewed, versioned. | Different products. This is the real fork. |
| **Structured output** | Optional. No `schema` → the final text as a string. With one → forced `StructuredOutput` tool, validated at the tool-call layer. | Required on every agent and human step. Provider returns raw; **the engine** validates against the real schema. | **weft**, on discipline more than mechanism. |
| **Lane failure** | `agent()` returns `null`; caller must `.filter(Boolean)`. | `Settled<T>`; `ctx.ok()` narrows and journals the drop. | **weft.** `null` erases the reason. |
| **Fan-out** | `parallel` (barrier), `pipeline` (no barrier). | Same two, same caps (see above); `pipeline` is a chained builder. | **Tie.** |
| **Progress** | `/workflows`: pause a run, stop or **restart one agent**, filter by status, read any agent's prompt and tool calls. | `tree.json` projection, live CLI tree, single-file web UI over SSE, one OTel span per run. | **Claude Code.** Its control surface is interactive; weft's is a view. |
| **Resume** | Longest-unchanged-**prefix**, ordinal, **same-session only**. | Content-addressed salvage anywhere in the journal; survives reboot, machine change, overnight human wait. | **weft** on capability — with a real soundness cost (Finding 2). Claude Code's replay is dumber and wastes tokens, but it cannot lie. |
| **Budget** | One token pool; throws once already spent, so N concurrent calls overshoot. | Tokens **and** USD, shared with sub-workflows, with admission control. | weft diagnosed the real flaw correctly and **shipped a worse remedy** (Finding 1). |
| **Isolation** | `isolation: 'worktree'` — a flag. | Declared `write:` scope → worktree → patch blob → scope partition → lands only at `ctx.integrate()`. Plus live `canUseTool` denial *before* the edit. | **weft**, by the widest margin on the board. |
| **Human in the loop** | **None.** | Durable, schema-validated, with `deny`/`escalate`/`default` timeout policy and `answeredBy: human \| policy \| timeout` provenance. | **weft**, uncontested. |
| **Prompt caching** | Staggers matching siblings up to 5 s so a fan-out pays the system-prompt prefix once. | No equivalent. | **Claude Code.** Real money on every fan-out. |
| **Distribution** | Built into a CLI already installed. | 16 packages, none publishable today (Part 5). | **Claude Code**, overwhelmingly. |

On engineering merit weft wins most axes it competes on. On the axis that decides adoption — *is it
already there* — it loses completely, and that is not a gap better code closes.

---

## Part 2 — What is genuinely right

**The journal is the only truth, and the projections really are pure.** `state.json`, `tree.json`, and
`report.md` are folds over `JournalRecord[]` (`packages/core/src/projections.ts:89, 345, 381`). Delete
them and they rebuild.

**Edit-tolerant replay works, and the numbers are exact.** `examples/04-resume-and-replay`:

```
run 6d195cc5:       3 provider calls, then suspended on a human
resume (unchanged): 0 provider calls, draw=0.805035
replay --dry:       hits=1 salvaged=0 diverged=[analyze]
resume (edited):    1 provider call → [scan@v1, analyze@v2, summarize@v1]
determinism:        draw identical across resumes → true
```

An unchanged resume costs nothing, rewording one step re-runs exactly that step, and `replay --dry`
predicted which one would diverge *before any model was called*. Temporal cannot do this at all; it
throws a nondeterminism error and makes you version the change by hand.

**Canonical hashing is done properly** — keys sorted recursively, `undefined` dropped
(`canonical.ts:12-26`), and the agent payload includes `{prompt, provider, model, effort, maxTurns,
timeoutMs, isolation, write}` (`ctx.ts:292-301`), so switching a step from Claude to Codex correctly
busts its cache. I expected this to be wrong. It is not.

**Failure accounting survives the failure.** Spend from a failed attempt is journaled on
`step.attempt` and recovered from the serialized error on `step.failed`, because the completion event
will never carry it (`replay.ts:186-207`). Almost nobody gets this right.

**USD accounting is honest about its own limits.** `reportsUsd` is a provider capability; Claude
reports `total_cost_usd`, Codex reports tokens only and is priced from a documented table. And when a
run has a USD-only ceiling, a provider that reports no cost, *and* no price entry for the model, weft
**refuses the dispatch** rather than silently charging $0 (`ctx.ts:445-458`). That is precisely the
case most systems get wrong.

**The write path is craft.** `capturePatch` force-stages in-scope ignored files, uses `--no-renames`
so a `git mv` out of scope decomposes into a checkable delete+add, and `--binary` so binary edits
survive (`packages/isolation/src/patch.ts:27-48`) — each with a comment explaining the failure it
prevents. Nothing else in the surveyed field can rebuild a working tree from its log on a fresh clone.

**Live scope enforcement.** `packages/provider-claude/src/gate.ts` intercepts `canUseTool` and denies
out-of-scope edits before they land. Codex CLI and Claude Code enforce per-*session* sandboxes; weft is
per-*step*, declarative, and checks the **result** as well as the attempts. I did not find another
system doing both halves.

**Defence in depth on determinism.** The AST rules are evadable by computed property access — this
gates clean:

```ts
const t = (globalThis as any)["Da" + "te"]["n" + "ow"]();
```

but the `node:vm` global replacement catches it at runtime with the right message:

```
failed  internal: Date.now() is unavailable in workflow code - use ctx.now()
```

The static rule is the cheap early check with a fix-it; the runtime replacement is the real fence.
That is the correct arrangement, and worth stating because the README undersells it.

**The gate's errors are better than most compilers':**

```
✗ .weft/workflows/tiny2.ts
  tiny2.ts:10:21  no-date-now  Date.now() is not allowed in workflow code
    fix: Date.now() is unavailable - use ctx.now()
```

Real source positions through an esbuild bundle, plus a fix-it.

**The HITL implementation is production-grade.** Per-request serialization so two concurrent answers
cannot both land (`engine.ts:1185-1218`), JSON-safety refused before journaling, routing to a
descendant run that actually owns the request, and "first standing answer wins" on replay with a
`human.rejected` event modelling the two-tier wire-schema/real-schema case. Decision *provenance*
(`answeredBy`) being first-class is, per the research, not something Restate, Trigger.dev, Inngest, or
Step Functions offer.

**The report is a genuine artifact** — Outcome / Changes / Checks / Ledger / Failures & drops /
Remaining risk / Next step, generated from the journal. Others produce transcripts; this is a record.

---

## Part 3 — Findings

### Finding 1 — BLOCKER: any budget ceiling silently destroys parallel fan-out

`Budget.reserveCall()` (`packages/core/src/budget.ts:151-186`) correctly identifies a real flaw in the
naive design Claude Code uses — N parallel calls all pass a nearly-dry check before the first charge
lands — and then **throws instead of waiting**:

```ts
if (samples === 0) {
  // No cost observed yet: calls probe ONE at a time so a parallel fan-out
  // cannot multiply an unknown cost past the ceiling.
  if (root.inflightCalls > 0) refuse("while an unpriced call is in flight");
}
```

`refuse()` throws `BudgetExceededError`; `ctx.parallel` turns it into a rejected `Settled`; `ctx.ok()`
drops it. On a **cold start** — every run's first fan-out — all lanes but one are refused regardless of
headroom. Measured with a 300 ms mock latency:

```
8-way fan-out, $500 ceiling, 0% consumed  ->  1/8 lanes survived (7 × budget_exceeded)
8-way fan-out, no ceiling                 ->  8/8 lanes survived
```

The refusal message shows the pool untouched:

```
budget cannot cover step w1 while an unpriced call is in flight
  (1 in flight; remaining tokens=1000000, usd=null)
```

**It inverts the stdlib.** `adversarialVerify` counts a failed refuter as a refute vote
(`packages/stdlib/src/adversarial.ts:117-119`) — defensible on its own ("a claim never survives because
nobody managed to check it") — so a budget refusal reads as a substantive refutation. With every
refuter fixture honestly returning `refuted: false`:

```
budget set     ->  survived 0/4, refuted 4/4
  reason: "refuter 1 failed (budget_exceeded): ... while an unpriced call is in flight"
no budget      ->  survived 4/4, refuted 0/4
```

The tool **fails closed into "everything was a false positive," which is indistinguishable from the
tool working.** That is the worst possible failure mode for a precision instrument. `judgePanel`
degrades the same way — 1 of 4 attempts reaches the judges.

On the repo's own flagship, run exactly as documented:

```
audit-and-fix, no budget   ->  found 3 findings, 3 survived refutation
audit-and-fix, --budget $50 ->  found 1 finding,  1 survived refutation
```

Two of three requested directories are never audited. The run reports success.

**Why 610 tests miss it:** nothing crosses a budget with a wide fan-out. `examples/05` avoids the
intersection *explicitly* — `{ concurrency: 1 }, // serialize so the budget cliff is deterministic`
(`examples/05-sub-workflows-and-budget/main.ts:47`). The symptom was observed and worked around at the
example layer rather than fixed at the gate.

**Stated fairly:** the drops *are* journaled and appear under "Failures & drops" in `report.md`. They
are not invisible. But the workflow's control flow has already consumed the truncated result.

**Fix.** Every production engine in the survey treats a limit as a *scheduling constraint, never an
error* — Inngest queues, Temporal backpressures on the task queue, Trigger.dev holds runs queued.
`reserveCall` should **await** a slot while budget remains and refuse only at `remaining <= 0`. Weft
already has the primitive: `Semaphore` (`packages/core/src/limiter.ts`) is a FIFO counting semaphore
with abort support. Two independent follow-ups:

- `ctx.ok()` should distinguish an *engine refusal* from a *step failure*; the former is never a
  legitimate result.
- An errored voter should **abstain, not vote no**. Even with the budget fixed, a refuter that dies of
  a timeout or an API error still counts as a refutation. Fail-open on infrastructure, fail-closed on
  genuine uncertainty.

---

### Finding 2 — MAJOR: a salvage cache hit can lie

The README's guarantee is "a cache miss re-runs rather than lying." The failure mode is not a miss; it
is a **wrong hit**.

Step identity is `sha256(kind + canonical(payload) + schemaJson + key)` (`canonical.ts:35`,
`runtime.ts:431`). `key` is documented as optional — "Auto `Phase/agent#N` if omitted"
(`sdk/types.ts:45`) — but that auto value is a **label**, and labels are not hashed. Two agent steps
with the same prompt and schema and no explicit key are therefore *the same step* to replay. The world
is not in the hash, and agent steps are impure by construction: they read the repository.

Confirmed against the engine:

```ts
// v1
const before = await ctx.agent("what colour is the build?", { schema: S });
worldState = "GREEN";                    // the fix lands
const after  = await ctx.agent("what colour is the build?", { schema: S });

// v2 — the author deletes the pre-check. An ordinary edit.
worldState = "GREEN";
const after  = await ctx.agent("what colour is the build?", { schema: S });
```

```
RUN 1 (v1)          -> {before:"RED", after:"GREEN"}   provider saw ["RED","GREEN"]
RUN 2 (v2, resumed) -> {after:"RED"}    <-- served the PRE-fix entry
```

Distinct explicit keys fix it completely (also confirmed: `after` → `"GREEN"`). So the mechanism is
sound; **the default is the unsound path.** `key` is load-bearing for *correctness* and documented as a
convenience.

Two aggravating factors:

- **Salvage consumes in journal order, not program order.** `byHash.find(e => !e.consumed && e.kind === kind)`
  (`replay.ts:236-240`) searches the whole journal, so a later call site can consume an earlier twin's
  entry. Weft already warns on *duplicate explicit* keys (`runtime.ts:433-435`: `duplicate step key
  "X" — give each call a unique key for exact replay identity`) — the omitted-key case, which is the
  dangerous one, gets no warning.
- **The hash uses the *wire* schema, not the real one.** `hashStep(..., spec.schemaJson, ...)` where
  `schemaJson` is `toWireSchema(schema).json`. For any non-Zod Standard Schema that is a fixed
  permissive wrapper — `{type:"object", properties:{value:{}}, required:["value"]}`
  (`jsonschema.ts:59-61`) — identical for *every* non-Zod schema. So under Valibot or ArkType the
  collision widens from "same schema" to "any two steps with the same prompt."

**Why this matters more here than elsewhere.** In Temporal a mismatched memo usually surfaces as a
deserialization crash. In weft the salvaged value is a schema-valid LLM answer, indistinguishable from
a correct one. The blast radius is worse precisely because the payload is unverifiable.

**Context, in weft's favour:** its real peer here is Inngest, not Temporal. Inngest already shipped the
edit-tolerant thesis and built a product on it, using `stepID + counter` memoization. The philosophy is
validated; what is unique to weft is making the name *optional*. Inngest supplies exactly the two
pieces weft lacks — a stable name and an occurrence counter.

**Fix, cheapest first:**

1. Fold a **positional occurrence index** into the hash when `key` is omitted. `@weft/gate` already
   produces a source map, so a source-position-derived auto-key is available.
2. Constrain salvage so a consumed entry cannot precede the consumer's program-order position.
3. Warn in `weft check` when two `ctx.agent` call sites can produce the same hash.
4. Prefer `schema['~standard'].jsonSchema` over `isZodSchema` in `toWireSchema`. **Verified locally:
   the Zod 4.4.3 already in this lockfile exposes `~standard.jsonSchema`.** This is roughly thirty
   lines, and it simultaneously gives non-Zod users a real wire schema, gives `hashStep` a real
   fingerprint, and lets `@weft/core` drop its direct Zod import.
5. Longer term, take the Bazel lesson: let a step declare `reads:`, enforce it in `canUseTool` exactly
   as `write:` already is, and hash the git tree-hash of the matching files into the key. Weft
   currently sits *below* Turborepo on cache-key soundness — an agent step declares no inputs at all,
   while its real inputs are the prompt, the whole working tree it can grep, its tool surface, and
   model nondeterminism. Only the prompt is in the hash. (Prefect's default cache policy includes the
   flow-run ID for exactly this reason; a run-scope component with cross-run salvage as explicit
   opt-in would be a cheap intermediate step.)

---

### Finding 3 — MAJOR: the replayer is not a pure function of the journal

`OrderedDelivery` (`replay.ts:281-400`) delivers cached completions in journaled order while replay is
"pure," and breaks a stall with a **wall-clock quiescence watchdog**: a 50 ms timer, two consecutive
quiet checks, then skip the cursor forward.

```ts
this.watchdog = setTimeout(() => {
  ...
  if (this.lastProgress === seen && this.inflightLive() === 0) {
    this.quietChecks++;
    if (this.quietChecks >= 2) { /* skip forward */ }
  }
}, 50);
```

Two replays of the same journal on machines of different speed can therefore release parked deliveries
in different orders, and so assign different `seq` numbers — which changes fast-path matching on the
*next* resume. Every engine surveyed makes replay a pure function of the history; weft's depends on
timing.

**Severity, stated fairly:** this degrades to content-addressed salvage, which still matches by hash,
so the practical consequence is a reduced fast-path hit rate and nondeterministic `seq` numbering
rather than wrong answers. It becomes serious only in combination with Finding 2. The watchdog is
solving a real problem (an edited script that never requests the expected order must not deadlock);
the fix is to make the stall condition structural — no live dispatch in flight *and* no parked
delivery can be satisfied — rather than temporal.

---

### Finding 4 — MINOR: gaps in the determinism fence

Neither the AST rules nor the `vm` global replacement covers locale or GC-timing primitives. This
workflow gates clean **and runs to completion**:

```
{ "locale": "1.000,5", "sorted": "aäz", "weak": true, "fin": true, "tz": "UTC" }
```

`toLocaleString`, `localeCompare`, `Intl`, `WeakRef`, `FinalizationRegistry`, and the ambient timezone
are all reachable. Temporal explicitly replaces `WeakRef`/`FinalizationRegistry` with throwers because
v8 GC is non-deterministic.

Practical impact is mostly cost, not correctness: an ICU or timezone difference changes prompt text,
which changes the hash, which re-runs the step. The genuine nondeterminism vector is the GC pair.
Also unfenced: `Promise.race`/`Promise.any` over two `ctx` steps is resolved by wall clock — Cloudflare
Workflows explicitly tells you to wrap `Promise.race()` inside a step for this reason.

---

### Finding 5 — MINOR: four README claims the source does not support

1. **"`schema` is required on `agent`, `human.*`, `check`, and workflow I/O."** `CheckOptions`
   (`sdk/types.ts:359-374`) has no `schema` field.
2. **"`@weft/gate` … unawaited-promise check."** No such AST rule exists. `gate/src/rules.ts` enforces
   exactly eight: `no-bare-import`, `no-date-now`, `no-math-random`, `no-process-env`,
   `no-argless-date`, `no-timers`, `no-global-fetch`, `no-require`. The unawaited-promise handling is a
   *runtime* hint when a workflow **returns** a promise (`core/test/engine.test.ts:289`). A floating
   `ctx.agent(...)` mid-body is caught by neither — it dispatches, charges budget, and consumes a seq.
3. **"`@weft/isolation` | Worktrees, patch capture, scope checks, 3-way merge, conflict handling."**
   That package is 228 lines total (`scope.ts` is 23). The merge and conflict handling live in
   `core/ctx.ts:2023-2100`.
4. **"never prose and never `null`."** `AgentOptions.onError: "null"` exists, and `ctx.exec`/`bash`/
   `fetch` without a schema return raw strings. More importantly, `z.object({ summary: z.string() })`
   *is* a free-text channel that merely acquired a field name. The defensible claim is that **the
   plumbing between steps is typed**, not that prose was eliminated.

The README already has a "Status and honest deviations" section listing five real gaps — exactly the
right instinct. These belong in it.

---

## Part 4 — Architecture: what is structurally wrong

**`ctx.ts` is a god object.** 2,361 lines owning the authoring surface *and* agent dispatch, worktree
lifecycle, ignored-file manifests, patch application, three-way merge, conflict resolution, check
execution, the integration ledger, signals, and notes. With `engine.ts` (1,657) that is 12% of the
codebase in two files, and it is where the seams the package table promises were not cut. The natural
splits are visible from the payload constructors: agent dispatch, the write/patch/integrate pipeline,
and the effects (`fs`/`exec`/`bash`/`fetch`/`env`) are three modules wearing one coat.

**16 packages for 33.6k lines is premature.** Several are thin, the boundaries do not hold (the merge
lives in core), and since nothing is published the granularity buys no consumer-facing modularity —
only `workspace:*` bookkeeping and a package table that overstates what each package owns.

**`provider-claude/src/tools.ts` is a 576-line hardcoded mirror of another product's tool names.**
Careful work, but coupled to an undocumented, unversioned surface that will drift. The pin comment on
`index.ts` covers the *SDK*; nothing covers this list. It needs a conformance test or a fail-closed
fallback on unrecognised tools.

**No `ContinueAsNew`, no compaction, no retention, no documented ceiling.** Resume is O(total steps)
and paid per suspension. Per the research the wall is far away for this domain — roughly 10k–20k steps
and 50–100 suspend/resume cycles, two to three orders of magnitude past a realistic coding workflow —
but Temporal added `ContinueAsNew` precisely to cap history growth, and Golem pairs its oplog with
state snapshots. The honest criticism is not "it won't scale" but that the ceiling is undocumented.

**No corpus replay gate.** Temporal ships `Worker.runReplayHistories()` and tells you to bulk-replay
recent production histories in CI. Weft has the *better* primitive — `replay --dry` prints
hits/salvaged/diverged before a model is called — but it is manual and per-run, not an assertion
exported from `@weft/testing`. This is the single cheapest way to have caught Finding 2.

**What the journal-derived tree does not recover.** Weft is right that the graph should be code — that
argument is now consensus, not contrarian. But three things an explicit graph buys are genuinely
absent: a pre-execution topology and cost preview, fork-from-a-checkpoint without re-running the
program, and a reducer-merged shared state object a UI can subscribe to. The tree is *discovered by
execution*, so it can only show what already happened, and recovery from a checkpoint means
re-executing from line one and relying on journal hits — which is what makes Finding 2 load-bearing
rather than cosmetic.

---

## Part 5 — Publish readiness: currently zero

This is the most actionable section in the review, and none of it is about code quality.

- **There is no LICENSE file**, despite the README and all 16 manifests declaring MIT. That alone
  blocks adoption at any company with a license scanner.
- **No package has a `build` script.** Every one sets `exports` to `./src/index.ts` for both `types`
  and `default` — raw TypeScript, with `.ts`-extension relative imports inside.
- **No `files`, no `publishConfig`, no `repository`/`keywords`/`homepage`/`author`** in any manifest.
  Scoped packages default to restricted without `publishConfig.access`.
- No changesets, no release job in CI (CI runs lint, typecheck, test only).

So `npm i -g weft` cannot work today for structural reasons, not merely because nobody has pushed.

**And the name is taken.** Verified against the registry: `weft` on npm is *"NodeJS API Wrapper for
Google Web Fonts"*, v1.3.1, last published 2021-04-24. The README's documented install can never
resolve to this project under that name.

The good news, also verified: **`@weft/sdk` returns 404 — the `@weft` scope appears unclaimed.** So the
fix is not a rename. Publish scoped, ship `@weft/cli` with a `weft` binary, and change one README line
from `npm i -g weft` to `npm i -g @weft/cli`.

*Research-sourced and unverified by me:* several other AI-agent projects reportedly use the name
"weft" on GitHub, the largest with positioning close to this one. Worth checking before investing in
the brand; I could not confirm it from here.

---

## Part 6 — Developer experience

### Good

The smallest useful workflow is genuinely small, and input fields become CLI flags automatically.
`weft new` scaffolds, `weft check` gates before you spend a cent, `weft doctor` actually diagnoses
(`no ANTHROPIC_API_KEY — run 'claude login' or export the key`). The verb set is right, and two verbs
are things I have wanted in every other system in this space and found in none: `replay --dry`
("how much of this run survives, and where does it start costing money again") and `diff <a> <b>`.

The stdlib is better than the inline patterns it competes with. `adversarialVerify` uses a strict
majority so an even panel does not kill on a tie; `judgePanel` uses best-votes with mean-score
tiebreak "so a single generous judge cannot carry a weak attempt," and pins the judge's schema to the
exact attempt count so a wrong-length score array gets repaired.

### Friction

**A missing `schema` produces the ugliest error in the API** — and it is the most common first mistake:

```
error TS2769: No overload matches this call.
  Overload 1 of 2, '(prompt: string, opts: AgentOptions<AnySchema> & { onError: "null"; }): Promise<any>', gave the following error.
    Argument of type '{ key: string; }' is not assignable to parameter of type 'AgentOptions<AnySchema> & { onError: "null"; }'.
      Property 'schema' is missing in type '{ key: string; }' but required in type 'AgentOptions<AnySchema>'.
  Overload 2 of 2, ...
```

The real message is buried under overload noise and a widened `AnySchema`. The `onError: "null"`
overload being listed *first* is what makes it two errors instead of one. Split `agent`/`agentOrNull`
rather than overloading on an option value.

**A mistyped input flag is silently accepted and runs the wrong thing.** `parseDynamicFlags`
(`cli/src/flags.ts:12-35`) accepts any `--name value`; Zod strips unknown keys; the engine validates
without strictness:

```
$ weft run review --basse release-2.0
parsed flags: {"basse":"release-2.0"}
>>> workflow ran with base = "main"
```

Weft spends real money reviewing the wrong branch without a word. The engine has the input schema in
hand; warning on unrecognised keys is a few lines.

**Input flags are undiscoverable.** `weft run review --help` lists `--args`, `--budget`, `--reuse`,
`--watch` — not `--base`, the flag the workflow actually takes. There is no `weft describe`. Rendering
the input schema into `run --help` closes this and the typo gap together.

**`ctx.ok(await ctx.parallel(...))` is correct ceremony that reads badly**, and it is in every example.
`ctx.parallel.ok(...)` would keep the semantics and lose the nesting.

**`key` is under-sold.** Given Finding 2 it is a correctness feature documented as a convenience.

**One-week-in wishlist:** `--json` on `ls`/`status`/`report` (scripting weft into CI currently means
parsing terminal output); a cost *estimate* on `replay --dry`, not just a divergence list; tail/follow
a running step; re-run one step by key; cost breakdown by phase.

---

## Part 7 — The cross-vendor pitch needs rework

Weft's flagship example is "Claude finds, Codex refutes." Three problems, in increasing order of
seriousness.

**The panel is not actually cross-vendor in its decisive case.**
`PANEL = ["claude", "codex", "claude"]` with a `>= 2` majority (`audit-and-fix.ts:15, 53`). Two Claude
seats and a threshold of two means Claude alone carries a verdict and Codex's vote is never decisive.
The workflow is only an example and the fix is one line, but the marketing claim rests on it.

**The refuter is anchored on the finder's framing.** Both `review.ts` and `audit-and-fix.ts` pass
`f.evidence` straight into the refuter's prompt. The published work closest to this design
(*Refute-or-Promote*, per the research) deliberately gives the adversarial track **only the claim and
not the advocate's reasoning**, precisely to prevent that anchoring.

**The empirical claim is weaker than stated.** Find-then-verify is now the industry-standard
architecture, not a differentiator — Anthropic's own managed code review, CodeRabbit, and Ellipsis all
run parallel finders into a verification/dedupe stage, and Ellipsis already does it across vendors.
Self-preference bias in LLM judges is real and quantified, which establishes weft's *premise* that a
same-model verifier is a biased instrument — but on preference benchmarks, not defect detection. Read
together, the available evidence suggests most of the precision win comes from *having a refutation
gate at all*, not from *whose model runs it*. No one has published the leave-one-out ablation.

The defensible version of the pitch is therefore: **weft makes the refutation gate a typed, journaled,
replayable part of the program, and lets you swap the vendor if you want to.** That is true and
valuable. "Cross-vendor verification catches what single-vendor misses" is currently unproven, and
weft's own example does not implement it faithfully.

One more thing worth saying out loud rather than hiding: weft's Claude adapter serves a *terminating*
`structured_output` tool, so the agent reasons freely across turns and serializes once at the end. Per
the research, the current synthesis on the structured-output "format tax" is that it is
capacity-dependent and largely recovered by "think first, format later" — which is exactly what this
design does. Weft is already on the right side of that literature and does not claim the credit.

---

## Part 8 — Recommendations

### Now — before anyone else runs this

1. **Fix `reserveCall`**: await a slot while budget remains; refuse only at `remaining <= 0`. Add the
   regression test that crosses a budget with a wide parallel fan-out.
2. Make an errored voter **abstain** in `adversarialVerify`, and have `ctx.ok()` distinguish an engine
   refusal from a step failure.
3. Fold a positional occurrence index into the step hash when `key` is omitted; constrain salvage to
   program order.
4. **Add a LICENSE file.**
5. Correct the four README claims, or move them into "honest deviations."

### Next

6. Prefer `schema['~standard'].jsonSchema` over `isZodSchema` in `toWireSchema` (~30 lines; the Zod
   already in the lockfile supports it). Fixes non-Zod wire schemas and the non-Zod hash collision at
   once.
7. Make `OrderedDelivery`'s stall condition structural rather than a 50 ms wall-clock watchdog.
8. Export a **corpus replay assertion** from `@weft/testing` — bulk `replay --dry` over saved journals
   as a CI gate. This is how Finding 2 gets caught next time.
9. Publish readiness: build scripts, `files`, `publishConfig.access`, `repository`, changesets, a
   release job. Ship as `@weft/cli`; change the README's `npm i -g weft`.
10. Warn on unrecognised input keys; render the input schema into `weft run <name> --help`.
11. Split `agent`/`agentOrNull`; add `--json` to `ls`/`status`/`report`.
12. Fix `audit-and-fix.ts`: a genuinely cross-vendor panel, and withhold the finder's evidence from
    the refuter.

### Later

13. Declared `reads:` inputs per step, enforced in `canUseTool` and hashed as a git tree-hash — the
    Bazel lesson, and the real fix for cache soundness.
14. Split `ctx.ts` along its three visible seams.
15. Fence `WeakRef`/`FinalizationRegistry`; document the `Intl`/locale and `Promise.race` caveats.
16. Document the journal ceiling, and consider a snapshot/compaction event.

### Cut

17. Collapse `@weft/isolation` into core and make `@weft/index-sqlite` a flag. Ship fewer, honest
    packages.
18. Stop leading with orchestration. The fan-out surface is commoditised and the README spends its
    best real estate defending it. Lead with the write model and the audit record — the parts nobody
    else has.
