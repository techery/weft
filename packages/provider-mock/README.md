# @techery/weft-provider-mock

Mock AgentProvider for tests and replay verification.

Part of [Weft](https://github.com/techery/weft) — durable, journaled, schema-validated multi-agent coding workflows
in TypeScript. This package is not usually installed on its own; see the
[project README](https://github.com/techery/weft#readme) for what Weft is and how the pieces fit together.

```bash
npm i @techery/weft-provider-mock
```

```ts
import { mock, mockSequence } from "@techery/weft-provider-mock";

const provider = mock({ strict: true, profile: "codex" })
  .on({ key: "review:*" }, mockSequence([{ verdict: "revise" }, { verdict: "ship" }]));
```

Strict mode rejects fixture writes from read-only steps, workspace escapes, protected paths, and files
outside a declared write scope. `profile` advertises the selected real provider's capabilities so tests
exercise capability preflight instead of a universally permissive mock.

- Source: [`packages/provider-mock`](https://github.com/techery/weft/tree/main/packages/provider-mock)
- Issues: https://github.com/techery/weft/issues
- License: MIT
