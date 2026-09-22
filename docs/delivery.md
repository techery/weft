# Owned workspaces and recoverable delivery

Status: executable in this checkout. These APIs extend the existing SDK/engine; they do not make the declaration-only prototype executable. Publication and live-provider acceptance are separate release gates.

Start with [the reviewed-PR example](../examples/12-reviewed-pr/README.md). Its tests run real scratch Git workspaces with mock agents and remote operations. Ordinary review-only and patch-producing workflows retain their existing contracts.

## Small authoring contract

| Intent | SDK API | Runtime guarantee |
| --- | --- | --- |
| Own a coding candidate | `defineWorkflow({ workspace: { branch, from?, prepare?, fingerprintFiles? }, ... }, run)` | New branch/worktree starts at a committed ref; ownership, registration and branch are authenticated on resume; existing branch names are refused |
| Make a candidate | `ctx.workspace.snapshot({ key })` | Requires a clean committed tree; records head, tree, generation and environment fingerprint |
| Check current code | `ctx.verify(candidate, checks, { key })` | Executes static named checks freshly and checks candidate identity before/after each; only executed passes mint a proof |
| Publish verified work | `ctx.delivery(definition, input, { key, candidate, proofs, approval? })` | Rechecks candidate/proofs before and after human waits; invokes a host-bound recoverable operation |
| Make a recoverable external call | `ctx.operation(definition, input, { key, requestId?, timeout? })` | Records intent before dispatch and a receipt before ordinary step completion; uncertain outcomes reconcile on resume |

Use stable semantic keys for repeated writes and waits: `ctx.git.commit({ message, key })` and `ctx.sleep('30s', { key })`. Use keyed lanes for required fan-out and `defineProcedure` for named same-run reuse; see the [composition ADR](adr/0001-composition-replay-semantics.md).

`ctx.workspace` exists only in a workflow declaring an owned workspace. Write agents use that worktree with strict scope by default; explicit `isolation: 'worktree'` keeps the existing patch/integrate path. Owned-workspace mutation wrappers serialize agents, commands, Git writes, integration and file reviews against verification/delivery. This is execution coordination, not an operating-system sandbox. Out-of-process edits are detected at candidate boundaries; providers and host executors still require trusted configuration.

Preparation commands run through journaled execution and must tolerate repetition after an interrupted attempt. Uncommitted source-checkout edits are **not** copied into a new owned worktree. Environment identity includes Node/platform/architecture, workspace declaration, and explicitly declared `fingerprintFiles` bytes in addition to the committed tree. Declare ignored toolchain/preparation metadata when it matters; the engine does not infer every dependency, network input or environment variable.

Candidate and proof objects are runtime-issued authority within one execution. JSON copies, spread copies and cross-run objects are rejected. On resume the workflow re-enters, observes the retained workspace, and re-verifies; it does not deserialize an old proof into current publication authority. New code requires a new candidate and new approval.

## Checks, repair and waivers

Existing `required` checks still gate final run completion; failure history is not silently erased. Use `purpose: 'diagnostic'` in exploratory repair loops, or use candidate verification: a failed candidate keeps its evidence but a repaired, newly committed candidate may pass.

Unrevisioned callback checks re-execute on resume because closure inputs cannot be established from a stable key. Versioned checks may retain historical results outside candidate verification. `ctx.verify` always requests fresh execution, including command checks. Check definitions supplied to it must be static (no unbound input schema), non-empty and uniquely named.

New invocation waivers require a reason, validate any expiry, preserve a failed verdict with `disposition: 'waived'`, and cannot waive a required check. Trusted/waived historical results never mint delivery proofs. Legacy `ctx.check.skip` behavior remains for compatibility; it is not promotion authority. Organization-specific exception authorization is intentionally not inferred from a prose reason.

An independent review can be a named check whose callback invokes a separate read-only agent, as in example 12. That binds the observed verdict to the exact candidate and prevents missing reviewers from becoming success. It does not establish statistically independent model judgment or replace deterministic acceptance tests.

## Trusted host bindings

Workflow code defines schemas and names a binding with `defineOperation`/`defineDelivery`. The host supplies the executor and reconciler via `new Engine({ operations })` or `createWeft({ operations })`. Definitions cannot supply a remote executor or lower its host risk. A delivery-only binding rejects generic `ctx.operation`, and its `requiredChecks` manifest must be covered by current proofs. This verifies execution/evidence plumbing, not the semantic quality of arbitrary check definitions in untrusted workflow code.

The operation identity binds run/request, host binding, definition revision, parsed input, and delivery candidate. Changing input or candidate under an existing request is refused. Input bytes are captured before authorization waits. The host must establish `applied`, `not_applied`, or `unknown` on reconciliation; only proven absence permits another dispatch. An execution/reconciliation timeout or lost acknowledgement remains actionable recovery, not proof that nothing happened. Host implementations must honor cancellation and must not return `not_applied` while a previous remote attempt can still commit.

A recorded receipt prevents repeated dispatch after a crash between receipt and step completion. Generic shell commands remain generic shell commands: wrapping `git push` or `curl` in `ctx.exec` does not give them this recovery protocol.

If a host callback ignores cancellation or its timeout, the engine reports recovery promptly but retains and renews the live run's ownership lease until that callback settles. It refuses another dispatch in the same live engine and does not journal a late successful receipt. This fences cooperating local engines; after process loss, the adapter's durable reconciliation still has to establish the remote outcome.

### GitHub opt-in

The host API, outside workflow code:

```ts
import { createWeft } from '@techery/weft-host';

const token = () => {
  const value = process.env.GITHUB_TOKEN;
  if (!value) throw new Error('GITHUB_TOKEN is required by this host');
  return value;
};

const weft = await createWeft({
  cwd: process.cwd(),
  githubReviewedPr: {
    owner: 'your-org', repo: 'your-repo', base: 'main',
    branchPrefix: 'weft/', draft: true,
    requiredChecks: ['tests', 'independent-review'], token,
  },
  githubPrFeedback: {
    owner: 'your-org', repo: 'your-repo',
    requiredChecks: ['CI / test'], requiredApprovals: 1, token,
  },
});
// Resolve/persist/start a workflow through the host, then close it when the host exits.
await weft.close();
```

`github.reviewed-pr` accepts only title/body. Owner, repository, base, writable branch namespace, publication mode and credentials belong to host configuration. Git push uses existing host Git credentials; tokens are not embedded into the remote URL or workflow journal. The adapter authenticates the local repository/worktree, validates its push destination, pushes the exact commit using a create-only ref lease, then verifies Git and GitHub agree. Existing branches at a different head are not overwritten. The empty-expected-value lease requires an absent ref; it is not permission to force-update an existing branch. [Git push documentation](https://git-scm.com/docs/git-push).

PR lookup includes closed requests and paginates with a configured bound. A durable request marker identifies the exact request/candidate. Closed, moved, duplicate-marker or unrelated existing PRs remain unknown. Before POST the host persists a creating-phase record; if POST may have succeeded but no matching PR is visible, it will **not** repeat creation based only on an empty list. Keep `.weft/github-delivery` together with run journals when restoring a host. See the [GitHub pull request API](https://docs.github.com/en/rest/pulls/pulls) and [Git reference API](https://docs.github.com/en/rest/git/refs).

`github.pr-feedback` takes PR number and expected head. Each poll uses a distinct operation key. It reports exact-head CI/check statuses and current-head review evidence as `passed`, `failed`, `pending` or `unknown`; missing/unreadable/moved evidence does not become a pass. Local proof names and remote CI context names are separate policies. A pass is **not** a branch-protection decision, merge permission or merge receipt. See [check runs](https://docs.github.com/en/rest/checks/runs), [commit statuses](https://docs.github.com/en/rest/commits/statuses) and [reviews](https://docs.github.com/en/rest/pulls/reviews).

The adapter supports GitHub.com, same-repository, create-only PR delivery. It does not auto-merge, force-update a PR after feedback, auto-close PRs, bypass repository protection, manage forks, or provision credentials. Feedback repair can be an explicit subsequent workflow/decision with its own code and authority boundaries.

## Operations and recovery

Inspect `weft status`, `weft report`, `weft workspace`, MCP `weft_inspect`, or the manager queue/run detail. The shared journal projection includes owned workspace, candidates, verification history, operation intent/receipt/unknown state, delivery receipt and bounded provider activity. Recovery is an actionable attention state; the underlying legacy run status remains compatible (`failed` with `recovery_required` where appropriate).

Choose resume intent explicitly for operational runs:

```sh
weft resume RUN --mode strict        # verify current source matches recorded identity
weft resume RUN --mode retained      # load saved source/UI, then verify strict identity
weft resume RUN --mode edit-tolerant # deliberately allow source evolution; current default
```

Retained resume does not restore old installed dependencies: changed or missing dependency provenance is refused. A running daemon wakes due sleeps and signal/human timeouts under a lease with retained-first strict identity, including after restart; unsafe identity becomes attention instead of unattended code migration. This is local daemon scheduling, not a distributed scheduler.

`weft workspace RUN --cleanup` is explicit terminal-run maintenance. It acquires the run and descendant leases, authenticates ownership/parentage and the exact marker/registration/branch/repository, refuses active descendants, unknown operations and dirty/ignored files, and removes only the owned worktree. The branch and commits remain recoverable. There is no automatic deletion on failure, cancellation or ambiguous remote success.

Keep source/bundle provenance, journals, blobs, ownership metadata and operation phase records together. Restoring just a report or serialized candidate cannot restore execution authority. See [evaluation and compatibility evidence](evaluation.md) for exercised scenarios and what remains a live release gate.
