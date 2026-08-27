# 09 · Custom React workflow UI

This workflow is both a custom-UI contract example and a stress test for the reusable Weft design system. It
demonstrates every custom-UI mode in one durable run:

1. `ctx.ui.render()` publishes a read-only deployment plan as its own replayable presentation step.
2. `ctx.human.ask({ ui: … })` renders a custom release command center that can only stage a candidate answer.
3. A second `ctx.ui.render()` composes workflow input and the validated human decision into a final view.

The standard schema form and raw result stay visible beside custom UI. The component never receives a final
submission function; the Workflow Manager validates and submits the staged candidate through host-owned chrome.

The views import `@techery/weft-design-system` for the same tokens and React primitives used by the manager.
Each view uses `WeftTheme`, which embeds the approved styles without a CSS import.

The default input deliberately includes eight services across ready, degraded, queued, and blocked states. The
review frame exercises responsive grids, overflow, empty selections, long operator notes, required production
fields, disabled actions, accessible toggles, ranges, selects, and four decision presets:

- **Approve all** produces an all-clear receipt with an empty deferred state.
- **Safe canary** demonstrates partial approval and warning banners.
- **Minimal scope** reduces the release to one service and changes rollout controls.
- **Reject** stages a valid zero-service no-op and requires an explanatory note.

The final view renders approved, partial, and rejected outcomes; empty and populated service groups; missing and
present optional fields; policy warnings; long wrapping text; and an expandable normalized JSON receipt.

Run the deterministic offline contract check used by CI:

```sh
npx tsx examples/09-custom-react-ui/main.ts
```

It compiles all three real browser assets, drives the human suspension programmatically, and asserts that the
plan and outcome presentations can be recovered from the journal and blob store.

From the repository root, start the Workflow Manager in one terminal:

```sh
pnpm exec weft ui
```

Then start the example in another terminal:

```sh
pnpm exec weft run ./examples/09-custom-react-ui/custom-react-ui/main.ts \
  --args '{"environment":"production"}' \
  --watch
```

Open the waiting run from the queue. Use **Stage selection** inside the workflow-provided frame, inspect the exact
candidate in Weft, then choose **Submit and resume**. The final timeline contains both immutable result views and
the human request. Refreshing the page renders each presentation from its journaled asset and props references.

Files ending in `.ui.tsx` are direct TypeScript imports for authoring, but Weft compiles them twice: the workflow's
Node graph receives an inert typed token, while a separate browser graph receives the React component and its
contained imports.
