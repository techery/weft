# @techery/weft-sdk

Weft authoring SDK: defineWorkflow, ctx types, Zod re-export.

Part of [Weft](https://github.com/techery/weft) — durable, journaled, schema-validated multi-agent coding workflows
in TypeScript. This package is not usually installed on its own; see the
[project README](https://github.com/techery/weft#readme) for what Weft is and how the pieces fit together.

```bash
npm i @techery/weft-sdk
```

The SDK also provides stateless composition primitives:

```ts
const reviewPrompt = definePrompt({ name: "review", render: ({ file }) => [prompt.section("File", file)] });
const reviewer = defineAgent({ name: "reviewer", prompt: reviewPrompt, schema: ReviewResult });
const reviewFile = defineRecipe({
  name: "review-file",
  input: ReviewFileInput,
  output: ReviewResult,
  run: (ctx, input) => ctx.agent(reviewer, input, { key: input.key }),
});
const packageTests = defineCheck({
  name: "package-tests",
  input: z.object({ package: z.string().min(1) }),
  policy: "required",
  revision: "v1",
  command: ({ package: name }) => ["pnpm", "--filter", name, "test"],
});

const review = ctx.phase("Review");
const reviewers = review.scope({ parallel: { concurrency: 3, errors: "throw" } });
const results = await reviewers.parallel(files, (file, index) =>
  reviewers.recipe(reviewFile, { file, key: `review:${index}:${file}` }),
);
await review.phase("Verify").check(
  packageTests,
  { package: "@acme/core" },
  { key: "check:core-tests" },
);
```

`phase()` and `scope()` return immutable context handles, so differently scoped lanes may execute concurrently.
Definitions do not create hidden durability boundaries: effects inside `defineRecipe()` remain ordinary journaled
steps, and members of a `defineCheckSuite()` remain separate check records. See the
[complete composition example](../../examples/11-composable-workflow/README.md).
Parameterized checks require an `input` Standard Schema (normally Zod); invocation types are inferred from it,
and validation/defaults/coercions run before `run` or `command` receives the parsed input.
Executed checks return `status: "pass" | "fail"` plus an optional summary and structured `details` (files,
metrics, commands, artifacts, or text). Weft assigns `disposition: "executed" | "trusted" | "waived"`
separately, so a waiver cannot masquerade as execution. Prior results can only be trusted for a revisioned check
when the referenced run completed with an executed pass for the same canonicalized, schema-parsed input.

- Source: [`packages/sdk`](https://github.com/techery/weft/tree/main/packages/sdk)
- Issues: https://github.com/techery/weft/issues
- License: MIT
