import { z } from "@techery/weft-sdk";

export const Finding = z.object({
  file: z.string(),
  line: z.number().int().min(1),
  claim: z.string(),
  evidence: z.string(),
});
export type Finding = z.infer<typeof Finding>;

export const Verdict = z.object({
  real: z.boolean(),
  reason: z.string(),
});
export type Verdict = z.infer<typeof Verdict>;

export const FixResult = z.object({
  summary: z.string(),
  tests: z.array(z.string()),
});
export type FixResult = z.infer<typeof FixResult>;
