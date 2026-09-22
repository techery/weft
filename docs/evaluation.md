# Workflow evaluation and replay compatibility

The checkout includes a repeatable, model-free evaluation of executable workflow behavior. Run it with:

```sh
pnpm evaluate:workflows
pnpm test:evaluation
```

The first command prints JSON and exits nonzero when observed behavior differs from the checked-in expectations. For JSON without pnpm's command header, use `node --import tsx scripts/evaluate-workflows.ts`. The tests run every case twice against fresh engines and compare the complete reports; they also prove that an incorrect expectation and an empty selection cannot produce success.

CI and release configuration run the repeatability gate alongside the package tests. CI also executes every numbered example with a top-level runner and the portable cookbook, composition and reviewed-PR suites. The reviewed-PR portable suite is an explicit release gate; it remains a mocked remote integration, not live publication.

Inputs and expected observations live in [evaluate-workflows.cases.json](../scripts/evaluate-workflows.cases.json). [The runner](../scripts/evaluate-workflows.ts) executes the canonical review workflow, the composable example's actual review procedure, the standard library's diagnostic repair helper, and the engine's operation protocol. Every provider is a scripted mock, command fixtures are strict, and the external-operation binding mutates only an in-memory fixture. Temporary files stay inside automatically cleaned temporary directories.

## What the cases measure

| Case | Observable acceptance criterion |
| --- | --- |
| Distinct review findings | Two different claims at one location both survive; an identical claim on another line is deduplicated before refutation. |
| Failed review worker | Required reviewer failure rejects the run before refutation. |
| Bounded review fan-out | Twelve requested reviews admit four workers concurrently even when the host allows 32. A barrier makes admission measurement independent of machine speed. |
| Diagnostic repair | A fixture that passes after two repairs produces two repair calls and three independently recorded diagnostic calls. |
| Repair exhaustion | A one-repair budget returns the remaining failing evidence without claiming acceptance. |
| Procedure restart | Reconstructing the engine re-enters the procedure body and reuses its completed agent leaf without another provider call. |
| Operation reconciliation | A simulated apply followed by lost acknowledgement enters `recovery_required`; a new engine reconciles the existing result and does not execute it twice. |
| Missing effect fixture | A missing command fixture is rejected before launching a command. |

Reports contain counts and outcomes, with no timestamps, run ids, temporary paths, token estimates, or timing claims. The result is a deterministic regression baseline. Eight passing cases are evidence for those cases; they are not a model-quality score, production success rate, latency benchmark, or a comparison against another product. The restart cases reconstruct an engine over the same memory stores; they do not simulate an operating-system crash or disk corruption.

Provider quality and performance evaluation requires a separate dataset, model/provider versions, candidate commits, environment inventory, repeated trials, and a declared spend budget. Those measurements have not been performed by this command.

## Compatibility contract in this checkout

Current replay is effect-level and permits edited workflow code. [The engine](../packages/core/src/engine.ts) records the body hash and accepts an optional bundle hash. It trusts positional identity only when available hashes agree. [The replay index](../packages/core/src/replay.ts) first matches completion identity, then salvages unconsumed completions by content. Ambiguous keyless effects are re-executed when positions are no longer trusted. [Runtime freshness checks](../packages/core/src/runtime.ts) can refuse an otherwise matching completion.

The body hash includes `def.run.toString()` and the workflow's name; it cannot see changes inside an imported helper or a closed-over value. The bundle fingerprint now combines emitted source with the statically resolved external dependency graph: actual module contents, package manifests including nested module-mode declarations, dependency edges, and Node/esbuild versions. It detects local SDK/stdlib edits even when their package versions stay unchanged. It follows reachable imports only, with limits of 5,000 modules and 32 MiB; unimported documentation and tests do not contribute. Dynamic `import()` and function-scoped `require()` are refused because they could first load different bytes after fingerprinting.

Registry and recorded path loading pass the loaded fingerprint through [host resume options](../packages/host/src/weft.ts). New CLI, daemon and MCP starts also retain a write-once manifest, bundled workflow/relative-module source and UI assets independently of current-source references. This permits an explicit retained-source resume even after the original source file is edited or removed. Bare imports remain external: the retained loader re-fingerprints the currently installed dependencies and refuses missing or changed provenance. It does not archive an old dependency installation or every separately registered child workflow. The loader tracks shared external modules and refuses changed dependencies already loaded in this process instead of pairing a new fingerprint with Node's cached code. Restart the host after changing installed packages. Conditional exports are fingerprinted using each dependency edge's actual import or require mode.

External dependencies must remain immutable for the host process lifetime, including custom allow-listed modules imported by other host code. Known SDK dependencies are baselined when the loader initializes. Node does not expose the source provenance of arbitrary ESM modules cached before loader initialization, so the fingerprint is not proof of those preexisting instances; hosts must restart after dependency edits. Workflow source and bundled relative helpers retain their normal edit-tolerant reload behavior.

`weft resume RUN --mode strict` requires matching recorded and current body/bundle identities. `--mode retained` selects saved source/UI and then applies the same strict engine check; missing provenance is an error, not a silent fallback to current source. `--mode edit-tolerant` (the default) retains the existing migration behavior and may re-execute effects after code changes. Saved inline runs still use their recorded source in the default path. Legacy runs whose bundle stamp predates the dependency fingerprint cannot claim strict equality to the new format; their compatibility path is explicit edit-tolerant replay.

The running daemon discovers due journaled sleeps and signal/human timeouts, including deadlines left by a previous process. It wakes the owning root under a lease using retained-first strict identity, so an unattended wake does not silently opt into changed code. Unknown provenance produces recovery attention. The scheduler is host-local and requires a running daemon; it is not a distributed scheduling service. Manual/legacy answer wake retains the existing edit-tolerant compatibility path. [Deadline regressions](../packages/daemon/test/deadlines.test.ts) cover restart, child-to-root wake and a crash between timer firing and leaf completion.

Named procedures add a revision and input identity to the leaf execution scope and re-enter their bodies on resume. Changing a procedure revision invalidates its leaves even when the parent body and leaf prompt stay the same. Keyed lanes preserve item identity when input order changes. Existing recipes remain transparent helpers without an independent namespace. Migration to procedures therefore intentionally changes resolved leaf keys and may require a new execution; it does not promise automatic reuse of every historical recipe call.

The root-level `reuse: "key"` option can deliberately reuse stale content. Runtime execution inside a procedure uses content identity even under that option, preserving revision/input binding. Generic `exec` still needs an operation-specific freshness or reconciliation contract before its historical completion can authorize delivery. Candidate verification and recoverable operation receipts provide those stronger boundaries for supported delivery paths.

Persistent workflow tasks retain their workflow-owned, cross-run lifetime. The portable task-backed review suite executes two runs of the same logical finding and checks that one task retains its first-seen run while updating last-seen provenance. The evaluation does not migrate persistent tasks to run-local records.

## Remaining compatibility evidence gaps

1. Library users can still omit `defHash` when resuming supplied definitions. If the body text is unchanged but an imported helper changed, the engine has no bundle evidence that call-site positions moved. Supply the current bundle hash or use revisioned procedures with stable leaf keys. Historical journals that lack a hash are intentionally treated as unchanged for that missing stamp; this is a compatibility fallback with weaker evidence.
2. The dependency fingerprint covers the supported static module graph and toolchain identity. It does not capture arbitrary runtime data files, environment-dependent behavior, native service behavior, or a retained installation of previous dependencies. Hosts and adapters remain responsible for those execution boundaries.
3. A [frozen event-contract corpus](../packages/core/test/fixtures/history/7fe75e9.json) now preserves three vectors based on commit `7fe75e96a9de66143005d392ce6d554b7b98de1e`: completed review/check evidence, failed required attempts followed by a pass, and rejected human answers. Expectations were checked by executing that commit's reducer and replay index; current tests verify projections and replay salvage against the same vectors. These are explicitly hand-authored contract fixtures, not captured production runs. Full cross-release execution evidence still requires real journals captured by prior published engines, their producing versions, and expected resume outcomes.
4. Returning the same mock result after engine reconstruction does not verify a real provider's resumed session, permission enforcement, filesystem durability, or a remote service's idempotency semantics. Those need provider-specific integration runs and fault injection at the actual host/remote boundary.

Relevant focused regression suites are [replay](../packages/core/test/replay.test.ts), [composition](../packages/core/test/composition.test.ts), the [portable workflow tests](../.weft/workflows), and the [task-backed review tests](../examples/08-task-backed-code-review/task-backed-code-review/tests/main.test.ts). Keep their evidence separate from the deterministic case counts above.
