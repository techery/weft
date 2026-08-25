# @techery/weft-testing

runWorkflow harness, mock fixtures, journal assertions, conformance suites.

Part of [Weft](https://github.com/techery/weft) — durable, journaled, schema-validated multi-agent coding workflows
in TypeScript. This package is not usually installed on its own; see the
[project README](https://github.com/techery/weft#readme) for what Weft is and how the pieces fit together.

```bash
npm i @techery/weft-testing
```

`runWorkflow` wires the production task store for every definition, matching the normal host. This lets
fixture-driven tests exercise filtered agent context, journaled `ctx.tasks` operations, extension-schema
validation, and recurring upserts across runs that share a `cwd`, without calling a model.
Pass `providers: { claude, codex }` to prove provider routing with independent fixtures; `provider` remains
the convenient fallback for both ids.

- Source: [`packages/testing`](https://github.com/techery/weft/tree/main/packages/testing)
- Issues: https://github.com/techery/weft/issues
- License: MIT
