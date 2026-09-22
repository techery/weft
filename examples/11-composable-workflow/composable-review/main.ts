import { defineWorkflow, z } from "@techery/weft-sdk";
import { reviewLead } from "./lib/agents.ts";
import { reviewQuality } from "./lib/checks.ts";
import { Finding, ReviewTask, Summary } from "./lib/contracts.ts";
import { loadReviewContext, reviewOneFile } from "./lib/procedures.ts";

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
    description: "Review files with reusable prompts, agents, procedures, and immutable execution contexts.",
    input: Input,
    output: Output,
    defaults: { provider: "claude" },
    tasks: ReviewTask,
  },
  async (ctx, input) => {
    const review = ctx.phase("Review");

    const understand = review.phase("Understand");
    const context = await understand.procedure(
      loadReviewContext,
      { files: [...new Set(input.files)] },
      { key: "context" },
    );

    const reviewers = review.phase("Inspect files").scope({
      tasks: { mode: "read" },
      parallel: { concurrency: 3, errors: "throw" },
    });
    const reviews = await reviewers.parallel.all(
      context.files,
      (file, lane) =>
        lane.procedure(
          reviewOneFile,
          {
            objective: input.objective,
            file,
            conventions: context.conventions,
          },
          { key: "inspect" },
        ),
      { key: "files", keyOf: (file) => file.path, concurrency: 3 },
    );
    const findings = reviews.flat();

    const decide = review.phase("Decide").scope({ agent: { effort: "high" } });
    const summary = await decide.agent(
      reviewLead,
      { objective: input.objective, findings },
      { key: "summary" },
    );

    const verify = review.phase("Verify");
    const quality = await verify.check(
      reviewQuality,
      {
        requestedFiles: input.files,
        reviewedFiles: context.files.map((file) => file.path),
        findings,
      },
      { keyPrefix: "review-quality" },
    );
    if (!quality.passed) throw new Error("Review completeness or evidence checks failed");

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
