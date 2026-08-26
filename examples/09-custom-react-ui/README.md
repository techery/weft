# 09 · Custom React workflow UI

This workflow demonstrates every custom-UI mode in one durable run:

1. `ctx.ui.render()` publishes a read-only deployment plan as its own replayable presentation step.
2. `ctx.human.ask({ ui: … })` renders a custom selector that can only stage a candidate answer.
3. A second `ctx.ui.render()` composes workflow input and the validated human decision into a final view.

The standard schema form and raw result stay visible beside custom UI. The component never receives a final
submission function; the Workflow Manager validates and submits the staged candidate through host-owned chrome.

From the repository root, start the Workflow Manager in one terminal:

```sh
pnpm exec weft ui
```

Then start the example in another terminal:

```sh
pnpm exec weft run ./examples/09-custom-react-ui/workflow.ts \
  --args '{"environment":"staging","services":["api","web","worker"]}' \
  --watch
```

Open the waiting run from the queue. Use **Stage selection** inside the workflow-provided frame, inspect the exact
candidate in Weft, then choose **Submit and resume**. The final timeline contains both immutable result views and
the human request. Refreshing the page renders each presentation from its journaled asset and props references.

Files ending in `.ui.tsx` are direct TypeScript imports for authoring, but Weft compiles them twice: the workflow's
Node graph receives an inert typed token, while a separate browser graph receives the React component and its
contained imports.
