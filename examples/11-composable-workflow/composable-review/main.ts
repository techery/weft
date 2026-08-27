import { defineWorkflow, z } from "@techery/weft-sdk";
import { reviewLead } from "./lib/agents.ts";
import { reviewQuality } from "./lib/checks.ts";
import { Finding, ReviewTask, Summary } from "./lib/contracts.ts";
import { loadReviewContext, reviewOneFile } from "./lib/recipes.ts";

const Input = z.object({
  objective: z.string().min(1),
  files: z.array(z.string().min(1)).min(1),
  requireApproval: z.boolean().default(true),
});

const Output = z.object({
  findings: z.array(Finding),
  summary: Summary,
  approved: z.boolean(),
});

export default defineWorkflow(
  {
    id: "composable-review",
    name: "composable-review",
    description: "Review files with reusable prompts, agents, recipes, and immutable execution contexts.",
    input: Input,
    output: Output,
    defaults: { provider: "claude" },
    tasks: ReviewTask,
  },
  async (ctx, input) => {
    const review = ctx.phase("Review");

    const understand = review.phase("Understand");
    const context = await understand.recipe(loadReviewContext, { files: input.files });

    const reviewers = review.phase("Inspect files").scope({
      tasks: { mode: "read" },
      parallel: { concurrency: 3, errors: "throw" },
    });
    const lanes = await reviewers.parallel(context.files, (file, index) =>
      reviewers.recipe(reviewOneFile, {
        objective: input.objective,
        file,
        conventions: context.conventions,
        key: `review:${index}:${file.path}`,
      }),
    );
    const findings = reviewers.all(lanes).flat();

    const decide = review.phase("Decide").scope({ agent: { effort: "high" } });
    const summary = await decide.agent(
      reviewLead,
      { objective: input.objective, findings },
      { key: "summary" },
    );

    const verify = review.phase("Verify");
    await verify.check(
      reviewQuality,
      {
        requestedFiles: input.files,
        reviewedFiles: context.files.map((file) => file.path),
        findings,
      },
      { keyPrefix: "review-quality" },
    );

    const approve = ctx.phase("Approve");
    const approval = input.requireApproval
      ? await approve.human.approve({
          key: "approve-review",
          action: "Approve this review recommendation?",
          detail: `${summary.recommendation}: ${summary.summary}`,
        })
      : { approved: true };

    await ctx.tasks.upsert({
      dedupeKey: `review:${input.objective}`,
      key: "record-review",
      set: {
        title: `Review: ${input.objective}`,
        description: summary.summary,
        status: approval.approved ? "done" : "blocked",
        relatedFiles: input.files,
        extensions: {
          objective: input.objective,
          recommendation: summary.recommendation,
          findingCount: findings.length,
        },
      },
      note: approval.approved ? "Human approved the recommendation." : "Human rejected the recommendation.",
    });

    await ctx.note({
      kind: "decision",
      text: `${summary.recommendation}: ${summary.summary}`,
      evidence: `${findings.length} validated findings across ${context.files.length} files`,
    });
    return { findings, summary, approved: approval.approved };
  },
);
