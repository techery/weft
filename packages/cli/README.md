# @techery/weft

weft CLI: runs, workflow-bound task tracking, gates, reports, debugging, and UI.

Part of [Weft](https://github.com/techery/weft) — durable, journaled, schema-validated multi-agent coding workflows
in TypeScript. This package is not usually installed on its own; see the
[project README](https://github.com/techery/weft#readme) for what Weft is and how the pieces fit together.

```bash
npm i -g @techery/weft
```

Add workflows outside the configured `.weft/workflows` directory with a repeatable global flag. Run state,
tasks, and config still belong to `--cwd`:

```bash
weft --extra-workflow-dir examples/08-task-backed-code-review \
  --extra-workflow-dir examples/09-custom-react-ui ui
```

- Source: [`packages/cli`](https://github.com/techery/weft/tree/main/packages/cli)
- Issues: https://github.com/techery/weft/issues
- License: MIT
