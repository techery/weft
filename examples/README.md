# Examples

Folders 01–07 are self-contained library tours that run offline and deterministically with
`@techery/weft-provider-mock`; `03` also builds a throwaway git repository because write steps need real
worktrees. Folder 08 is a production-style CLI workflow: its test uses fixtures, while an interactive run uses
the configured review providers and the repository's durable task store.

```sh
pnpm install                                       # once, at the repo root
npx tsx examples/01-engine-as-a-library/main.ts    # then any example
```

| # | Folder | What it shows |
|---|--------|---------------|
| 01 | [`01-engine-as-a-library`](./01-engine-as-a-library) | The engine as a plain class: memory stores, a mock provider, an inline workflow, and the generated `report.md` |
| 02 | [`02-human-in-the-loop`](./02-human-in-the-loop) | A high-risk gate suspending the run durably; answer and resume from "other processes"; timeout policies answering by default |
| 03 | [`03-write-steps-and-patches`](./03-write-steps-and-patches) | Write steps in isolated worktrees, patches landed only by `ctx.integrate`, a warn-mode scope violation flagged in the report |
| 04 | [`04-resume-and-replay`](./04-resume-and-replay) | Edit-tolerant replay: zero re-runs on an unchanged resume, exactly one on a reworded prompt, `replay --dry` previews, journaled randomness |
| 05 | [`05-sub-workflows-and-budget`](./05-sub-workflows-and-budget) | Child runs with their own journals under one shared token ceiling; the call that would overrun is refused |
| 06 | [`06-stdlib-patterns`](./06-stdlib-patterns) | `loopUntilDry` + `adversarialVerify` + `finalReport` from `@techery/weft-stdlib`, composed inside one workflow |
| 07 | [`07-testing-workflows`](./07-testing-workflows) | `@techery/weft-testing`'s `runWorkflow`: git fixtures, schema-validated mock fixtures, journal and phase assertions |
| 08 | [`08-task-backed-code-review`](./08-task-backed-code-review) | A read-only review that consolidates and independently refutes findings, then upserts only human-selected work into a durable deduplicated backlog |

Most example *workflows* used by the CLI live separately in [`.weft/workflows/`](../.weft/workflows)
(`review.ts`, `audit-and-fix.ts`) — those are what `weft run review` executes; the folders
here drive the engine directly as a library.
