# 10 · Minimal API cookbook

Tiny workflow files cover the remaining public workflow APIs without turning one demo into a large application:

- `composition.ts` — structured agents, detailed results, retries, parallel lanes, pipelines, settled helpers, and children.
- `humans-and-waits.ts` — gates, ask/approve/review, signals, and durable sleep.
- `effects.ts` — filesystem, exec, bash, fetch, environment, secrets, and all check forms.
- `git.ts` — every git read and mutation behind one explicit operation switch. Run mutations only in a throwaway repo.
- `state-tasks-and-patches.ts` — durable values, run/budget state, notes, task operations, integration, and discard.

Each file is a real workflow that typechecks with the repository. `examples/coverage.json` maps every public `Ctx`
surface to one example, and `pnpm verify:examples` derives the API list from the SDK and fails if the map drifts.

Run any file directly, supplying the small input its schema requests:

```sh
pnpm exec weft run ./examples/10-api-cookbook/composition.ts --args '{"values":[1,2,3]}' --watch
```
