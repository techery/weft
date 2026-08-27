# Lint strictness review — Biome 2.5.10

_August 2026. Measured against `d9b7bdf` (67.5k LOC of TS/TSX across 18 packages, `apps/ui`,
`examples/`, `.weft/`)._

## What was measured

Biome 2.5.10 ships **484 lint rules**; the `recommended` preset turns on 182 of them. To find out
what the remaining 302 would cost, every one was enabled at `error` in a throwaway config and the
whole repo was linted with `--reporter=json`. That produced **13,690 diagnostics across 111 rules**
— and, more usefully, **196 rules that fire zero times**.

A rule that fires zero times is free to turn on. It changes no code today; it stops the pattern
from arriving tomorrow. That is where the bulk of the win was.

## What changed

`biome.json` now enables **96 rules beyond `recommended`**, and `pnpm lint` fails on warnings.

### 1. `pnpm lint` now fails on warnings

This was the largest single soundness hole, and it had nothing to do with which rules were on.
`biome check` exits `0` when every diagnostic is a warning or info, and **87 of the 182 recommended
rules default to `warn` (57) or `info` (30) severity** — `useConst`, `noApproximativeNumericConstant`,
`useDefaultSwitchClauseLast`, `noConstEnum`, and friends. Verified directly: a file with a
`style/useConst` violation lints "Found 1 warning" and exits `0`. Every one of those rules was
advisory in CI.

```diff
-"lint": "biome check ."
+"lint": "biome check --error-on-warnings ."
```

The repo passes clean under the stricter gate, so nothing had to be fixed to land this — but from
here a warning-severity regression can no longer merge.

### 2. Type-aware rules, all at zero cost

Biome 2.5's type inference is good enough to run these, and the codebase is already clean under
every one of them:

| Rule | Catches |
| --- | --- |
| `nursery/noFloatingPromises` | an async call whose rejection nobody handles |
| `nursery/noMisusedPromises` | a `Promise` used where a boolean or `void` is expected |
| `nursery/useExhaustiveSwitchCases` | a `switch` over a union that misses a member |
| `nursery/noUnsafePlusOperands` | `+` across mismatched types |
| `nursery/noUselessTypeConversion` | `String(x)` on a `string`, `Number(n)` on a `number` |

`noFloatingPromises` returning zero on a codebase this async-heavy was surprising enough to be
worth double-checking, so it was verified against a synthetic floating promise — the rule fires,
the repo is simply clean. Locking that in is the most valuable single line in the diff: this
engine's correctness rests on awaited journal writes.

These rules do **not** need `linter.domains.project` (confirmed with `project: "none"`), which
matters — enabling that domain would also drag in `noUnresolvedImports` and
`noUndeclaredDependencies`, both of which are unusable here (see below).

### 3. `correctness/useImportExtensions`, scoped

`packages/*/src` is already **100% extension-ful** (293 `.ts` / 1 `.tsx` relative imports, zero
extensionless) because the published packages are `NodeNext` ESM, where a missing extension is a
runtime `ERR_MODULE_NOT_FOUND`. All 251 violations of this rule live in `apps/ui`, which is
Vite-bundled and idiomatically extensionless.

So the rule is on globally and off for `apps/ui` via an override. Zero code changed; a whole class
of "works in tests, breaks on install" bugs is now unrepresentable in the published packages.

### 4. Two recommended rules taken off the disabled list

`biome.json` had switched off four recommended rules plus three non-recommended ones. Measuring
them showed three were nearly free:

| Rule | Violations | Action |
| --- | --- | --- |
| `suspicious/noAssignInExpressions` | 2 | fixed, re-enabled |
| `style/useTemplate` | 4 | fixed, re-enabled |
| `complexity/noUselessStringConcat` | 1 | fixed, enabled |
| `style/noParameterAssign` | 4 | fixed, enabled (was never on — it is not in `recommended`) |
| `complexity/noForEach` | 0 | left off — zero violations, but it is a style call, not a soundness one |
| `complexity/useLiteralKeys` | 34 | left off |
| `suspicious/noExplicitAny` | 49 | left off — see below |
| `style/noNonNullAssertion` | 241 | left off — see below |

The `noAssignInExpressions` / `noParameterAssign` fixes were the same two sites in
`packages/core/src/jsonschema.ts`: `const seen = (ancestors ??= new WeakSet())`. The mutation was
dead — recursion already passes `seen` down explicitly — so it became `ancestors ?? new WeakSet()`.

### 5. Test-suite integrity rules

Four real defects surfaced, each a single site, each now enforced:

- `packages/core/test/review-regressions.test.ts` had **two `describe` blocks titled
  "codex review findings, round 33 (PR #1)"** (`nursery/noIdenticalTestTitle`).
- `packages/host/test/task-removal-durability.test.ts` declared `afterAll` before `beforeEach`
  (`nursery/useTestHooksInOrder`).
- `packages/daemon/test/api.test.ts` exported a type from a test file
  (`suspicious/noExportsInTest`).
- `packages/gate/test/gate.test.ts` used `Array(4)` rather than `new Array(4)`
  (`style/useConsistentBuiltinInstantiation`).

Alongside them, the zero-violation ratchets that keep a green suite honest:
`suspicious/noFocusedTests` (a stray `.only` silently shrinks CI to one test),
`suspicious/noSkippedTests`, `suspicious/noDuplicateTestHooks`,
`complexity/noExcessiveNestedTestSuites`, `nursery/useTestHooksOnTop`, `style/noDoneCallback`.

### 6. The rest of the zero-cost set

Roughly 70 more rules, all at zero violations. The ones that earn their place on soundness rather
than taste:

- **Silent-wrong-answer guards** — `suspicious/noConstantBinaryExpressions`,
  `suspicious/noUnusedExpressions`, `suspicious/noReturnAssign`,
  `suspicious/noUnassignedVariables`, `suspicious/noParametersOnlyUsedInRecursion`,
  `suspicious/noEqualsToNull`, `suspicious/noBitwiseOperators`,
  `suspicious/useNumberToFixedDigitsArgument`, `nursery/noNegationInEqualityCheck`.
- **Error handling** — `style/useThrowOnlyError`, `style/useThrowNewError`,
  `suspicious/useErrorMessage`, `complexity/noUselessCatchBinding`. A thrown non-`Error` loses its
  stack, and this engine journals `cause` chains.
- **ESM / Node correctness** — `correctness/noGlobalDirnameFilename` (`__dirname` does not exist
  in ESM), `correctness/useJsonImportAttributes` (`NodeNext` requires `with { type: "json" }`),
  `style/noCommonJs`, `suspicious/noVar`.
- **Package boundaries** — `correctness/noPrivateImports`, `correctness/noUndeclaredVariables`,
  `correctness/noUnusedInstantiation`, `complexity/noRedundantDefaultExport`.
- **React (`apps/ui`, `packages/design-system`)** — `correctness/useExhaustiveDependencies`,
  `correctness/useHookAtTopLevel`, `correctness/useJsxKeyInIterable`,
  `correctness/noNestedComponentDefinitions`, `correctness/noReactPropAssignments`,
  `suspicious/noArrayIndexKey`, `suspicious/noLeakedRender`,
  `security/noDangerouslySetInnerHtml{,WithChildren}`.
- **Idiom lock-ins** — `useForOf`, `useObjectSpread`, `useAsConstAssertion`, `noInferrableTypes`,
  `noUselessElse`, `useCollapsedElseIf`, `noYodaExpression`, `noSubstr`, `useTrimStartEnd`,
  `useNumberNamespace`, `nursery/useIncludes`, `nursery/useStringStartsEndsWith`,
  `nursery/useRegexpTest`, `nursery/useArraySome`, `nursery/useReduceTypeParameter`.

### Cost

Lint wall-clock went from **0.65s to 7s** — the type-inference scanner. That is the price of
`noFloatingPromises` and it is worth paying in a 10-minute CI job.

## Rules deliberately not adopted

### Not sound enough yet — Biome's inference produces false positives

These are the ones worth re-testing on each Biome upgrade. Every finding below was read in context
and is wrong:

| Rule | Hits | Why it was rejected |
| --- | --- | --- |
| `correctness/noUnresolvedImports` | 74 | Claims `react` has no export named `StrictMode` or `Fragment`, and that `node:sqlite` and the workspace packages cannot be resolved. 53 of the 74 are `*.module.css` imports typed by `vite/client`, which Biome does not read. All false. |
| `suspicious/noUnnecessaryConditions` | 61 | Calls `if (readyTimer.current)` "always falsy" — it cannot model a React ref mutated elsewhere. |
| `nursery/noUnsafeTypeAssertion` | 757 | Directionally right, but at this volume it is a rewrite, not a lint pass. |
| `nursery/useAwaitThenable` | 5 | All five are `await` on a `T \| Promise<T>` union (fixture hooks, `canUseTool`, `act`). Awaiting is correct. |
| `nursery/noBaseToString` | 5 | Loses `string[]` through `[...new Set(…)]` and flags `dirs.join(", ")`. |
| `nursery/useNullishCoalescing` | 1 | `state.createdAt \|\| steps[0]?.startedAt` is deliberate: `0` must fall through. |
| `suspicious/useArraySortCompare` | 14 | Fires on `string[]`, where the default comparator is the intended one. |
| `nursery/noLoopFunc` | 5 | All are `new Promise(resolve => …)` inside a `while` — no capture hazard. |
| `correctness/noUndeclaredDependencies` | 50 | Correct in principle: test files import `vitest` and workspace packages that the per-package `package.json` does not declare. Adopting it means adding devDependencies to ~15 packages. Worth doing on its own, not here. |

### Real debt, deferred

Sound rules with a cost that needs a decision, ranked by value:

| Rule | Hits | Note |
| --- | --- | --- |
| `style/useErrorCause` | 21 | Real: 21 places rethrow without `{ cause }`, discarding the original stack. The highest-value item on this list. |
| `suspicious/noEvolvingTypes` | 10 | Implicit `any` evolution; 8 of 10 in tests. |
| `suspicious/noShadow` | 36 | 8 in `packages/cli/src/commands/task.ts` alone. |
| `suspicious/noEmptyBlockStatements` | 11 | Mostly deliberate `catch {}`; each wants a comment or a `void`. |
| `suspicious/noExplicitAny` | 49 | Concentrated in 8 files, ~41 of them in `packages/sdk/src/{types,composition,define}.ts` and `core/src/ctx.ts` — generic-variance escape hatches that `unknown` cannot express. Adoptable as a file-scoped `overrides` entry rather than a blanket `off`. |
| `performance/noAwaitInLoops` | 143 | Many are intentionally sequential (journal ordering). Needs case-by-case review, not a sweep. |
| `suspicious/useAwait` | 84 | `async` with no `await`; largely test helpers and interface conformance. |
| `style/noNonNullAssertion` | 241 | 184 in tests, where `!` is reasonable. A `src`-only override would cost 46 fixes and pair well with `noUncheckedIndexedAccess`, which is already on. |
| `performance/noBarrelFile` / `noNamespaceImport` / `noDelete` | 33 / 6 / 15 | Bundle-size and shape rules; low value for a Node library. |

### Rejected on taste, not soundness

House-style rules the codebase consistently violates by choice, with counts for the record:
`style/noTernary` (1519), `style/useBlockStatements` (1573), `style/noMagicNumbers` (799),
`style/noNegationElse` (405), `style/noIncrementDecrement` (169), `style/noContinue` (113),
`style/useNamingConvention` (125), `style/useExportsLast` (104), `style/useDestructuring` (90),
`nursery/useExplicitType` (617), `complexity/noExcessiveCognitiveComplexity` (139).

Framework rules for stacks this repo does not use (Vue, Qwik, Solid, Next, Astro, Svelte, GraphQL,
Drizzle, Playwright, React Native, Tailwind) were excluded outright — note that Biome runs them
regardless of what is installed, so `suspicious/noReactSpecificProps` (604) and
`correctness/noSolidDestructuredProps` (213) are noise, not findings.

## Maintenance

Eighteen of the 96 new rules are in Biome's `nursery` group, which is explicitly unstable.
`@biomejs/biome` is pinned to an exact `2.5.10` in `package.json`, so they cannot shift underneath
CI — but **a Biome upgrade should re-run this measurement**, both to re-check the nursery rules and
to see whether the false-positive list above has shrunk.
