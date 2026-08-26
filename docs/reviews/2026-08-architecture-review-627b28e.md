# Architecture review — weft @ 627b28e

*Scope: current HEAD (627b28e), including the daemon + web UI (7d500a7) and the task-tracking subsystem (627b28e). The prior review (`docs/reviews/2026-08-dx-and-architecture.md`, commit ad5ecae) is treated as acted-on; findings it fixed are not repeated, findings it half-fixed are called out as such.*

---

## 1. Verdict

Weft commits to one idea and carries it further than most systems that claim it: **the journal is the only truth, and everything else is a projection or a cache over it**. Steps are content-addressed (`hashStep(kind, payload, schema, key)`, `packages/core/src/canonical.ts:35`), effects are made durable through a four-verb contract (`execute`/`revive`/`onSettle`/`verifyServe`, `packages/core/src/runtime.ts:505-623`), humans are ordinary suspended steps, agent writes never mutate a tree but produce a patch blob that only `ctx.integrate` may land, and every host — CLI, MCP, daemon — is a shell over one `Engine`. That architecture is sound. The substrate that implements it is genuinely excellent: `FsJournalStore.appendLocked` (`packages/store-fs/src/journal.ts:104-175`) treats only newline-terminated bytes as committed, cuts torn tails under a cross-process mutex after a *second* reconcile, loops `writeSync` against short writes and `fsyncSync`s before advancing its cache; `appendIf` is a real CAS re-tested after a post-steal fold; `Semaphore` (`packages/core/src/limiter.ts`) and `Budget.reserveCall` (`packages/core/src/budget.ts:186-210`) are both free of lost-wakeup windows and the lock order between them is total (`packages/core/src/ctx.ts:627` then `:635`). I could not lose or duplicate a committed record through the normal append path, and neither could the reviewers.

The defects are not in those mechanisms. They are all at seams, and there are exactly three ideas missing, each showing up three or four times:

**(a) The unit of ownership is the run tree plus its in-flight work; only the single run is modelled.** One `AbortController` is shared tree-wide (`packages/core/src/engine.ts:1210`) but `fence()` — the "you no longer own this journal, stay resumable" primitive — is per-runtime (`packages/core/src/runtime.ts:1200`), so a real lease loss makes the *other* half of the tree journal a durable `run.cancelled` (finding H2). Symmetrically `drive()` appends the terminal record and releases the ownership claim without aborting or draining live steps (`packages/core/src/engine.ts:959-996`), which `cancel()` and `shutdown()` both explicitly refuse to do — producing two processes appending to one journal, reproduced (finding H1).

**(b) The keyless-ambiguity guard the prior review added is a property of one match function, not of step identity.** `ReplayIndex.matchStep` computes `ambiguousKeyless` and consults `positionsTrusted` (`packages/core/src/replay.ts:294,311`); `matchHuman` is hash-only with no seq and no `key` on the public API (`packages/core/src/replay.ts:339-341`), so after any script edit a surviving `ctx.human.approve` consumes a deleted sibling's answer — a denial replays as an approval (finding C1, reproduced). The same guard is *counter-productive* for `ctx.now/random/uuid/sleep`, whose payloads carry no distinguishing content and which also have no `key`, so the "safe" re-run is definitionally wrong (finding H4, reproduced). And `replayDry` never computes the stamp at all (`packages/core/src/engine.ts:1986-1992`), so `weft replay --dry` disagrees with the resume it prices (finding H5, reproduced).

**(c) The integration working tree is the one shared resource with no coordinator.** Weft has an explicit owner for every other one — `Semaphore` for throughput, `Budget` for spend, `RunLease`/`owner.json` for a journal, a cross-process SQLite mutex for the task store, a CAS for every terminal append. `rt.cwd` has none, and every child inherits it (`packages/core/src/engine.ts:1360`). Two concurrent `ctx.integrate` calls each snapshot, apply, and — on conflict — blindly `git restore` their own pre-apply snapshot over whatever is on disk (`packages/core/src/ctx.ts:2495`), reverting a patch the other lane already journaled as `patch.merged`. Reproduced three ways, including through `ctx.parallel(ctx.workflow(...))`, the flagship composition. `IntegrateOptions.order?: "sequential"` (`packages/sdk/src/types.ts:548`) is declared, documented in the shipped agent skill, and read nowhere — the ghost of the abstraction that should exist.

**The single most important thing to fix is `ctx.integrate`.** Two independent, separately reproduced defects — the verify-refused re-execution that serves its own nested apply step (`packages/core/src/ctx.ts:2475`) and the unsynchronised rollback (`packages/core/src/ctx.ts:2495`) — each end with a green run, a ledger that says `merged`, a report that lists the change under "Changes", and a working tree that does not contain the patch. That voids README.md:35 ("a resume on a fresh clone rebuilds the tree from the journal") and it is the exact invariant the entire write/patch/scope discipline exists to produce. Everything else in the write path — `--no-renames` so both halves of a rename reach `checkScope`, `-z` throughout, one `scopeMatcher` shared by the live gate and the post-hoc check, never parsing a diff by hand — is right, which makes this the one place where a very well-built boundary produces a false negative silently.

The cheapest high-value patch, however, is finding C1: `matchHuman` needs the same contract `matchStep` already has, and the fix is a signature change plus a `key` on `AskOptions`. It is the only defect here where the system produces an operator-visible lie about a human decision.

---

## 2. Architecture assessment

### The core commitment is right, and the layering holds

The package graph is a clean DAG. `rg 'from "../../"' packages/*/src` returns nothing — there is no cross-package relative reach-in. Core never imports a host. The daemon really is a shell: `packages/daemon/src/state.ts:9` folds journals with core's own `reduceState`/`renderTree` rather than reimplementing them, and `packages/daemon/src/state.ts:19-24` deliberately re-folds rather than trusting the in-memory projection, with the reasoning written down. The two routes that could have reimplemented engine logic — resume and answer — call straight through and let the lease decide. The only module cycles are barrel↔impl (`packages/git/index.ts`↔`git.ts`, `packages/isolation/index.ts`↔`patch.ts`/`worktree.ts`) and all but one are type-only.

The four-verb step contract is the best abstraction in the codebase. `execute`/`revive`/`onSettle`/`verifyServe` is enough to express everything from `ctx.uuid()` to a worktree-isolated agent call with patch capture, priced-failure propagation and post-hoc scope checking, and `ctx.ts` is disciplined about staying a thin payload constructor over `rt.runStep`. `ctx.workflow` steps are `verifyServe: () => false` so a sub-workflow can never freeze an edited child's stale output. `OrderedDelivery` counts drained event-loop turns plus in-flight replay I/O rather than wall clock, which really does make signal delivery order a function of the journal rather than of machine speed.

### Where the layering is wrong

**The run/tree/step boundary (findings H1, H2).** `SharedRunResources` is the honest admission that some state is tree-scoped: it holds the budget, the abort controller, the agent counter, `positionsTrusted`. But *ownership* and *terminality* were left run-scoped. `fenceLostRun` (`packages/core/src/engine.ts:844-856`) is per-`ActiveRun` and never walks `active.children` or up to the parent, so it reaches the rest of the tree only as a plain abort — which the un-fenced half correctly interprets as a user cancellation and durably journals. And `drive()` publishes the terminal record and releases the claim while steps are still running, which is precisely the thing `shutdown()` refuses to do with a comment saying so (`packages/core/src/engine.ts:1847-1850`, "never release ownership over still-live work"). The missing type is something like `RunTree` owning `{ abort, lease, liveSteps }`, with fence/terminate/drain defined on it rather than on `RunRuntime`.

**Step identity is not a first-class concept (findings C1, H4, H5).** Identity is computed in one place (`packages/core/src/runtime.ts:509`) but *resolved* in three, with three different policies. The guard added in da85488 lives in `matchStep`; `matchHuman` never got it; the primitives that most need positional resolution (`now`/`random`/`uuid`/`sleep`) get the guard applied to them and are broken by it; and `replayDry` builds a `SharedRunResources` without the stamp at all. The right shape is a single `resolveEntry(kind, seq, hash, key, positionsTrusted)` that knows, per kind, whether ambiguity means "re-run" (agent — costs money, returns a valid answer), "re-ask" (human — the only side that cannot be wrong), or "resolve positionally" (`uuid` — reads no world state, so the Nth occurrence *is* the identity).

**The integration tree has no owner (findings C2, H3).** Discussed above. Note that the global limiter does not cover integrate or git steps at all — `globalLimiter.with` appears only at `packages/core/src/ctx.ts:627` (agent), `:1554` (exec), `:1691` (fetch), `:2176` (check) — so `limits.concurrency: 1` is not a mitigation, verified. The lock must live on the tree root, not on `RunRuntime`, because `packages/core/src/engine.ts:1360` hands every child `parent.cwd`.

**There is no timer service (finding M2).** Human deadlines are armed with an in-process `setTimeout` (`packages/core/src/runtime.ts:1096-1100`) and `ctx.sleep` waits `deadline - clock()` in-process (`packages/core/src/ctx.ts:2665-2685`). `detach()` clears them and defers to "the run's next owner" (`packages/core/src/runtime.ts:1163-1167`) — but nothing in the system creates that owner. The daemon wakes runs on answers and signals only (`packages/daemon/src/app.ts:312`, called from `:218` and `:233`) and does no adoption pass at startup. A durable wait whose only wake-up is a clock is durable only while a process holds it.

**Human-wait vocabulary is known to the runtime and not to its neighbours (findings H8, H9).** `runtime.awaitAnswer` deliberately decrements `inflightLive` (`packages/core/src/runtime.ts:1034`) so `Engine.suspensionOf` (`packages/core/src/engine.ts:891`) can fire and the run can *say* it is parked. Two other waits never learned that vocabulary: `Budget.reserveCall`'s park (`packages/core/src/budget.ts:203`) still counts as live work, so a budgeted run that parks on a person can never report it and `weft run` hangs with no question printed; and the whole agent lane sits inside `globalLimiter.with` (`packages/core/src/ctx.ts:627`), so a tool-permission gate holds an Engine-wide permit for the duration of a human's coffee break. Both are the same one-line-of-reasoning gap, and both are reproduced.

**The task subsystem is a second source of truth, deliberately — and the boundary is priced wrong (finding H12).** The choice not to derive tasks from any one journal is defensible: tasks are cross-run and cross-actor. The reconciliation machinery is good — `batchId` computed inside `execute` and journaled so it is replay-stable, `onSettle` short-circuiting on a durable batch marker, per-operation `appliedOperations` keys, and agent write authority bounded by `visibleTaskIds` derived from the *journaled* observation rather than a re-evaluated selector. But preflight validation is implemented by physically duplicating the entire store into a tmpdir (`packages/host/src/tasks.ts:988`), twice per batch, once *inside* the per-workflow mutex. Measured: 14.8 s of mutex-held work for a 50-op batch at 400 existing tasks, and a concurrent mutation gave up with "task store is busy" after 10.3 s. `examples/08-task-backed-code-review` is designed to accumulate exactly that backlog.

**The provider interface is right at the seam that matters and undeclared at its edges (finding M20).** The provider returns raw output and the *engine* validates (`packages/core/src/ctx.ts:1040`, revalidated from raw on replay at `:546-560`), so a lying vendor cannot smuggle a value past the contract. That is the correct choice. But `ProviderCapabilities` exists and only `reportsUsd` is ever read — one grep hit, `packages/core/src/ctx.ts:737`. `permissionHook` and `sessionResume` are declared and consulted nowhere. The engine populates `maxTurns`, `onMaxTurns`, `tools.deny` and `hitl` unconditionally and Codex silently drops all four (`packages/provider-codex/src/index.ts:136-152`), while `maxTurns` is nonetheless hashed into step identity. Per-step routing therefore does not yield interchangeable steps.

**The daemon's security model is one 10-line middleware (finding H13).** `packages/daemon/src/app.ts:85-97` is the entire boundary: a Host/Origin check with no authentication behind it, treating every loopback *port* as one trust domain and never seeing a cross-site no-cors GET at all. Everything *else* about the daemon's input handling is better than most production code — `jsonBody`, `budgetOf` refusing a misspelled axis, `parseConfig` before atomic temp+rename, blob refs pinned to 64 hex, the static reader rejecting NUL and backslash and prefix-checking after `resolve` — which makes the one missing piece conspicuous rather than characteristic.

**The UI has two disconnected models of freshness.** Lists poll (`apps/ui/src/api/queries.ts:50`); the run detail page relies entirely on SSE and explicitly does not poll ("The journal stream invalidates this", `apps/ui/src/api/queries.ts:69`). That SSE path drops the one frame type the daemon added for nested runs (findings M21), and replays the whole journal into React state quadratically to compute a value no component renders (finding M22). The rest of `apps/ui` is well built — `domain/adapt.ts` is a real anti-corruption layer and the best-tested file there, atomic design is actually respected, there is no `dangerouslySetInnerHTML` or markdown renderer anywhere.

**Packaging: the shapes are wrong, not the directions (finding L12).** `@techery/weft-host` is a bundle — the only home of `TaskStore` (1665 lines of durable store, `packages/host/src/tasks.ts`) *and* a hard dependency on both vendor SDKs. `@techery/weft-testing` imports exactly one symbol from it (`packages/testing/src/run.ts:22`) and thereby drags `@anthropic-ai/claude-agent-sdk`, `@openai/codex-sdk`, `esbuild` and `typescript` into a mock-only fixture harness. `TaskStore` is a store; it belongs beside `@techery/weft-store-fs`.

**Documentation drift.** README.md:391 still lists "the web UI is a single-file page served by the daemon, not a Vite + React app" as an honest deviation, while `apps/ui` ships a React SPA and is the default surface. README.md:399 claims "a keyless step whose content matches several journaled entries re-runs instead of guessing" — true for steps, false for humans (C1), and actively harmful for `uuid` (H4). The deviations list is one of this project's better habits; it needs a pass.

---

## 3. Findings

### CRITICAL

### [critical/soundness] Human/gate replay matches on hash alone — an edit serves one gate's approval to another gate — `packages/core/src/replay.ts:340`

`matchHuman(hash)` returns `this.humansByHash.get(hash)?.find((e) => !e.consumed)` — no seq, no `positionsTrusted`, no ambiguity guard, in contrast to `matchStep` (`replay.ts:284-337`) which computes `ambiguousKeyless` at `:311`. Identity is built at `packages/core/src/runtime.ts:947` as `hashStep("human", payload)` with no key argument, and `HumanEntry.seq` (`replay.ts:41`) is populated at `:222` and never read by any matcher. There is no caller-side escape: `HumanAskOptions`/`ApproveOptions`/`ReviewOptions` (`packages/sdk/src/types.ts:315-337`) expose no `key`, and `gateStep` (`runtime.ts:1332-1360`) funnels straight into `runHuman`, so `ctx.bash(..., {risk})`, `ctx.git` writes and `ctx.integrate` confirmations all share the keyless identity. `confirmToken` is derived from `sha256(action)` and is not in the hashed payload, so it does not disambiguate.

**Failure (reproduced):** v1 has two `ctx.human.approve({action:"ship?"})`; answer the first `{approved:true}` and the second `{approved:false}`; result `{a:'true', b:'false'}`. v2 deletes the first gate; `engine.resume(runId, {def: v2, defHash:'bundle-v2'})` serves the deleted gate's entry to the survivor — observed `SECOND GATE REPLAYED AS: true`. No `replay.diverged`, no log, run completes. Substitute `ctx.bash("rm -rf dist", {risk:"high"})` for the second gate and this is an approval the operator explicitly refused.

**Fix:** give `matchHuman` `matchStep`'s contract — take `seq`, `kind`, `positionsTrusted`; treat `humansByHash.get(hash).length > 1` as ambiguous; serve by seq when positions are trusted; otherwise append `replay.diverged` and **re-open the request**. Re-opening is the side that cannot be wrong for a human decision. In parallel add an optional `key` to `AskOptions`/`ApproveOptions`/`ReviewOptions` and to `gateStep`, folded in as `hashStep("human", payload, undefined, key)`.

### [critical/soundness] A verify-refused `integrate` re-executes but its nested apply step is served, so the patch is never re-applied — `packages/core/src/ctx.ts:2475`

`verifyServe` on the outer `integrate:<key>` step (`ctx.ts:2419-2444`) correctly refuses when the tree no longer holds the patch. But the actual work lives in two *nested* journaled steps — `integrate:snapshot:<key>` (`ctx.ts:2456-2474`) and `integrate:apply:<key>` (`ctx.ts:2475-2486`) — with unchanged payload hashes and no `verifyServe` of their own. `runtime.ts:538-545` → `replay.ts:313-317` serves them by seq+hash; nothing invalidates a re-executing parent's journaled children. `io.reExecuting` (`runtime.ts:739`) already exists for exactly this and is used by `ctx.git.tag`/`checkout` (`ctx.ts:1981`, `:2025`) — integrate just doesn't use it.

**Failure (reproduced twice, independently):** `ctx.agent.detailed("fix it", {key:"fix", write:{paths:["src/**"]}})` → `ctx.integrate([fix])` → `ctx.human.ask(...)`. Run 1 lands the patch and suspends. Roll the tree back out of band (`git checkout -- src/auth.ts`, a `reset --hard`, a reviewer undoing the edit), answer, resume. Observed journal: `replay.diverged seq 2 "journaled effect … no longer holds"`, a new `step.scheduled` for seq 2 **only** — no fresh schedule for the snapshot/apply children — then `patch.merged {baseTree: 1118798c…, resultTree: 1118798c…}` and `step.completed {applied:true}`. Run returns `{merged:["fix:auth"]}`; `src/auth.ts` still reads `export const fixed = false;`. Because the new completion's `resultTree` now matches the untouched tree, every later replay self-certifies — the loss is permanent.

*Verifier qualifier:* reaching it requires the integration tree to be rolled back out of band between the first execution and the resume — but that is precisely the situation `verifyServe` exists to catch, so **the guard is dead code in its intended case**.

**Fix:** pass `io.reExecuting` from the parent's `execute(io)` and call `applyPatchToTree`/`integrationBaseCommit` directly on that path, or fold the attempt identity into the nested payloads. At minimum give `integrate:apply:<key>` a `verifyServe` that re-checks with `git apply --reverse --check`. Add regressions in both directions — `packages/core/test/review-regressions.test.ts:1140` only covers the tree still *holding* the patch.

---

### HIGH

### [high/concurrency] The integration tree has no owner: a conflicting lane's rollback silently reverts a merged patch — `packages/core/src/ctx.ts:2495`

`ctx.integrate` mutates `rt.cwd` with no mutual exclusion of any kind. Each call takes its own snapshot (`ctx.ts:2456-2474`) and, on conflict, unconditionally restores its target files from it via `restorePatchFiles` (`ctx.ts:2270-2296`) — `git restore --worktree --source <snapRef> -- <file>` per file, with no check that the file still holds what the failed apply left. `grep -rn "Semaphore|Mutex|lock" packages/core/src` finds only the two throughput semaphores at `engine.ts:321/331`, and integrate takes neither.

**Failure (reproduced three ways):** two write agents each rewriting line 1 of `a.txt`. (1) `Promise.allSettled([ctx.integrate([a]), ctx.integrate([b])])` + `ctx.discard` the loser → run `complete`, output `{"merged":["fa"]}`, `patch.merged fa 4707622a → 9622abf0` in the journal — and `a.txt` back to base. (2) `ctx.parallel([ctx.workflow(childA), ctx.workflow(childB)])`, each child with its own integrate — same loss, parent completes. (3) With `limits.concurrency: 1` — identical, because integrate steps take no permit at all. Which lane loses is nondeterministic; the bug is symmetric. No error, no drop, no `scope.violation`, no `unintegrated_patches`.

**Second failure mode, same root — the merge ledger is corrupted.** `baseTree` and `resultTree` come from two independent `treeHash(rt.cwd)` calls straddling the apply (`ctx.ts:2464`, `ctx.ts:2487`). Under overlap both records get the same pair: reproduced as `MERGED a base 0c4ef531… result c27e478a…` / `MERGED b base 0c4ef531… result c27e478a…` for two distinct patches. *Verifier:* the applied tree is correct and an immediate resume still serves both merges, because the shared `resultTree` equals the live tree. The actual damage is the lost chain link — no record's `baseTree` equals the earlier patch's true `resultTree`, so `mergedBaseTrees` (`replay.ts:263`, consulted at `ctx.ts:2435`) can no longer recognise a patch whose lines a later merge edited, and the decision falls through to a forward `git apply --check` that can conclude the patch is absent and re-execute the merge.

**Fix:** give the integration tree an owner — a per-`cwd` (or per-run-tree-root, since children inherit `parent.cwd` at `engine.ts:1360`) async mutex held across snapshot + apply + resultTree hash + rollback as one critical section, and around every other `rt.cwd` mutator (`ctx.git.checkout/commit/branch.create`, in-place capture). Cheaper interim: make `restorePatchFiles` refuse when the file's current content is not what the failed apply produced, and journal a `drop`. Then implement `IntegrateOptions.order` (`packages/sdk/src/types.ts:548`) or delete it.

### [high/concurrency] `drive()` journals the terminal event and releases the lease while steps are still executing — `packages/core/src/engine.ts:959`

`drive()` appends `run.completed`/`run.failed` (`engine.ts:959-964`) and its `finally` clears the lease timer and releases the lease (`engine.ts:992-996`) with no `shared.abort.abort()` and no drain. `cancel()` (`engine.ts:1728-1760`) aborts then `drainWithin(CANCEL_DRAIN_MS)` and fences if not drained; `shutdown()` (`engine.ts:1847-1850`) has `if (!drained) continue; // never release ownership over still-live work`. `rt.append` (`runtime.ts:351-366`) only refuses when `fencedWith` is set, so a terminal-but-unfenced runtime keeps accepting appends.

**Failure (reproduced):** `Promise.all([ctx.agent('good'), ctx.agent('bad')])` where `bad` throws immediately and `good` takes 300 ms. At rejection the journal is `0:run.created 1:run.status 2:step.scheduled 3:step.scheduled 4:step.failed 5:run.failed`, `isActive` is already false and `acquireRun` immediately hands out a fresh lease. A second engine resumed the run to completion (through `15:run.completed`), after which the *first* process's still-live lane appended `16:budget.sampled 17:step.completed 18:step.settled` — two processes interleaved into one journal, with a duplicate `step.completed` for a seq that a later `ReplayIndex.fromRecords` will index over the legitimate one.

**Fix:** make the terminal transition drain-first as `cancel()`/`shutdown()` already do — abort `rt.shared.abort` and `drainWithin` before `appendTerminal`, and release `active.lease` only if the drain completed.

### [high/concurrency] `fence()` fences one run; the rest of the tree journals a terminal `run.cancelled` — `packages/core/src/runtime.ts:1200`

`fence()` aborts the *shared* controller, and `executeChildRun` gives the child `abort: parent.shared.abort` (`engine.ts:1210`), so one controller covers the tree. `fenceLostRun` (`engine.ts:849-857`) touches only one `ActiveRun`, and `drive()`'s catch tests `rt.fenced` on its own runtime only before taking the `run.cancelled` branch (`engine.ts:970-976`).

**Failure (reproduced both directions, driving the real lease-loss entry point):** child fenced → parent journal ends `run.created,run.status,step.scheduled,step.failed,run.cancelled`, `engine.state(parent).status === 'cancelled'`, `handle.result` rejects with `CancelledError`, not the detached `StepError`. Parent fenced → parent journal stays clean at `executing` while the **child** journal — the one a new owner is about to resume — gains `step.failed,run.cancelled`.

**Fix:** give `ActiveRun` a parent link and have `fenceLostRun` walk to the root and fence every live descendant before the abort propagates. Failing that, gate `drive()`'s cancel branch on the abort *reason* — if it is a fence `StepError`, rethrow like `rt.fenced` instead of journaling.

### [high/soundness] `ctx.now/random/uuid/sleep` hash to a constant and have no `key`, so 2+ calls all re-draw after any edit — `packages/core/src/ctx.ts:2707`

`nowFn`/`randomFn`/`uuidFn` (`ctx.ts:2686-2714`) and `sleepFn` (`ctx.ts:2665-2684`) journal `{op:"uuid"}` / `{op:"now"}` / `{op:"random"}` / `{op:"sleep", ms}` with no `key`; `label` is not hashed (`canonical.ts:35-37`). N calls of one primitive produce N identical `(hash, kind)` entries → `ambiguousKeyless` at `replay.ts:311`; once the body hash moves, `positionsTrusted` is false and `runtime.ts:544-560` discards the match and re-runs. The SDK offers no override (`packages/sdk/src/types.ts:627-632`).

**Failure (reproduced):** v1 with two `await ctx.uuid()` returned `{a:'871a9fb3…', b:'bd8fb39c…'}`; v2, byte-identical except one added `ctx.log("an added line")`, resumed to `{a:'b01bb60a…', b:'c2a4ccc8…'}` — both re-drawn. A control workflow with a *single* `ctx.uuid()` and the same edit replayed identically, confirming the trigger is exactly "two or more calls of the same primitive". A workflow naming a branch `feat/${await ctx.uuid()}` and a worktree from a second `ctx.uuid()` loses both handles on the first resume after any edit; two `ctx.sleep("24h")` calls re-arm and wait 24 h again each. The repo's own test (`packages/core/test/replay.test.ts:18-44`) resumes with the *same* def and one call each, so it never reaches this path.

**Fix:** exempt these kinds from the ambiguity guard and resolve them positionally — they read no world state, so the Nth `ctx.uuid()` of a run is a complete identity. An occurrence counter folded into the payload (`{op:"uuid", n:2}`) achieves it with no API change. Optionally also accept a `key`.

### [high/soundness] `replayDry` never computes `positionsTrusted`, so `weft replay --dry` reports hits where resume re-runs — `packages/core/src/engine.ts:1988`

`replayDry(runId, opts: ResumeOptions)` (`engine.ts:1945`) builds `shared: { budget, abort, agentCounter, reuse }` (`engine.ts:1986-1992`) with no `positionsTrusted` and never calls `versionUnchanged`; `opts.defHash` is ignored entirely. `runtime.ts:544` reads `this.shared.positionsTrusted !== false`, so `undefined` means *trusted*, and the guard never fires under dry.

**Failure (reproduced on the repo's own scenario, `packages/core/test/replay.test.ts:329-375`):** that test asserts the real resume journals `replay.diverged` with `/ambiguous keyless identity/` and re-dispatches a paid agent call. `engine.replayDry(runId, {def: onlyAfter})` on the same journal returns `{"hits":2,"salvaged":0,"diverged":[],"pendingRequests":[],"completed":true}` — byte-identical with `defHash` supplied. The CLI is worse: `packages/cli/src/commands/replay.ts:27` passes neither `def` nor `defHash`, then prints "the run replays to completion — a resume would only re-run what diverged" (`replay.ts:41-44`).

**Fix:** compute the stamp in `replayDry` exactly as `resumeSetup` does (`engine.ts:539-546`), and have the CLI pass `resumeOptions(await persistedDefOf(weft, runId))` so the preview resolves the same definition and hash the resume will.

### [high/soundness] `patch.key` falls back to the cosmetic label, so two write steps sharing a key or label collapse and one patch vanishes — `packages/core/src/ctx.ts:907`

`const patchKey = opts.key ?? label` where `label = opts.label ?? opts.key ?? \`${phase}/agent#${ordinal}\`` (`ctx.ts:433`), and `onSettle` does `rt.patches.set(value.patch.key, …)` on a plain Map (`ctx.ts:598-608`). A second patch with the same string evicts the first. The dangling-patch guard walks `rt.patches.values()` (`engine.ts:944-949`), so the evicted patch is invisible to it.

**Failure (reproduced, both variants):** two write agents with distinct prompts, both `key:"fix"` (and separately, both keyless with `label:"fix"`); A writes `src/a.txt`, B writes `src/b.txt`; the workflow integrates only B. Run completes `{merged:["fix"]}`, `src/b.txt` present, `src/a.txt` absent, no `unintegrated_patches`, no drop record.

*Verifier:* the `key` variant at least produces a log line (`runtime.ts:512-515`). The `label` variant is not warned at all, and `label` is documented as purely cosmetic (`packages/sdk/src/types.ts:202`) — that is the stronger half of this finding.

**Fix:** make the patch key unique per step — `opts.key ?? \`${label}@${io.seq}\``, or key `rt.patches` by the blob ref. Alternatively refuse a duplicate un-integrated patch key in `onSettle` with `invalid_input`.

### [high/soundness] `ctx.agent.detailed` with `onError:"null"` returns `null` live but a `{value:null}` object on replay — `packages/core/src/ctx.ts:1225`

`reviveDetailed` (`ctx.ts:538-549`) turns the durable `$suppressed` marker into a `DetailedAgentResult`-shaped object with `value: null`, and `ctx.ts:1223-1225` is literally `const detailed = await run(); return mode.detailed ? detailed : detailed.value;` with no suppression check in between — so `detailed` returns the truthy wrapper while the live catch path (`ctx.ts:1226-1256`) returns bare `null` for both. `packages/sdk/src/types.ts:262-265` types it `DetailedAgentResult<…> | null`.

**Failure (reproduced):** the same shape as the existing regression at `packages/core/test/review-regressions.test.ts:3518` but with `ctx.agent.detailed` — run 1 provider throws, suspend on an ask, resume, answer. Observed `{"got":"object:null"}`; the non-detailed form yields `"null"`. Worse for write steps, where `detailed` is the only form carrying `.patch`: after a resume `if (r) { await ctx.integrate([r]) }` now *enters*, with `patch` undefined (a silent "(no patch)" skip), and any `r.value.field` read throws.

**Fix:** have `reviveDetailed` signal suppression to the caller and make line 1225 read `return suppressed ? null : (mode.detailed ? detailed : detailed.value)`.

### [high/concurrency] A budget-parked lane counts as live work, so a run that suspends on a human never reports it — `weft run` hangs — `packages/core/src/budget.ts:203`

`await root.parkUntilChange(signal)` is reached from `ctx.ts:635`, inside `execute: async (io) => rt.host.globalLimiter.with(...)` (`ctx.ts:627`), and nothing on that path calls `io.markWaiting()` — the only call sites are `ctx.ts:1415`, `ctx.ts:2678`, `runtime.ts:1388`. So a parked lane still counts in `inflightLive` and `engine.ts:891` (`if (active.runtime.liveStepCount() > 0) return undefined`) keeps `suspensionOf` undefined, even though the gated lane already decremented in `awaitAnswer` (`runtime.ts:1034`).

**Failure (reproduced):** `limits.concurrency: 8`, a provider raising `req.hitl.onPermission({tool:'Bash', risk:'high'})` for key `gated`, workflow `ctx.parallel([gated, plain])`. Without a budget, `handle.outcome()` resolves `waiting_for_human`. With `budget:{tokens:1_000_000}` (a pool 50000× the call) it never resolves — the `plain` lane is parked because `admits()` returns "while an unpriced call is in flight" at `samples === 0` (`budget.ts:159-161`). `packages/cli/src/commands/run.ts:81` and `packages/cli/src/outcome.ts:42` both await exactly this promise, so `weft run` never exits and never prints the `weft answer` line, on a run whose journal already holds `human.requested`.

**Fix:** pass `io` (or a `{markWaiting, unmarkWaiting}` bridge) into `reserveCall` and mark/unmark around `parkUntilChange`, as `ctx.workflow` does at `ctx.ts:1415`.

### [high/architecture] A step suspended on a human keeps its global concurrency permit, freezing every other run in a daemon — `packages/core/src/ctx.ts:627`

The whole agent lane runs inside `globalLimiter.with(..., io.signal)`; the permit is released only on settlement or abort. The in-call gate at `ctx.ts:779` awaits `rt.gateStep` → `runHuman` → `awaitAnswer`, pending indefinitely. `engine.ts:321` creates one `globalLimiter` per Engine and `packages/host/src/weft.ts:131` constructs one Engine per daemon, shared by `exec` (`ctx.ts:1554`), `fetch` (`:1691`) and `check` (`:2176`) too.

**Failure (reproduced):** Engine with `limits.concurrency: 1`, one agent raising a high-risk permission request. `h.outcome()` returns `waiting_for_human` — the engine declares the run idle — while `engine.globalLimiter.acquire()` from outside never resolves.

*Verifier correction:* impact is bounded by the configured cap — `config.ts:67` yields 1 only on 1–3 core hosts; on an 8-core box you need 6 concurrent pending approvals to freeze the daemon. The mechanism is exactly as described, and it contradicts the liveness accounting at `runtime.ts:1034`.

**Fix:** release the permit for the duration of a durable human/signal wait and re-acquire before resuming, or give human waits their own accounting (a `Semaphore.yield()` used by `gateStep`/`runHuman`).

### [high/security] `treeHash`/`integrationBaseCommit` run git unhardened, executing a repository-configured `core.fsmonitor` program — `packages/core/src/ctx.ts:291`

`GitCli.raw` prefixes `-c core.fsmonitor=false` on **every** invocation (`packages/git/src/git.ts:100`) with a comment naming the hazard. `treeHash` (`ctx.ts:283-296`) and `integrationBaseCommit` (`ctx.ts:308-340`) bypass `GitCli` entirely with bare `execa("git", …)` and `{...process.env, GIT_INDEX_FILE}` — no fsmonitor guard, no `GIT_ENV` sanitisation — and both run `git add -A` in the integration repo on every write-step dispatch (`ctx.ts:666`) and inside every `ctx.integrate` (`ctx.ts:2422/2464/2471`).

**Proven:** a scratch test importing the real helpers against a repo with `core.fsmonitor=./hook.sh` printed four executions of the hook; a raw shell A/B gave 2 unhardened vs 0 with `-c core.fsmonitor=false`. A linked worktree's `git config core.fsmonitor …` writes the **main** repo's `.git/config`, and `gate.ts:230` applies `mutatesSharedGitMetadata` only when `scope?.mode === "strict"` while the default is `warn` (`ctx.ts:438`).

*Verifier correction:* the "sandbox escape" framing is overstated for the warn-mode path — under warn the Bash gate (`packages/provider-claude/src/gate.ts:200-252`) already permits arbitrary non-risky shell in the worktree, so an agent that could plant the fsmonitor can already execute host code directly. **The genuine residual is repository-attached code:** a pre-poisoned `.git/config` (untrusted clone, or a strict-mode run where every agent-side escape *is* blocked) executes on the engine's very first `treeHash`/`integrationBaseCommit`, defeating exactly the hardening `GitCli.raw` applies everywhere else.

**Fix:** one line in each helper — prepend `["-c", "core.fsmonitor=false"]` and merge `GIT_ENV`, or route both through `createGit(cwd).raw(...)` (which supports `{ env }`). Separately, apply `mutatesSharedGitMetadata` in `warn` mode too: warn's contract is "flag the edit", not "let the agent reconfigure the shared repository", and a `git config` write is invisible to patch capture in either mode.

### [high/concurrency] `RunIndex.rebuild()` is not concurrency-safe, and the daemon calls it on a 3 s cache over every journal — `packages/index-sqlite/src/run-index.ts:169`

`rebuild()` does `this.db.exec("BEGIN")` on the single shared `DatabaseSync`, then `await store.read(...)` inside the transaction, with `catch { this.db.exec("ROLLBACK"); throw err; }` (`run-index.ts:168-181`). `weft.reindex()` (`packages/host/src/weft.ts:181-185`) has no in-flight dedupe. `packages/daemon/src/api/workflows.ts:79-87` sets the memo's timestamp *before* `load()` resolves, with `CACHE_MS = 3_000` (`:45`), so any rebuild slower than 3 s guarantees overlap.

**Failure (reproduced with tsx against the real classes, 400 runs):** `[ 'ok', 'REJ cannot start a transaction within a transaction' ]` and `rows after: 50` of 400 — the losing call's `ROLLBACK` aborted the winner's transaction, yet **the winner resolved successfully** leaving a silently truncated index. Cost of one rebuild against a real `FsJournalStore`: 440 ms for 100 runs / 22 MB, and `rebuild` reads every journal twice (`list()` folds them, `read()` again).

*Verifier correction (use this wording):* correct, and understated — the overlapping `ROLLBACK` can leave rebuild A reporting success with a partially populated `runs` table, not merely one endpoint 500ing.

**Fix:** serialize rebuilds inside `RunIndex` (an instance-level promise chain) and never `ROLLBACK` a transaction this call did not begin — use `SAVEPOINT`/`RELEASE`, or build into a temp table and swap. Separately, stop full-rebuilding on an HTTP path: index incrementally as records are appended, or key the memo on completion.

### [high/architecture] Batch preflight copies the entire task store to a tmpdir under the per-workflow mutex, whose acquire budget is ~9.2 s — `packages/host/src/tasks.ts:988`

`validateBatchUnlocked` (`tasks.ts:929-1050`) lists all tasks, `mkdtemp`s a shadow `TaskStore`, and does `for (const task of current) await shadow.write(task, true)` — each with `handle.sync()` + `syncDir` — then replays every operation through the shadow's public `create`/`update`/`upsert`, each taking its own SQLite mutex and re-`list()`ing. It runs twice per mutation, once *inside* the `mutate()` block opened at `tasks.ts:716`. `mutate` gives up after 200 attempts of `10 + min(attempt,40)` ms ≈ 9.2 s and throws `workflow <id> task store is busy` (`tasks.ts:1180-1190`). That throw reaches `runtime.ts:606-623`/`:770-800` as a `phase:"settle"` failure with `retryable = false`, excluded from `onError:"null"` (`ctx.ts:1224`).

**Measured:** at 400 existing tasks — `addNote` direct 6 ms, `applyBatch` of one note 1185 ms, `applyBatch` of 50 creates **14780 ms**. A concurrent `addNote` started 300 ms into that batch failed after 10324 ms with "task store is busy".

*Verifier:* directionally right and if anything understated (14.8 s at 400 tasks, not 2000). One mitigation the finding omits: the settle failure is not permanent — `replay.ts:184-190` keeps the completed output and `weft resume` re-runs `applyBatch` with the same batch id (`packages/core/test/engine.test.ts:348`), so the run is recoverable, just failed.

**Fix:** validate in memory against the already-loaded `current` array; if a shadow store is kept, seed it by hard-linking rather than fsyncing N files, and take it outside the mutex. Make the mutex wait bounded by a caller-supplied deadline and treat lock contention as retryable.

### [high/security] Loopback guard trusts every localhost port as one origin, so any local page can start runs and approve gates — `packages/daemon/src/app.ts:93`

`isLoopbackName` (`app.ts:51-60`) compares only `url.hostname` — the port is discarded — and `app.ts:85-97` is the entire boundary, with both checks `!== undefined` guarded so a missing Origin passes. `grep -rn 'token|bearer|auth' packages/daemon/src` finds nothing but the gate `confirmToken`.

**Failure (reproduced against a real engine):** `POST /api/runs` with `host: 127.0.0.1:4781`, `origin: http://localhost:3000`, `content-type: text/plain;charset=UTF-8` → `202 {"ok":true,"runId":"e8ffbf44"}`; the follow-up `POST /api/runs/<id>/answer` from the same foreign loopback origin → `200 {"ok":true}`, satisfying a human approve gate. With no Origin at all, `GET /api/runs?spend=1` → 200 and `GET /api/workflows/gated/tasks` → 200 — and that route *writes* via `weft.tasks.registerWorkflow` (`packages/daemon/src/api/workflows.ts:223-228`). The existing test (`packages/daemon/test/daemon.test.ts:604-628`) covers only a non-loopback Host and Origin.

*Verifier correction:* two narrowings worth stating — a cross-site POST from an ordinary internet origin **is** blocked (the browser stamps `Origin: https://attacker.example` → 403), so the POST vector requires a page served from some other loopback port (dev server, another local tool). The Origin-less vector is GET-only and the response is opaque, so its impact is side-effecting GETs and resource consumption, not exfiltration.

**Fix:** mint a per-daemon secret at startup, inject it into the served `index.html`, require it as a header on every `/api/` request. At minimum: require Origin to equal the daemon's own scheme+host+port exactly; reject `/api/` requests carrying `Sec-Fetch-Site: cross-site` or no `Sec-Fetch-*`; move `/api/workflows/:name/tasks` off GET.

### [high/security] The Claude provider omits `settingSources`, so the target repo's `.claude/settings.json` reconfigures the permission pipeline the write-scope gate depends on — `packages/provider-claude/src/index.ts:250`

The `Options` literal at `index.ts:249-270` is exactly `cwd`, `abortController`, `mcpServers`, `canUseTool`, `permissionMode:"default"`, optional sandbox/model/maxTurns/effort/resume. No `settingSources`, no `allowedTools`/`disallowedTools`, no `disableAllHooks`. `grep -rn settingSources packages apps examples docs` returns nothing. The installed SDK (0.3.241, `sdk.d.ts:2009-2014`) states: "When omitted, all sources are loaded (matches CLI defaults). Pass `[]` to disable filesystem settings", with `'project'` = `.claude/settings.json`. `sdk.d.ts:1416-1418` describes the option-level twin of `permissions.allow` as "auto-allowed **without prompting**", and `sdk.d.ts:4498` confirms `canUseTool` is the *ask* surface — rule-based decisions resolve before it.

**Failure:** any repo with a perfectly ordinary `.claude/settings.json` containing `{"permissions":{"allow":["Edit","Write","Bash"]}}`. Give the step `write: { paths: ["src/**"], mode: "strict" }`. The agent edits `deploy/prod.yaml`: the allow-rule auto-approves, `createToolGate` is never called, and the out-of-scope write lands — caught only post-hoc as a quarantined patch, which is exactly what `strict` exists to prevent. The same file's `hooks.PreToolUse` runs repo-specified commands during a step weft calls read-only, directly contradicting `packages/provider-claude/src/tools.ts:234-238` ("a read-only step must never execute repository-configured code"). Read-only steps are the sharp edge because `ctx.ts:429` gives them no worktree, so there is no patch capture behind the gate.

**Fix:** pass `settingSources: []` and supply model/env explicitly. If project CLAUDE.md is wanted, load it as prompt text. Add a regression asserting `options.settingSources` is `[]` on every `queryFn` call — the DI seam makes this trivial.

---

### MEDIUM

### [medium/soundness] `checkIdle()` iterates the live listener array while listeners unregister themselves — `packages/core/src/runtime.ts:477`

`checkIdle` does `const listeners = this.idleListeners; for (const l of listeners) l();` (`runtime.ts:475-479`), `offIdle` splices that same array (`:470-473`), and `outcomeOf`'s listener calls `offIdle(onIdle)` synchronously from inside the callback (`engine.ts:860-866`) — a splice-during-`for-of` skip. **Reproduced:** two un-awaited `handle.outcome()` calls on a run that then blocks in `ctx.human.ask` — the first resolved `{status:'waiting_for_human'}`, the second was still pending after 400 ms. Applying `const listeners = [...this.idleListeners];` made both resolve; reverted. Reachable from MCP, where `liveWait` (`packages/mcp/src/runs.ts:118-119`) leaves an idle callback behind per `weft_wait`.

**Fix:** iterate a snapshot, as `fence()` and `cancelHumanWaits()` already do.

### [medium/architecture] Time-based suspensions never resume: `ctx.sleep` and human deadlines live only in the holding process's memory — `packages/core/src/runtime.ts:1099`

Deadlines are armed with an in-process `setTimeout` (`runtime.ts:1091-1101`); `detach()` clears them and defers to "the run's next owner" (`runtime.ts:1161-1172`); `ctx.sleep` waits in-process (`ctx.ts:2665-2685`). The only automatic wake in the daemon is `wakeIfSuspended` (`packages/daemon/src/app.ts:312`), called solely from the answer (`:218`) and signal (`:233`) routes; `setInterval` in `packages/daemon/src` is only the UI poll and the SSE heartbeat, and startup does no adoption pass over `list({status:'waiting_for_human'})`. Nothing creates the next owner.

*Verifier correction:* the state is recoverable, not lost — a later `weft resume` re-arms the deadline from the journal and applies the timeout policy. The defect is that nothing schedules that owner.

**Fix:** a periodic daemon sweep over non-terminal, unclaimed runs whose earliest journaled deadline (`human.requested.deadline`, or a sleep step's `step.scheduled.at + ms`) has passed, reusing `wakeIfSuspended`. Until then, document `ctx.sleep` and human timeouts as durable only while a host holds the run.

### [medium/soundness] An engine refusal on an `onError:"null"` step is journaled as a durable `$suppressed` completion — `packages/core/src/ctx.ts:1227`

The suppression predicate (`ctx.ts:1222-1255`) is `onError === 'null' && err instanceof StepError && !isCancellation && !isSettlementFailure` — `err.code` is never consulted, so `budget_exceeded`, the agent hard cap (`internal`) and `depth_exceeded` all produce `rt.recordDrop` plus a durable `step.completed {$suppressed:true}`. The taxonomy exists a few hundred lines away (`runtime.ts:784-789` excludes those codes from retry) and is not used here.

**Reproduced:** two 600-token agents under `budget:{tokens:700}`, second `onError:'null'` → journal `… 7:step.failed 8:drop 9:step.completed{"$suppressed":true} 10:run.completed{"a":"one","b":null}`, state `complete`. Resuming in a fresh engine returns the identical truncated output with **zero** provider calls.

**Fix:** exempt engine refusals from the branch so they fail the run, or at minimum stop journaling `$suppressed` for them so a resume re-attempts. Same test belongs in `ctx.ok()` (`ctx.ts:1354-1361`).

### [medium/soundness] A served step whose revive-time schema check fails kills the run forever instead of diverging — `packages/core/src/runtime.ts:604`

`const value = spec.revive ? await spec.revive(loaded, entry) : (loaded as T);` sits outside every divergence path — contrast the blob-unreadable branch (`runtime.ts:580-593`) and the `verifyServe` branch (`:563-577`), both of which journal `replay.diverged` and re-run. The thrower is `ctx.ts:558-566`.

**Reproduced:** agent step `key:"sum"` journals `{summary:"short"}` and suspends on a human; the author tightens the schema to `z.string().refine(s => s.length > 100)` — `toWireSchema` output is byte-identical so the hash is unchanged and the entry is served. Resume → `{status:"failed", error:{code:"invalid_output"}}`, **zero** `replay.diverged`, **zero** `step.failed`, zero provider calls. Every later resume fails identically, stranding the human answer and any captured patches.

*Verifier:* downgraded from high only because it requires tightening a schema mid-flight in a way JSON Schema cannot express, and reverting restores the run.

**Fix:** treat a `revive` rejection on a served entry like an unreadable blob — catch, mark consumed, append `replay.diverged`, fall through to live dispatch. Let `StepSpec` opt into strictness rather than defaulting to it on the path that runs on every resume.

### [medium/concurrency] A deterministic settle-phase failure is unretryable, unsuppressable, and re-thrown on every resume — `packages/core/src/ctx.ts:618`, `packages/host/src/tasks.ts:407`

The task batch is applied in `onSettle`, after `step.completed` is journaled (`ctx.ts:610-619`, `ctx.ts:2732-2760`); `retryable = !completed && …` (`runtime.ts:786-790`) so it is never retried; `onSettle` re-runs on every replay of the served entry (`runtime.ts:607`); and `ctx.ts:1224` excludes settlement failures from `onError:"null"`. Retry-on-resume *is* the design (`replay.ts:184-190`, `packages/core/test/engine.test.ts:407`) — the defect is that a **deterministic** refusal has no escape hatch. Two verified instances:

- **Dedupe-key race.** Forcing the real window (a barrier making both lanes clear `validateBatch` before either applies), run 1 failed with `task task-80b7… for dedupe key "finding:auth-bypass" was not present in this step's observed task context` (`tasks.ts:962-971`; `retry:{attempts:3}` never fired), and resumes 2 and 3 failed identically with 0 provider calls. The journaled `taskContext` snapshot can never contain the other lane's task.
- **`ifRevision` mismatch.** `tasks.ts:406-411` re-checks the CAS at apply time; since `revision` only increases, a mismatch arriving in the preflight→settle window is deterministic forever.

*Verifier corrections:* the ordinary parallel conflict is caught at dispatch-time `validateBatch` (`ctx.ts:1178-1181`) and the step re-runs — only the race window is unrecoverable. For `ifRevision`, recovery is not limited to hand-editing `.weft/tasks/`: the wedge is on `weft resume` only; a fresh run re-observes and succeeds.

**Fix:** at the engine seam, a settlement failure on a *replayed* step must be able to diverge — journal it and re-run the step, or record a `step.settle_failed` the workflow can observe. At the store, treat a revision mismatch as a durable recorded no-op (an `appliedOperations` entry plus a skipped-operation note) so the batch converges, and let a same-run sibling's task satisfy snapshot authority.

### [medium/architecture] With a task tracker installed, a keyless agent's cosmetic auto-label becomes part of its replay identity and re-runs the paid step — `packages/core/src/ctx.ts:484`

`packages/sdk/src/types.ts:196-199` promises that with `key` omitted "the auto `Phase/agent#N` is a display label that identity ignores". `ctx.ts:483-484` passes `task-context:${opts.key ?? label}` as the observation step's `key`, `runtime.ts:509` hashes `spec.key`, and `ctx.ts:519-526` folds the observation's snapshot into the **agent** step's payload — which is hashed too. `taskAccess` defaults on whenever a tracker exists (`ctx.ts:453`, `engine.ts:388`) and `packages/host/src/weft.ts:139` always installs one.

**Reproduced matrix** (keyless agent, `ctx.phase("Plan")`→`"Planning"` on resume, provider call count): no tracker + rename → 0; tracker + stable snapshot + rename → 0; tracker + moving snapshot + no rename → 0; tracker + moving snapshot + rename → **1 re-dispatch of an already-paid agent step**. In a parallel fan-out the ordinal follows completion order under `mapWithConcurrency`, so this drifts with no source edit at all.

*Verifier correction:* blast radius is one re-dispatched (re-paid, possibly different-answered) agent step after a cosmetic edit, and only for keyless task-aware agents — keyed agents are immune because the observe key uses `opts.key`. A cost/determinism defect, not data loss.

**Fix:** derive the observation's key from the agent step's own content hash or a positional index, never the display label. Better: keep the observed snapshot out of the agent's payload hash — journal it as step metadata like `route`/`scope`.

### [medium/api-design] `onError:"null"` and `retry` do not cover the engine-injected task observation — `packages/core/src/ctx.ts:483`

`observeTasks` is a bare `await` at the top of `agentImpl`, before the `run()` closure. `onError` wraps only `await run()` (`ctx.ts:1223-1226`) and the retry spec is attached only to the agent step (`ctx.ts:585-587`); the observation's own `rt.runStep` (`ctx.ts:385-404`) declares no retry.

**Reproduced:** tracker whose `snapshot()` throws once then succeeds; `ctx.agent('maybe', {key:'opt', onError:'null', retry:{attempts:3}})` → run **rejected** with `tracker storage unavailable` after exactly one `snapshot()` call — no retry, no `null`, no `$suppressed`. Both author declarations bypassed by a step they never wrote.

**Fix:** issue `observeTasks` inside `run()`'s `execute` so it inherits the retry and the `onError` catch. An injected step must never carry weaker failure semantics than the declared one.

### [medium/soundness] `ctx.workflow` demands the child's PARSED input type while the engine validates the RAW value — `packages/sdk/src/define.ts:81`

`defineWorkflow` returns `WorkflowDefinition<InferOut<InS>, …>`; `ctx.workflow<In,Out>(def, input: In)` (`packages/sdk/src/types.ts:599`) therefore demands the schema's *output* type, while `engine.ts:1333-1337` validates the raw value against `def.meta.input`. **Verified with tsc:** for a child with `input: z.object({n: z.string().transform(Number)})`, `ctx.workflow(child, {n: 42})` compiles clean and throws `StepError invalid_input` at runtime, while `{n: "42"}` — the value the engine accepts — is a compile error; `ctx.workflow(withDefault, {})` is also a compile error though the engine accepts it. `packages/sdk/src/types.ts:320` (`onTimeout: HumanTimeoutPolicy<InferIn<S>>`) gets the direction right for humans.

*Verifier correction:* the consequence is a loud fail-fast at the child-start step, not corruption; the default-only case is merely over-strict.

**Fix:** give `WorkflowDefinition` a third parameter for the accepted input type, or narrow `ctx.workflow`'s first overload to carry `InferIn<InS>`. Fix `InferWorkflowInput` at the same time.

### [medium/type-safety] `InferWorkflowOutput<D>` resolves to `never` for every real workflow — `packages/sdk/src/define.ts:72`

`run` is a readonly *property* with a function type (`define.ts:68`), so under `strictFunctionTypes` its parameter is contravariant and `WorkflowDefinition<{a:string},X>` is not assignable to `WorkflowDefinition<unknown, infer Out>`. **Verified:** `const o: InferWorkflowOutput<typeof wf> = { b: 1 }` was the only error tsc emitted for the whole project — "not assignable to type 'never'". It is exported (`packages/sdk/src/index.ts:12`), has no consumer and no test.

**Fix:** probe on the covariant side — `D extends { readonly run: (ctx: Ctx, input: never) => Promise<infer Out> } ? Out : never` — and add a type-level test.

### [medium/type-safety] `AgentFn` overloads drop the `| null` when `onError` is a union-typed variable — `packages/sdk/src/types.ts:255`

The nullable return is selected by an overload requiring the literal `onError: "null"`, while `AgentOptions.onError` is declared `"throw" | "null"` (`types.ts:219`) and `ctx.ts:1228-1252` branches on the runtime *value*. **Verified:** `const onError = strict ? ('throw' as const) : ('null' as const); const v = await ctx.agent('p', {schema:S, onError}); return v.a.length;` produced no error; the same call with the literal correctly errors. `agent.detailed` has the identical pair at `types.ts:262-269`. Any step whose failure mode is configured rather than hard-coded hits a TypeError on the first suppressed step.

**Fix:** one signature with a conditional return that widens when `"null"` is merely a *member* of `O["onError"]`.

### [medium/api-design] MCP `weft_run` never calls `rejectUnknownInput`, so a typo'd input field is silently dropped — `packages/mcp/src/tools.ts:348`

`startRun` (`tools.ts:326-369`) goes `resolveWorkflow` → `reserveRunId` → `engine.start({input: args.input})` with no unknown-key check, and the tool schema declares `input` as `z.unknown()` (`tools.ts:77-81`). `rejectUnknownInput` appears only at `packages/host/src/input.ts:43`, `packages/daemon/src/api/starts.ts:57` and `packages/cli/src/commands/run.ts:49` — and `packages/host/src/input.ts:4-8` documents that this exact cross-host gap already bit once. **Proven over a real MCP transport:** `weft_run {workflow:"hello", input:{name:"ada", agressive:true, budgetUsd:50}}` returned no error, ran to completion, both extra fields dropped. The MCP door is the one where an LLM composes the object.

**Fix:** call `rejectUnknownInput` in `startRun` for plain-object inputs, guarded as `starts.ts` does. Better: move the guard inside `Engine.start` so a fourth host cannot be added without it.

### [medium/security] `weft_answer` lets an agent satisfy approval gates, and the fold cannot show which door the answer came through — `packages/mcp/src/tools.ts:221`

`weft_answer` (`tools.ts:136-153`) is an unrestricted door into `engine.answer` for any request kind including `gate`/`confirm`, and the confirm token — `confirm:<8 hex of sha256(action)>` minted at `runtime.ts:1335` — is embedded verbatim in the JSON Schema description at `runtime.ts:1341`, which `packages/mcp/src/runs.ts:196` hands straight back to the model. Only prose in `packages/mcp/src/server.ts:44` stands between an agent and self-approval.

*Verifier corrections:* `answeredBy` is typed `"human" | "policy" | "timeout"` (`events.ts:67`) — it denotes the *mechanism*, not the identity, and the journal **does** record `channel: "mcp"`. The genuine defect is narrower: `packages/core/src/projections.ts:276` copies `answeredBy` and reads `channel` nowhere, so the folded `RunState` and `renderReport` cannot surface it. This is also not MCP-specific — `weft answer` and the daemon's POST route record the same way, and the confirm token rides in `PendingRequest.confirmToken` to every surface, so it is anti-fat-finger ceremony by design, not a secret.

**Fix:** carry `channel` into the projection and render it in `renderReport`, so an audit can tell a person's sign-off from an agent's. Then let policy act on it — at minimum have `weft_answer` refuse `kind: "confirm"`.

### [medium/soundness] The token ceiling measures the wrong quantity — `packages/core/src/budget.ts:65`, `packages/provider-claude/src/index.ts:301`

Two mechanisms, one defect: the hard token ceiling README.md:38 advertises undercounts Claude-billed input.

1. `Budget.charge` sums only `nonNegative(usage.input) + nonNegative(usage.output)` (`budget.ts:65`). `usage.cacheRead` is carried through `ctx.ts:1118` and `provider-claude/src/index.ts:303` and is never charged, priced (`ctx.ts:808-813`), restored (`replay.ts:159`) or displayed; `cache_creation_input_tokens` is never read anywhere. **Ran it:** `new Budget({tokens:10_000}).charge({input:4, output:800, cacheRead:180_000})` → `spentTokens 804, remaining 9196, exhausted false`. The same numbers feed `admits()` (`budget.ts:166-168`), so the per-call average gating concurrency is understated by the same factor.
2. `absorb()` reads `message.usage`, which the pinned SDK documents (`sdk.d.ts:4615/4661`) as "MAIN AGENT LOOP ONLY — excludes Task subagent, sidechain, and auxiliary model calls. Prefer `modelUsage` for token/cost accounting". `grep modelUsage packages` returns nothing. Nothing restricts the toolset and the gate allows Task, so subagent fan-out is reachable.

*Verifier correction:* the **USD axis is not affected** — `provider-claude` reports `reportsUsd: true` (`index.ts:168`) and sets `usage.usd` from `total_cost_usd`, which covers the whole pipeline, so `--budget "…,$5"` is enforced correctly. And Codex has no undercount: OpenAI's `input_tokens` already includes `cached_input_tokens`, and `provider-codex/src/index.ts:364-366` correctly keeps `cacheRead` non-additive. The defect is confined to Claude's token axis.

**Fix:** sum `modelUsage` in `absorb()` with a `usage` fallback; add `cacheWrite` to `Usage`; make `charge()` sum `input + output + cacheRead + cacheWrite`; extend `ModelPrice` with cache rates for the fallback pricing path.

### [medium/security] Every agent step in every workflow silently gets `mode:"write"` task authority by default — `packages/core/src/ctx.ts:454`

`taskAccess` falls back to `{}` whenever a tracker exists (`ctx.ts:450-453`) and `const taskMode = taskAccess?.mode ?? "write"` (`ctx.ts:454`); `engine.ts:388/1359` set `defaultAgentTaskContext: this.taskTracker !== undefined` and `packages/host/src/weft.ts:139` always installs one. There is no workflow- or engine-level lever: `WorkflowMeta` (`packages/sdk/src/define.ts:36-55`) exposes only schema config, `meta.defaults` (`:65`) only provider/model/effort. The only opt-out is `tasks: false` / `{mode:"read"}` at every call site. `packages/core/test/engine.test.ts:18-95` confirms a workflow with no `tasks:` declaration gets a `task-context:plan` step and a `taskOperations` envelope.

*Verifier correction:* the severity is bounded by real guards — `validateBatchUnlocked` (`packages/host/src/tasks.ts:938-970`) rejects any update/note/criterion on a task id not in the step's observed snapshot and any upsert onto an unseen dedupe key, read mode rejects non-empty batches, every op is schema-validated and shadow-replayed, and applied operations are journaled with an `agent:<provider>:<runId>:<step>` actor. **The defensible finding is "write is the wrong default and there is no workflow- or engine-level way to make task context read-only or opt-in"** — a safe-defaults gap, not privilege escalation.

**Fix:** default `taskMode` to `"read"`, or gate implicit task context on the workflow having declared `meta.tasks`.

### [medium/soundness] `TaskStore.write()` enforces none of the invariants `decodeTask()` requires, so a backwards clock step bricks a workflow's whole task store — `packages/host/src/tasks.ts:1123`

`write()` checks only `jsonUnsafeAt` (`tasks.ts:1123-1131`) while `decodeTask` rejects `updatedAt < createdAt` (`tasks.ts:1526-1529`); `updatedTask` (`:425,:465`) and `addNote` (`:568-573`) stamp `Date.now()` with no clamp. `list()` maps `readTask` through `Promise.all` with no per-file isolation (`:281-287`), and every mutator reads before it writes.

**Reproduced:** create a task, move `Date.now` back 5 minutes, `addNote` → written without complaint as `{createdAt: 1787733008822, updatedAt: 1787732708829}`; immediately afterwards `get`, `list` and `snapshot` all throw `invalid task file …: updatedAt must be an integer at or after createdAt`. The workflow's whole task namespace is unusable and only hand-editing the JSON restores it.

*Verifier:* trigger is a backwards wall-clock step (NTP correction, VM snapshot resume), not anything a workflow can cause; damage is a wedged store repairable by editing one file.

**Fix:** clamp (`updatedAt = Math.max(current.updatedAt, Date.now())`) in `updatedTask`/`addNote`, validate through `decodeTask`'s rules before persisting, and isolate per-file failures in `list()` the way `Engine.list()` already does for damaged runs.

### [medium/architecture] `GET /api/runs?spend=1` folds every journal in the repo in unbounded parallel, and the UI polls it every 4 s — `packages/daemon/src/app.ts:108`

`listFilter` (`app.ts:459-468`) adds `limit` only when the query supplies one; `app.ts:108-109` folds all summaries in one `Promise.all(repaired(...))` and `:113-127` adds a second unbounded `Promise.all` of `stateOf`, which reads and JSON.parses the entire journal into an array (`state.ts:20-22`). `apps/ui/src/api/client.ts:91` never sends `limit`; `queries.ts:50-58` polls at 4 s; `QueuePage.tsx:20` and `RunsPage.tsx:20` both use `{spend: true}`. `packages/daemon/src/api/pending.ts:34-35` batches at `CONCURRENCY = 8` with exactly this rationale.

**Measured through `app.request()`:** 300 runs × 160 records → ~440 ms; 1500 runs × 300 records → ~2450 ms, RSS 346–391 MB.

*Verifier correction:* the numbers are lower than first reported (2.4 s / ~390 MB, not 7.9 s / 602 MB), so "permanently saturated" needs a big repo. Also, the plain non-spend list is unbounded **by explicit design** (`app.ts:110-113`). The unacknowledged part is the per-run full-journal fold under `?spend=1` being both unbounded and fully parallel while `pending.ts` caps itself at 8.

**Fix:** default `limit` on the list route; bound the spend fan-out; better, serve `?spend=1` from `IndexedRun.tokens`/`usd` instead of re-folding journals.

### [medium/architecture] `FsJournalStore.watch()` re-reads and re-parses the whole journal every 400 ms tick — `packages/store-fs/src/journal.ts:403`

`const poll = setInterval(() => wake?.(), 400)` (`:390`) and the follow loop call `this.read(runId, cursor)` (`:403`), which is an unconditional `readFile` + `split` + `JSON.parse` of every line with `rec.i >= fromIndex` applied *after* the parse (`:350-370`). No stat/size guard, no use of `cached.byteOffset` — while `reconcile()` twenty lines above demonstrates exactly the delta-read this needs.

**Measured:** 12.27 MB / 4000-record journal, one watcher past the end, 4 s wall → 0 records delivered, 761 ms CPU (~19 % of a core), synchronous, on the loop the 2.5 s lock renewal (`journal.ts:270`) and 5 s lease refresh (`engine.ts:762`) run on. Long-lived watchers are real: `engine.ts:1033` holds one for the life of every run, and `packages/daemon/src/app.ts:404/426` add one per SSE client and per descendant. `MemoryJournalStore.watch` has no poll and slices by array index, so no memory-backed test can surface it.

*Verifier:* cost is idle CPU / event-loop occupancy on large journals, not a correctness defect.

**Fix:** give `watch()` its own byteOffset cursor, stat first and skip when size has not moved. Add a conformance assertion that a caught-up watcher performs no whole-file read.

### [medium/edge-case] The determinism fence bans `Intl` and `toLocaleString` but leaves every host-timezone `Date` accessor open — `packages/gate/src/rules.ts:47`

`LOCALE_METHODS` is exactly six locale/collation names; the fix-its justify the ban as "it reads ambient ICU data and the host timezone" (`rules.ts:66-69`), and `no-argless-date` explicitly blesses `new Date(value)`. `sandboxDate()` (`packages/gate/src/load.ts:163-193`) builds `safeProto = Object.create(Date.prototype)` and guards only `Date.now`, argless construct and bare apply — every instance method is inherited unchanged. **Proven:** `checkSource` returns `[]` for a body reading `getTimezoneOffset()/getHours()/getDay()/toString()`, and the values differ across `Asia/Tokyo {9,-540,4}` / `UTC {0,0,4}` / `America/Los_Angeles {16,480,3}` — a real branch flip on `getDay()`. The prior review named the ambient timezone (`docs/reviews/2026-08-dx-and-architecture.md:521`); the recorded fix (line 77) covered only the ICU/locale half.

**Fix:** add the local-time prototype accessors to a `no-local-time` AST rule with fix-its naming the UTC equivalents, and shadow them on `safeProto` with throwers. `getTime`, `valueOf`, `toISOString` and the `getUTC*` family stay, which makes the allowed surface easy to state.

### [medium/security] `createToolGate` is allow-by-default over a vendor-name blocklist — `packages/provider-claude/src/gate.ts:256`

After the structured-output bypass and an empty `denied` set, only `EDIT_TOOLS.has(base)` (the 4 names at `packages/provider-claude/src/tools.ts:14`) and `base === "Bash"` are screened; the function ends in a bare `return allow;`. The engine never populates `ToolPolicy.deny` — `ctx.ts:758` sets only `allowEdits` — and `index.ts` sets neither `Options.tools` (the documented base-toolset knob, `sdk.d.ts:1470-1481`) nor `allowedTools`/`disallowedTools`, so the full `claude_code` preset applies. Read-only steps are the sharp edge: `ctx.ts:429` gives them no worktree, so the gate is the sole live enforcement with no patch capture behind it.

*Verifier corrections:* the specific REPL-writes-a-file scenario is **unproven** — the REPL/Artifact/Cron names come from a generated CLI schema dump (`sdk-tools.d.ts:11-56`) and their availability to a headless SDK query is not established. And `Task` subagent calls **do** reach `canUseTool`, contrary to the original claim. What stands is the design fact.

**Fix:** invert the default — deny unrecognised tool names, mirroring the strict-mode unknown-path branch at `gate.ts:156-160` — and pass an explicit `Options.tools`/`allowedTools` allow-list so unrecognised tools are never offered. Add a conformance test enumerating the SDK's shipped tool schemas.

### [medium/api-design] `ProviderCapabilities` is never consulted, so per-step routing does not yield interchangeable steps — `packages/provider-codex/src/index.ts:136`, `:323`

`grep -rn "capabilities()"` over `packages`/`apps` (excluding dist/test) yields exactly one site: `ctx.ts:737`, `!provider.capabilities().reportsUsd`. `permissionHook` and `sessionResume` are declared (`provider-codex/src/index.ts:391-395`, `provider-claude/src/index.ts:167-169`) and read nowhere. Two concrete consequences:

- `threadOptions` forwards only workingDirectory/sandboxMode/skipGitRepoCheck/approvalPolicy/model/effort; `maxTurns`, `onMaxTurns`, `tools.deny` and `hitl` are dropped silently — while `maxTurns` **is** hashed into step identity (`ctx.ts:510-526`), so it perturbs the replay cache while changing nothing about the call.
- `toResult` hardcodes `filesTouched: []` (`index.ts:317-324`), deleting the engine's only witness for a write that escaped the worktree — the engine's own comment at `ctx.ts:888-899` says that report "is the only witness there is", and `ctx.ts:936-948` appends `scope.violation` from it when there is no patch. The data is available and discarded: the Codex SDK's `FileChangeItem` carries per-file changes and `renderTranscript` already walks them.

*Verifier corrections:* `maxTurns` cannot be forwarded — the pinned `@openai/codex-sdk` 0.149.0 exposes no turn-cap option at all — so the honest fix is a declared capability check plus an error/warning, not a forward. And the "unguarded" framing is wrong: the Codex adapter substitutes an OS sandbox (`sandboxFor` → `"read-only"` for `allowEdits:false`, `index.ts:99-101`). For `filesTouched`, the cross-provider asymmetry holds specifically for edit-tool escapes under a `warn` scope — the Claude adapter's list comes from `gate.ts`'s `onEdit` and likewise never records shell-written files.

**Fix:** extend `ProviderCapabilities` with what each provider honours (`turnLimit`, `toolDeny`, `reportsFilesTouched`) and have `agentImpl` refuse or loudly annotate a step that sets an option the routed provider cannot honour. Drop `maxTurns` from the hash for providers that ignore it. Populate Codex `filesTouched` from `file_change` items.

### [medium/api-design] The daemon's `event: child` SSE frames are dropped by the shipped React client — `apps/ui/src/api/events.ts:28`, `packages/daemon/src/app.ts:406`

`app.ts:394-413` deliberately forwards descendant records as `event: child` ("a question raised inside a sub-workflow must nudge the UI even though the selected run's own journal stays quiet"), and `apps/ui/src/api/events.ts:27-36` installs only `source.onmessage`, which per the HTML spec fires solely for `message`-typed frames. `grep -rn addEventListener apps/ui/src` returns only two window keydown listeners. `useRun` has no `refetchInterval` on the explicit grounds that the stream invalidates it (`queries.ts:69`), and the parent journal really is quiet meanwhile (`engine.ts:1441-1451` appends the parent's `budget.sampled` only after `await handle.result`).

**Reproduced:** the NESTED fixture (parent whose only work is `ctx.workflow(child)`, child parked on `ctx.human.approve`) produced 3 plain frames for the parent and 4 `event: child` frames; `GET /api/runs/<parent>` reported `executing`.

*Verifier correction:* "the daemon's only client never receives" is wrong — the built-in legacy page **does** consume them (`packages/daemon/src/ui.ts:343-348`). The accurate statement is that the React manager at `apps/ui`, the default surface, drops them, so the feature regressed when the manager replaced the built-in page. And the gate is not lost — `usePending` polls independently, so it still appears in `/queue`; it is the parent's own detail view that never refreshes.

**Fix:** add `source.addEventListener("child", …)` routed to a separate `onChildRecord` callback (so `Last-Event-ID` stays tied to the selected run's indices), plus a listener for the daemon's `event: error`. Have `useRunView` treat a child record as an invalidation cue, and use `GET /api/runs/:id/pending` (`app.ts:168-176`, currently unused by `apps/ui`) so a descendant's question surfaces on its ancestor's screen. Give the test harness a fake EventSource that can dispatch named events — `apps/ui/src/test/daemon.ts:555` currently stubs a `SilentEventSource` that never delivers.

### [medium/architecture] Every run-detail open replays the whole journal into React state, quadratically — `apps/ui/src/app/useRunView.ts:52`

The stream is opened with no cursor (`api/events.ts:27` has no `?from=`, so `app.ts:426-429` watches from index 0), and every record does a `some()` scan, a spread copy, a full sort and a `setRecords` — one React render per frame. **Re-measured under node:** 1,000 records = 29 ms, 5,000 = 398 ms, 10,000 = 1.6 s, 20,000 = 8.6 s of pure main-thread work before renders. `journalEntries(records)` runs in the hook body with no `useMemo` (`useRunView.ts:122`) and lands in `run.journal` (`adapt.ts:195`), which `domain/types.ts:208` declares and no component reads — `RUN_TABS` (`domain/views.ts:9`) has no journal tab.

*Verifier correction:* the records array is **not** wasted — `agentSessionsOf(records)` (`useRunView.ts:123`) is a real consumer. What is provably dead is `journalEntries` → `run.journal`; the O(n²) copy+sort is a real but only-at-large-n cost.

**Fix:** append with `records[records.length-1].i < record.i` instead of `some()`+`sort()`; drop `journal`/`journalEntries` until a journal tab exists; pass `?from=` so a page open does not replay a completed run's journal.

### [medium/architecture] Every run needs `node:sqlite`, which is flag-gated on the declared `engines.node` floor of 22.12 — `packages/host/src/tasks.ts:1175`

`await import("node:sqlite")` sits inside `TaskStore.mutate()`, reached unconditionally: `registerWorkflow` → `mutate` (`tasks.ts:208`, whose only escape is `options.persist === false` at `:195`), installed on every `createWeft` (`packages/host/src/weft.ts:136-152`) and awaited on the normal start path (`packages/core/src/engine.ts:370-374`; only the dry-replay path at `:1972-1976` passes `persist:false`). All 16 manifests plus the root declare `">=22.12"` and `packages/cli/src/commands/doctor.ts:21` (`MIN_NODE = [22, 12]`) returns "ok" for 22.12.x. Node unflagged `node:sqlite` in 22.13.0. **Proven** by making `node:sqlite` unresolvable: `registerWorkflow` returns `ERR_UNKNOWN_BUILTIN_MODULE`, uncaught. Secondary: `ExperimentalWarning: SQLite is an experimental feature` on stderr of every `weft run` on supported runtimes. CI (`.github/workflows/ci.yml:48`, `node: [22, 24]`) never tests the floor.

*Verifier correction:* exposure is narrow — only 22.12.x. The defect is that `engines.node` and doctor's `MIN_NODE` advertise a floor one minor below what the code needs.

**Fix:** bump both to `>=22.13` and pin the CI matrix to the floor; or replace the `.mutex.sqlite` advisory lock with an `open(path,"wx")` lockfile. Add `--no-warnings=ExperimentalWarning` scoping so CLI output is not preceded by a Node warning.

### [medium/architecture] Strict-scope shell approval can only be whitelisted per tool name, not per command — `packages/core/src/ctx.ts:780`

`gateStep` builds the approval key as `agent tool ${permReq.tool} (${label})` and puts the command in `detail` (`ctx.ts:779-786`); `resolveApproval` (`runtime.ts:1321-1331`) matches picomatch against `action` only, then tiers, then risk (low→auto, everything else→ask). `detail` is never an input. `config.ts:95` defaults `approvalPolicy: {}`, so the first `pnpm test` in any strict-scope write step suspends the run on a human — and the only escape auto-approves *all* Bash in that step, re-admitting the computed-destination escape the broker exists to catch. `packages/provider-claude/src/gate.ts:238-241` promises the opposite ("policy whitelists the project's trusted build commands"), and the test that documents it stubs the verdict (`packages/provider-claude/test/claude.test.ts:886`). Other gate actions embed their target in the action string (`packages/core/test/engine.test.ts:750`, pattern `"git.push origin/wip/*"`) — this one departs from that design.

**Fix:** give `gateStep` a structured subject (tool + normalised command) so `agent tool Bash [pnpm test]` can be auto-approved while `agent tool Bash [python -c …]` still asks. Secondary: `ctx.ts:787` returns `allow` for any request whose `risk` is undefined/low/medium and `PermissionRequest.risk` is optional (`provider.ts:25-29`) — inert for first-party providers today, but it should deny.

### [medium/soundness] `FsBlobStore.put` never fsyncs, so the fsynced journal can reference bytes that never reached disk — `packages/store-fs/src/blobs.ts:31`

`await fs.writeFile(tmp, data); await fs.rename(tmp, path);` with no filehandle sync and no directory sync — while `FsJournalStore.append` fsyncs every batch (`journal.ts:169`) and `TaskStore.write` does `handle.sync()` + `syncDir()` (`packages/host/src/tasks.ts:1139-1148`). `rename()` orders metadata, not data. The unrecoverable consumer is `ctx.ts:2477-2483`, which reads the captured patch back inside a replay-served integrate step; `get()` throws `BlobCorruptError` and the served step has no divergence path, so the patch is gone with the worktree it came from.

*Verifier correction:* trigger is narrower than the prose suggests — a plain process crash is harmless (page cache); this needs power loss / kernel panic / volume failure between the blob write and the next natural sync.

**Fix:** `open` → `writeFile` → `handle.sync()` → `close` → `rename` → `syncDir(dirname(path))`. Lift `syncDir` out of `packages/host/src/tasks.ts` into a shared helper so all three stores use one implementation.

---

### LOW

### [low/edge-case] One corrupt committed journal line makes the run vanish from `ls`, the index and the UI with no diagnostic — `packages/store-fs/src/journal.ts:456`
`list()` catches `SyntaxError` via `damagedOrGone` (`journal.ts:36-38`) and `continue`s with no marker — while the comment directly above claims `weft ls` is how a person finds the run that needs repairing. `RunIndex.rebuild` then `DELETE FROM runs` and repopulates from that list (`run-index.ts:167-176`), so the row disappears from SQLite and every daemon surface. `doctor.ts` never inspects `.weft/runs`. *Operability gap on an already-corrupt journal, not data loss — `read()`'s loud error and `weft resume` are intact.* **Fix:** return damaged runs with a `damaged: true` marker; keep them out of the derived index rather than the listing; add a doctor check.

### [low/api-design] `FsBlobStore.has()` flattens EACCES/EIO into "absent" — `packages/store-fs/src/blobs.ts:68`
`get()` deliberately narrows to ENOENT/ENOTDIR (`:47-58`); `has()` is a bare `try/catch → false`. `packages/daemon/src/api/blobs.ts:26` turns that into `blob <ref> not found` and `api/artifacts.ts:34` marks it unavailable, so a permissions problem reads as "garbage-collected". `blob-errors.test.ts` covers the asymmetry for `get()` only. **Fix:** catch only ENOENT/ENOTDIR; 5xx rather than 404 in the daemon.

### [low/api-design] The conformance suite never exercises `appendIf` or `acquireRun` — `packages/testing/src/conformance.ts:111`
The only optional-method test is the `readSnapshot` block. `MemoryJournalStore.acquireRun` (`packages/core/src/stores.ts:115`) does not accept the interface's `opts?: {ttlMs?}` (`:75`) and never expires, versus the fs store's 15 s default (`journal.ts:615`); `readSnapshot` returns the live mutable object. *The fs store itself is well covered directly (`journal.test.ts:529-670`), so the gap is portability of the shared suite — a third-party `appendIf` can be a read-then-write and pass everything.* **Fix:** add CAS and lease-expiry blocks.

### [low/soundness] `structuralCheck`'s `additionalProperties:false` uses `in`, so `Object.prototype` keys pass — `packages/core/src/jsonschema.ts:152`
Ran it: `{"a":"x","__proto__":{…},"constructor":1}` returns `[]`. `packages/host/src/input.ts:60-61` fixed this exact `in`-vs-`hasOwn` hazard in the sibling checker and named it in a comment. Reachable via `engine.ts:1663`, the only validation on the out-of-process answer path — the impact is the accept-then-reject round trip `structuralCheck` exists to prevent. **Fix:** `Object.hasOwn` at `:152` and `:141`.

### [low/type-safety] The `Duration` template-literal type admits strings `parseDuration` throws on — `packages/sdk/src/duration.ts:6`
`${number}` accepts exponents and signs; the regex (`:22`) accepts neither. `const d: Duration = '1e5m'` compiles; `parseDuration('1e5m')` throws. `toMs` runs inside the live step path (`ctx.ts:428`, `ctx.ts:2666`), so it surfaces mid-run. **Fix:** widen the regex or narrow the type.

### [low/soundness] In-place strict scope discards the provider's out-of-tree file report — `packages/core/src/ctx.ts:1020`
The worktree branch unions `escaped` back in with a comment explaining that dropping it made `warn` mode flag nothing (`ctx.ts:895-899`); the in-place branch overwrites `files` with the tree diff and calls `checkScope` only inside `if (afterSnap !== inPlaceSnap || newIgnored.length > 0)` (`:999`). *Verifier: the stated scenario does not occur — Codex reports `filesTouched: []` anyway, and a Claude strict scope denies the escape live (`gate.ts:171-178`, `:216-223`). The reachable case is an in-place step in the default `warn` mode where the provider honestly reports an out-of-tree write; impact is a missing `scope.violation` record.* **Fix:** compute `escaped` before the branch and fold into both paths; run `checkScope` whenever `scope` is set.

### [low/api-design] `snapshot.total` counts every task while `tasks`/`truncated` describe the filtered set — `packages/host/src/tasks.ts:646`
Ran it: seven tasks, two `todo`, `snapshot("wf", {statuses:["todo"]})` → `{total: 7, truncated: false, tasks: [2]}`, serialised verbatim into the agent prompt (`ctx.ts:717`). Neither field is documented (`packages/sdk/src/types.ts:108-113`). *A docs/naming problem; `candidates.length` is already in hand.* **Fix:** rename to `totalInWorkflow` plus a `matched` count, and document both.

### [low/soundness] Launcher starts a run with `{}` while saying "This workflow declares no inputs" — `apps/ui/src/components/organisms/Launcher.tsx:108`
For `z.record(...)`/catchall schemas, `schemaQuestions` yields zero controls (`adapt.ts:598`, `:647`), the panel prints the note (`Launcher.tsx:295-299`) and `gateAnswer` returns `{}`. The raw-JSON escape hatch (`Launcher.tsx:279-294`) is gated on `schema === null` only. *Verifier: `{}` is a **valid** input for these schemas — nothing invalid reaches the engine. The real defect is that an open-keyed workflow cannot be given input from the launcher, and the copy misdescribes it.* **Fix:** show the raw-JSON fallback whenever a schema yields zero controls but is not provably empty.

### [low/architecture] The full patch diff is downloaded on every run-detail open — `apps/ui/src/api/queries.ts:117`
`usePatch` never passes `statsOnly` though `api/client.ts:107-110` supports `?stats=1`; `useRunView.ts:41` mounts it regardless of tab; `:63` invalidates it on every debounced burst; `:93-118` re-parses with `splitDiff` in the hook body with no `useMemo`. The daemon built the cheap path deliberately (`packages/daemon/src/api/artifacts.ts:49-51`) and returns per-file stats in both modes. **Fix:** split into `usePatchStats` (always) and a lazy `usePatchDiff` (Changes tab only); `useMemo` the totals loop.

### [low/edge-case] The Artifacts tab auto-selects the first artifact and renders one span per line with no cap — `apps/ui/src/components/organisms/ArtifactsTab.tsx:24`
`resolveArtifact` falls back to `run.artifacts[0]` (`domain/views.ts:36-38`), the daemon puts captured patches first with `size: null` (`packages/daemon/src/api/artifacts.ts:100-123`), and `ArtifactsTab.tsx:81-91` maps every line to a `<span>` with `staleTime: Infinity`. **Fix:** don't auto-select a patch (it has its own Changes tab); cap rendered lines with the existing Raw affordance; have the daemon report a size for patch entries.

### [low/api-design] `StepPane`'s "Copy step id" button has no click handler — `apps/ui/src/components/organisms/StepPane.tsx:167`
`<Button variant="secondary" size="mediumWide">{step.action}</Button>` with no `onClick`; `Button` spreads `...rest` onto a bare `<button type="button">` (`atoms/Button.tsx:15-19`). `grep -rn clipboard apps/ui/src` returns nothing. Labels come from `adapt.ts:414`/`:455`. **Fix:** wire `navigator.clipboard.writeText(stepId)` with a transient state, or delete the button.

### [low/architecture] `@techery/weft-testing` pulls both vendor agent SDKs, esbuild and typescript for one import of `TaskStore` — `packages/testing/src/run.ts:22`
The only `@techery/weft-host` reference in `packages/testing/src`, used once. `packages/host/package.json:56-68` hard-depends on gate/provider-claude/provider-codex/index-sqlite, which pull `@anthropic-ai/claude-agent-sdk@^0.3.241`, `@openai/codex-sdk@^0.149.0`, `esbuild@^0.28.2`, `typescript@~5.9.3`. *Install weight and audit surface only — the providers are dynamically imported and the harness never loads them.* Note also that the two `taskTracker` adapter literals (`packages/host/src/weft.ts:139-164` and `packages/testing/src/run.ts:110-128`) have already diverged — the testing copy omits `protectedPaths`. **Fix:** move `TaskStore` into `@techery/weft-store-fs` or its own package; demote the two providers to optional deps.

### [low/api-design] `weft ui` calls `startDaemon({weft, port})`, which does not satisfy the exported `StartDaemonOptions` — `packages/cli/src/commands/ui.ts:20`
The CLI hand-writes `DaemonModule` over a computed `import()` (`ui.ts:46-47`), so tsc never checks the call; the real interface requires `cwd` (`packages/daemon/src/server.ts:24-36`), whose own doc comment admits it is unused when `weft` is supplied. The only guard is a runtime `typeof` check (`ui.ts:56`). No test covers the join. Also `ui.ts:2-4` calls the daemon optional while `packages/cli/package.json:64` lists it as a hard dependency. **Fix:** make `StartDaemonOptions` a discriminated union, delete `DaemonModule`, and type the dynamic import as `typeof import("@techery/weft-daemon")`.

### [low/architecture] Registry `tolerantLoad` swallows every load error, so a broken workflow file reads as "not found" on resume — `packages/gate/src/registry.ts:253`
`isNotAWorkflow` (`:243-249`) exists and is used only by `find()`'s direct-filename path (`:131-138`); `findById` (`:167`) and `list` (`:178`) use the catch-all. **Reproduced:** a workflow with `Date.now()` gives `load()` → "workflow gate: 1 violation … no-date-now", but `resolve({id,name})` → `undefined` and `list()` → `[]`, so `weft resume` reports `no definition for "audit-and-fix"` instead of the gate diagnostic. *Diagnostic quality only; the run stays resumable once fixed.* **Fix:** `catch (err) { if (isNotAWorkflow(err)) return undefined; throw err; }`, and give `list()` a wrapper that collects failures.

### [low/edge-case] A multi-event journal append is not atomic under a short write — `packages/store-fs/src/journal.ts:160`
The batch is one buffer written by a loop that can throw after a newline-terminated prefix is down; indices advance only after `fsyncSync`, and `reconcile` counts every complete line without parsing it (`:339-343`), so the orphan is folded in as real history rather than cut as a torn tail. The exposed callers are the auto-approval pair (`runtime.ts:1015`) and cancel (`engine.ts:1807`). *Verifier: milder than "blocks forever" — the orphan is a valid, answerable `human.requested`, so a person unblocks the run; the loss is the automatic approval. The trigger is close to theoretical: it needs `writeSync` to fail exactly on the newline boundary of a sub-page payload.* **Fix:** truncate back to the pre-append `cached.byteOffset` on write error (the lock is still held) before rethrowing.

---

## 4. Type safety

The type layer is load-bearing in this codebase to an unusual degree, and it mostly earns it. `noExplicitAny` and `noNonNullAssertion` are on; an `rg` for `as any|as unknown as|: any|@ts-ignore` across `packages/*/src` returns four hits, three of which are honest boundary casts, and the non-null assertions are guarded a few lines above. The wire boundary is the strongest part: `toWireSchema` converts on the *input* side (`packages/core/src/jsonschema.ts:24`), the RAW provider value is journaled and re-validated from raw on both the live (`ctx.ts:1040-1041`) and replay (`ctx.ts:546-560`) paths, so a Zod transform runs exactly once per read; `jsonUnsafeAt` refuses bigint, Map/Date, cycles, non-finite numbers and present-but-undefined keys before anything reaches the journal. I could not construct a Zod schema whose static type disagreed with the runtime value through agent/human/exec/fetch/signal. The `apps/ui` tsconfig is as strict as the packages plus `noUnusedLocals`/`noUnusedParameters` and is included in the root `typecheck`.

Where the types are **decorative** clusters around one mistake: **a single type parameter that conflates "what `run()` receives" with "what a caller supplies."** `defineWorkflow` returns `WorkflowDefinition<InferOut<InS>, …>` (`packages/sdk/src/define.ts:81`), and that `In` is then consumed as a caller-supplied type by `ctx.workflow` (`packages/sdk/src/types.ts:599`) and by `InferWorkflowInput` — while the engine validates the caller's raw value against `meta.input` (`packages/core/src/engine.ts:1333`). For any transforming, coercing or defaulting input schema, the type and the runtime demand opposite things, verified in both directions with tsc. The same conflation makes the sibling helper `InferWorkflowOutput` resolve to `never` for every real workflow (`define.ts:72`) — an exported public type that cannot work and has no test. `ctx.human.ask` gets the direction exactly right (`types.ts:320`, `HumanTimeoutPolicy<InferIn<S>>` in, `InferOut<S>` out), which is what makes the sub-workflow case read as an oversight rather than a design position.

The second gap is **overload-set precision**: `AgentFn` selects its nullable return on a literal `onError: "null"` (`types.ts:255-260`) while the option is declared as a union (`types.ts:219`) and the runtime branches on the *value* (`ctx.ts:1228`). A `strict`/`lenient` flag threaded through a helper produces a non-nullable type the runtime fills with `null`. `agent.detailed` has the identical pair.

The third is **runtime-side type checking that isn't**: `structuralCheck` uses `in` where the team already learned to use `hasOwn` (`packages/core/src/jsonschema.ts:152` vs the comment at `packages/host/src/input.ts:60-61`), and `Duration`'s template-literal type admits spellings its own parser throws on (`packages/sdk/src/duration.ts:6` vs `:22`). Both are small; both are the type system claiming a guarantee the validator does not implement, which is exactly the failure mode this codebase otherwise avoids.

Finally, one *host-boundary* type gap that is really an architecture gap: `packages/cli/src/commands/ui.ts:20` hand-declares the daemon's module shape over a computed `import()`, so `pnpm typecheck` cannot see that the declared shape and `StartDaemonOptions` (`packages/daemon/src/server.ts:24`) disagree. Two packages that ship together are joined only by a runtime `typeof === "function"`.

---

## 5. What is sound

These are things I would not touch.

- **`FsJournalStore.appendLocked` (`packages/store-fs/src/journal.ts:104-175`).** Only newline-terminated lines count as committed; the torn tail is cut under a cross-process mutex after a second reconcile; `writeSync` is looped against short writes; `fsyncSync` runs before the cache advances; index assignment is tentative until the bytes are down. `appendIf` is a real CAS re-tested after the post-steal fold, and `acquireRun` makes every claim mutation a compare-and-swap under one lock. Directly tested at `packages/store-fs/test/journal.test.ts:529-670`.
- **The blob store's absence/corruption line (`packages/store-fs/src/blobs.ts:47-58`).** ENOENT/ENOTDIR → `BlobMissingError`, everything else propagates as itself, which is exactly the distinction `isBlobBeyondRepair` needs. Path construction from a hash is regex-gated, so there is no traversal even if a ref were attacker-influenced.
- **`canonicalJson` and `hashStep` (`packages/core/src/canonical.ts`).** A real canonical form — recursive key sort, `undefined` dropped, Date normalised — and kind/payload/schema/key composed as distinct fields, so there is no concatenation ambiguity. `revive` re-validates against the *real* schema, which catches the one collision hashing can construct (two non-Zod schemas both serialising to `permissiveWrapper()`).
- **`ctx.workflow` steps are `verifyServe: () => false`**, so a sub-workflow can never freeze an edited child's stale output — and `OrderedDelivery` counts drained event-loop turns plus in-flight replay I/O rather than wall clock, so delivery order is a function of the journal, not machine speed.
- **The whole write/patch/scope construction.** Never parse the diff yourself: git produces the file list (`diff --cached --name-only -z --no-renames`) and the patch body, and `git apply` is the only consumer; `patch.ts`'s regexes are reporting-only fallbacks. `--no-renames` deliberately decomposes a rename so both sides reach `checkScope`; `-z` everywhere; one `scopeMatcher` shared by the live `canUseTool` gate and the post-hoc check, failing closed on empty/exclusion-only scopes. Every listed bypass (`../`, absolute paths, `.git/` writes via a linked worktree's gitfile, renames, case folding, unicode, newline-in-path, submodule gitlinks) lands fail-closed.
- **`Semaphore` (`packages/core/src/limiter.ts`) and `Budget.reserveCall` (`packages/core/src/budget.ts:186-210`).** `available` can never go negative, `releaser()` is idempotent, the grant hand-off is synchronous, `with()` releases on abort as well as settlement. The park loop registers `waiters.add` synchronously inside the promise executor with no await between reading `inflightCalls` and registering, and the `inflightCalls === 0` escape means a park cannot outlive the last in-flight call. The permit is always taken before the reservation (`ctx.ts:627` then `:635`) and nothing holding a permit waits for another, so the lock order is total.
- **The Claude gate's shell screening (`packages/provider-claude/src/tools.ts`, `gate.ts:200-252`).** `shellWords`/`isReadOnlyCommand`, per-write symlink resolution, the `GIT_READ_WRAPPER`, `mutatesSharedGitMetadata` — the most rigorous treatment of this problem I have seen anywhere. The repair loop is likewise sound: bounded by `config.limits.repair`, journaled per attempt via `io.appendAttempt` (`ctx.ts:1206`), usage accumulated and charged even on throwing paths.
- **The task subsystem's authority model.** Agent write authority is bounded by `visibleTaskIds` derived from the *journaled* observation, not a re-evaluated selector (`packages/host/src/tasks.ts:938-970`); `batchId` is computed inside `execute` and journaled so it is replay-stable; `ifRevision` is a real compare-and-swap under a cross-process lock. There is no authority bypass on the agent write path.
- **The daemon's read discipline (`packages/daemon/src/state.ts:19-24`)** — folding journals rather than trusting the in-memory projection, with the reasoning written down — and its input validation on write paths (`jsonBody`, `budgetOf`, `parseConfig` before atomic temp+rename, `POST /api/runs` refusing paths, `:name` shape-checked before a registry that executes module top level, blob refs pinned to 64 hex, the static reader rejecting NUL/backslash and prefix-checking after `resolve`). SSE cleanup is correct end to end.
- **`apps/ui/src/domain/adapt.ts`** as a genuine anti-corruption layer between wire shapes and the view model, and the settings screen's whole-file PUT with an `inFlight` guard against a stale second write.
- **The release machinery.** `scripts/verify-packing.mjs` and `verify-install.mjs` are real gates: packing passes 16/16, and a packed sdk/core/git/isolation/store-fs/provider-mock/testing/host laid out as a consumer's `node_modules` typechecks a custom `JournalStore`, `BlobStore` and `AgentProvider` under `moduleResolution: NodeNext`. `ProviderId` is open and `Engine.providers` is public, so a third provider is registerable.
- **`packages/stdlib`** is honest thin sugar over `ctx` with no engine privilege, and the legacy daemon page builds its DOM with `textContent` — no XSS surface anywhere in either UI.

Two non-obvious guards worth noting because a reviewer *tried* to break them and could not: the append lock's "mutex lost" check does have two pre-mutation guards (`journal.ts:123`, `:136`) plus a post-await check (`:295-298`); and `restoreFiles()`'s whole-tree default (`packages/isolation/src/patch.ts:109-112`) is deliberate and pinned by a passing test.

---

## 6. Recommendations

### Now (this week)

1. Give `matchHuman` `matchStep`'s contract — seq + `positionsTrusted` + ambiguity → re-open the request — and add `key` to `AskOptions`/`ApproveOptions`/`ReviewOptions`/`gateStep` (`packages/core/src/replay.ts:340`, `packages/core/src/runtime.ts:947`).
2. Pass `io.reExecuting` into integrate's nested snapshot/apply steps (or give `integrate:apply:*` its own `verifyServe`) so a verify-refused merge actually re-applies (`packages/core/src/ctx.ts:2475`).
3. Add a per-tree-root mutex around integrate's snapshot+apply+hash+rollback and every other `rt.cwd` mutator; make `restorePatchFiles` refuse when the file is not what the failed apply left (`packages/core/src/ctx.ts:2388-2500`).
4. Make `drive()` abort-and-drain before `appendTerminal` and release the lease only on a completed drain (`packages/core/src/engine.ts:959`).
5. Have `fenceLostRun` walk the tree and fence every live member, or gate `drive()`'s cancel branch on the abort reason (`packages/core/src/engine.ts:849`, `packages/core/src/runtime.ts:1200`).
6. Add `-c core.fsmonitor=false` and `GIT_ENV` to `treeHash` and `integrationBaseCommit` — two lines (`packages/core/src/ctx.ts:291`, `:321`).
7. Pass `settingSources: []` in the Claude adapter's `Options` and assert it in a test (`packages/provider-claude/src/index.ts:250`).
8. Mark `reserveCall`'s park as a waiting step via `io.markWaiting` so a budgeted run can report suspension (`packages/core/src/budget.ts:203`, `packages/core/src/ctx.ts:635`).
9. Derive `patchKey` from the step's seq/hash, not the display label (`packages/core/src/ctx.ts:907`).
10. Return `null` from the detailed revive path when `$suppressed` is set (`packages/core/src/ctx.ts:1225`).
11. Iterate a snapshot in `checkIdle()` — one line (`packages/core/src/runtime.ts:477`).
12. Serialize `RunIndex.rebuild` and stop it from `ROLLBACK`-ing another call's transaction (`packages/index-sqlite/src/run-index.ts:169`).

### Next (this month)

13. Make step identity a single resolver that knows, per kind, whether ambiguity means re-run, re-ask, or resolve positionally; give `now/random/uuid/sleep` an occurrence ordinal (`packages/core/src/replay.ts:284`, `packages/core/src/ctx.ts:2665-2714`).
14. Compute `positionsTrusted` in `replayDry` and have the CLI pass the resolved def/defHash (`packages/core/src/engine.ts:1988`, `packages/cli/src/commands/replay.ts:27`).
15. Replace the task-store shadow-copy preflight with in-memory validation against the loaded array, outside the mutex (`packages/host/src/tasks.ts:988`).
16. Make settle-phase failures on served entries divergable rather than terminal, and give `revive` failures the same treatment (`packages/core/src/runtime.ts:604`, `:607`, `:786`).
17. Add a per-daemon secret injected into `index.html` and required on `/api/`; exact-origin match; move `/api/workflows/:name/tasks` off GET (`packages/daemon/src/app.ts:93`).
18. Default `taskMode` to `"read"` and add a workflow-level opt-in; move `observeTasks` inside the agent's retry/onError envelope; key it off content, not the label (`packages/core/src/ctx.ts:454`, `:483`).
19. Sum `modelUsage` and charge `cacheRead`/`cacheWrite` (`packages/provider-claude/src/index.ts:301`, `packages/core/src/budget.ts:65`).
20. Bound `?spend=1` and default `limit`; serve spend from the run index (`packages/daemon/src/app.ts:108`).
21. Add `addEventListener("child", …)` and an error-frame listener to the UI stream manager, plus a fake EventSource in the harness (`apps/ui/src/api/events.ts:28`, `apps/ui/src/test/daemon.ts:555`).
22. Give `watch()` a byteOffset cursor with a stat guard (`packages/store-fs/src/journal.ts:403`).
23. Fix `WorkflowDefinition`'s input parameter (`InferIn` for callers), `InferWorkflowOutput`, and the `AgentFn` overload pair (`packages/sdk/src/define.ts:72,81`; `packages/sdk/src/types.ts:255`).
24. Call `rejectUnknownInput` in MCP `startRun` — better, move it inside `Engine.start` (`packages/mcp/src/tools.ts:348`).
25. fsync blobs before publishing, using a shared `syncDir` helper (`packages/store-fs/src/blobs.ts:31`).
26. Bump `engines.node` and `MIN_NODE` to 22.13 and pin the CI matrix to the floor (`packages/host/src/tasks.ts:1175`, `packages/cli/src/commands/doctor.ts:21`).

### Later

27. Add a daemon deadline sweep so `ctx.sleep` and human timeouts have an owner; until then document the limitation (`packages/daemon/src/app.ts:312`).
28. Give `gateStep` a structured subject so approval policy can whitelist per command, and make the unspecified-risk branch deny (`packages/core/src/ctx.ts:780`, `:787`).
29. Invert `createToolGate` to deny-by-default and pass an explicit `Options.tools` allow-list (`packages/provider-claude/src/gate.ts:256`).
30. Extend `ProviderCapabilities` (`turnLimit`, `toolDeny`, `reportsFilesTouched`) and have `agentImpl` refuse or warn on unhonoured options; populate Codex `filesTouched` from `file_change` items (`packages/core/src/ctx.ts:737`, `packages/provider-codex/src/index.ts:136`, `:323`).
31. Add `no-local-time` to the gate's AST rules and shim the timezone accessors on `safeProto` (`packages/gate/src/rules.ts:47`, `packages/gate/src/load.ts:163`).
32. Move `TaskStore` out of `@techery/weft-host` into its own package or `store-fs`, and demote both provider packages to optional deps (`packages/host/src/tasks.ts`, `packages/testing/src/run.ts:22`).
33. Add `appendIf`/`acquireRun` blocks to the conformance suite and make the memory store honour `ttlMs` (`packages/testing/src/conformance.ts:111`, `packages/core/src/stores.ts:115`).
34. Clamp `updatedAt` on write and isolate per-file failures in `TaskStore.list` (`packages/host/src/tasks.ts:425`, `:281`).
35. Surface damaged runs in `list()` with a marker and add a `weft doctor` check over `.weft/runs` (`packages/store-fs/src/journal.ts:456`).
36. UI cleanups: lazy patch diff, memoised `splitDiff`, drop `run.journal`, cap the Artifacts render, wire the "Copy step id" button, and show the raw-JSON input path for open-keyed schemas (`apps/ui/src/api/queries.ts:117`, `apps/ui/src/app/useRunView.ts:52`, `ArtifactsTab.tsx:24`, `StepPane.tsx:167`, `Launcher.tsx:108`).
37. Refresh README's "Status and honest deviations": item 3 (README.md:391) still describes the single-file daemon page while `apps/ui` is the default surface, and item 5 (README.md:399) claims a keyless-ambiguity guarantee that does not hold for humans and is harmful for `uuid`.