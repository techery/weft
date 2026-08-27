import { defineCheck, defineCheckSuite, z } from "@techery/weft-sdk";
import { Finding } from "./contracts.ts";

const ReviewedFilesInput = z.object({
  requestedFiles: z.array(z.string()),
  reviewedFiles: z.array(z.string()),
});

export const allFilesReviewed = defineCheck({
  name: "all-files-reviewed",
  description: "Every requested file must be present in the assembled review context.",
  policy: "required",
  revision: "v1",
  input: ReviewedFilesInput,
  run: ({ requestedFiles, reviewedFiles }) => ({
    status: requestedFiles.every((file) => reviewedFiles.includes(file)) ? "pass" : "fail",
    summary: `${reviewedFiles.length}/${requestedFiles.length} requested files reviewed`,
    details: [
      {
        kind: "metric",
        name: "reviewed-files",
        actual: reviewedFiles.length,
        expected: requestedFiles.length,
      },
    ],
  }),
});

const FindingsInput = z.object({ findings: z.array(Finding) });

export const findingsHaveEvidence = defineCheck({
  name: "findings-have-evidence",
  description: "Every reported finding must include concrete evidence.",
  policy: "required",
  revision: "v1",
  input: FindingsInput,
  run: ({ findings }) => ({
    status: findings.every((finding) => finding.evidence.trim().length > 0) ? "pass" : "fail",
    summary: `${findings.filter((finding) => finding.evidence.trim().length > 0).length}/${findings.length} findings have evidence`,
  }),
});

const ReviewVerificationInput = z.object({
  requestedFiles: z.array(z.string()),
  reviewedFiles: z.array(z.string()),
  findings: z.array(Finding),
});

export const reviewQuality = defineCheckSuite({
  name: "review-quality",
  description: "Verify completeness and evidence quality for an assembled review.",
  input: ReviewVerificationInput,
  concurrency: 2,
  checks: ({ requestedFiles, reviewedFiles, findings }, use) => ({
    files: use(allFilesReviewed, { requestedFiles, reviewedFiles }),
    evidence: use(findingsHaveEvidence, { findings }),
  }),
});
