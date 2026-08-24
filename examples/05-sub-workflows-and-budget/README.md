# 05 · Sub-workflows & budgets

Child runs have their own journals and typed input/output boundaries (§08); budgets are
hard ceilings pooled across the whole run tree (C8).

```sh
npx tsx examples/05-sub-workflows-and-budget/main.ts
```

What to look for:

- each `ctx.workflow(verifyOne, { claim })` creates a **real child run** — `engine.list()`
  shows four children under the parent, each resumable on its own;
- the run carries `budget: { tokens: 1800 }` and every mock call bills 600: three calls
  spend the pool exactly, so the fourth child's agent step throws `budget_exceeded`
  **before dispatch**;
- the failure surfaces as one `Settled` branch — the parent logs it, skips that claim,
  and still returns a typed result, with `ctx.budget.spent` exact at 1800.
