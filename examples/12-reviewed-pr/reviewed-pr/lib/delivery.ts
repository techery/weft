import { defineDelivery, defineOperation, z } from "@techery/weft-sdk";

export const PullRequest = z.object({
  url: z.string().url(),
  number: z.number().int().positive(),
  head: z.string(),
  branch: z.string(),
  repository: z.string(),
  base: z.string(),
  requestId: z.string(),
  draft: z.boolean(),
});
export const publish = defineDelivery({
  name: "Create reviewed pull request",
  revision: "1",
  binding: "github.reviewed-pr",
  input: z.object({ title: z.string(), body: z.string() }),
  output: PullRequest,
  risk: "high",
});
export const feedback = defineOperation({
  name: "Observe pull request feedback",
  revision: "1",
  binding: "github.pr-feedback",
  input: z.object({ number: z.number(), head: z.string() }),
  output: z.object({ status: z.enum(["passed", "failed", "pending", "unknown"]), head: z.string() }),
  risk: "low",
});
