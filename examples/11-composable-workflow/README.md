# Composable workflow DSL

This runnable SDK example shows the organization for a substantial workflow in this checkout:

- `contracts.ts` owns schemas and durable task contracts.
- `prompts.ts` owns named, independently testable prompt templates.
- `agents.ts` combines one prompt, one output contract, and routing defaults into reusable roles.
- `checks.ts` owns typed verification policy independently of workflow sequencing.
- `procedures.ts` owns schema-backed orchestration procedures with local effect keys and declared context requirements.
- `composable-review/main.ts` is the policy and lifecycle entry point: phases, parallel policy, gates, checks, tasks, and final output.
- `composable-review/lib/` holds its reusable prompts, agents, procedures, contracts, and checks.
- `composable-review/tests/` and `composable-review/CHANGELOG.md` travel with the workflow package.

The central shape uses immutable nested phase contexts:

```ts
const review = ctx.phase("Review");
const understand = review.phase("Understand");
const reviewers = review.phase("Inspect files").scope({
  tasks: { mode: "read" },
  parallel: { concurrency: 3, errors: "throw" },
});
const verify = review.phase("Verify");

const reviews = await reviewers.parallel.all(context.files, (file, lane) =>
  lane.procedure(reviewOneFile, {
    objective: input.objective,
    file,
    conventions: context.conventions,
  }, { key: "inspect" }),
  { key: "files", keyOf: (file) => file.path, concurrency: 3 },
);
const findings = reviews.flat();
```

Nested phases are journaled as display paths such as `Review / Understand` and `Review / Verify`. A procedure owns a schema boundary and a local key namespace. Its body re-enters on resume so nested effects retain their own replay and recovery rules. A reviewer can use the local key `review` in every file; a resolved key is `files/alpha.ts/inspect/review`. File identity stays stable when input order changes. Required parallel lanes settle before reporting failures, and any failed reviewer fails the review. Use `ctx.workflow()` when the child needs a separate run, budget, or suspension lifecycle. Existing recipes remain supported for unnamed same-run reuse.

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
node --import tsx --test examples/11-composable-workflow/composable-review/tests/main.test.ts
```

The portable tests verify multiple procedure invocations, required reviewer completeness, evidence checks before approval, declined approval, and task outcomes. Persistent review tasks retain their cross-run lifetime.
