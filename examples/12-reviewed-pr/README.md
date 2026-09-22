# Issue to reviewed pull request

This is an executable SDK workflow, not the declaration-only prototype. It creates a run-owned branch/worktree, writes and commits there, runs candidate-bound command checks, obtains an independent read-only agent review, asks for exact-candidate approval, and invokes a trusted host PR binding. Failed checks/reviews allow bounded repair; incomplete reviewers, no-op writers and exhausted repairs do not publish.

Run the local, model-free integration demonstration:

```sh
node --import tsx examples/12-reviewed-pr/main.ts
```

Or select its portable tests through the registry:

```sh
weft --extra-workflow-dir examples/12-reviewed-pr/reviewed-pr test reviewed-pr
```

These tests use real temporary Git repositories, explicit `fixtureMode: "integration"`, mock agents and mock remote bindings. They make no GitHub calls and require no credentials. A PR receipt is **not** a merge receipt or proof that CI passed. Optional bounded feedback polling returns an explicit status and records follow-up evidence; it never treats pending/failed feedback as acceptance or force-updates code in response to untrusted comments.

To enable actual publication, the host must explicitly configure `createWeft({ githubReviewedPr: { ... } })` with a fixed local repository, GitHub owner/repo/base, branch prefix, required checks `['tests', 'independent-review']`, and host credentials. See [delivery guide](../../docs/delivery.md). Merely importing this workflow does not install credentials or grant a GitHub executor. Draft publication is the adapter default. Input `prepare` commands (for example `['pnpm', 'install', '--frozen-lockfile']`) prepare the new worktree and must be safe to repeat after interruption.

Recovery and maintenance use existing run surfaces:

```sh
weft status RUN
weft report RUN
weft workspace RUN
weft resume RUN
# Explicit maintenance only after inspecting a terminal, clean workspace:
weft workspace RUN --cleanup
```

Cleanup refuses dirty/ignored files and uncertain operations, and preserves the branch and commits. Failure retains the workspace by default. The operator decides how to handle failed remote feedback; the example does not autonomously merge, close, discard changes or bypass repository protection.
