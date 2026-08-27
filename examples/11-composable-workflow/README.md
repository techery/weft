# Composable workflow DSL

This prototype shows the intended organization for a substantial workflow:

- `contracts.ts` owns schemas and durable task contracts.
- `prompts.ts` owns named, independently testable prompt templates.
- `agents.ts` combines one prompt, one output contract, and routing defaults into reusable roles.
- `checks.ts` owns typed verification policy independently of workflow sequencing.
- `recipes.ts` owns schema-backed orchestration recipes whose effects remain visible in the parent journal.
- `workflow.ts` is the policy and lifecycle layer: phases, parallel policy, gates, checks, tasks, and final output.

The central shape uses immutable nested phase contexts:

```ts
const review = ctx.phase("Review");
const understand = review.phase("Understand");
const reviewers = review.phase("Inspect files").scope({
  tasks: { mode: "read" },
  parallel: { concurrency: 3, errors: "throw" },
});
const verify = review.phase("Verify");

const lanes = await reviewers.parallel(files, (file, index) =>
  reviewers.recipe(reviewOneFile, {
    file,
    key: `review:${index}:${file.path}`,
  }),
);
```

Nested phases are currently journaled as stable display paths such as `Review / Understand`, `Review / Inspect files`, and `Review / Verify`. `phase()` returns an immutable context, so sibling phase handles may run concurrently without changing each other's journal grouping. A `defineRecipe()` is ordinary TypeScript composition, not a durability boundary: each nested agent, check, task operation, and human request remains directly inspectable. Use `ctx.workflow()` instead when the child needs an independent budget, suspension lifecycle, or durable contract.

Checks follow the same definition/invocation split as agents. The definition owns its Zod input contract, how to
verify, and its default policy; the workflow supplies run-specific input and replay identity. The call type is
inferred from `input`, and `run` receives the schema-validated, parsed value:

```ts
export const findingsHaveEvidence = defineCheck({
  name: "findings-have-evidence",
  input: z.object({ findings: z.array(Finding) }),
  policy: "required",
  revision: "v1",
  run: ({ findings }) => findings.every((finding) => finding.evidence.trim().length > 0),
});

await verify.check(findingsHaveEvidence, { findings }, {
  key: "check:findings-have-evidence",
});
```

Checks with different input shapes can be assembled into one contextual suite. The suite validates its shared
input once and maps named members explicitly; concurrency is configuration, while every member still produces
its own journal entry, evidence, and required-check outcome:

```ts
const quality = defineCheckSuite({
  name: "review-quality",
  input: ReviewVerificationInput,
  concurrency: 2,
  checks: ({ requestedFiles, reviewedFiles, findings }, use) => ({
    files: use(allFilesReviewed, { requestedFiles, reviewedFiles }),
    evidence: use(findingsHaveEvidence, { findings }),
  }),
});

const result = await verify.check(quality, { requestedFiles, reviewedFiles, findings }, {
  keyPrefix: "quality",
});
// result.results.files and result.results.evidence remain independently inspectable
```

Run the self-contained mock-backed example:

```sh
pnpm tsx examples/11-composable-workflow/main.ts
```
