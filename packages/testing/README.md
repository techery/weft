# @techery/weft-testing

runWorkflow harness, mock fixtures, journal assertions, conformance suites.

Part of [Weft](https://github.com/techery/weft) — durable, journaled, schema-validated multi-agent coding workflows
in TypeScript. This package is not usually installed on its own; see the
[project README](https://github.com/techery/weft#readme) for what Weft is and how the pieces fit together.

```bash
npm i @techery/weft-testing
```

Strict fixtures exercise the same edit boundary as production, while `fixture.sequence` makes repeated
responses explicit (ordinary arrays remain ordinary schema values):

```ts
import { fixture, mock, runWorkflow } from "@techery/weft-testing";

const result = await runWorkflow(workflow, {
  input: {},
  fs: {
    "src/input.ts": "export const value = 1;\n",
    ".weft/test-config.json": JSON.stringify({ defaults: { provider: "codex" } }),
  },
  config: { path: ".weft/test-config.json" },
  provider: mock({ strict: true }).on(
    { key: "review:*" },
    fixture.sequence([{ verdict: "revise" }, { verdict: "ship" }]),
  ),
});

result.journal.ran("review:src/input.ts");
result.journal.neverRan("fix:src/input.ts");
```

- Source: [`packages/testing`](https://github.com/techery/weft/tree/main/packages/testing)
- Issues: https://github.com/techery/weft/issues
- License: MIT
