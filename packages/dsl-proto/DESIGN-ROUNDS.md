# DSL workflow design rounds

> Historical record: the round fixtures described here were removed from the active source tree after their
> findings were folded into the canonical DSL. Use Git history at commit `929b8c4` to inspect the original files.
> Current authoring guidance lives in `PROTOTYPE.md` and `WEFT-DSL-BLOG.md`.

This log records eleven compile-time authoring rounds against the declaration-only DSL. Each round uses
concrete coding workflows, an adversarial type/DX review, and an API-minimization pass. A proposed feature
is accepted only when it makes a safety boundary expressible or removes repeated accidental complexity; a
helper that merely shortens ordinary TypeScript is rejected.

## Round 1 — baseline coding workflows

Workflows: issue-to-verified-patch, dependency migration, and review-to-release.

What held up:

- schema inference survived agents, goals, checks, workspaces, artifacts, operations, and observers;
- `WorkflowNode` remained useful as shared definition identity without pretending definitions had one
  context-free input/output pair;
- ordinary TypeScript was sufficient for bounded rework and step-specific policy.

Friction found:

- command-backed checks accepted an empty `readonly string[]`;
- portable declarations had to invent operation and polling callbacks;
- evidence and write authority could still be projected into ordinary strings too early;
- independent review, generation-bound promotion, and dynamic check matrices were verbose enough to merit
  dedicated pressure tests.

Changes accepted:

- `CheckCommand` is a non-empty tuple;
- operations support mutually exclusive host-bound and locally implemented forms;
- polling observers support the same host-binding split through `HostBinding`.

Deferred: `defineReview`, delivery/promotion, check matrices, and trusted path policies. An
`isolatedDeclarations` convenience alias was rejected because it addressed example compiler configuration,
not a workflow-domain contract.

## Round 2 — identity, input/output, and composition

Workflows: monorepo API refactor, deterministic flaky-test repair, and security remediation.

What held up:

- bound context calls retained exact result envelopes while definitions stayed inert and registry-safe;
- candidate workspaces made isolated fan-out, integration, ordered verification, and capture expressible;
- nominal evidence was clearly different from schema-shaped agent advice in adversarial security flows.

Changes accepted:

- `SequenceFn` now preserves the enclosing workspace mode, so an item scope inside a candidate or durable
  workspace cannot silently fall back to detached-patch semantics;
- engine-observed generations are nominal `WorkspaceSnapshotRef` values, active workspaces expose the current
  `snapshot`, check and suite calls bind it as their `candidate`, and `PatchRef` is nominal and names its base
  snapshot.

Rejected: universal public `WorkflowNodeInputOf` / `WorkflowNodeOutputOf` helpers. Several definitions have
different results when bound to different invocation modes, so only `WorkflowInvocationInput` and
`WorkflowInvocationOutput` may claim a total input/output relationship.

Deferred: keyed lane results, repeated-check series, evidence attestations, authorization type-state, and
artifact-correlated human review. These need review/delivery and capability-specific pressure tests.

## Round 3 — review and delivery

Workflows: adversarial multi-lens review, exact-head pull-request delivery, and emergency hotfix release.

Changes accepted:

- `defineReview` is a candidate-bound specialization of transparent orchestration. Its evaluator may use any
  reviewer topology, but the engine guards one unchanged `WorkspaceSnapshotRef`, validates findings, applies
  pure acceptance policy, and returns a typed attestation. Rework remains explicit workflow code;
- `defineDelivery` is not an alias for `defineOperation`. `ctx.delivery.prepare` atomically validates
  same-candidate evidence and freezes delivery input, `ctx.delivery.authorize` mints candidate-specific
  authority, and callable `ctx.delivery` performs the host-bound effect and returns an attested receipt;
- checks, suites, goals, and review results expose nominal `SubjectAttestation` values; artifacts are nominal,
  record provenance sources, and can be passed directly to `ctx.human.review` without losing their exact type.

Rejected: a fixed reviewer-agent hierarchy and implicit review/rework loop. Both would make one strategy easy
at the cost of freezing policy that ordinary TypeScript already expresses clearly.

Deferred: check waiver eligibility and attested waivers move to the failure-policy round. General operation
authorization and write-scope authority move to the capability round.

## Round 4 — tools, context, and authority

Workflows: bounded agent tool use, multi-source grounded analysis, and adversarial path and external-effect
authorization.

Changes accepted:

- agents accept an explicit operation allowlist with optional call budgets; a grant can narrow an operation
  but cannot create an unavailable capability or bypass its authorization policy;
- `defineContextSource` is strictly read-only and host-bound, returning a nominal `ContextSnapshot` with
  freshness, trust, and general `EvidenceRef` provenance;
- `definePathPolicy` separates fixed roots and denials from proposed paths; only `ctx.paths.resolve` can mint
  an expiring `WriteScope` bound to the current workspace snapshot;
- operations declare either no authorization or a required authorization policy. Unprotected operations are
  directly callable, while protected effects use the explicit prepare → authorize → execute transition.

Rejected: `defineToolset`. A named bundle adds no safety until repeated workflows prove an identity or policy
contract beyond an ordinary operation allowlist.

Observed tradeoff: protected effects are deliberately more verbose. A later ergonomics round may reduce
mechanical ceremony, but it must not collapse business approval and host capability authorization into one
ambiguous call.

## Round 5 — admission and observation

Workflows: authenticated pull-request and issue events, scheduled monorepo maintenance, and long-running
signal-first CI and deployment observation.

Changes accepted:

- `defineTrigger` binds one authenticated host event schema to one target workflow through pure filtering,
  event identity, deduplication identity, and exact input mapping. It is intentionally absent from `Ctx`;
- trigger admission validates mapped input, scopes the claim by definition digest and revision, binds event IDs
  to payload digests, and atomically records claim, child run, and launch outbox. Nominal provenance reaches
  `ctx.run.trigger` without exposing the source payload;
- signal observers require an explicit host binding and a non-empty trust authority set. Optional identity
  contracts let the engine reject correlation mismatches, replay conflicts, and non-monotonic sequences;
- `ctx.observe.detailed` retains a nominal subject, provenance, and evidence reference, while a `signal-first`
  source makes deadline-triggered polling fallback one engine-owned state machine with a single winner.

Rejected: putting cron syntax, leases, overlap, coalescing, or queue retry policy into `defineTrigger`. Those are
host deployment concerns; the portable DSL owns only the authenticated and type-safe admission edge.

Deferred: cancellation or compensation for a remote effect started by an operation. It is an operation lifecycle
problem, not a reason to overload external workflow triggers with a `start`/`cancel` pair.

## Round 6 — failure lifecycle and exceptions

Workflows: partially completed multi-service release, cancellable and resumable code migration, and a narrowly
waivable production safety check beside an unwaivable integrity check.

Changes accepted:

- `ctx.cancellation` exposes an engine-minted terminal reason and cooperative `AbortSignal`; worker loss and
  resumable interruption remain distinct, and catching cancellation cannot turn the run into success;
- recoverable protected operations first journal a nominal pre-dispatch attempt with a direct host-bound
  conditional cleanup. Execution returns only host-minted `succeeded`, proven `not-committed`, or ambiguous
  `may-have-committed` evidence; unknown post-dispatch failures are ambiguous;
- successful receipts alone unlock explicit protected compensation. Reverse ordering, continued recovery, and
  manual intervention remain visible ordinary workflow code;
- check definitions default to `waiver: { mode: "never" }`. Eligible revisioned checks use a fixed host policy,
  authorize only an executed exact-candidate failure, and return a nominal expiring `CheckWaiverRef` retained on
  the waived result.

Rejected: a generic saga/recovery node, `ctx.defer(callback)`, workflow-authored error classifiers, and task
records as retry or recovery authority. Each would hide an execution or trust boundary without proving it.

Deferred: preserving eligible check revision literals through generic definitions moves to the inference round.
The explicit recoverable-operation surface is also a candidate for call-site simplification there, but its
pre-dispatch, commit-certainty, and receipt-only transitions may not be collapsed.

## Round 7 — reuse, registries, and cross-repository programs

Workflows: a heterogeneous versioned workflow registry, a reusable platform workflow factory, and a
contracts-to-API-to-SDK-to-application program spanning four repositories.

Changes accepted:

- `WorkflowDefinition` retains its exact input and output schema types, with
  `WorkflowInputSchemaOf` and `WorkflowOutputSchemaOf` helpers for generic registries;
- `ctx.workflow` is a named callable `WorkflowFn`. Its `detailed` form returns a nominal
  `WorkflowRunReceipt` carrying child subject, provenance, and attestation, plus a workspace only when the
  child definition owns one;
- scoped workflow factories may add a `keyPrefix`, so reusable modules can avoid colliding with sibling
  scopes without introducing a new runtime node category;
- workflow-owned workspaces may declare a `WorkflowWorkspaceTarget` containing an authoritative host binding
  and repository identity. Host evidence is still re-resolved at execution time.

Rejected: `defineModule`, `defineProgram`, and a catalog `WorkflowNode`. Ordinary TypeScript factories and
closed registries already preserve exact definitions, while these proposed nodes would add identity without
an additional engine boundary.

What held up:

- exhaustive switching over exact definition objects remains the sound way to dispatch heterogeneous
  registry entries; a string-key convenience overload cannot honestly promise a correlated output;
- detailed child receipts retain lineage without changing the simple `ctx.workflow` result used by most DSL
  authors;
- cross-repository orchestration remains ordinary parent workflow code, with each child owning its own bound
  workspace and budget.

Deferred: exact revision and definition-name literals, candidate-correlated promotion evidence, and provenance
literal preservation move to the adversarial inference round.

## Round 8 — adversarial type safety and inference

Workflows: a negative compile-time authority suite, inference helpers for checks and recoverable operations,
and exhaustive public-node and internal-invocation registries.

What held up:

- all 18 public `define*` factories return nominal `WorkflowNode` definitions across the closed 17-kind node
  union;
- all 27 internal invocation kinds participate in one exhaustive `AnyWorkflowInvocation` result map;
- exact definitions preserve input/output correlation, while an intentionally erased internal union returns
  broad results until its kind or concrete definition is narrowed;
- inline inference for check suites, protected operations, recovery mappers, and detailed child calls remains
  strong without explicit generic arguments.

Changes accepted:

- promotion evidence now preserves the exact candidate, and `NoInfer<Candidate>` prevents conflicting evidence
  from widening it during preparation. Round 11 later restricts promotion to positive proof handles;
- eligible checks retain an exact revision literal through a trailing compatible generic, so waiver authority
  carries the definition's name and revision without a wrapper or assertion;
- operation, review, and delivery definitions retain exact names. This strengthens effect identity and keeps
  heterogeneous registry names closed while preserving old explicit generic arities through defaults;
- workflow definitions retain whether they own a workspace. Detailed plain-child receipts expose `undefined`,
  while detailed workspace-child receipts expose `WorkspaceSnapshotRef` directly.

Rejected: a universal public node-to-input/output helper and an implicitly dynamic registry dispatcher. Several
node kinds have multiple invocation modes, and a generic indexed registry cannot preserve key, input, and result
correlation without an explicit discriminant or exhaustive narrowing.

Kept intentionally broad in this round: host-observed trust authorities and observer completion endpoints.
Round 11 later preserves the declared allow-list and enforced trust floor as precise result postconditions while
still requiring the host to establish and mint the evidence.

Deferred: a compact public derivation helper for exported recoverable-operation wrappers. Inline use is already
well inferred, so the helper needs repeated demand before expanding the surface. Round 11 later adds the smaller
`withRecovery` and `runRecoverable` façade while retaining this explicit lifecycle in `/advanced`.

## Round 9 — canonical workflow reimplementation

Workflows: issue-to-reviewed-pull-request, security remediation, and dependency migration.

What held up:

- each workflow uses one host-verified workspace target, fresh authoritative context, nominal write scope,
  bounded agents, required verification, exact-candidate review, an immutable dossier, and authorized delivery;
- rework remains a small ordinary loop that captures a new workspace generation and reruns checks and review;
- triggers stay outside workflows as admission definitions, while observers appear only when a workflow truly
  waits for changing external state. None of the three canonical workflows needed either merely for ceremony;
- cancellation is checked where a workflow owns an explicit pre-mutation cancellation policy; delivery failures
  propagate for journal reconciliation instead of being converted into friendly domain failures.

Changes accepted:

- check-suite results and member results now retain an invocation's exact workspace candidate. Passing
  `candidate` in suite options produces a promotion-compatible exact-candidate attestation;
- `ReviewResult` retains the optional evaluator summary, avoiding a parallel summary channel in rework and
  evidence dossiers;
- candidate-bound artifact capture now returns the required exact candidate and artifact attestation. Explicitly
  unbound capture returns `undefined`, while broad storage/tooling types can still represent either branch.

Rejected: automatic rework, implicit artifact capture, implicit delivery after passing checks, and adding triggers
or observers to the canonical examples. Each would hide a policy or engine boundary that the workflow author
must be able to see.

Remaining tradeoff at this round: context trust metadata stayed host-observed and broad. Round 11 replaces that
widening with definition-derived postcondition types; a future host still has to reject observations that do not
satisfy the declared floor and authority allow-list.

## Round 10 — CI failure repair and integrated API audit

Workflow: authenticated failed-CI admission, bounded repair, independent review, exact repair delivery, and
authoritative replacement-run observation. Separate adversarial fixtures exercised every definition family,
candidate correlation, erased unions, and public versus internal execution boundaries.

What held up:

- trigger admission, canonical context resolution, workspace targeting, path authority, and delivery each own
  a distinct trust transition; none became redundant when combined in one workflow;
- an exact workspace candidate flows through the verification suite, adversarial review, promotion candidate,
  delivery receipt, and observed CI result without reducing authority to copied hashes;
- the public DSL stays small when ordinary TypeScript owns loops, rework, factories, and exhaustive registries.

Changes accepted:

- all reusable definition families now retain identity literals that affect correlation, including prompt,
  agent, recipe, artifact, suite, goal, UI, task-contract, and workflow identity; workflows require a stable ID;
- exact check candidates must be supplied as nominal input. Unbound calls remain intentionally broad, while
  suite members, results, attestations, artifacts, reviews, and deliveries preserve an explicitly bound candidate;
- inline agents receive an internal normalized node and invocation, closing the node-backed executor without
  adding a public inline definition factory;
- plain contexts expose read-only Git, workspace contexts add local mutations, fetch is read-only, secret
  handles are nominal, and callers cannot declare effect risk. Generic remote effects require a protected
  operation; promotion of workspace state requires an exact-candidate delivery;
- dynamic string workflow dispatch was removed. Exact definition calls and exhaustive narrowing preserve the
  input/output relationship that an unvalidated name cannot;
- package docs and the clean `prepack` build now keep the published declaration surface aligned with source.

Rejected: modeling the CI submission as a general operation, exposing raw Git push/pull/tag, adding
`defineModule`, `defineProgram`, or a catalog dispatcher, and forcing primitive host effects into
`WorkflowNode`. These choices would either weaken promotion evidence or add a node identity without a reusable
definition boundary.

Deferred: a public `OperationAttemptFor` convenience helper and a separate exhaustive primitive-effect algebra.
The recoverable-operation transitions are verbose but honest, while primitive effects are already typed on the
host context and need a real engine implementation before another public abstraction is justified. Round 11
addresses the ordinary call site with a declarative recovery wrapper rather than exposing another attempt helper.

Boundary retained: local workspace generations may advance provisionally. External promotion can advance only
by freezing one exact current generation, collecting same-candidate positive proof, obtaining candidate-specific
authority, and executing the corresponding delivery. This keeps the authoring API concise without letting type
convenience invent runtime trust.

## Round 11 — assessment response and public-surface tightening

Pressure test: seven compiler-confirmed unsoundness cases plus an authoring-surface audit. The negative fixture is
[`src/examples/rounds/round-11-type-safety-regressions.ts`](./src/examples/rounds/round-11-type-safety-regressions.ts).

Strict regressions closed:

1. an agent goal is one `GoalBinding`, so its definition and input cannot be inferred independently;
2. required input presence comes from the definition form (`"none"` or `"required"`), so a schema whose value
   includes `undefined` still requires an explicit `input` property;
3. widened agent options return every possible envelope, while one `ctx.agent(definition, input, options)` call
   keeps read, write, and recoverable-failure policy orthogonal and type-safe;
4. custom providers use a discriminated `dynamic` form and cannot overlap the built-in provider union;
5. delivery preparation accepts only engine-minted positive check, review, or goal proofs. A failure, waiver,
   artifact, arbitrary attestation, or copied snapshot is not promotion proof;
6. `failure: "return"` returns an exhaustive `AgentOutcome` with diagnostic failure data; omitting it keeps
   required completion and throwing failure semantics;
7. engine-minted definitions, observations, artifacts, grants, proofs, waivers, protected candidates,
   authorizations, attempts, and recoverable receipts carry private-member nominal identity, so object spread
   cannot directly retain authority while rewriting visible fields. Generic intersection helpers and unsafe casts
   remain TypeScript escape hatches, so a future host must still validate registry identity, digests, candidate,
   policy, and expiry at every consequential boundary.

Authoring changes accepted:

- one callable `ctx.agent` now covers reusable definitions, inputless definitions, and one-off `{ prompt,
  schema }` definitions. The final options object carries `key`, optional `write`, and optional
  `failure: "return"`; there are no separate read, write, or try methods;
- ordinary protected operations and verified deliveries have one-shot `.run` facades. `withRecovery` binds
  guaranteed direct cleanup and optional compensation once, and `.runRecoverable` returns the exhaustive commit
  classification without public attempt generics. Their single durable key names the logical effect; a conforming
  engine derives stable lifecycle subkeys. Explicit prepare, authorize, execute, recovery, candidate, and receipt
  contracts remain available from the `/advanced` subpath;
- parallel work chooses `.all` or `.settled` at the method boundary, starts work only through an item callback,
  rejects already-started promise items, and requires `keyOf`. Pipelines reject async `map`, distinguish pure
  `map`/`filter` from named durable `mapEffect` calls, and terminate with the same all-or-settled choice;
- `ctx.step` is the single durable grouping primitive. It namespaces child keys without introducing a second
  grouping abstraction;
- `WorkflowCtx`, `WorkspaceCtx`, and authority-reduced `ReviewCtx` make callback capabilities legible. Public
  workflow, recipe, and review definitions retain hidden type bags but no longer expose their implementation
  callbacks or positional phantom fields; `typeof` and named extractors recover the contract;
- source trust and freshness results retain the definition's enforced floor, authority literals, and reject-stale
  guarantee. Ordinary code reads `ctx.workspace.snapshot` and passes it as `candidate`; checks, reviews,
  artifacts, and deliveries must atomically reject a stale candidate or evidence from another candidate.
  `/advanced` exposes `sameSnapshot` and `assertUnchanged` only for code that genuinely needs explicit probes;
- `ctx.policy.decide` and `ctx.human.confirm` are branch decisions, never reusable effect authority. Operations
  and deliveries alone mint authorization bound to frozen candidates; `ctx.check.authorizeWaiver` names its
  narrower exact-failure exception explicitly;
- checks and primitive journaled filesystem, Git, process, network, signal, clock, randomness, environment,
  note, and integration effects require one stable author key. Scoped contexts may namespace that key without
  changing the semantic identity rule;
- task operations consistently keep durable options last, while task contracts retain only an extension schema
  and agent-access policy. They expose no author-facing contract version, revision, or migration surface because
  tasks are short-lived. Engine-owned per-task numeric revisions still protect optimistic updates, and dedupe
  keys still make retried upserts converge. Human review accepts immutable
  artifact references as a first-class subject, and engine-minted result fields are read-only;
- the package root uses a curated context with one-shot protected effects; `/advanced` exposes the comprehensive
  lifecycle context. `/testing` is a type-only harness contract, and the build emits declarations with no runtime
  export condition.

Proof boundary: this package still contains declarations and compile-time fixtures, not the engine behavior
implied by journaling, key derivation, host validation, freezing, freshness checks, authorization consumption,
or task persistence. Round 11 makes those runtime obligations more precise; it does not claim they ship here.
