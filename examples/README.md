# Examples

Folders 01–07 are self-contained library tours that run offline and deterministically with
`@techery/weft-provider-mock`; `03` also builds a throwaway git repository because write steps need real
worktrees. Folder 08 is a production-style CLI workflow: its test uses fixtures, while an interactive run uses
the configured review providers and the repository's durable task store. Folder 09 has an offline compiler/runtime
check plus an interactive file workflow for custom React result and input views in the Workflow Manager.

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
| 09 | [`09-custom-react-ui`](./09-custom-react-ui) | Browser-compiled React views for a replayable result, schema-authoritative human input, and a composed final presentation |

## Key-feature coverage

Every major public capability has a runnable example. When a new key feature lands, add or extend an example and
this matrix in the same change.

| Weft capability | Primary example |
|-----------------|-----------------|
| Typed workflows, structured agent output, journal-derived reports | 01 · Engine as a library |
| Durable human gates, cross-process answers, timeout policies | 02 · Human in the loop |
| Isolated write steps, patch capture, scope enforcement, explicit integration | 03 · Write steps and patches |
| Content-addressed replay, edit tolerance, dry-run previews, deterministic values | 04 · Resume and replay |
| Typed child workflows, run trees, shared hard budgets | 05 · Sub-workflows and budget |
| Reusable adversarial verification and loop-until-dry patterns | 06 · Stdlib patterns |
| Deterministic fixtures and journal assertions | 07 · Testing workflows |
| Durable task observation, selection, deduplication, and upsert | 08 · Task-backed code review |
| Custom result views, custom human input, composed React presentations | 09 · Custom React UI |

Most example *workflows* used by the CLI live separately in [`.weft/workflows/`](../.weft/workflows)
(`review.ts`, `audit-and-fix.ts`) — those are what `weft run review` executes; the folders
here drive the engine directly as a library.
