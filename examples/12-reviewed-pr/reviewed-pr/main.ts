import { defineCheck, defineWorkflow, StepError, z } from "@techery/weft-sdk";
import { feedback, PullRequest, publish } from "./lib/delivery.ts";

const Input = z.object({
  objective: z.string().min(1),
  branch: z.string().regex(/^weft\/[A-Za-z0-9/_-]+$/),
  files: z.array(z.string().min(1)).min(1),
  checkCommand: z.array(z.string()).min(1),
  prepare: z.array(z.array(z.string()).min(1)).default([]),
  maxRepairs: z.number().int().min(0).max(5).default(2),
  requireApproval: z.boolean().default(true),
  pollFeedback: z.boolean().default(false),
});

export default defineWorkflow(
  {
    id: "reviewed-pr",
    name: "reviewed-pr",
    description:
      "Owned edits, bounded repairs, exact-candidate checks, independent review and recoverable PR delivery",
    input: Input,
    output: z.object({
      pullRequest: PullRequest,
      candidateId: z.string(),
      feedback: z.enum(["not_requested", "passed", "failed", "pending", "unknown"]),
    }),
    workspace: (input) => ({
      branch: input.branch,
      prepare: input.prepare.map((command) => [command[0]!, ...command.slice(1)] as [string, ...string[]]),
    }),
  },
  async (ctx, input) => {
    if (!ctx.workspace) throw new StepError("invalid_input", "reviewed-pr requires an owned workspace");
    await ctx.note({
      kind: "decision",
      text: `Work is retained in ${ctx.workspace.path} on ${ctx.workspace.branch}`,
      evidence: ctx.workspace.id,
    });
    let repairEvidence = "";
    for (let attempt = 0; attempt <= input.maxRepairs; attempt++) {
      await ctx.agent(
        `${attempt === 0 ? "Implement" : "Repair"} this objective: ${input.objective}\n${repairEvidence}\nEdit only the declared files. Do not commit or publish; the workflow owns that.`,
        {
          key: `write:${attempt}`,
          schema: z.object({ summary: z.string() }),
          write: { paths: input.files, mode: "strict" },
          tasks: false,
        },
      );
      const changed = await ctx.exec("git", ["status", "--porcelain", "--untracked-files=all"], {
        key: `changes:${attempt}`,
      });
      if (changed.exitCode !== 0 || !changed.stdout.trim())
        throw new StepError(
          "check_failed",
          "writer produced no candidate changes; no pull request was published",
        );
      await ctx.git.add({ paths: input.files, key: `stage:${attempt}` });
      await ctx.git.commit({
        message: `${attempt ? "Repair" : "Implement"}: ${input.objective}`,
        key: `commit:${attempt}`,
      });
      const candidate = await ctx.workspace.snapshot({ key: `candidate:${attempt}` });
      const quality = await ctx.verify(
        candidate,
        [
          defineCheck({
            name: "tests",
            revision: "1",
            policy: "required",
            command: [input.checkCommand[0]!, ...input.checkCommand.slice(1)],
          }),
        ],
        { key: `quality:${attempt}` },
      );
      if (!quality.proof) {
        repairEvidence = JSON.stringify(quality.results);
        continue;
      }

      // A separate read-only agent call, with no writer session or task-mutation authority.
      const independent = await ctx.verify(
        candidate,
        [
          defineCheck({
            name: "independent-review",
            revision: "1",
            policy: "required",
            run: async () => {
              const review = await ctx.agent(
                `Independently review commit ${candidate.head}, tree ${candidate.tree}, for: ${input.objective}. Inspect the actual code and tests. Do not modify files. Approve only if this candidate satisfies the objective without blocking defects.`,
                {
                  key: `review:${candidate.id}`,
                  tasks: false,
                  schema: z.object({ approved: z.boolean(), evidence: z.string() }),
                },
              );
              return { status: review.approved ? "pass" : "fail", evidence: review.evidence };
            },
          }),
        ],
        { key: `review-check:${attempt}` },
      );
      if (!independent.proof) {
        repairEvidence = JSON.stringify(independent.results);
        continue;
      }
      await ctx.workspace.assertCurrent(candidate);
      const receipt = await ctx.delivery(
        publish,
        {
          title: input.objective,
          body: `Implemented by Weft.\n\nCandidate: ${candidate.id}\nCommit: ${candidate.head}\n\nExecuted checks: tests, independent-review.\n\nThis receipt records PR creation, not merge or CI acceptance.`,
        },
        {
          key: `publish:${candidate.id}`,
          candidate,
          proofs: [quality.proof, independent.proof],
          ...(input.requireApproval
            ? { approval: { question: "Publish this verified candidate as a pull request?" } }
            : {}),
        },
      );
      let status: "not_requested" | "passed" | "failed" | "pending" | "unknown" = "not_requested";
      if (input.pollFeedback) {
        for (let poll = 0; poll < 3; poll++) {
          const observed = await ctx.operation(
            feedback,
            { number: receipt.value.number, head: candidate.head },
            { key: `feedback:${candidate.id}:${poll}` },
          );
          status = observed.value.status;
          if (status !== "pending" || poll === 2) break;
          await ctx.sleep("30s", { key: `feedback-wait:${candidate.id}:${poll}` });
        }
        if (status !== "passed")
          await ctx.note({
            kind: "decision",
            text: `PR feedback requires follow-up: ${status}`,
            evidence: receipt.value.url,
          });
      }
      return { pullRequest: receipt.value, candidateId: candidate.id, feedback: status };
    }
    throw new StepError(
      "check_failed",
      `candidate did not pass checks and independent review after ${input.maxRepairs} repairs; owned workspace retained`,
    );
  },
);
