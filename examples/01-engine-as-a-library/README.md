# 01 · The engine as a library

No CLI, no filesystem, no models: hand `Engine` a journal store, a blob store, and a
provider registry, and run a workflow defined in the same process.

```sh
npx tsx examples/01-engine-as-a-library/main.ts
```

What to look for:

- the workflow is an ordinary `defineWorkflow` value — the same shape a
  `.weft/workflows/*/main.ts` package exports;
- the mock provider's fixtures are matched by step **key** and still pass through the
  engine's schema validation, so a fixture that would not survive production fails here too;
- the printed output is `report.md` — a projection folded from the journal after the
  fact, exactly what `weft report <run>` renders.
