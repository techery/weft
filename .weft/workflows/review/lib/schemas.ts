/**
 * Schemas owned by the review workflow package.
 *
 * Relative imports (`./lib/schemas.ts`) are bundled into the script and hashed with it,
 * so editing a schema changes the workflow's definition hash — and replay knows the
 * steps that depended on it have to run again.
 */
import { z } from "@techery/weft-sdk";

/**
 * A claimed defect. Evidence travels with the claim: the report renders it and
 * integration checks for it, so a finding without a quote is not a finding.
 */
export const Finding = z.object({
  file: z.string(),
  line: z.number().int().min(1),
  claim: z.string(),
  evidence: z.string(),
});
export type Finding = z.infer<typeof Finding>;

/**
 * The refutation verdict. `real` is the decision the workflow branches on — a
 * boolean the code reads, never prose it has to interpret.
 */
export const Verdict = z.object({
  real: z.boolean(),
  reason: z.string(),
});
export type Verdict = z.infer<typeof Verdict>;

/** What a fix step reports alongside the patch it produced in its worktree. */
export const FixResult = z.object({
  summary: z.string(),
  tests: z.array(z.string()),
});
export type FixResult = z.infer<typeof FixResult>;
