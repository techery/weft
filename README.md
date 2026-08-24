# Weft

Durable, journaled, schema-validated multi-agent coding workflows in TypeScript.

Weft runs multi-agent coding workflows you write as ordinary TypeScript programs. Every step — an agent
turn, a human answer, a shell command, an HTTP call, a git read — returns a schema-validated value, so the
plumbing between steps is typed rather than parsed. Every run is journaled to an append-only event log, so it survives a crash, a
reboot, or an overnight wait on a human, and resumes from the line it stopped on. The same script runs on
Claude (Agent SDK) or Codex (Codex SDK), from a terminal or from inside a Claude Code / Codex session over
MCP, and leaves behind two records of what happened: the mechanical journal and a generated report.

Status: design preview. See [Status and honest deviations](#status-and-honest-deviations).

## Why Weft

- **The graph is your code.** `await` is a sequential edge, `ctx.parallel` fans out and joins,
  `ctx.pipeline` runs independent lanes, `if` on a typed field is a conditional edge, `while` is a bounded
  loop. There is no separate graph DSL to keep in sync with the program.
- **Every step returns a schema-validated value.** `schema` is required on `agent`, `human.*`, and workflow
  I/O (`ctx.check` returns a fixed `{ status, evidence }`). Invalid output is repaired in the same session
  with the validation errors fed back, not thrown away. A `z.string()` field is still prose — the guarantee
  is that what flows *between* steps has a shape you declared, not that prose is gone. Steps that opt out
  say so: `onError: "null"` yields `T | null`, and `ctx.exec`/`bash`/`fetch` without a `schema` hand back
  the raw result.
- **Durable by journaled replay, and replay is edit-tolerant.** Side effects are journaled steps; resume
  re-executes your code and serves completed steps from the journal. Reordering steps is free, rewording a
  prompt re-runs that step and what depended on it, and a cache miss re-runs rather than lying. Identity is
  content plus `key`: give each call a distinct `key` when two of them could share a prompt and schema, or
  replay re-runs them rather than guess which journaled answer belongs to which.
- **Humans are steps.** `ctx.gate` and `ctx.human.ask/approve/review` suspend the run durably. The answer
  can arrive hours later from the CLI, the web UI, or the session that started the run, and it is validated
  like any other output. Auto-approvals by policy are still recorded.
- **The journal owns the diffs.** A write step runs in its own git worktree and returns a patch, not a
  mutated tree. Patches are scope-checked and merged only where the workflow says `ctx.integrate()`, so a
  resume on a fresh clone rebuilds the tree from the journal.
- **Providers, not a host, and real accounting.** Claude and Codex sit behind one `AgentProvider` interface
  with per-step provider/model/effort routing, so a cross-vendor panel is one option on one step. Tokens and
  USD come from provider usage and enforce hard ceilings shared with sub-workflows.
- **Two records, both generated; the engine is a library.** The mechanical journal and the semantic report
  (checks, ledger, remaining risk) are projections over the same events, and the CLI, MCP server, and daemon
  are thin shells over one `Engine` class.

## Install

> Not on npm yet — the packages below are what the release workflow publishes, and the names
> are final. Until the first tag lands, use the [Quickstart](#quickstart) from a checkout.
> Delete this note when `v0.1.0` ships.

The CLI is `@techery/weft`; the binary it installs is `weft`.

```bash
npm i -g @techery/weft        # or: pnpm add -g @techery/weft · bun add -g @techery/weft
weft doctor                   # checks node, git, provider credentials, .weft/ layout
weft new review               # scaffold .weft/workflows/review.ts
```

Without installing anything:

```bash
npx @techery/weft doctor
```

To drive Weft from inside a Claude Code or Codex session, point its MCP config at the server
package — no global install needed:

```json
{ "mcpServers": { "weft": { "command": "npx", "args": ["-y", "@techery/weft-mcp"] } } }
```

To write workflows, or to embed the engine in your own program, install the libraries you need:

```bash
npm i @techery/weft-sdk                        # defineWorkflow, ctx types, z
npm i -D @techery/weft-testing                 # runWorkflow harness + mock fixtures
npm i @techery/weft-core @techery/weft-host    # the Engine itself
```

Node 22.12 or newer. Every package is ESM-only and ships compiled JavaScript with type
declarations, so no loader or bundler is required.

## Quickstart

In a checkout of this repository:

```bash
pnpm install
pnpm typecheck && pnpm test

# this repo ships .weft/workflows/review.ts and audit-and-fix.ts — run them with the CLI
node packages/cli/bin/weft.js check review                    # tsc + gate
node packages/cli/bin/weft.js run review --base main --watch  # input fields become flags
node packages/cli/bin/weft.js ui                              # localhost: runs, live tree, report, answer

# scaffold another one, or put `weft` on your PATH for this checkout
node packages/cli/bin/weft.js new triage
pnpm -C packages/cli link --global
```

`bin/weft.js` asks the manifest which shape this package is in: a published install's
`exports` point at `dist/`, so it loads the compiled ESM; a checkout's point at `src/*.ts`,
so it registers tsx and loads the sources. The CLI therefore works straight after
`pnpm install`, and `pnpm build` does *not* change what it runs — a checkout keeps loading
`src/` even with `dist/` present, because its dependencies are still TypeScript and the
sources are the only coherent thing to load.

The engine is also usable directly as a library — no CLI, no filesystem, no models:

```bash
npx tsx examples/01-engine-as-a-library/main.ts
```

That example builds an `Engine` over in-memory stores and the mock provider, runs an inline workflow, and
prints the `report.md` projection it produced. It is the same assembly the CLI performs, with the fs stores
and a real vendor adapter swapped in. Six more runnable tours live alongside it — durable human gates,
write-step patches and scopes, edit-tolerant resume, sub-workflow budgets, the stdlib patterns, and the
testing harness. Start at [`examples/README.md`](./examples/README.md).

## A workflow, annotated

`.weft/workflows/review.ts` — review the files changed since a base ref, have Claude find bugs, have Codex
try to refute each one, return only what survived:

```ts
import { defineWorkflow, z } from "@techery/weft-sdk";
import { Finding, Verdict } from "./schemas.ts";   // relative imports are bundled and hashed with the script

export default defineWorkflow(
  {
    // `name` derives from the filename: "review".
    description: "Review changed files; keep only findings that survive refutation",
    input: z.object({ base: z.string().default("main") }),      // --base main; the engine validates it
    output: z.object({ confirmed: z.array(Finding) }),          // and validates the result on the way out
  },
  async (ctx, { base }) => {
    ctx.phase("Scope");                                          // phases group steps in the live tree
    const { files } = await ctx.git.changedSince(base);          // [{ path, status }] · journaled, replayed
    const paths = files.filter((f) => f.status !== "D").map((f) => f.path);

    ctx.phase("Find");
    const found = ctx.ok(                                        // ok() narrows and records what it dropped
      await ctx.parallel(                                        // Settled<T>[] in input order
        paths.map((f) =>
          ctx.agent(`Review ${f} for correctness bugs. Cite file:line and quote the evidence.`, {
            schema: z.object({ findings: z.array(Finding) }),     // required on every step
            key: `review:${f}`,                                  // stable identity for replay, tests, the tree
          }),
        ),
      ),
    );
    const findings = found.flatMap((r) => r.findings);           // typed — no nulls to filter

    ctx.phase("Verify");
    const confirmed = ctx.ok(
      await ctx
        .pipeline(findings)                                      // independent lanes, no barrier between stages
        .step((f) =>
          ctx.agent(`Try to refute: ${f.claim} (${f.file}:${f.line}). Default real=false if unsure.`, {
            schema: Verdict,
            provider: "codex",                                   // a different vendor grades
            key: `refute:${f.file}:${f.line}`,
          }),
        )
        .filter((verdict) => verdict.real)                       // a falsy verdict drops the lane
        .map((_verdict, f) => f)                                 // back to the finding
        .run(),
    );

    return { confirmed };
  },
);
```

`.weft/workflows/audit-and-fix.ts` takes the same shape further: a cross-vendor refutation panel, an
approval gate, parallel fixes in isolated worktrees with declared write scopes, an explicit sequential
merge, and a required `pnpm test` check that gates the run's completion.

## How it works

Everything that leaves the sandbox is a step. The engine executes it, appends the outcome to an append-only
journal, and hands the workflow a validated value. There is no other persisted state.

Resume re-executes your code from the top and serves completed steps out of the journal, so the process can
die between any two of them. Replay is edit-tolerant: a step is reused when its inputs still hash the same
(sequence fast path, then content-addressed salvage, then a live call), and `weft replay --dry` prints
hits, salvaged, and diverged before a single model is called.

Humans sit in the graph rather than beside it. `ctx.gate` and `ctx.human.*` suspend the run durably; the
answer arrives from `weft answer`, the web UI, or the calling session, and is schema-validated on the way in.

Write steps do not mutate the tree. An agent with a declared `write:` scope gets its own git worktree, its
diff is captured as a patch blob, out-of-scope files are flagged (or the patch quarantined), and nothing
lands until the workflow calls `ctx.integrate()`. A run that ends with un-integrated patches fails.

```text
.weft/runs/<id>/
  journal.jsonl     # the truth — every step, request, answer, patch (secrets redacted)
  script.ts         # what ran, bundled (+ source map, so errors point at your .ts lines)
  blobs/<hash>      # patches, transcripts, large step outputs
  state.json        # projection: status, steps, scopes, checks
  tree.json         # projection: the live tree the UIs render
  report.md         # projection: outcome, changes, checks, ledger, remaining risk
```

Only `journal.jsonl` has to survive; every other file in that directory is rebuilt from it.

## Packages

| Package | Owns |
| --- | --- |
| `@techery/weft-sdk` | `defineWorkflow`, the `ctx` types, the Zod re-export. Zero runtime deps beyond Zod. |
| `@techery/weft-core` | Scheduler, replayer, journal model, budget, HITL broker, projections. No SDK imports. |
| `@techery/weft-gate` | TS parse, the AST rule set (clock, randomness, timers, network, env, imports, GC and locale globals), esbuild bundling, the sandboxed loader. |
| `@techery/weft-store-fs`, `@techery/weft-index-sqlite` | JournalStore and BlobStore on the filesystem; an optional derived `node:sqlite` run index. |
| `@techery/weft-provider-claude`, `@techery/weft-provider-codex`, `@techery/weft-provider-mock` | `AgentProvider` adapters behind a shared conformance suite (structured output, repair, scope, abort, usage). |
| `@techery/weft-git` | `ctx.git.*`: typed read/write git operations with fixed risk tiers. |
| `@techery/weft-isolation` | Worktrees, patch capture, scope checks. (Merge and conflict handling live with `ctx.integrate` in `@techery/weft-core`.) |
| `@techery/weft-stdlib` | Typed patterns: `adversarialVerify`, `judgePanel`, `loopUntilDry`, `integrationLedger`, `finalReport`, … |
| `@techery/weft-testing` | `runWorkflow` harness, mock fixtures, journal assertions, store conformance suites. |
| `@techery/weft-host` | Engine assembly shared by the hosts: config loading, stores, providers, workflow registry. |
| `@techery/weft`, `@techery/weft-mcp`, `@techery/weft-daemon` | Hosts. CLI: run, resume, ls, status, answer, cancel, report, replay, check, explain, diff, ui, doctor. MCP: `weft.run/wait/answer/resume/list/report/types`. Daemon: serves the web UI and wakes suspended runs. |

## Development

```bash
pnpm install
pnpm typecheck        # tsc -p tsconfig.json --noEmit, over every package plus examples/ and .weft/
pnpm test             # vitest run
pnpm test:watch
pnpm lint             # biome check .
pnpm lint:fix         # biome check --write .
pnpm format           # biome format --write .
pnpm build            # tsc per package, src/ -> dist/, in dependency order
pnpm clean            # drop every dist/
pnpm verify:packing   # pack every package and check the tarballs are installable
pnpm verify:install   # install those tarballs for real and run the CLI out of them
```

Node 22.12 or newer, pnpm 10, ESM everywhere, TypeScript strict. Relative imports inside a package carry an
explicit `.ts` extension (`allowImportingTsExtensions`), including in `.weft/workflows/`. `pnpm build`
rewrites those to `.js` on the way out (`rewriteRelativeImportExtensions`), so what ships is plain ESM that
resolves under node with no loader.

Day to day you never need `pnpm build` — tests, examples, and `bin/weft.js` all run off `src/`. It matters
when you are checking what a release will look like; see [RELEASING.md](./RELEASING.md).

`.weft/workflows/` and `examples/` import workspace packages by name (`@techery/weft-sdk`, `@techery/weft-core`, …). The
workspace root lists those packages as `workspace:*` devDependencies, so both directories resolve them
through the root `node_modules` — `pnpm install` once and `npx tsx examples/…` works from a fresh clone.

## Testing workflows

Workflow tests run with zero model calls. Fixtures match on the step key, receive the real request, and go
through the engine's normal schema validation — a fixture that would not pass in production fails the test.

```ts
import { mock, runWorkflow } from "@techery/weft-testing";
import review from "../.weft/workflows/review.ts";

test("keeps only findings that survive refutation", async () => {
  const { output, journal } = await runWorkflow(review, {
    input: { base: "main" },
    provider: mock()
      .on({ key: "review:*" }, () => ({
        findings: [{ file: "a.ts", line: 3, claim: "off-by-one", evidence: "for (i <= n)" }],
      }))
      .on({ key: "refute:*" }, (req) => ({ real: req.prompt.includes("off-by-one"), reason: "loop bound" })),
    git: { changedSince: { files: [{ path: "a.ts", status: "M" }] } },
  });

  expect(output.confirmed).toHaveLength(1);
  expect(journal.steps({ kind: "agent" })).toHaveLength(2);
  expect(journal.step("refute:a.ts:3").prompt).toContain("Default real=false");
});
```

`runWorkflow` also takes `exec`, `bash`, `fetch`, `env`, and `answers` fixtures, so a workflow with human
steps and shell checks runs end to end in a unit test.

## Status and honest deviations

This repository implements the design in the two design documents. Where it does not, it says so:

1. **The sandbox is `node:vm` with replaced globals, not `worker_threads`.** The design calls for a worker
   thread; the loader currently evaluates the bundled script in a `vm` context whose globals are replaced.
   Either way it is a determinism fence, not a security boundary — workflow scripts are our own agents'. The
   upgrade path (worker thread, or `isolated-vm` if untrusted scripts ever appear) is behind the same seam.
   The fence is two-layered by design: the AST rules reject the named form at parse time with a fix-it, and
   the replaced globals stop the computed form (`globalThis["Da" + "te"]`) at run time. The AST half is
   syntactic and evadable on purpose — it is the cheap early warning, not the boundary.
2. **The Claude adapter uses the terminating `structured_output` tool only.** Native JSON mode is not wired
   up yet, so every Claude step pays for the SDK-MCP tool round trip even when its schema would fit the
   native path. The schema lint that flags what the native path would reject exists; the native branch does
   not.
3. **The web UI is a single-file page served by the daemon, not a Vite + React app.** It covers the run
   list, live tree, report, and answering pending requests over SSE, but it is one hand-written HTML file
   rather than the component-based UI the design describes.
4. **TypeScript is pinned to 5.9.** The gate needs the in-process compiler API to parse workflow scripts and
   apply its AST rules; the native 7.x compiler does not expose it yet. Unpinning waits on that API.
5. **Replay identity is content plus `key`, and the world is not in it.** A step's identity hashes its
   kind, payload, schema, and `key`. What the step could *read* — the working tree an agent greps — is not
   hashed, which is the trade edit-tolerant replay makes for not forcing you to version every change. Two
   guards narrow it: a keyless step whose content matches several journaled entries re-runs instead of
   guessing, and a resume compares a hash of the workflow body so step positions are only trusted when the
   script did not change. Declared read scopes (`reads:`), which would put the tree hash in the key, are not
   built.
6. **OpenTelemetry spans cover runs, not steps.** One span per run, with the run id as the trace id. The
   per-step spans the design describes are not emitted yet, so step-level latency has to come from the
   journal.

## License

MIT
