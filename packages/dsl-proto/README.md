# @techery/weft-dsl-proto

Type-only prototype of the intended Weft context DSL.

## Latest prototype revision

This working-tree revision makes the proposed DSL smaller and more literal:

- one `ctx.agent(...)` function handles reusable agents, one-off prompts, authorized writes, and returned failure;
- `ctx.step(...)` names durable workflow sections, while pipeline effects use `.mapEffect(...)`;
- `ctx.workspace.snapshot` captures the current state, and checks, reviews, artifacts, and delivery bind to a
  `candidate`;
- the host must atomically reject stale candidates and evidence from another candidate; explicit comparison and
  freshness assertions live only on the advanced surface;
- task contracts have no author-facing version, revision, or migration API because task state is run-scoped and
  short-lived.

This is a source-level prototype update, not a published runtime release. The package remains declaration-only.

Part of [Weft](https://github.com/techery/weft) — durable, journaled, schema-validated multi-agent coding workflows
in TypeScript. This package is not usually installed on its own; see the
[project README](https://github.com/techery/weft#readme) for what Weft is and how the pieces fit together.

```bash
npm i @techery/weft-dsl-proto
```

- Source: [`packages/dsl-proto`](https://github.com/techery/weft/tree/main/packages/dsl-proto)
- Prototype contract and module map: [`PROTOTYPE.md`](./PROTOTYPE.md)
- Developer introduction and design story: [`WEFT-DSL-BLOG.md`](./WEFT-DSL-BLOG.md)
- Eleven-round DX and type-safety log: [`DESIGN-ROUNDS.md`](./DESIGN-ROUNDS.md)
- Advanced operation and delivery lifecycle types: [`@techery/weft-dsl-proto/advanced`](./src/advanced.ts)
- Type-only workflow harness contract (no executable harness here): [`@techery/weft-dsl-proto/testing`](./src/testing.ts)
- Refined coding workflows: [`src/examples/refined`](./src/examples/refined)
- Adversarial workflow rounds: [`src/examples/rounds`](./src/examples/rounds)
- Internal execution proof: [`src/examples/internal-engine.ts`](./src/examples/internal-engine.ts)
- Issues: https://github.com/techery/weft/issues
- License: MIT
