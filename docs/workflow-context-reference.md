# Workflow `ctx` reference

Every Weft workflow receives a `ctx` object as the first argument to its `run` function:

```ts
import { defineWorkflow, z } from "@techery/weft-sdk";

export default defineWorkflow(
  {
    id: "example",
    description: "Demonstrate workflow context",
    input: z.object({}),
    output: z.object({ ok: z.boolean() }),
  },
  async (ctx) => {
    ctx.phase("Work");
    ctx.log(`run ${ctx.run.id}`);
    return { ok: true };
  },
);
```

`ctx` is the workflow's boundary to agents, humans, the filesystem, processes, HTTP, Git, durable tasks,
time, randomness, and child workflows. This document describes every public method, the engine logic behind
it, and the patterns to use when composing workflows.

The TypeScript contract is defined by [`Ctx`](../packages/sdk/src/types.ts) and
[`UiApi`](../packages/sdk/src/ui.ts). The runtime behavior is implemented in
[`buildCtx`](../packages/core/src/ctx.ts).

## Mental model

### Journaled steps and transparent orchestration

Methods that observe or affect the outside world are journaled. On resume, Weft executes the workflow
function again from the top and reuses a completed step when its recorded identity still matches. Agent
calls, human requests, filesystem reads, commands, HTTP requests, Git operations, checks, task operations,
waits, time, randomness, and UUID generation all cross this durable boundary.

Orchestration helpers such as `parallel`, `pipeline`, `sequence`, `successes`, `all`, `scope`, and `recipe`
do not hide their nested effects inside one opaque step. Each nested `ctx` call remains independently
journaled and visible in the run tree.

### Step identity and `key`

A journaled step's identity includes its kind, inputs, schema, and optional `key`. Content identity is enough
for a unique one-off call, but a stable key is strongly recommended for repeated, reordered, or similar
calls. If replay cannot unambiguously match a keyless step, Weft reruns it instead of guessing.

Use keys that identify the logical operation, not its current position:

```ts
await ctx.agent(`Review ${file}`, {
  key: `review:${file}`,
  schema: FindingList,
});
```

Human requests, commands, fetches, checks, task mutations, UI presentations, and child workflows also expose
keys where call sites benefit from explicit replay identity.

### Schemas are runtime contracts

Agent results, human answers, workflow input/output, recipe input/output, signals, and optionally command or
HTTP results are validated by their Standard Schema. A TypeScript type alone is not a runtime guarantee.
Provider-facing JSON Schema may be a compatible projection, but the original Standard Schema remains the
authority when Weft accepts a value.

### Determinism

Workflow source should not call ambient nondeterministic APIs such as `Date.now()`, `Math.random()`,
`crypto.randomUUID()`, raw `fetch`, process execution, or direct filesystem modules. The gate rejects or
replaces those paths. Use `ctx.now()`, `ctx.random()`, `ctx.uuid()`, `ctx.fetch()`, `ctx.exec()`/`ctx.bash()`,
and `ctx.fs.*()` so the observed result can be journaled and replayed.

### Durations and paths

Duration arguments accept milliseconds as a non-negative number or strings such as `"250ms"`, `"30s"`,
`"10m"`, `"2h"`, and `"1d"`.

Paths are normally repository-relative and resolve from `ctx.run.cwd`. Write-scope globs must be non-empty
POSIX repository-relative patterns: no absolute paths, backslashes, or `..` segments.

## Surface map

| Area | Methods and fields |
| --- | --- |
| Agents | `agent`, `agent.detailed` |
| Fan-out and flow | `parallel`, `sequence`, `pipeline`, `successes`, `all` |
| Composition | `workflow`, `scope`, `recipe`, `step` (deprecated) |
| Humans and UI | `gate`, `human.ask`, `human.approve`, `human.review`, `human.review.detailed`, `ui.render` |
| Files and processes | `fs.read`, `fs.glob`, `fs.stat`, `exec`, `bash`, `env.get`, `secret` |
| HTTP | `fetch` |
| Git reads | `git.status`, `head`, `branches`, `mergeBase`, `changedSince`, `diff`, `log`, `show`, `blame`, `fileAt`, `snapshot` |
| Git writes | `git.add`, `commit`, `checkout`, `fetch`, `pull`, `push`, `reset`, `apply`, `tag`, `branch.create`, `branch.delete`, `stash.push`, `stash.pop`, `stash.drop`, `clean` |
| Verification and patches | `check`, `check.exec`, `check.fn`, `check.trust`, `check.skip`, `integrate`, `discard`, `note` |
| Durable tasks | `tasks.observe`, `tasks.upsert`, `tasks.update`, `tasks.note`, `tasks.setCriterion` |
| Durable waits | `signal`, `sleep` |
| Journaled values | `now`, `random`, `uuid` |
| Structure and metadata | `phase`, `log`, `budget`, `run` |

## Agents

### `ctx.agent(prompt, options)`

```ts
const result = await ctx.agent("Find correctness bugs in auth.ts.", {
  key: "review:auth",
  schema: z.object({
    findings: z.array(z.object({ line: z.number(), claim: z.string() })),
  }),
  provider: "codex",
  effort: "high",
  timeout: "10m",
});
```

Runs one provider-backed agent step and returns only its schema-validated value.

Important logic:

- `schema` is required. Invalid structured output is sent back to the same session for schema repair; the
  default repair allowance comes from engine configuration and can be overridden with `repair`.
- Routing precedence is step options, then workflow defaults, then engine defaults. `provider`, `model`, and
  `effort` can be selected per step.
- `providerOptions` is namespaced by provider. Only the selected provider's entry is validated and sent.
- `providerRequirements` fails before a paid turn when the provider cannot satisfy required structured-output,
  permission-hook, or session-resume capabilities.
- `maxTurns`, `timeout`, `retry`, `repair`, and `onMaxTurns` control execution. Retry attempts are separate
  step attempts; schema repairs happen inside the provider session and all usage is accumulated.
- `onError: "throw"` is the default. `onError: "null"` changes the return type to `T | null`, records the
  dropped failure, and durably replays the same suppression instead of retrying it on resume. Cancellation and
  settlement failures are never suppressed.
- `label` is presentation only. `key` is replay identity.

#### Read and write steps

An agent is read-only unless `write` is declared. A write step runs in its own Git worktree and returns a patch;
it does not mutate the integration tree.

```ts
const fixed = await ctx.agent.detailed("Fix the retry loop and nothing else.", {
  key: "fix:retry",
  schema: z.object({ summary: z.string() }),
  write: {
    paths: ["src/retry.ts"],
    also: ["pnpm-lock.yaml"],
    mode: "strict",
  },
});
```

`write.mode: "warn"` is the default: out-of-scope edits are reported but the patch remains eligible for
integration. `"strict"` quarantines a patch with out-of-scope edits. Use `ctx.integrate()` to land an accepted
patch or `ctx.discard()` to close it without landing it. A run cannot complete with unresolved patches.

`isolation: "worktree"` also isolates a read step. Declaring `write` implies worktree isolation.

#### Workflow task context for agents

Task context is available only when the workflow declares a task contract and the host has a task tracker.
Use `tasks: false` to omit it, or pass a selector and an explicit mode:

```ts
await ctx.agent("Reassess open parser work.", {
  key: "reassess:parser",
  schema: Assessment,
  tasks: {
    mode: "read",
    statuses: ["todo", "in_progress", "blocked"],
    tags: ["parser"],
    limit: 20,
  },
});
```

The engine injects a bounded snapshot and, in write mode, accepts validated task operations in the structured
agent result. Providers do not receive direct task-store or CLI authority. Operations settle idempotently only
after the agent step succeeds.

### Reusable `ctx.agent(definition, input, options?)`

Agents created by `defineAgent()` fix a prompt template, output schema, and routing defaults:

```ts
const result = await ctx.agent(fileReviewer, { path: "src/auth.ts" }, {
  key: "review:auth",
  effort: "xhigh",
});
```

The prompt input is validated when the reusable prompt declares an input schema. Invocation options override
definition defaults. A reusable agent cannot bake in a call-site key or silently default to nullable output.

### `ctx.agent.detailed(...)`

Accepts the same direct-prompt and reusable-agent forms, but returns operational metadata:

```ts
type DetailedAgentResult<T> = {
  value: T;
  usage: { input: number; output: number; cacheRead?: number; usd?: number };
  files: string[];
  patch?: { ref: string; key: string; files: string[]; quarantined?: boolean; outOfScope?: string[] };
  attempts: number;
  sessionId?: string;
};
```

Use `detailed` when the workflow needs usage, files, session metadata, or especially a patch for
`ctx.integrate()`/`ctx.discard()`. Use plain `ctx.agent()` when only the typed value matters.

## Fan-out and flow control

### `ctx.parallel(tasks, options?)`

### `ctx.parallel(items, mapper, options?)`

Runs independent lanes and returns `Settled<T>[]` in input order:

```ts
const settled = await ctx.parallel(
  files,
  (file) =>
    ctx.agent(`Review ${file}`, {
      key: `review:${file}`,
      schema: Review,
    }),
  { concurrency: 4, errors: "settle" },
);
```

Each result is `{ ok: true, value }` or `{ ok: false, error: StepError }`.

- `errors: "settle"` is the default and lets the caller choose how to handle lane failures.
- `errors: "throw"` waits for every lane to settle, then throws the first failure.
- `concurrency` works with the item/mapper form or an array of thunks. It cannot limit promises that were
  already started; Weft rejects that combination rather than pretend to bound it.
- The engine enforces its configured fan-out cap and global concurrent-step limit.
- Cancellation propagates instead of becoming an ordinary settled failure.

Prefer the mapper form for most fan-out. Use thunks when each lane has distinct code:

```ts
await ctx.parallel(
  [
    () => ctx.agent("Check API", { key: "check:api", schema: Result }),
    () => ctx.agent("Check UI", { key: "check:ui", schema: Result }),
  ],
  { concurrency: 2 },
);
```

### `ctx.successes(settled)`

Returns successful values, records every failed lane as a deliberate drop, and preserves the relative order
of successes.

```ts
const reviews = ctx.successes(await ctx.parallel(files, reviewFile));
```

Use this only when partial results are an intentional workflow policy. It makes tolerance visible in the run
report instead of silently filtering errors.

### `ctx.all(settled)`

Returns all values in input order or throws the first failure.

```ts
const reviews = ctx.all(
  await ctx.parallel(files, reviewFile, { concurrency: 4 }),
);
```

Because `parallel` has already settled all lanes, `all` does not abandon work in flight. Use it when every lane
is required. `errors: "throw"` on `parallel` and a later `ctx.all()` express similar failure policy; normally
choose one place to enforce it.

### `ctx.pipeline(items)`

Builds an immutable per-item pipeline. Every item passes through its stages independently, so a fast lane can
enter stage two before a slow lane finishes stage one.

```ts
const confirmed = ctx.all(
  await ctx
    .pipeline(findings)
    .step((finding) => ctx.agent(`Verify ${finding.claim}`, { key: `verify:${finding.id}`, schema: Verdict }))
    .filter((verdict) => verdict.real)
    .map((_verdict, originalFinding) => originalFinding)
    .run({ concurrency: 4, errors: "throw" }),
);
```

Pipeline methods:

- `.step(fn)` awaits a stage and carries its result to the next stage.
- `.filter(fn)` removes a lane when the verdict is falsy. Filtered lanes do not appear in `.run()` results.
- `.map(fn)` is a typed transformation stage; it may be synchronous or asynchronous.
- `.run(options?)` returns ordered `Settled` results for the lanes that were not filtered. It supports the same
  `concurrency` and `errors` policy as `parallel`.

Every callback also receives the original item and its input index. Builder branches are immutable, so two
pipelines derived from a common prefix do not share later stages.

### `ctx.sequence(items, options, run)`

Traverses items sequentially and gives each item a stable phase-scoped context and key builder:

```ts
const outputs = await ctx.sequence(
  services,
  {
    keyOf: (service) => service.id,
    phase: (service) => `Deploy ${service.name}`,
    keyPrefix: "service",
  },
  async (service, item) => {
    return item.ctx.workflow(deployService, service, {
      key: item.key("deploy"),
    });
  },
);
```

`keyOf` must return a unique, non-empty string without `:` for every item. `keyPrefix` and local keys have the
same restriction. `item.key("deploy")` produces `service:<itemKey>:deploy`. The default phase is the item key
and the default prefix is `item`.

Use `sequence` for ordered traversal where stable per-item structure matters. It stops on the first thrown
failure and returns plain `Result[]`, not settled results.

## Workflow and reusable composition

### `ctx.workflow(definitionOrName, input, options?)`

Runs a real child workflow with an independent run, journal, suspension lifecycle, and optionally a delegated
budget:

```ts
const verdict = await ctx.workflow(verifyFinding, { finding }, {
  key: `verify:${finding.id}`,
  label: `Verify ${finding.file}:${finding.line}`,
  budget: { fraction: 0.2 },
});
```

`budget` accepts `fraction`, absolute `tokens`, absolute `usd`, or a compatible combination. Child spending
rolls up to the parent. The engine enforces its configured maximum child depth.

An inline child definition needs `meta.id` or `meta.name` for stable replay identity. A registry name can be
passed as a string, but passing the imported definition preserves input/output typing. On resume Weft re-enters
the child rather than blindly serving the old outer result; the child's own journal decides which internal
steps remain reusable after code edits.

Use `ctx.workflow()` when the child needs a durable boundary. Use `ctx.recipe()` for transparent in-process
composition whose individual effects should remain directly in the parent run.

### `ctx.scope(options)`

Returns an immutable context that applies defaults to all nested calls, including nested namespaces such as
`human.ask`, `git.branch.create`, and `agent.detailed`:

```ts
const deepReview = ctx.scope({
  agent: { provider: "codex", effort: "xhigh", timeout: "20m" },
  tasks: { mode: "read", tags: ["security"] },
  parallel: { concurrency: 2, errors: "throw" },
});

const results = await deepReview.parallel(files, (file) =>
  deepReview.agent(`Review ${file}`, { key: `security:${file}`, schema: Review }),
);
```

Scope defaults merge with a parent scope. Explicit call options win. Agent scope options intentionally exclude
call-specific `schema`, `key`, `label`, `onError`, and `tasks`; task authority has its own scope field.

Because the returned handle is immutable and execution-scoped, separate scoped contexts can run concurrently
without changing one another.

### `ctx.recipe(definition, input)`

Runs a `defineRecipe()` definition transparently:

```ts
const summary = await ctx.recipe(summarizeFiles, { files });
```

The recipe input is validated before its function runs and its output is validated afterward. Nested effects
use the current phase/scope and remain ordinary journal entries. The recipe call itself is not an independent
durability, budget, or suspension boundary.

### `ctx.step(definition, input)` (deprecated)

Runs a legacy `defineStep()` transparent composition helper. It validates that the value is a step definition
but has no schema-backed input/output boundary. Use `defineRecipe()` and `ctx.recipe()` for new code.

## Humans and custom UI

### `ctx.gate(request)`

Requests approval for an action with a risk tier:

```ts
const decision = await ctx.gate({
  action: "Deploy payments to production",
  risk: "high",
  detail: "Image sha256:abc123; migrations: none",
});

if (!decision.approved) return { deployed: false };
```

The host approval policy first matches action globs, then risk-tier overrides. By default, `low` is
auto-approved and `medium`, `high`, and `irreversible` ask a person. Irreversible approvals require a generated
confirmation token unless policy auto-approves them. Policy approvals are still journaled.

The result is `{ approved, note?, answeredBy }`, where `answeredBy` is `"human"`, `"policy"`, or `"timeout"`.
Use `gate` for risk policy, not for arbitrary typed input; use `human.ask` for typed questions.

### `ctx.human.ask(options)`

Always creates a durable human request and validates the answer:

```ts
const lane = await ctx.human.ask({
  key: "release:lane",
  question: "Choose a release lane",
  detail: "Canary receives 5% of traffic.",
  schema: z.object({ lane: z.enum(["canary", "full"]) }),
  timeout: "2h",
  onTimeout: { default: { lane: "canary" } },
});
```

Timeout policies are:

- `"deny"` (also the default): the ask fails with a human-timeout error.
- `"escalate"`: records that the deadline passed and keeps waiting.
- `{ default: rawInput }`: validates the supplied raw value through the same schema and returns its output.

A human answer that fails the authoritative schema is rejected and the request reopens for a replacement.
Use a stable `key` when similar questions may occur more than once or move during edits.

An optional custom input view can stage an answer:

```ts
const answer = await ctx.human.ask({
  key: "release:decision",
  question: "Approve the release plan",
  schema: ReleaseDecision,
  ui: { view: ReleaseDecisionView, props: { plan, checks } },
});
```

View props and proposed answers must be JSON-compatible. The browser component can only propose a candidate;
host-owned controls validate and submit the durable answer.

### `ctx.human.approve(options)`

Asks a person for `{ approved: boolean, note?: string }` without applying risk-tier auto-approval:

```ts
const approval = await ctx.human.approve({
  key: "publish:report",
  action: "Publish the report?",
  detail: "Target: internal engineering portal",
  timeout: "1d",
  onTimeout: "deny",
});
```

Unlike `ctx.gate`, this method is an explicit human checkpoint. A denied or timed-out approval is returned as
`{ approved: false, note? }`; workflow code decides what to do next.

### `ctx.human.review(options)`

Presents a primary artifact or file plus optional immutable artifact attachments, waits for a schema-validated
answer, and returns the answer only.

Artifact form:

```ts
const answer = await ctx.human.review({
  key: "review:plan",
  subject: { kind: "artifact", content: plan, mediaType: "text/markdown", label: "Plan" },
  attachments: [{ kind: "artifact", content: evidence, label: "Evidence" }],
  question: "Review the plan",
  schema: z.object({ approved: z.boolean(), note: z.string().optional() }),
});
```

The legacy `artifact: string` shorthand remains supported. Artifact bytes are stored as blobs and the journal
holds references.

File form:

```ts
const answer = await ctx.human.review({
  key: "review:release-notes",
  subject: { kind: "file", path: "docs/release.md", mode: "edit" },
  schema: z.object({ approved: z.boolean() }),
});
```

File paths are repository-relative. `mode: "view"` is read-only. `mode: "edit"` lets the operator submit a
draft; Weft applies it only while the file still matches the content hash that was opened, preventing a stale
review from overwriting later edits. Review supports the same timeout and custom-UI options as `human.ask`.

### `ctx.human.review.detailed(options)`

Performs the same review but returns `{ answer, subject }`. Artifact metadata includes blob ref, SHA-256, size,
media type, and label. File metadata includes path, mode, before/after SHA-256, resulting blob ref and size, and
whether an edit was applied. Use it when later workflow logic needs durable subject provenance.

### `ctx.ui.render(options)`

Publishes a durable, read-only custom presentation:

```ts
await ctx.ui.render({
  key: "present:release-plan",
  slot: "release-plan",
  view: ReleasePlanView,
  props: { plan, checks },
});
```

`view` must be a display view created with `defineResultView()`. `props` must be JSON-compatible and the
protocol caps serialized props at 512 KiB. `key` is required replay identity. `slot` is an optional projection
identity that lets a UI region select its latest presentation.

The method returns `void`; presentation data is journaled separately from the ordinary step output, which is
`null` on the wire. Rendering happens only in the browser and cannot mutate workflow values.

## Files, commands, environment, and HTTP

### `ctx.fs.read(path)`

Reads a file and returns `{ content, sha256, size }`. The result is journaled, so a resume sees the same bytes
when the step is reused. Prefer repository-relative paths.

### `ctx.fs.glob(patterns, options?)`

Expands one pattern or an array of patterns and returns `{ paths }` sorted lexicographically. `node_modules`
and `.git` are ignored. `options.cwd` changes the glob root and resolves relative to the workflow cwd.

```ts
const { paths } = await ctx.fs.glob(["packages/*/src/**/*.ts"], { cwd: "." });
```

### `ctx.fs.stat(path)`

Returns `{ exists, size?, mtimeMs?, isFile?, isDirectory? }`. Missing paths and a missing parent are normal
`{ exists: false }` values. Other failures such as permission errors fail the step rather than masquerading as
absence.

`ctx.fs` intentionally has no write methods. Agent writes are patch-producing steps; reviewed file edits,
patch integration, Git operations, and explicitly gated commands are the controlled mutation paths.

### `ctx.exec(file, args?, options?)`

Executes a program directly without a shell:

```ts
const result = await ctx.exec("pnpm", ["test", "--filter", "@acme/api"], {
  key: "test:api",
  cwd: ".",
  timeout: "10m",
});
```

Without a schema it returns `{ exitCode, stdout, stderr }`. A non-zero exit is data, not automatically a thrown
error; inspect `exitCode` or use `ctx.check` when pass/fail semantics are the goal. Spawn failures, cancellation,
and timeouts fail the step.

With `schema`, stdout must be JSON and validate against the schema; the typed value is returned:

```ts
const manifest = await ctx.exec("node", ["scripts/manifest.mjs"], {
  key: "manifest",
  schema: Manifest,
});
```

`risk` routes the command through `ctx.gate` semantics before execution. `env` accepts ordinary strings and
`ctx.secret()` handles.

### `ctx.bash(command, options?)`

Runs a command through `/bin/bash`. It has the same raw/schema return forms, cwd, timeout, env, risk, and key
behavior as `ctx.exec`.

Prefer `exec` for fixed argv because it avoids shell interpolation. Use `bash` for pipelines, redirection, or
shell syntax that is intentionally part of the operation.

### `ctx.env.get(name)`

Returns a journaled `string | undefined` environment value. Because the value is stored in the journal, do not
use this for credentials or sensitive material.

### `ctx.secret(name)`

Returns an opaque `SecretHandle` immediately; it does not reveal the value to workflow code. The engine resolves
the named environment variable only on the live execution path of `exec`, `bash`, or `fetch`, and journals
`<redacted>` instead.

```ts
const token = ctx.secret("SERVICE_TOKEN");
const response = await ctx.fetch("https://api.example.com/v1/jobs", {
  headers: { authorization: token },
});
```

Keep the handle opaque. Do not stringify it into command text or HTTP bodies; pass it through supported `env`
or `headers` fields.

### `ctx.fetch(url, options?)`

Performs a journaled HTTP request. Options include `method`, `headers`, string `body`, `timeout`, and `key`.

Without a schema it returns `{ status, headers, body }` for any HTTP status. With a schema, Weft requires a 2xx
response, parses the body as JSON, validates it, and returns the typed value.

```ts
const job = await ctx.fetch("https://api.example.com/v1/jobs/42", {
  key: "job:42",
  timeout: "30s",
  headers: { authorization: ctx.secret("SERVICE_TOKEN") },
  schema: Job,
});
```

If `fetchAllow` is configured, every redirect hop must match the hostname allow-list. Weft follows at most five
redirects in its policy-aware path. Credential headers and all secret-backed headers are stripped on a
cross-origin redirect. Secrets and allow-list checks occur only during live execution; a replayed response does
not resolve credentials or contact the network.

## Git

All Git methods run in `ctx.run.cwd` and are journaled. Read methods do not ask for approval. Write methods have
a fixed minimum risk tier and pass through the approval policy. A call's `risk` option may raise that tier but
never lower it.

### Git read methods

#### `ctx.git.status()`

Returns `{ branch, clean, staged, unstaged, untracked }`.

#### `ctx.git.head()`

Returns `{ sha }` for `HEAD`.

#### `ctx.git.branches()`

Returns `{ current, all }`.

#### `ctx.git.mergeBase(a, b)`

Returns `{ sha }` for the merge base of two refs.

#### `ctx.git.changedSince(ref)`

Returns `{ files: Array<{ path, status }> }`, where status is `A`, `M`, `D`, or `R`. The comparison is based on
the merge base with `HEAD` and includes working-tree and untracked changes.

#### `ctx.git.diff(range?)`

Returns `{ patch, stats, ref? }`. `range` accepts `from`, `to`, and `paths`; omitted bounds compare `HEAD` to the
working tree.

#### `ctx.git.log(options?)`

Returns `{ commits }` with SHA, author, date, subject, and body. Options accept `from`, `to`, `paths`, and `max`.

#### `ctx.git.show(ref)`

Returns `{ content }` for a Git object/ref.

#### `ctx.git.blame(path, options?)`

Returns `{ lines }` with line number, SHA, author, and content. `options.lines` limits the result to a
`[start, end]` tuple.

#### `ctx.git.fileAt(ref, path)`

Returns `{ content }` for one path at a ref.

#### `ctx.git.snapshot()`

Records the current tracked working-tree state as a reusable commit-like ref without moving `HEAD` or the
index. A clean tree returns the current `HEAD` ref. This is a read-classified capture, not a checkout.

### Git write risk tiers

| Minimum risk | Operations |
| --- | --- |
| `low` | `add`, `commit`, `branch.create`, ordinary `checkout`, `fetch`, `stash.push`, `stash.pop`, `tag` |
| `medium` | `pull`, soft/mixed `reset`, `apply`, `stash.drop`, discard checkout |
| `high` | ordinary `push` |
| `irreversible` | force push, hard reset, branch delete, clean |

### Git write methods

#### `ctx.git.add({ paths, risk? })`

Stages the listed paths.

#### `ctx.git.commit({ message, paths?, risk? })`

Commits either the selected paths or the staged state and returns `{ sha }`. On resume, a served completion is
accepted only while the commit still exists in `HEAD` history.

#### `ctx.git.checkout(ref, { discard?, risk? }?)`

Checks out a ref. `discard: true` is a higher-risk path-restoration operation. An ordinary checkout is
re-established on resume when the working tree has moved to a different branch/ref.

#### `ctx.git.fetch({ remote?, risk? }?)`

Fetches a remote, defaulting to `origin`.

#### `ctx.git.pull({ remote?, branch?, rebase?, risk? }?)`

Pulls the selected/default upstream.

#### `ctx.git.push({ remote?, branch?, setUpstream?, force?, risk? }?)`

Pushes the selected/default branch. `force: true` raises the fixed tier to `irreversible`.

#### `ctx.git.reset({ to, mode?, risk? })`

Resets to a ref. Mode defaults to `mixed`; `hard` is irreversible.

#### `ctx.git.apply({ patch, threeWay?, risk? })`

Applies patch text, optionally with Git's three-way mode. The journal identity stores a hash of the patch rather
than duplicating its contents.

#### `ctx.git.tag(name, { ref?, risk? }?)`

Creates a tag and returns the commit SHA it points to. Resume verifies the exact tag namespace and target; it
does not allow a same-named branch to stand in for a missing tag.

#### `ctx.git.branch.create(name, { from?, checkout?, risk? }?)`

Creates a branch, optionally checking it out. Resume verifies both branch existence and, when requested, the
active checkout.

#### `ctx.git.branch.delete(name, { force?, risk? }?)`

Deletes a branch. The operation is classified as irreversible even without `force`.

#### `ctx.git.stash.push({ message?, risk? }?)`

Pushes a stash entry.

#### `ctx.git.stash.pop({ risk? }?)`

Pops the latest stash entry.

#### `ctx.git.stash.drop({ risk? }?)`

Drops the latest stash entry. This is at least medium risk because the saved state is removed.

#### `ctx.git.clean({ force?, risk? }?)`

Cleans untracked files according to the Git adapter's operation. It is always classified as irreversible.

For agent-produced patches, prefer `ctx.integrate()` over reconstructing patch landing with low-level Git
methods. `integrate` understands Weft's patch journal, quarantine state, replay verification, and conflicts.

## Checks, patches, and notes

### `ctx.check(definition, input?, options?)`

Runs a reusable check created by `defineCheck()`:

```ts
const result = await ctx.check(typecheck, { package: "api" }, {
  key: "check:typecheck:api",
  policy: "required",
  timeout: "10m",
});
```

A check result has `status: "pass" | "fail"`, optional summary/evidence/details, and a disposition of
`"executed"`, `"trusted"`, or `"waived"`.

Reusable checks may run a callback or construct an argv command. Input schemas are validated before execution.
Definitions declare `advisory` or `required`; an invocation can strengthen advisory to required but cannot
weaken required. A failed required check may be returned so the workflow can inspect it, but it is also recorded
and prevents a successful run completion.

Invocation policy:

- `trust: { run, reason }` reuses evidence only for a revisioned definition when the named completed run
  contains a compatible executed pass with the same definition name, revision, and validated-input hash.
- `waive: { reason, issue?, expiresAt? }` produces a passing result with `disposition: "waived"` and preserves
  the stated rationale.

### Check suites

Passing a `defineCheckSuite()` definition runs its members concurrently and returns
`{ passed, results: Record<name, CheckResult> }`. A parameterized suite validates its input, resolves named
member definitions and inputs, and returns results under those member names. Suite options can set
`keyPrefix`, strengthen all members to required, override timeouts, and override concurrency.

### Legacy check forms

These remain public for compatibility but reusable definitions are preferred:

```ts
await ctx.check("typecheck", { exec: ["pnpm", "typecheck"], required: true });
await ctx.check.exec("typecheck", ["pnpm", "typecheck"], { required: true });
await ctx.check.fn("manifest", async (signal) => validateManifest(signal));
await ctx.check.trust("typecheck", { run: "r-previous", reason: "same artifact" });
await ctx.check.skip("platform-test", "requires macOS");
```

The direct `ctx.check(name, options)` form requires exactly one source: `exec`, `fn`, `trustPrior`, or `skip`.
Command checks pass on exit code zero. Callback checks accept a boolean or a structured check result and receive
an abort signal for timeout handling. Legacy callback checks rerun on resume because their closed-over inputs
are not visible in step identity. The `exec`, `fn`, `trust`, and `skip` properties are deprecated convenience
forms; use `defineCheck()` plus invocation `trust`/`waive` for new workflows.

### `ctx.integrate(results, options?)`

Lands patches returned by `ctx.agent.detailed()` or passed as `PatchRef` values, in array order:

```ts
const ledger = await ctx.integrate(fixes, {
  order: "sequential",
  onConflict: "fail",
});
```

`order` currently supports only `"sequential"`. The returned ledger contains `merged`, `conflicts`,
`quarantined`, and `skipped` patch keys.

- Results without a patch are skipped.
- Strict-scope violations are quarantined and never applied.
- `onConflict: "fail"` restores the pre-apply files and throws.
- `onConflict: "ask"` lets a person skip the patch, keep conflict markers, or abort.
- `onConflict: "agent"` runs a strict in-place resolver limited to the conflicted files and independently
  verifies that conflict markers are gone.

Integration snapshots support rollback, and resume verifies that previously merged patch content still exists
before serving the recorded completion. This is the standard way to land agent changes.

### `ctx.discard(results)`

Marks the supplied agent patches or patch refs as deliberately discarded. It does not modify the integration
tree. Passing results with no patches is a no-op.

Every produced patch should end in `integrate` or `discard`; dangling patches fail run settlement.

### `ctx.note(note)`

Adds a journaled semantic note to the report:

```ts
await ctx.note({
  kind: "decision",
  text: "Kept the compatibility path for one release.",
  evidence: "tests/compat.test.ts",
});
```

`kind` is `"decision"`, `"claim"`, or `"risk"`. Use notes for conclusions worth preserving independently of
logs. `evidence` is optional prose or a reference meaningful to the reader.

## Durable workflow tasks

`ctx.tasks` operates on workflow-scoped durable records. The workflow must declare a stable `meta.id` and task
contract, and the host must provide a task tracker. All operations are journaled and idempotent.

Task selectors are conjunctive across fields and alternative within a field. They support `ids`, `dedupeKeys`,
`statuses`, `tags`, `relatedFiles`, and `limit` (default 50, host-capped).

### `ctx.tasks.observe(selector, { key })`

Returns a bounded snapshot:

```ts
const snapshot = await ctx.tasks.observe(
  { statuses: ["todo", "in_progress"], tags: ["security"], limit: 25 },
  { key: "tasks:security:open" },
);
```

The result is `{ total, truncated, tasks }`. Each task is a bounded summary containing identity, revision,
title, description, lifecycle, priority, tags, dependencies, related files, acceptance criteria, latest note,
typed extensions, and update time.

An observation is replay-stable: a new run reads fresh state, while a resume reuses what that step originally
saw. This prevents task changes made during a suspension from silently changing already-decided control flow.

### `ctx.tasks.upsert(spec)`

Converges one recurring logical task by workflow-scoped `dedupeKey`:

```ts
await ctx.tasks.upsert({
  key: `task:upsert:${finding.fingerprint}`,
  dedupeKey: `finding:${finding.fingerprint}`,
  set: {
    title: finding.claim,
    description: finding.evidence,
    status: "todo",
    priority: "high",
    tags: ["code-review"],
    relatedFiles: [finding.file],
    acceptanceCriteria: ["Regression test added", "Fix merged"],
    extensions: { firstSeenSha: sourceSha },
  },
  note: `Observed in run ${ctx.run.id}`,
});
```

For a new task, omitted optional fields receive create defaults. For an existing task, only supplied fields are
updated; the optional note is appended atomically. `key` identifies the journal step, while `dedupeKey`
identifies the persistent logical task.

The legacy overload `upsert(dedupeKey, { create, update?, note? }, { key })` remains available when create and
update policy intentionally differ.

### `ctx.tasks.update(id, input, { key })`

Updates selected task fields. `acceptanceCriteria` replaces the criteria list; matching criteria keep their
state unless `resetAcceptance` is true. `ifRevision` enables optimistic concurrency.

### `ctx.tasks.note(id, text, { key, ifRevision? })`

Appends a task note, optionally guarded by task revision.

### `ctx.tasks.setCriterion(id, criterionId, met, { key, ifRevision? })`

Marks one stable acceptance-criterion ID met or unmet, optionally guarded by revision. Use IDs returned by
`observe`; criterion text is not the mutation identity.

Task mutations are validated against the workflow's current task contract and applied after the journaled step
settles. Typed extension input may differ from stored extension output when the Standard Schema transforms it.

## Durable waits and journaled values

### `ctx.signal(name, schema, options?)`

Waits for an externally delivered named signal and returns its schema-validated payload:

```ts
const deployment = await ctx.signal(
  "deployment.finished",
  z.object({ deploymentId: z.string(), status: z.enum(["succeeded", "failed"]) }),
  { timeout: "2h" },
);
```

The incomplete step is reused across resume, so a timeout continues from its original deadline instead of
starting over. An invalid delivery is durably rejected, allowing a corrected later signal to proceed. A valid
payload is journaled and replayed.

### `ctx.sleep(duration)`

Creates a durable timer. Resume waits only the remaining time from the original schedule; it does not restart
the full duration. The engine records the timer firing before the step completes.

### `ctx.now()`

Returns the host clock as journaled epoch milliseconds. Replays return the recorded value.

### `ctx.random()`

Returns a journaled `Math.random()` draw in `[0, 1)`. Replays return the same draw.

### `ctx.uuid()`

Returns a journaled random UUID. Replays return the same UUID.

These methods are asynchronous because crossing the journal is the feature. Do not replace them with ambient
globals merely to avoid `await`.

## Structure, logging, and run metadata

### `ctx.phase(name)`

Announces a phase and returns an immutable context bound to it:

```ts
const review = ctx.phase("Review");
await review.agent("Review the parser", { key: "review:parser", schema: Review });
```

Nested phase handles produce paths such as `Review / Verify`. The name must be non-empty.

Ignoring the return value preserves the legacy statement-style pattern:

```ts
ctx.phase("Review");
await ctx.agent(/* ... */);
```

Prefer the returned handle when phases may overlap or run concurrently. Immutable handles prevent one lane's
phase from changing a sibling lane's journal grouping.

### `ctx.log(message)`

Emits a workflow log message for live observability and the run record. It returns `void` and is not a typed
data dependency. Use `ctx.note()` when a decision, claim, risk, or evidence should be promoted into the semantic
report.

### `ctx.budget`

A live read-only view, not a method:

```ts
ctx.budget.spent;     // { tokens, usd }
ctx.budget.remaining; // { tokens: number | null, usd: number | null }
```

`null` remaining means that axis is unlimited. The getter reflects current spend, including completed child
workflow usage. Budget checks occur at agent admission and charge boundaries; this view is for workflow policy
and observability, not a reservation.

### `ctx.run`

Read-only metadata for the current run:

```ts
ctx.run.id;      // durable run ID
ctx.run.cwd;     // integration working directory
ctx.run.baseRef; // optional base ref supplied by the host
ctx.run.depth;   // 0 for root, increasing in child workflows
```

Use `run.id` for provenance and task occurrence notes. Use stable workflow IDs and step keys—not the run ID—when
identifying logic that should recur across runs.

## Recommended patterns

### Required fan-out

```ts
const results = ctx.all(
  await ctx.parallel(items, runItem, { concurrency: 4 }),
);
```

### Deliberately tolerant fan-out

```ts
const results = ctx.successes(
  await ctx.parallel(items, runOptionalItem, { concurrency: 4 }),
);
```

### Patch-producing work

```ts
const fixes = ctx.successes(
  await ctx.parallel(files, (file) =>
    ctx.agent.detailed(`Fix ${file}`, {
      key: `fix:${file}`,
      schema: FixSummary,
      write: { paths: [file], mode: "strict" },
    }),
  ),
);

const accepted = fixes.filter((fix) => shouldLand(fix.value));
const rejected = fixes.filter((fix) => !shouldLand(fix.value));
await ctx.discard(rejected);
const ledger = await ctx.integrate(accepted, { onConflict: "fail" });
```

### Transparent reuse versus child workflow

Use `ctx.recipe()` for a reusable typed function whose nested steps belong directly to the current run. Use
`ctx.workflow()` when the unit needs an independent budget, durable contract, run ID, or suspension lifecycle.

### Human choice versus risk approval

Use `ctx.human.ask()` for typed business input, `ctx.human.approve()` for an unconditional human checkpoint,
and `ctx.gate()` when the host's action/risk approval policy should decide whether a person must be asked.

### Secret handling

Use `ctx.env.get()` only for non-sensitive configuration. Use `ctx.secret()` and pass the handle directly in
`exec`/`bash` environment maps or `fetch` headers for credentials. Never interpolate a secret handle into text.

### Replay-safe loops

Give repeated calls stable logical keys. For sequential collections, prefer `ctx.sequence()` and
`item.key(local)`. For concurrent collections, derive keys from stable item identity rather than array index.
