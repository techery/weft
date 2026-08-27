# @techery/weft-provider-claude

AgentProvider over the Claude Agent SDK.

Part of [Weft](https://github.com/techery/weft) — durable, journaled, schema-validated multi-agent coding workflows
in TypeScript. This package is not usually installed on its own; see the
[project README](https://github.com/techery/weft#readme) for what Weft is and how the pieces fit together.

```bash
npm i @techery/weft-provider-claude
```

Per-step Claude SDK mechanics live under the `claude` provider namespace:

```ts
await ctx.agent("Inspect the change", {
  provider: "claude",
  providerOptions: { claude: { permissionMode: "dontAsk" } },
  schema: Verdict,
});
```

`default` routes permission questions through Weft's hook; `dontAsk` denies tools that are not already
permitted. Neither value can widen Weft's read/write scope.

- Source: [`packages/provider-claude`](https://github.com/techery/weft/tree/main/packages/provider-claude)
- Issues: https://github.com/techery/weft/issues
- License: MIT
