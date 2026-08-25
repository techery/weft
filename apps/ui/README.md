# @techery/weft-ui

The weft workflow manager — the local daemon's single-page web UI.

```bash
pnpm dev:ui                              # vite on :4782, hot reload, proxied to a daemon
pnpm --filter @techery/weft-ui build     # -> packages/daemon/web/
pnpm --filter @techery/weft-ui test
```

## Editing the UI against a working daemon

Two processes. The daemon does the real work; Vite serves the page and forwards its API
calls there, so you can edit a component while a run is mid-flight and see the change
without losing what is on screen.

```bash
weft ui                 # terminal 1 — a daemon on :4781, running your workflows
pnpm dev:ui             # terminal 2 — the UI on :4782, hot-reloading against it
```

Then open **http://localhost:4782** — not `127.0.0.1:4782`. Vite binds `[::1]` and the
daemon binds `127.0.0.1`; the proxy bridges them, but only the address Vite is actually
listening on will answer.

Point it somewhere else with `WEFT_DAEMON`:

```bash
WEFT_DAEMON=http://127.0.0.1:4790 pnpm dev:ui
```

Keep that an IP, not `localhost` — Node resolves `localhost` to `::1` first, and the
daemon does not listen there.

The proxy exists instead of CORS on the daemon, deliberately. The daemon refuses any
request carrying a non-loopback `Origin`, and that guard is what stands between a page you
happen to visit and an API that can cancel your runs. Proxying keeps the browser
same-origin, so the guard stays exactly as strict in dev as in production.

Two things to know:

- **`weft ui` serves the built bundle**, read once at startup. Changes you make in dev do
  not reach it until `pnpm --filter @techery/weft-ui build` **and** a daemon restart. Dev
  mode is where you iterate; the daemon is where you check the shipped artifact.
- The status bar shows the origin the page is talking to, which in dev is Vite's address
  rather than the daemon's. That is the address requests actually go to.

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

The daemon that serves this page. `api/` holds the typed calls and the query
hooks; `domain/adapt.ts` maps the daemon's wire shapes onto the domain types the
components take. Nothing renders a value the API did not supply.

That adapter is where the design and the journal are reconciled, and it makes
three kinds of decision:

- **Derived.** A workflow's shape strip and its phase labels come from its most
  recent run's steps — nothing declares them, and the code decides them as it
  runs.
- **Omitted.** A step's tool calls exist only as prose inside an agent
  transcript, and "what weft will do next" is not journaled at all. Those render
  as absent, not as invented.
- **Never faked.** A run started with no ceiling shows its spend and no
  denominator, because `$0.12 / $0.00` reads as over budget.

## Live updates

A run's screen opens an `EventSource` on its journal. That stream does double
duty: it is the Journal tab's content, and it is the signal to refetch the fold —
a step that finishes appends a record, and that record is the cue. So an open run
updates itself without polling, and a finished one costs nothing. The lists poll
on an interval instead, since a run started from a terminal has no other way to
reach the screen.

## State

TanStack Query owns everything the daemon owns. Jotai holds what is genuinely
local: which step of the launcher is open, what has been typed into a form but
not submitted. The router holds what deserves a URL: which filter, which
workflow, which step of which run — so every view is a link you can share.
