# 07 · Testing workflows

`@weft/testing`'s `runWorkflow` drives a real engine over memory stores with fixtures
for everything that would leave the sandbox — zero model calls, zero git repos. This
example runs it under plain `node:assert` to show there is no test-runner magic; the
same API backs the vitest suites in `packages/*/test`.

```sh
npx tsx examples/07-testing-workflows/main.ts
```

What to look for:

- `git: { changedSince: … }` fixtures `ctx.git` — the deleted `b.ts` never gets a
  review step, and the journal proves it (`steps({ kind: "agent" })` has length 2);
- mock fixtures are validated against each step's schema, so a fixture that would not
  pass in production fails the test;
- the **journal is an assertion target**: the refuter's prompt text, its `provider:
  "codex"` route (cross-vendor grading), and the discovered phase list are all checked;
- `journal.toJSON()` is snapshot-stable — no timestamps, no volatile ids — for catching
  accidental graph changes.
