# Task-backed code review

This workflow keeps same-run review claims in typed data, then persists only findings that survive an
independent provider and explicit human selection. Repeated runs upsert one task per semantic fingerprint,
append occurrence evidence, preserve first-seen provenance, and reopen completed recurring findings.

Run the deterministic offline demonstration with `npx tsx examples/08-task-backed-code-review/main.ts`.

```bash
cp examples/08-task-backed-code-review/workflow.ts .weft/workflows/task-backed-code-review.ts
weft run task-backed-code-review --watch
weft task --workflow example.task-backed-code-review list
weft ui
```

The review agents receive only related open `code-review` tasks with read-only task authority. Consolidation
and refutation receive no task context, avoiding anchoring. The workflow itself owns the journaled task
observation and upsert after the human gate.
