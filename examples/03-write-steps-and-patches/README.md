# 03 · Write steps, patches, and scopes

The journal owns the diffs (C6). A write step runs in its **own git worktree**; its edits
come back as a patch blob, and nothing touches the integration tree until
`ctx.integrate()` lands the patches you pass, in the order you pass them.

```sh
npx tsx examples/03-write-steps-and-patches/main.ts
```

What to look for:

- two `ctx.agent.detailed(…, { write: { paths: [...] } })` steps run in parallel in
  separate worktrees — the pre-integrate `ctx.fs.read` proves the tree is untouched;
- `fix:api` writes `NOTES.md`, **outside** its declared scope. In the default
  `mode: "warn"` the patch still lands, and the run's report lists the violation under
  *Remaining risk* (with `mode: "strict"` the patch would be quarantined instead);
- the throwaway repo's files show both patches applied after integration.
