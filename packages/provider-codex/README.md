# @techery/weft-provider-codex

AgentProvider over the OpenAI Codex SDK.

Part of [Weft](https://github.com/techery/weft) — durable, journaled, schema-validated multi-agent coding workflows
in TypeScript. This package is not usually installed on its own; see the
[project README](https://github.com/techery/weft#readme) for what Weft is and how the pieces fit together.

```bash
npm i @techery/weft-provider-codex
```

Per-step Codex SDK mechanics live under the `codex` provider namespace:

```ts
await ctx.agent("Inspect the change", {
  provider: "codex",
  providerOptions: {
    codex: { sandboxMode: "read-only", networkAccess: false, webSearch: "cached" },
  },
  providerRequirements: { structured: "native" },
  schema: Verdict,
});
```

The adapter rejects unknown options and cannot widen a read-only Weft step to `workspace-write`.

- Source: [`packages/provider-codex`](https://github.com/techery/weft/tree/main/packages/provider-codex)
- Issues: https://github.com/techery/weft/issues
- License: MIT
