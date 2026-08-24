# Releasing

Every Weft package is versioned and published together, so one git tag names the whole
release and one workflow does the publishing.

## Cutting a release

```bash
pnpm version:set 0.2.0                  # rewrites the root + all 16 manifests
pnpm install                            # refresh the lockfile
git commit -am "release: v0.2.0"
git tag v0.2.0
git push --follow-tags
```

Pushing the tag runs [`.github/workflows/release.yml`](.github/workflows/release.yml), which:

1. fails fast if the tag and the manifests disagree on the version,
2. runs the same gates as CI — lint, typecheck, the full test suite, `sync:meta --check`,
3. builds every package (`src/` → `dist/`),
4. runs `pnpm verify:packing`, which packs each package and rejects the silent failures:
   `exports` still pointing at TypeScript source, an unrewritten `workspace:*` range, a bin
   that is not in `files`, a package with no build output,
5. runs `pnpm verify:install`, which installs those tarballs into a scratch project and
   drives `weft` and `weft-mcp` out of the install — compiled ESM, plain node, no loader,
6. publishes with `pnpm -r publish` using npm **trusted publishing** (OIDC — no token in the
   repository) with provenance attestation,
7. opens a GitHub release with generated notes.

`pnpm -r publish` skips any package whose version is already on the registry, so re-running a
release after a partial failure publishes only what is missing.

To rehearse without publishing, run the workflow manually from the Actions tab — the
`dry-run` input defaults to true and stops after `pnpm -r publish --dry-run`.

## What gets published

| | |
| --- | --- |
| `@techery/weft` | the CLI; installs the `weft` binary |
| `@techery/weft-mcp` | the MCP server; installs the `weft-mcp` binary |
| `@techery/weft-sdk`, `-core`, `-host`, `-gate`, `-git`, `-isolation`, `-store-fs`, `-index-sqlite`, `-stdlib`, `-testing`, `-daemon`, `-provider-claude`, `-provider-codex`, `-provider-mock` | libraries |

In the repository each package's `exports` points at `src/*.ts`, which is what lets tests,
examples, and `bin/weft.js` run with no build step. `publishConfig` swaps that for `dist/` at
pack time, so the published package resolves to compiled ESM and `.d.ts` under plain node.
Both `dist/` and `src/` ship: the declaration maps point at the sources, and the MCP server's
`weft_types` tool reads the SDK's `.ts` files off disk to hand a session the authoring surface.

Per-package `README.md` and `LICENSE` files are generated — edit
[`scripts/sync-package-meta.mjs`](scripts/sync-package-meta.mjs) and run `pnpm sync:meta`
rather than editing them in place. CI fails on drift.

## One-time npm setup

The scope and the trusted publishers have to exist before the workflow can publish.

1. Create the `techery` org (or scope) on npm, if it does not exist.
2. **Bootstrap the first publish by hand.** npm can only mark a package as trusted-published
   once that package exists, so the very first release of each name needs a human:

   ```bash
   npm login
   pnpm build && pnpm verify:packing && pnpm verify:install
   pnpm -r publish --access public --no-git-checks
   ```

3. For each of the 16 packages, open its npm settings and add a trusted publisher:
   - Repository: `techery/weft`
   - Workflow: `release.yml`

   After that, `id-token: write` in the workflow is the only credential needed and no npm
   token ever has to live in the repository.

If you would rather use a token than OIDC, add an npm automation token as the `NPM_TOKEN`
secret and give the publish step `NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}`. Trusted
publishing is preferred: it cannot leak, and it is what produces the provenance badge.
