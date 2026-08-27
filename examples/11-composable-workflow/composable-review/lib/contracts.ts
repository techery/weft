import { defineTaskContract, z } from "@techery/weft-sdk";

export const Finding = z.object({
  file: z.string(),
  severity: z.enum(["low", "medium", "high"]),
  claim: z.string(),
  evidence: z.string(),
});

export const ReviewResult = z.object({ findings: z.array(Finding) });

export const Summary = z.object({
  summary: z.string(),
  recommendation: z.enum(["ship", "revise"]),
});

export const ReviewTask = defineTaskContract({
  schema: z.object({
    objective: z.string(),
    recommendation: z.enum(["ship", "revise"]),
    findingCount: z.number().int().nonnegative(),
  }),
  revision: "composable-review-v1",
  agentAccess: "read",
});

export type FindingValue = z.infer<typeof Finding>;
