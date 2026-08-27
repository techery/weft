# 10 · Minimal API cookbook

Tiny workflow packages cover the remaining public workflow APIs without turning one demo into a large application:

- `example-composition/` — structured agents, detailed results, retries, parallel lanes, pipelines, settled helpers, and children.
- `example-humans-and-waits/` — gates, ask/approve/review, signals, and durable sleep.
- `example-effects/` — filesystem, exec, bash, fetch, environment, secrets, and all check forms.
- `example-git/` — every git read and mutation behind one explicit operation switch. Run mutations only in a throwaway repo.
- `example-state-tasks-and-patches/` — durable values, run/budget state, notes, task operations, integration, and discard.

Each directory is a complete workflow package with `main.ts`, `lib/`, `tests/`, and `CHANGELOG.md`.
`examples/coverage.json` maps every public `Ctx` surface to one example, and `pnpm verify:examples` derives the
API list from the SDK and fails if the map drifts.

Register any package directly, supplying the small input its schema requests:

```sh
pnpm exec weft --extra-workflow-dir examples/10-api-cookbook/example-composition \
  run example-composition --args '{"values":[1,2,3]}' --watch
```
