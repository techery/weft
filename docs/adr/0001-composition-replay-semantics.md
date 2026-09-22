# Composition and replay semantics

Status: accepted for the additive SDK implementation, 2026-09-04.

The runtime and declaration-only prototype must agree about the behavior of a composition boundary. New
contracts build on the existing execution kernel and preserve the callable SDK's legacy behavior.

## Boundary contract

| Boundary | Identity and code changes | Resume behavior | Context and cancellation | Failure and visibility |
| --- | --- | --- | --- | --- |
| Plain function | No engine identity | Body re-enters | Whatever the caller explicitly passes | Ordinary exceptions; nested effects visible |
| `ctx.scope()` | No identity change | Defaults reconstructed | Inherits supplied defaults; creates no authority | No independent status; nested effects visible |
| `parallel.all/settled` lane | Call key plus unique semantic item key, independent of array position | Mapper re-enters; leaves replay | Calling context plus `itemKey`, same cancellation and budget | Duplicate keys fail before dispatch; all lanes settle; `all` throws first input-order failure, `settled` preserves outcomes; cancellation propagates |
| Procedure | Invocation key, definition name/revision/body source/schema projections, parsed input | Body always re-enters; nested effects replay or reconcile | Contravariant typed context requirement; optional host-readable manifest; same run/workspace/budget/cancellation | Schema failures fail the call; named start/completion/failure, digests and duration in journal/state |
| Child workflow | Separate child run with keyed parent invocation | Parent re-enters child; child journal governs its effects | Explicit child inputs/budget; engine cancellation propagation | Independent run lifecycle and journal |
| Legacy recipe/step | Existing effect identities | Body re-enters | Existing SDK behavior retained | No newly inferred namespace or aggregate cache |

Procedure `revision` is an explicit semantic binding. The engine also hashes body source and schema projections,
but those cannot reflect a changed imported helper, closure capture, or schema refinement. Authors increment the
revision when those dependencies change. Parsed input changes also invalidate nested identity. Procedure leaves
use content matching even under key-based salvage; a stable key alone cannot waive changed procedure meaning.

Procedure output digests support diagnostics, not aggregate memoization. A completed procedure cannot bypass
freshness checks on a nested Git effect, candidate verification, or reconciliation of an external operation.
Pure aggregate memoization and composite validity proofs are not part of this contract.

Namespaces use slash-separated URL-encoded segments. They apply centrally to steps and human requests, including
keyless-effect identity. Presentation labels are separate and can change without invalidating work. A duplicate
procedure or fan-out invocation key fails during the same run pass, even for an empty body. A new resume pass
reconstructs these reservations from execution rather than treating a previous pass as a duplicate.

## Supported and proposed surfaces

| Surface | State | Compatibility decision |
| --- | --- | --- |
| SDK `defineProcedure` / `ctx.procedure` | Executable additive API | Prefer for new named same-run composition |
| SDK `parallel.all` / `parallel.settled` | Executable additive API | Explicit outcome modes and local lane keys |
| SDK `parallel`, `sequence`, `pipeline`, `recipe`, `step` | Existing executable behavior | Retain stored identity/failure contracts; no automatic reinterpretation |
| SDK task contracts | Persistent cross-run state | Preserve stable workflow identity, dedupe, semantic revision, schema version and migration |
| `@techery/weft-dsl-proto` | Declaration-only design package | Never load as an executable workflow dependency |
| Prototype procedure detailed receipts, review-context mode, proof-carrying interfaces | Design contracts | Do not infer availability from prototype typechecking; SDK exports determine executable support |

TypeScript capability annotations express requirements and preserve task extension types. An explicit optional
`requires` manifest is exposed to hosts and checked for available top-level names. Type annotations alone do not
create a runtime whitelist or isolate arbitrary JavaScript; a procedure is not a security boundary. Capability
confinement for provider tools remains the host's responsibility.

## Migration

1. Keep plain helpers for calculations and incidental reuse.
2. Replace a named recipe with `defineProcedure` only when its caller supplies a stable invocation key. Remove
   caller-prefix plumbing from leaf keys; do not change ordinary business inputs to carry orchestration identity.
3. Replace required fan-out with `parallel.all`; use `parallel.settled` only where failure coverage is explicitly
   evaluated. Choose semantic IDs that distinguish findings sharing a source location.
4. Keep existing histories on their original API until a deliberate resume preview or new run boundary. New
   namespace/binding hashes will not silently reuse global recipe keys or remove an existing failure policy.
5. Keep persistent tasks under the existing workflow ID. A shorter task-contract API does not authorize dropping
   open backlog, cross-run recurrence, deduplication or schema migration.

Regression coverage lives in `packages/core/test/composition.test.ts` and
`packages/sdk/test/procedure.test.ts`: duplicate preflight, settle-before-throw, reordering, nested key isolation,
procedure re-entry, revision invalidation, freshness recovery, human identity and capability typing.

## Resume compatibility and durable deadlines

The existing edit-tolerant policy remains the default for compatibility. `engine.resume(runId, {mode: "strict"})`
and `weft resume <run> --mode strict` instead require both the recorded body identity and executable bundle
fingerprint to match. Missing provenance or changed identity is refused before a new execution/lease/journal
mutation. Key-only salvage is incompatible with strict mode. This is an identity check, not a deterministic
VM: ambient inputs and host integrations remain subject to their effect contracts.

The existing `weft replay --dry <run> --reuse content` is the edit-tolerant compatibility preview; no second
planning DSL or command is introduced. It resolves the same current provenance and positional identity guards
as `weft resume <run> --mode edit-tolerant --reuse content`, reports reached hits/salvage/divergence/pending
requests, and stops at the first live-effect boundary on a path. Owned workspace inspection is read-only;
operation execute/reconcile is blocked by the common dry step boundary. This is not a sandbox for imports,
ordinary JavaScript, or schema transforms, nor a proof of future candidate freshness or complete cost estimate.

Current-definition resume loads registry/path workflows from current source. New CLI, daemon, and MCP starts
retain the emitted workflow bundle and its UI catalog separately from current-source provenance.
`--mode retained` loads that original source and applies strict identity checking; missing retention refuses
without falling back to edited source. The default remains current-source/edit-tolerant. Legacy inline runs
also retain their emitted script, but may not have the new retained manifest.
The executable fingerprint includes emitted source, current statically resolved external module bytes
and manifests, and toolchain identities. External dependencies are fingerprinted, not snapshotted; this does
not promise a retained dependency container or recovery after arbitrary runtime/library upgrades.

The daemon scans durable suspended waits at startup and periodically with bounded concurrency, caching
unchanged histories. Only an original deadline that is due may trigger automatic strict resume, using retained
source when present (otherwise strict current identity), protected by
the engine's durable ownership lease. Active and terminal runs are excluded. Interrupted `sleep` steps keep
the compatible `executing` status, so inactive executing journals are inspected for a due wait without
restarting arbitrary work. Identity failures become journaled `resume.blocked` attention, not automatic
edit-tolerant execution. Closing the daemon disarms its scheduler; a standalone stopped engine has no timer
process and needs an explicit resume or a running daemon.

An external operation timeout reports uncertainty without asserting that its adapter stopped. While the
original host call still exists in this engine, the run lease keeps renewing even after the failed result is
reported; reconciliation cannot race that call. Once it settles the lease releases. Shutdown stops renewal
but does not prematurely release an unresolved call. Process death still relies on the lease TTL and the
binding's reconciler: `not_applied` must establish that replay is safe, not merely that no result is visible yet.
