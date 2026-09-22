import { type Ctx, defineProcedure, z } from "@techery/weft-sdk";
import { fileReviewer } from "./agents.ts";
import { Finding } from "./contracts.ts";

const ReviewContext = z.object({
  files: z.array(z.object({ path: z.string(), content: z.string() })),
  conventions: z.array(z.string()),
});

export const loadReviewContext = defineProcedure({
  name: "load-review-context",
  revision: "v1",
  requires: ["fs", "parallel", "all"],
  description: "Gather a bounded, journaled context pack once for all reviewers.",
  input: z.object({ files: z.array(z.string()) }),
  output: ReviewContext,
  run: async (ctx: Pick<Ctx, "fs" | "parallel" | "all">, input) => {
    const reads = await ctx.parallel(input.files, async (path) => {
      const file = await ctx.fs.read(path);
      return { path, content: file.content.slice(0, 20_000) };
    });
    return {
      files: ctx.all(reads),
      conventions: [
        "Preserve durable replay identity for every effect.",
        "Keep schemas at workflow and agent boundaries.",
        "Prefer explicit evidence over speculative findings.",
      ],
    };
  },
});

export const reviewOneFile = defineProcedure({
  name: "review-one-file",
  revision: "v1",
  requires: ["agent"],
  input: z.object({
    objective: z.string(),
    file: z.object({ path: z.string(), content: z.string() }),
    conventions: z.array(z.string()),
  }),
  output: z.array(Finding),
  run: async (ctx: Pick<Ctx, "agent">, input) => {
    const result = await ctx.agent(fileReviewer, input, {
      key: "review",
      label: `review:${input.file.path}`,
    });
    return result.findings;
  },
});
