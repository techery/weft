# Contributing to Weft

Thanks for improving Weft. This guide covers changes to the runtime, packages, examples, workflow manager, and
documentation. For the release process, see [RELEASING.md](./RELEASING.md).

## Set up a checkout

Weft requires Node 22.12 or newer and pnpm 10.

```bash
pnpm install
pnpm typecheck
pnpm test
```

Packages, examples, and repository workflows run from source during normal development; a build is not required
for every edit. The workspace is ESM-only and TypeScript is strict. Relative imports within a package, including
`.weft/workflows/`, use an explicit `.ts` extension. `pnpm build` rewrites those imports to `.js` in `dist/` for
the published packages.

`.weft/workflows/` and `examples/` resolve workspace packages from the root `node_modules`, so one `pnpm install`
is enough to run examples with `npx tsx examples/...`.

## Choose the smallest useful check

Run the checks that exercise the behavior you changed, then expand before a broad or release-facing change.

| Change | Start with | Before sharing broadly |
| --- | --- | --- |
| Runtime or package behavior | Relevant Vitest file(s) | `pnpm typecheck && pnpm test && pnpm lint` |
| Workflow source or template | `weft check <name>` | Add a fixture-backed workflow test and run `pnpm verify:examples` if the public API changed |
| Custom workflow UI | Its unit/contract test and `npx tsx examples/09-custom-react-ui/main.ts` | Exercise the daemon/browser path when making a rendering or submission claim |
| Workflow Manager | Focused UI test plus `pnpm --filter @techery/weft-ui typecheck` | `pnpm test && pnpm lint`; use `pnpm dev:ui` against `weft ui` for interactive work |
| Package/release plumbing | `pnpm build` | `pnpm verify:packing && pnpm verify:install` |

Useful everyday commands:

```bash
pnpm test:watch
pnpm dev:ui           # Vite on :4782, proxied to a `weft ui` daemon
pnpm lint             # Biome checks — warnings fail, same as CI
pnpm lint:fix         # Biome writes lint fixes
pnpm format           # Biome formatting
pnpm build            # package dist/ output and workflow-manager bundle
pnpm clean            # remove package dist/ output
pnpm verify:examples  # ensure every public Ctx API has a runnable example
```

`biome.json` enables 96 rules beyond Biome's `recommended` preset, including the type-aware
`noFloatingPromises` / `noMisusedPromises` / `useExhaustiveSwitchCases`. Most were adopted because
they already fired zero times — they exist to keep it that way. Before adding a rule, measure it;
before switching one off, read
[`docs/reviews/2026-08-lint-strictness.md`](docs/reviews/2026-08-lint-strictness.md), which records
what each rule cost and why the rejected ones were rejected.

The test harness is deliberately model-free. Use `@techery/weft-testing` fixtures matched on stable step keys;
they execute the real engine validation and journal path. A test should assert the observable workflow result or
journal behavior, rather than only that a mock was called. Use `mockTaskEnvelope` when a test intentionally
exercises agent-requested task mutations.

## Workflow changes

Workflows are ordinary TypeScript, but the gate enforces replayable behavior. Keep side effects behind `ctx`,
give repeated or fan-out steps stable keys, and prefer the mapper form of `ctx.parallel` when you need a
concurrency cap. Run `weft check <name>` after authoring changes; it validates the gate, bundle, schemas, and
custom view assets before any provider work begins.

Use the scaffold that matches the job:

```bash
weft new answer --template simple
weft new review --template review
weft new issue-queue --template task
weft workflow inspect issue-queue --json
```

Task-enabled workflows need a stable `meta.id` and an explicit executable task revision. Prefer
`defineTaskContract` for typed extension data, and grant agent write authority only where it is required.

For custom UI, keep `.ui.tsx` components directly referenced by the workflow. Props and staged answers must be
JSON-safe. Input views may propose a candidate, but host-owned controls remain responsible for validation and
durable submission. Read [the custom React UI guide](./docs/custom-react-ui-in-workflows.md) before changing the
compiler, journal contract, manager frame, or example.

## Repository maintenance workflows

Weft uses its own workflows to keep its agent instructions and coverage honest:

- `maintain-agent-skill` compares the relevant source changes with the canonical `weft skill` document, makes
  bounded repairs in an isolated worktree, and independently verifies the generated skill. Run
  `weft run maintain-agent-skill --base main --watch` when an authoring or runtime change may alter the skill.
- `ensure-code-coverage` measures production-source coverage, can bootstrap the Vitest coverage provider, sends
  focused test work to isolated worktrees, and requires both numeric thresholds and an independent quality audit
  before it succeeds. Run `weft run ensure-code-coverage --base main --watch` to start the fail-closed workflow.

These are maintenance workflows for this repository, not generic CLI commands. Their reports are evidence for
their particular run; a completed measurement is not automatically proof that a release meets every quality gate.

## Documentation and submitted changes

Document user-visible behavior in the closest durable source: the root README for the product overview and
quickstart, a package README for package-specific behavior, and `examples/` for runnable APIs. Update
`examples/coverage.json` with an executable example whenever the public `Ctx` surface changes.

Keep a change focused, include regression coverage for behavior changes, and state the commands you ran and any
remaining verification limits. Do not claim browser, provider, package-publication, or release behavior based
only on static checks; exercise that path or describe the limitation precisely.
