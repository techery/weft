# @techery/weft-ui

The weft workflow manager — the local daemon's single-page web UI.

```bash
pnpm dev:ui                              # vite dev server on :4782, hot reload
pnpm --filter @techery/weft-ui build     # -> packages/daemon/web/
pnpm --filter @techery/weft-ui test
```

## How `weft ui` serves it

The build output goes to `packages/daemon/web/`, not to a local `dist/`. That is the
directory `@techery/weft-daemon` serves at `/`, and the daemon is what `weft ui` starts —
so there is one artifact in one place, found by the same relative lookup whether the
daemon is running off this repo's `src/` or off a published tarball. `index.html` is read
once at startup; hashed assets are read on first request and cached with a one-year
`immutable`; any path that is not a file and not under `/api/` is served the document, so
deep links into the manager's own routes work on a cold load.

Nothing here is required for the daemon to be useful: with no bundle built, it serves its
own built-in page instead, and `weft ui` prints which one you got. The built-in page — the
one that reads the live journal — stays at `/legacy` either way.

## What it shows

Five screens, recreated from the `Weft UI v6` design:

| Screen | What it answers |
| --- | --- |
| **Queue** | What is blocked on a human right now, and what is working |
| **Runs** | The 30-day journal index, filterable by state |
| **Run detail** | One run's steps, findings, artifacts, staged changes and journal |
| **Workflows** | Every workflow file, its shape, its success rate, its recent runs |
| **Settings** | Approval policy per risk tier, budget, pool size, providers |

Plus a ⌘K launcher: pick a workflow, fill in its declared inputs, start it.

## Layout

Atomic design, one concern per level:

```
src/
  domain/        types, fixtures and pure view-model builders — no React
  state/         Jotai atoms: answers, policy, budget, launcher
  app/           router, root layout, navigation hooks
  components/
    atoms/       buttons, dots, pills, fields
    molecules/   rows, cards, one-question controls
    organisms/   the rail, the step pane, the gate form, the launcher
    templates/   app shell and page frames
  pages/         one component per route
```

Two rules keep it honest:

- **`domain/` never imports React.** Everything the screens show is derived by
  pure functions over the run fixtures, so it is testable without rendering.
- **Component styles live in the component's own CSS module**, including the
  design-system button and field bases. Nothing depends on stylesheet ordering
  to win a specificity race.

## Where the data comes from

`domain/fixtures/` holds the five runs, six workflows and their diffs, exactly
as the design specifies them. `buildRuns()` takes the current answer state and
returns the runs, so approving or denying a gate rewrites the run it belongs
to — its state, pill, rail, journal and the gate step's own output all move.
Swapping in the daemon's `/api/runs` means replacing that one function; nothing
above it knows the difference.

## State

Jotai holds what is not worth a URL: gate answers, approval policy, budget,
pool size, launcher inputs. The router holds what is: which filter, which
workflow, which step of which run — so every view is a link you can share.
