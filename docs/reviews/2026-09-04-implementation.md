# DSL, composition and delivery implementation

Branch: `feat/dsl-delivery-improvements`, based on `7fe75e96a9de66143005d392ce6d554b7b98de1e`.

This implements the work packages in the [analysis and plan](2026-09-04-dsl-composition-dx-plan.md) on the existing SDK/engine. It preserves the legacy APIs and task lifetime rather than switching the product to the declaration-only prototype. Changes are working-tree implementation, not a published release or a production reliability claim.

## Delivered work

| Plan | Implementation and evidence |
| --- | --- |
| 0A: safe checks | Unrevisioned callback freshness; explicit diagnostic attempts; expiry-validated non-passing waivers; required checks remain fail-closed. Candidate checks force fresh execution. [Delivery regressions](../../packages/core/test/delivery.test.ts). |
| 0B: correct shipped workflows | Required review/refutation coverage, stable semantic finding identity, lazy bounded fan-out, one writer per conflict domain, sequential integration, truthful fixed counts, shared diagnostic repair helpers and portable behavior tests. [Workflows](../../.weft/workflows), [coding helpers](../../packages/stdlib/src/coding.ts). |
| 0C: trustworthy tooling | Registry-aware test selection including example-container roots; empty selection fails; strict fixtures by default with explicit integration mode; scaffolds test behavior/failures; strict preflight and installed-consumer dependency checks. [CLI tests](../../packages/cli/test/cli.test.ts), [testing harness](../../packages/testing/src/run.ts). |
| 1: semantics | [Accepted composition ADR](../adr/0001-composition-replay-semantics.md) defines identity, replay, namespaces, context requirements, visibility, cancellation and migration. Supported SDK and preview are distinguished. |
| 2A: owned candidate runtime | Run-owned branch/worktree, preparation, persistent owner marker/lock, current committed candidate/environment identity, runtime-issued proof authority, write/check/delivery coordination, retained work and explicit conservative cleanup. [Workspace runtime](../../packages/core/src/workspace.ts). |
| 2B: operation recovery | Typed host bindings, immutable request input identity, bounded execute/reconcile calls, durable intent and receipt, unknown-outcome recovery, and lease retention while timed-out host calls remain alive. [Operation kernel](../../packages/core/src/operations.ts), [adversarial tests](../../packages/core/test/delivery-adversarial.test.ts). |
| 2C: complete delivery path | Real branch/commits, command acceptance checks, independent read-only review, exact-candidate human approval, opt-in GitHub PR creation and bounded CI/review feedback. [Runnable example 12](../../examples/12-reviewed-pr/README.md), [host adapter tests](../../packages/host/test/github-delivery.test.ts). |
| 3: authoring consolidation | Capability-typed `defineProcedure` with body re-entry and local effect namespaces; keyed `parallel.all/settled`; migrated example 11; generated command schema, SDK-first skill guide, advisory migration diagnostics and executable README snippets. [Procedure tests](../../packages/core/test/composition.test.ts). |
| 4: operations/evolution | Shared recovery/verification/feedback attention in CLI/MCP/daemon/UI; candidate and PR evidence; bounded provider status; strict/current, retained-source and edit-tolerant resume paths; static external dependency fingerprint; saved baseline contract vectors; daemon deadline wake-up and restart tests. [Compatibility guide](../evaluation.md). |
| 5: ecosystem/quality | GitHub creation and feedback adapters, plus eight versioned deterministic orchestration evaluation cases with an exact-repeatability test. Evaluation and portable delivery-example checks are enforced by CI/release configuration. Actual provider acceptance/cost/latency evaluation remains an explicit live gate, not fabricated numbers. [Evaluation runner](../../scripts/evaluate-workflows.ts). |

## Boundary hardening beyond the happy path

The independent adversarial pass exercises owner-marker/lock tampering, mutations through child/scoped/generic-operation paths, mutable check-list substitution, expired/stale evidence, interruption after remote dispatch, and a host call that ignores cancellation. These tests exercise runtime behavior, not only types. Offline file-review answers authenticate the retained worktree so a restarted host cannot apply approved edits to the original source checkout by mistake.

Existing recipe/step/parallel and persistent task contracts remain usable. Required-check history is still history; repaired candidates do not erase earlier failure evidence. New invocation waivers do not manufacture a passing verdict or authorize delivery. Prototype-only detailed receipts and other unimplemented builders remain clearly labeled proposals, consistent with the plan's incremental scope.

## Supported bounds

- The owned delivery implementation starts with one local repository/worktree and GitHub.com same-repository create-only branch/PR publication. It retains failed work and never auto-merges, auto-closes or force-updates a PR after comments.
- Remote feedback is structured current-head evidence with explicit pending/failed/unknown handling. It is not branch-protection approval or proof that merging is safe.
- Host binding risk and candidate proof identity are enforced. Check names do not authenticate the semantic quality of arbitrary untrusted check code, and a TypeScript context or Git worktree is not a sandbox.
- Retained bundles preserve workflow source and UI provenance. Dependency fingerprints detect changed installed modules; they do not recreate an old dependency installation. Missing/changed provenance blocks conservative resume.
- Historical compatibility fixtures are explicitly handcrafted baseline contract vectors, checked by executing the baseline reducer/replay implementation. They are not invented production histories.
- Evaluation counts describe deterministic orchestration with mocks. No model-quality, comparative performance, human-time or production-success claims follow from them.

See [the delivery guide](../delivery.md) for the runtime/host contract, operational commands, configuration and recovery limits.

## Validation

Final local validation used Node `22.21.1` on macOS:

| Gate | Result |
| --- | --- |
| `pnpm typecheck` | Root and UI passed |
| `pnpm build` | All workspace packages and production UI passed |
| `pnpm test` | 70 files passed; **1,152 tests passed**, one Linux-only `/proc` test skipped |
| `pnpm lint` | Passed; two pre-existing `noConfusingVoidType` warnings in unchanged prototype `agent.ts` |
| `pnpm verify:packing` | All 18 publishable packages passed |
| `pnpm verify:install` | 5/5 passed in a fresh temporary consumer: CLI help, doctor, scaffold with strict validation, MCP initialization and bundled UI lookup |
| Portable workflow tests | Repository workflows, cookbook, composition and reviewed-PR suites passed; reviewed-PR includes three real-Git/mock-remote cases |
| Numbered example runners | All 11 top-level runners passed; cookbook has separate portable tests |
| `weft check --strict` | Four repository workflows passed lint/gate/schema/typecheck |
| `pnpm verify:examples` | 88 public surfaces mapped |
| `pnpm evaluate:workflows`, `pnpm test:evaluation` | Eight deterministic cases and all three repeatability/negative tests passed |
| Metadata and documentation | `pnpm sync:meta --check`, `git diff --check` and 32 local guide/report links passed |

The full suite was finally run after build completion so the built-UI check was exercised. Packing and install verification must run sequentially: the prototype's prepack clean/build shares its output directory. Fresh-install verification exposed and verified the fix for the gate's missing production stdlib dependency; example execution exposed and verified the explicit integration-mode setting needed by example 08's real scratch Git repository.

Focused suites additionally cover actual scratch Git changes, child/descendant ownership, dry-preview boundaries and mocked remote recovery. UI evidence is component tests plus a production build and installed asset lookup, not manual browser acceptance. CI/release gates were updated but have not been executed remotely. No live PR, merge, credential provisioning, model spend, comparative cost/latency benchmark, commit or publication is part of this validation. Existing untracked `docs/competitors/` research was preserved.
