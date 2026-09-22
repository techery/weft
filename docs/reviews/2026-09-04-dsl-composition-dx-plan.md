# Weft: DSL, composition, developer experience, and improvement plan

Reviewed 2026-09-04 at `7fe75e96a9de66143005d392ce6d554b7b98de1e`.

Scope: executable SDK and engine, declaration-only DSL prototype, repository workflows, examples, authoring and testing tools, supplied Orca research, and current primary documentation for adjacent products. This is an analysis and implementation plan; it does not implement the recommendations.

Implementation follow-up: [implemented changes and validation](2026-09-04-implementation.md). The findings and line references below describe the reviewed baseline commit, not the subsequently modified checkout.

## 1. Recommendation

Make Weft the dependable way to turn a repeatable coding task into a verified, reviewable outcome. Its strongest foundation is the combination of schema-validated agent handoffs, recorded execution, explicit patch integration, durable human decisions, and provider-independent orchestration.

The next investment should connect those mechanisms into one supported authoring and delivery path. The repository currently has a capable executable SDK, a substantially different future DSL, and examples that do not consistently demonstrate the strongest available behavior. More declarations alone will increase the distance between the product users can run and the product the design describes.

Prioritize these changes:

1. Correct the existing workflow examples, check replay behavior, and misleadingly green test paths.
2. Specify a small composition contract, including identity, recovery, cancellation, and context authority.
3. Implement one complete issue-to-reviewed-PR workflow with persistent workspace ownership and verification tied to the exact candidate.
4. Migrate authoring incrementally and expose actionable recovery and delivery state through the existing CLI, MCP, and manager.
5. Expand integrations and orchestration patterns after the complete path survives failure and resume tests.

This is a recommendation about sequencing, not a proposal to replace the existing engine.

## 2. Evidence boundaries

| Evidence | What it establishes | What it does not establish |
| --- | --- | --- |
| Current Weft source, CLI inspection, selected tests, and model-free reproductions | Actual authoring contracts and bounded runtime behavior at the reviewed commit | Production reliability, model quality, fresh-install success, or published package availability |
| `packages/dsl-proto` declarations and compiler fixtures | Proposed API relationships that TypeScript can check | Workspace enforcement, authentic evidence, effect recovery, or any executable prototype runtime |
| `docs/competitors/orca` | A supplied static teardown of Orca v1.4.197 at commit `637dc30a3211ec0667c55118a4d17edbee5cff80` | Independently executed Orca behavior or a benchmark against Weft |
| Current official competitor documentation | Documented product and API models | Verified implementation quality or comparative performance |

The prototype explicitly has no runtime exports: [PROTOTYPE.md](../../packages/dsl-proto/PROTOTYPE.md), lines 1–4 and 29–30; [package.json](../../packages/dsl-proto/package.json), `exports` and `publishConfig`. The Orca research states its static method and limitations in [its README](../competitors/orca/README.md), lines 9–13 and 110–117.

Older architecture reviews were used as context, then checked against current source. Their fixed findings are not automatically current defects.

## 3. What is worth preserving

**Ordinary TypeScript controls orchestration.** Branches, loops, typed transformations, and reusable functions remain familiar. Effects go through `ctx`; authors do not need to encode every local calculation as a graph node.

**The runtime is shared.** The CLI, daemon, and MCP surfaces build on the engine rather than defining different workflow semantics. The journal supports reconstruction of execution state and reports. Maintain that separation as the product grows.

**Schema validation is an actual boundary.** Reusable prompts, agents, recipes, checks, and workflow inputs/outputs have executable validation. Keep Standard Schema input/output transformations intact; raw input and validated output are not always the same TypeScript type. Provider output remains untrusted until the engine validates it.

**Patch-producing work is explicit.** Write steps, scope handling, integration, and dangling-patch rejection are materially useful coding abstractions. Ending a run with an unintegrated, undiscarded patch fails at [engine.ts:1082](../../packages/core/src/engine.ts#L1082). These are stronger semantics than merely launching a worker in a worktree.

**Replay already handles difficult cases.** The engine combines body and optional bundle hashes to decide whether positional replay remains trustworthy, and child runs re-enter their own journals instead of permanently caching a parent's child result. See [engine.ts:181](../../packages/core/src/engine.ts#L181), [engine.ts:622](../../packages/core/src/engine.ts#L622), and [ctx.ts:1718](../../packages/core/src/ctx.ts#L1718).

**There is a real testing and inspection foundation.** `weft check`, workflow contract inspection, the mock provider, fixture-backed engine execution, human inputs, and journal assertions are already useful. Improve their defaults and coverage before inventing a separate testing system.

### Existing usage patterns worth building on

| Actual workflow | Composition and outcome | What it teaches |
| --- | --- | --- |
| `audit-and-fix` | Discover → cross-provider refute → policy gate → isolated writers → integrate → required tests | Coding effects need integration and verification semantics; this example needs the identity/completeness corrections below |
| Task-backed code review | Snapshot source → bounded review → semantic deduplication → independent refutation → human selection → persistent task upsert | Transient analysis and durable engineering work should have different lifetimes. Only accepted findings enter the backlog |
| Composable review, example 11 | Reusable prompts/roles, schema-backed recipes, scoped policy, check suite and human step | Much of the desired reuse already works in the SDK; use this as the current teaching pattern |
| Coverage and agent-skill maintenance | Author/integrate/check/review/repair loops | Extract shared integration assertions, error aggregation and repository policy; retain independently visible effects |

The task-backed example is especially strong: it uses semantic fingerprints, withholds task context from the independent refuter, lets humans select accepted findings, and retains occurrence provenance across runs. See [task-backed review:89](../../examples/08-task-backed-code-review/task-backed-code-review/main.ts#L89), lines 150–207 and 246–317. Its behavior tests cover deduplication, rejected findings and reviewer failures in [todo-code-review.test.ts](../../packages/testing/test/todo-code-review.test.ts). Those tests should travel with the workflow package.

The larger maintenance workflows repeat the same integration/repair mechanics: [maintain-agent-skill:261](../../.weft/workflows/maintain-agent-skill/main.ts#L261) and [ensure-code-coverage:379](../../.weft/workflows/ensure-code-coverage/main.ts#L379). Extract existing patterns before introducing more general-purpose builders.

## 4. Findings, in priority order

### F1. Successful runs can conceal incomplete reviews

The repository's `review` workflow passes both discovery and refutation through `ctx.successes`. Its output contains only `confirmed`, without a coverage or completeness field. Agent failures are recorded in the journal, but the workflow may still complete with an empty list. Distinct findings at the same file and line also share `refute:${f.file}:${f.line}`.

Two model-free reproductions against the actual workflow established:

- One changed file and an unavailable agent fixture produced `status: complete` with `{ confirmed: [] }`.
- Two findings at the same location produced only one confirmed finding and a journaled drop for `duplicate step key "refute:a.ts:3"`.

The engine correctly refuses duplicate keys; the workflow then converts that refusal into a partial result. This is an authoring and output-contract problem, not evidence that the journal loses the failure.

The `audit-and-fix` workflow repeats the issue with `fix:${f.file}`. Its final `fixed` calculation also matches by that file-level key, so the correspondence between an individual finding and its actual fix is too weak. Sources: [review/main.ts:23](../../.weft/workflows/review/main.ts#L23), [review/main.ts:44](../../.weft/workflows/review/main.ts#L44), [audit-and-fix/main.ts:73](../../.weft/workflows/audit-and-fix/main.ts#L73), [audit-and-fix/main.ts:99](../../.weft/workflows/audit-and-fix/main.ts#L99).

**Change:** use required fan-out by default for exhaustive reviews. Deliberately partial analysis must return requested/completed/failed coverage and a partial outcome. Give findings stable semantic identities. For edits, group related findings by conflict domain, usually file or package, and execute one coherent change per group; adding unique keys alone does not resolve overlapping edits.

### F2. Reusable check replay does not establish fresh verification

Reusable callback checks disable the legacy callback's forced re-execution safeguard even when no `revision` is provided. Their replay payload contains the check identity and optional revision/input hash, but not the callback's executable semantics or a mandatory code candidate.

Reproduction: run `defineCheck({ name: "quality", run: () => true })`; reopen the engine over the same journal; resume with the same invocation key and a new definition whose callback returns `false`. The observed result remains `pass`, and the callback runs only once across both executions.

The code explicitly explains why legacy closures must not be replayed blindly, then applies that safeguard only when `definitionMeta === undefined`. Sources: [ctx.ts:2625](../../packages/core/src/ctx.ts#L2625), [ctx.ts:2699](../../packages/core/src/ctx.ts#L2699), [ctx.ts:2883](../../packages/core/src/ctx.ts#L2883); optional revision in [composition.ts:164](../../packages/sdk/src/composition.ts#L164).

Even a mandatory check revision would solve only part of the problem: unchanged check code can inspect changed repository contents, dependencies, or external state.

**Change:** distinguish a recorded historical check result from a current candidate attestation. Cache reusable checks only with adequate declared inputs and semantic identity. Require candidate binding for verification used to authorize delivery, and revalidate freshness at that boundary. Until then, re-run checks whose relevant inputs cannot be established.

### F3. Required checks are terminal failure bookkeeping, not promotion gates

A failing required check appends its name to a run-wide failure list. A later passing check does not supersede it. The engine rejects the run at completion. Workflow code can still execute subsequent effects before that final rejection.

A model-free reproduction observed `fail`, then `pass`, then a later journaled effect executing, followed by `required check(s) failed: quality`. Sources: [ctx.ts:2638](../../packages/core/src/ctx.ts#L2638), [engine.ts:1090](../../packages/core/src/engine.ts#L1090). The reference documents the completion failure; this is a design limitation rather than hidden behavior.

**Change:** separate diagnostic attempts from final candidate gates. Keep failed attempts as evidence, allow a new candidate to supersede an earlier candidate's verification, and require passing current proofs immediately before promotion. Do not reinterpret existing `required` semantics silently. Initially, repair loops can use explicit diagnostic results followed by a final required check.

Waivers also need a distinct contract. Current invocation-level waivers can produce `status: "pass", disposition: "waived"`; issue and expiry information are formatted as evidence rather than enforced as an eligibility policy. See [ctx.ts:2751](../../packages/core/src/ctx.ts#L2751) and [ctx.ts:2864](../../packages/core/src/ctx.ts#L2864). Preserve the underlying failing verdict and represent an authorized exception separately, with candidate, scope and expiry. Do not migrate an old waived pass into a normal verification proof. The prototype already distinguishes these at [checks.ts:217](../../packages/dsl-proto/src/core/checks.ts#L217).

### F4. There are two different composition languages

| Concern | Executable SDK | Prototype | Decision needed |
| --- | --- | --- | --- |
| Agent result | Value by default; `.detailed` for metadata | Receipt with `.value` | Prefer the current value default for read calls; explicitly request receipts when change ownership or evidence is needed |
| Parallel work | `parallel`, settled arrays, `all`, `successes`, error option | `parallel.all` / `parallel.settled`, lane context and `keyOf` | Adopt explicit outcome modes and stable lane identity |
| Same-run reuse | Functions, schema-backed recipes; deprecated steps | Functions and revisioned procedures | One supported named boundary with explicit replay semantics |
| Organization | Phase, scope, pipeline, sequence | Scope for defaults; ordinary control flow | Separate presentation, identity, and execution policy |
| Delivery/workspace | Step worktrees, patches, explicit Git operations | Owned workspace, snapshots, proofs, delivery receipts | Runtime implementation, not an API rename |
| Task lifetime | Persistent workflow-scoped records with semantic revision/migration | Run-scoped tasks without author-managed migration | Preserve persistent backlog semantics; make any separate ephemeral task surface explicit |

Sources: [SDK types](../../packages/sdk/src/types.ts), especially lines 378–466 and 1029–1089; [prototype overview](../../packages/dsl-proto/PROTOTYPE.md), lines 32–59.

The prototype removes several composition concepts but introduces a large domain vocabulary. Its issue-to-reviewed-PR example is 567 lines including schemas, policy, definitions, and orchestration. Length alone is not a defect, but it shows why reusable policy packs and progressive disclosure matter. Do not make every workflow author restate repository rules, check definitions, provider wiring, and delivery schemas.

**Change:** retain a small teaching surface and expose advanced contracts by need. Avoid a simultaneous rewrite of every workflow and every provider.

One immediate composition limitation is namespace ownership: current recipes re-enter their bodies but have no invocation key. Calling the same recipe twice with an identical internal effect key collides with the run-global duplicate check. Authors currently thread prefixes through domain inputs. A procedure/lane namespace should remove that plumbing without hiding nested effects. See [ctx.ts:3740](../../packages/core/src/ctx.ts#L3740) and [example recipe:37](../../examples/11-composable-workflow/composable-review/lib/recipes.ts#L37).

### F5. Whole-procedure caching is the wrong default for effectful composition

The prototype explicitly says replay returns a recorded procedure result instead of re-entering its body. Its example body includes Git and command effects. That outer cache can bypass the nested steps' freshness checks and recovery behavior.

This is a concern with the proposed semantics, not an executable prototype defect. The current child-workflow implementation already demonstrates the safer principle: re-enter the child and let its own journal decide which leaves can be reused.

Sources: [PROTOTYPE.md:65](../../packages/dsl-proto/PROTOTYPE.md#L65), [PROTOTYPE.md:83](../../packages/dsl-proto/PROTOTYPE.md#L83), [procedures.ts:103](../../packages/dsl-proto/src/core/procedures.ts#L103), [ctx.ts:1718](../../packages/core/src/ctx.ts#L1718).

**Change:** make a procedure a named, schema-validated same-run boundary with a local key namespace and trace. Re-enter its body on resume; replay or reconcile its individual effects. Permit aggregate memoization only for explicitly pure, fully bound computations or a separately specified composite-validity protocol.

### F6. Generic effect journaling is not external-effect recovery

`runStep` records scheduling, executes the effect, then records completion. A crash after a remote action succeeds but before completion is durable leaves an uncertain result. Generic `exec` does not provide a universal reconciliation protocol. Some Git/integration operations have targeted postcondition checks, which should be preserved; they do not make arbitrary commands or remote mutations exactly once.

Sources: [runtime.ts:832](../../packages/core/src/runtime.ts#L832), [runtime.ts:892](../../packages/core/src/runtime.ts#L892), [ctx.ts:1810](../../packages/core/src/ctx.ts#L1810). Current run states have no general recovery-required state: [events.ts:15](../../packages/core/src/events.ts#L15).

**Change:** add a bounded external operation protocol: persist intent and request identity, execute, reconcile uncertain outcomes, then persist a receipt. Distinguish step identity from remote request identity and validate payload equality on retries. Unknown outcomes must expose inspect/reconcile actions and remaining resources. A retry count alone is insufficient for push, PR creation, release, or deployment.

### F7. Green tooling does not yet imply meaningful workflow validation

`weft check` passes all four repository workflows. Their default `weft test` run executes four description-only tests, one per workflow, and passes. Neither catches F1.

`weft test` also selects a hardcoded `.weft/workflows` pattern instead of deriving tests from registered extra workflow roots. An invocation under `examples` with an extra workflow directory exits successfully with zero tests. Source: [test.ts:17](../../packages/cli/src/commands/test.ts#L17), [test.ts:35](../../packages/cli/src/commands/test.ts#L35).

The harness deliberately falls through to real effects when fixtures do not answer. This is documented in [fixtures.ts:1](../../packages/testing/src/fixtures.ts#L1) and implemented at lines 75–103. Thus “no model” does not imply “no external effects.”

**Change:** make test discovery use the registry; report discovered workflow/test counts; fail on an unintended empty selection. Provide strict fixture mode, default it for newly scaffolded workflow tests, and require explicit permission for real effects. Test outcomes and failure paths, not only metadata. Retain an explicit integration-test mode.

### F8. Context requirements need to be visible to both types and the host

Production `defineRecipe` receives `Ctx<any, any>`, which loses task-extension specificity and does not express minimum capabilities. The prototype's contravariant procedure requirement is a useful improvement. Sources: [composition.ts:133](../../packages/sdk/src/composition.ts#L133), [procedures.ts:11](../../packages/dsl-proto/src/core/procedures.ts#L11).

**Change:** type reusable bodies against the capabilities they need and preserve schema input/output types. Distinguish read context, writable workspace context, and operation authority. Enforce those boundaries in the host and provider adapters as well: a TypeScript brand or `Pick` is not a sandbox, and a worktree is not a security boundary. Test each supported provider's actual enforcement contract.

### F9. Documentation needs release-specific entry points

The code and docs do label the prototype, but the generated authoring skill introduces a long prototype reference before returning to executable SDK guidance. That creates unnecessary selection work for both humans and coding agents. See [skill.ts:92](../../packages/cli/src/commands/skill.ts#L92), line 99 onward, and line 490.

**Change:** generate a runnable SDK guide by default; expose preview and advanced domains explicitly. Compile runnable snippets, link them to tests, and derive CLI command schemas and API inventories from their implementations. Keep “implemented in this checkout,” “published,” and “proposed” as separate statuses. Resolve the README's pre-release installation note through a release audit rather than assuming it is current or stale.

A small concrete documentation defect supports executable snippet checks: [README.md:483](../../README.md#L483) introduces Node `assert`/`test`, while the following example calls unimported `expect` at line 503. Fix it with the relevant onboarding test rather than a text-only coverage assertion.

### F10. Task lifetime is a product decision hidden inside the API migration

Current tasks persist across runs under workflow identity, with semantic revision and migration rules. The prototype explicitly makes tasks run-scoped and removes author-managed version/migration chains: [PROTOTYPE.md:186](../../packages/dsl-proto/PROTOTYPE.md#L186), [tasks.ts:139](../../packages/dsl-proto/src/core/tasks.ts#L139).

This is not equivalent behavior with cleaner syntax. The task-backed review's deduplication, recurrence and first-seen provenance rely on persistent logical tasks. Migrating it blindly would erase an important usage pattern even if all new type fixtures passed.

**Change:** keep persistent engineering work as a supported first-class contract. If ephemeral run tasks are useful, distinguish their ownership and retention explicitly. Decide storage/contract migration before changing public names. Include two successive runs against the same logical finding in migration acceptance tests.

## 5. Target composition contract

The distinction authors need is ownership and replay behavior, not the number of builders.

| Construct | Owns | Resume rule | Intended use |
| --- | --- | --- | --- |
| Plain function | No independent durable boundary | Executes again as normal code; its `ctx` effects retain their own boundaries | Calculations and incidental reuse |
| `ctx.scope` | Inherited defaults | No independent cached result | Provider settings, budgets, concurrency defaults |
| Named procedure | Same-run namespace, schema boundary, trace | Re-enter body; replay/reconcile leaves | Reusable investigation or repair phase |
| Keyed parallel lane | Item identity and structured lifetime | Match by semantic item identity | Bounded fan-out; adding/reordering items preserves correspondence |
| Child workflow | Separate run, contract, lifecycle and lineage | Re-enter child's journal | Independent reusable job and operational boundary |
| Agent call | One provider execution and validated output | Reuse valid completion; report interrupted attempt separately | Nondeterministic reasoning or editing |
| External operation | Request identity, recovery and receipt | Reconcile before retry when outcome is uncertain | Push, PR creation, external mutation |

The last three rows must not be interchangeable shortcuts. A named function is not automatically a child run, and a journal key is not automatically an external idempotency key.

Use ordinary loops for sequential control flow. Keep the existing pipeline available during migration: its per-item progression can avoid stage-wide barriers. A single parallel callback containing several `await`s can express the same common pattern. Move convenience builders to optional helpers only after demonstrating equivalent behavior and acceptable performance.

Do not accidentally change parallel failure semantics. Current `parallel(..., { errors: "throw" })` waits for all lanes to settle ([ctx.ts:1581](../../packages/core/src/ctx.ts#L1581)); the prototype describes `all` as fail-fast ([composition.ts:32](../../packages/dsl-proto/src/core/composition.ts#L32)). Initially preserve settle-then-throw behavior. If an early-stop mode is introduced, specify admission, cooperative cancellation, draining, patch retention, and parent completion. Early rejection must never imply that writers have stopped.

Do not require durable keys on presentation-only logging. Require them on independently resumable boundaries, derive nested keys from procedure/lane identity, and reject duplicate semantic item keys before dispatch. Display the resolved path in diagnostics, for example `review / finding-42 / refute`.

## 6. Complete the coding lifecycle

The first complete delivery workflow should follow this sequence:

```text
Issue and acceptance criteria
  → owned branch/workspace
  → bounded implementation attempts
  → immutable candidate identity
  → checks + independent review against that candidate
  → candidate-bound authorization when policy requires it
  → reconciled push / PR creation
  → receipt with branch, commit, PR and evidence
  → CI/review feedback creates a new candidate and invalidates old proofs
```

The prototype already explores most of this in [issue-to-reviewed-pr.ts](../../packages/dsl-proto/src/examples/refined/issue-to-reviewed-pr.ts), especially lines 359–563. Use it as an executable acceptance scenario to build toward, not as a requirement to implement every declaration first.

The runtime should own these invariants:

- Workspace identity survives suspension and restart; ownership, leases, base revision, branch, and retained resources are explicit.
- A candidate identifies repository, workspace generation, tree, and relevant base/head. Validation records include check definition/revision, inputs, and declared environment dependencies.
- A code change invalidates previous candidate verification and authorization. Delivery checks current identity immediately before acting, including an expected remote head where relevant.
- Failed attempts remain visible but do not permanently invalidate a repaired candidate.
- Ambiguous remote success is reconciled before retry. A run reports what remains uncertain and which branch/worktree/PR exists.
- Cleanup respects unpushed changes, incomplete delivery, uncertain liveness, and retention policy.

Start with one local repository, one owned worktree, and GitHub PR delivery. Keep issue ingestion and organization-specific approval policy in adapters. A patch-only or review-only workflow remains a valid contract; the flagship delivery workflow should finish with a branch, commit, and PR receipt.

## 7. Competitor comparison and implications

These products overlap at different layers. Comparing feature counts would obscure the design decisions.

| Product | Relevant documented model | Implication for Weft |
| --- | --- | --- |
| Orca | Fleet, worktrees, sessions, task dispatch and acknowledged messaging; supplied teardown describes an LLM coordinator and mutation receipts | Borrow attention routing, explicit uncertain outcomes, request receipts, and workspace retention. Preserve Weft's executable plan and typed boundaries. [Local analysis](../competitors/orca/18-relevance-to-weft.md) |
| Agent Orchestrator | Git-backed workers and a work card joining task, agent, branch, PR, activity, CI and review | Make the delivered work item the product unit. A run tree should connect to the branch and PR lifecycle. [Official README](https://github.com/Untrivial-ai/agent-orchestrator/blob/main/README.md) |
| LangGraph | Both graph/subgraph APIs and a Functional API using entrypoints, tasks, normal branches and loops; persistence and interrupts | Ordinary code is useful but not unique. Explain state ownership, restart behavior, and the boundary between reusable helpers and durable children. [Functional API](https://docs.langchain.com/oss/javascript/langgraph/functional-api), [subgraphs](https://docs.langchain.com/oss/javascript/langgraph/use-subgraphs), [interrupts](https://docs.langchain.com/oss/javascript/langgraph/interrupts) |
| Inngest | Named durable steps, memoized successful results, workflow invocation, waits, and fixture-based testing | Teach identity, replay and testing together. Make reusable recipes demonstrably runnable. [Steps](https://www.inngest.com/docs/learn/inngest-steps), [testing](https://www.inngest.com/docs/reference/typescript/v4/testing) |
| Trigger.dev | Task invocation, batch waiting, wait tokens and process checkpointing | Provide clear fan-out and wait primitives, with runtime restrictions up front. Its documented checkpoint model differs from Weft's history replay. [Triggering](https://trigger.dev/docs/triggering), [execution model](https://trigger.dev/docs/how-it-works), [wait tokens](https://trigger.dev/docs/wait-for-token) |
| Temporal | Workflow/activity separation, explicit child lifecycle, signals/updates, and history replay tests | Specify side effects, code evolution, cancellation and child ownership. Maintain saved-history compatibility tests. [Workflow basics](https://docs.temporal.io/develop/typescript/workflows/basics), [children](https://docs.temporal.io/develop/typescript/workflows/child-workflows), [testing](https://docs.temporal.io/develop/typescript/best-practices/testing-suite) |

These sampled generic-framework docs do not establish a built-in coding workspace/PR lifecycle. That leaves room for Weft's domain-specific layer; it does not establish that competitors cannot support such integrations.

### How to use the Orca research

The research is valuable, but several conclusions need qualification:

1. **The products can substitute for the same job.** Even if one coordinates terminal sessions and the other executes programs, both can be selected to supervise coding agents. “Mostly not competitors” understates this practical overlap. This is product judgment, not a market-size claim.
2. **Orca has orchestration and journals.** Its execution model differs from Weft's; do not describe those capabilities as absent. The useful distinction is transcript/fleet/task history versus replayable program control flow. See [18-relevance-to-weft.md:39](../competitors/orca/18-relevance-to-weft.md#L39).
3. **Weft already repairs torn journal tails before append.** The suggested gap at [18:81](../competitors/orca/18-relevance-to-weft.md#L81) is overstated. Current [journal.ts:125](../../packages/store-fs/src/journal.ts#L125) reconciles, checks ownership, truncates the torn tail, and then appends. Quarantine diagnostics and deliberate mid-file corruption handling are separate improvements worth evaluating.
4. **Completed-step durability does not mean no work is lost.** An in-flight provider turn and a remotely committed but locally unrecorded effect are separate recovery problems. Do not repeat the broad crash claim at [18:114](../competitors/orca/18-relevance-to-weft.md#L114).
5. **Existing SSE is not fine-grained provider progress.** Weft already exposes journal events and pending decisions. A provider-status protocol would add live attempt information; it would not create observability from scratch. See [daemon/index.ts:15](../../packages/daemon/src/index.ts#L15) and [provider.ts:151](../../packages/core/src/provider.ts#L151).
6. **Fail-open telemetry must not become fail-open authorization.** Orca's best-effort hook delivery is a lesson for status reporting. Weft's protected effect and write-authority decisions need their own stricter contract.

Do not prioritize Orca's full terminal, browser, editor, remote-host, or mobile surface. First expose one actionable queue for decisions, failed verification, stale candidates, uncertain operations, and PR feedback. Treat Orca launch/plugin integration as an experiment until executed and validated.

## 8. Implementation plan

Effort bands below are planning estimates for focused engineering work, not delivery promises: S ≈ 1–3 engineer-days, M ≈ 1–2 engineer-weeks, L ≈ 2–4 engineer-weeks. Runtime work carries more uncertainty than documentation and CLI changes. Owners are suggested workstreams, not assigned people.

| Order | Work package and owner | Concrete deliverable | Acceptance gate | Estimate / dependency |
| --- | --- | --- | --- | --- |
| 0A | Current correctness — SDK/runtime | Safe reusable-check replay fallback; explicit semantic identity rules | Changed callback or candidate cannot silently reuse a pass; unchanged declared inputs retain safe reuse | M; immediate |
| 0B | Flagship workflows — examples/DX | Correct finding identity, required review coverage, conflict-domain grouping, behavioral tests | Missing worker, duplicate locations, one failed refuter, conflicting edits, declined approval all yield explicit outcomes | M; parallel with 0A |
| 0C | Tool trust — CLI/testing | Registry-based test discovery, zero-test failure, strict fixture option and scaffold defaults | Extra-directory workflows execute their tests; missing exec/fetch/git fixture fails before the effect | M; parallel with 0A |
| 1 | Composition specification — SDK/runtime | Short semantic ADR, supported/preview matrix, migration table | Every boundary specifies identity, replay, context, failure, cancellation, visibility and code-change behavior | S–M; informed by 0 |
| 2A | Workspace/candidate runtime — engine/isolation | Durable owned workspace and candidate-bound check/review evidence | Restart retains workspace; later edits invalidate prior proofs; repaired candidates can pass | L; depends on 1 |
| 2B | External operation recovery — engine/adapters | Intent, request identity, reconciliation, receipts and unknown-outcome state | Crash before/after remote success never causes an unexamined duplicate; ambiguous result has an actionable recovery path | L; depends on 1; can overlap 2A |
| 2C | Complete delivery workflow — SDK/stdlib | Issue → implementation → verification → reviewed PR, using one supported runtime | Branch, commit, PR and evidence agree; changing candidate blocks stale approval; restart resumes without losing ownership | M–L; depends on 2A/2B |
| 3 | Authoring consolidation — SDK/CLI/docs | Keyed lanes and capability-typed named procedures; migration helpers; compact generated SDK guide | Existing runnable workflows migrate incrementally; nested replay remains inspectable; no silent parallel failure change | L; begin additive pieces after 1, finalize against 2C |
| 4 | Operation and evolution — host/UI/testing | Recovery/attention queue, saved-history corpus, explainable resume, scheduled-wait ownership tests | A user can identify what completed, what changed, what is unknown, and the exact safe next action across CLI/MCP/UI | L; incremental throughout 2–3 |
| 5 | Ecosystem and quality — providers/evaluation | Additional adapter selected by demand; versioned coding-task evaluations | Matched task corpus reports acceptance, cost, latency, human intervention and delivery completeness | M then ongoing; after 2C |

Each work package should be independently reviewable. Stabilization work can ship before the new workspace runtime. Do not wait for a universal operation framework, every prototype builder, or broad provider coverage before demonstrating the first delivery workflow.

### Migration sequence

1. Add new contracts alongside executable SDK behavior. Preserve legacy replay identities and stored histories.
2. Implement new semantics on the existing execution kernel. Keep any compatibility adapters explicit.
3. Convert the actual repository workflows first, then scaffolds, examples, CLI guidance, and documentation in the same change series.
4. Ship diagnostics for legacy patterns: ambiguous identity, dropped required lanes, unbound verification, and unsupported preview imports. Diagnostics should name the remedy.
5. Deprecate redundant surface only after feature and behavior parity. Do not automatically rename recipes to procedures if their caching/lifecycle behavior differs.
6. Make run-definition policy explicit: use a retained executable bundle for a stable resume path, and an explicit edit-tolerant path with a reuse preview. Keep generic external effects subject to recovery rules in either mode.

The existing body/bundle hash machinery is useful input to step 6, but it is not a complete author-facing version policy.

## 9. Required scenarios and quality measures

Maintain six canonical, executable scenarios: exhaustive review; bounded investigate/fix/check repair; parallel edits grouped by conflict domain; reusable child workflow; suspended candidate-bound human approval; and issue-to-PR with CI/review feedback. Each needs a success case, partial failure, cancellation, process restart, code edit, and evidence/outcome assertions where relevant.

A saved-history corpus should include at least:

- Inserting/reordering keyed lanes and changing a helper implementation.
- A child workflow or procedure changing while the parent body stays identical.
- A check callback changing without a revision; a candidate changing without a check-definition change.
- A failed check followed by repair and a valid replacement candidate.
- Approval followed by an out-of-band branch edit.
- A remote mutation succeeding immediately before local completion is interrupted.
- Cancellation while writers remain active, including retained worktree ownership.
- A timer/signal wait across host restart, proving which host re-arms or wakes it.

Track the following after establishing a baseline; these are proposed measures, not current results:

| Measure | Definition / intended use |
| --- | --- |
| First useful run | Fresh-checkout time and author steps to scaffold, validate, test, run and inspect one meaningful workflow |
| Authoring burden | Repeated configuration and orchestration code needed for the canonical scenarios; count behavior-preserving simplification, not merely fewer lines |
| Delivery completeness | Fraction of eligible started tasks that reach the declared verified branch/PR outcome; report blocked, cancelled and infrastructure failures separately |
| Resume correctness | Expected reuse, re-execution and recovery decisions across saved histories; no stale proof or duplicate-effect acceptance in the corpus |
| Supervision burden | Human interventions and time spent determining the next safe action per delivered task |
| Evaluation quality | Acceptance rate, regressions, cost and latency on versioned tasks with pinned repository and provider/model configuration |

Model-free workflow tests validate orchestration. They do not establish prompt quality, reviewer independence, or coding success. A cross-vendor vote is useful evidence but does not replace deterministic acceptance checks; correlated mistakes remain possible.

## 10. Validation performed for this review

- Prototype documentation validation and TypeScript checks passed.
- SDK, replay, and engine selection: 98 tests passed across three files.
- Replay, human, patch, and cancellation selection: 62 tests passed across four files. The restricted run timed out in a local HTTP fixture; the same selection passed with permitted local loopback access. This selection overlaps the preceding replay suite; the counts must not be summed as unique tests.
- CLI and task-backed workflow testing selection: 64 tests passed across two files.
- All four repository workflows passed `weft check`; the default workflow test command passed four metadata tests.
- The composable workflow example ran with fixtures and recorded phases, checks, and tasks.
- Separate model-free probes reproduced F1, F2, F3, and the zero-test discovery behavior in F7.

No real model calls, Git publication, PR creation, competitor execution, fresh package installation, browser UX validation, or full-repository test run was performed. The passing existing tests are evidence of the current substrate and also show where the proposed regression scenarios are missing.

### Reproducing the two smallest failures

From the repository root, this in-memory probe reproduces the reusable-check result problem without changing repository files:

```sh
node --import tsx --input-type=module <<'EOF'
import { defineWorkflow, defineCheck, z } from '@techery/weft-sdk';
import { testEngine, reopen } from './packages/core/test/helpers.ts';
let calls = 0;
const workflow = value => defineWorkflow(
  { name: 'check-replay-probe', description: 'replay probe',
    input: z.object({}), output: z.object({ status: z.string() }) },
  async ctx => ({ status: (await ctx.check(
    defineCheck({ name: 'quality', run: () => { calls++; return value; } }),
    { key: 'quality' }
  )).status })
);
const first = testEngine();
const initial = await first.engine.start(workflow(true), { input: {}, cwd: process.cwd() });
console.log('initial', await initial.result);
const second = reopen(first);
const resumed = await second.engine.resume(initial.runId, { def: workflow(false) });
console.log('resumed', await resumed.result, 'callback calls', calls);
await first.engine.shutdown();
await second.engine.shutdown();
EOF
```

Observed: initial and resumed results both pass; callback calls equals 1.

This valid extra package is discoverable, but its tests are not selected by the default test command:

```sh
node packages/cli/bin/weft.js --cwd examples \
  --extra-workflow-dir 08-task-backed-code-review/task-backed-code-review workflow list
node packages/cli/bin/weft.js --cwd examples \
  --extra-workflow-dir 08-task-backed-code-review/task-backed-code-review test
```

Observed: the first command lists `task-backed-code-review`; the second exits 0 with `tests 0`.

## 11. First release acceptance

The next meaningful milestone is one user-visible promise:

> A coding workflow can resume, finish with the declared branch/PR outcome, show the checks and review for the exact delivered code, and explain uncertain or incomplete work without reporting it as success.

The smaller DSL is valuable when it makes that promise easier to author and verify. It should be judged by the complete executable scenarios and their failure behavior, not by the breadth of the declaration surface.
