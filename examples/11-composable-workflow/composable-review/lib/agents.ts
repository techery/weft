import { defineAgent } from "@techery/weft-sdk";
import { ReviewResult, Summary } from "./contracts.ts";
import { reviewFilePrompt, synthesizePrompt } from "./prompts.ts";

export const fileReviewer = defineAgent({
  name: "file-reviewer",
  description: "Review one bounded file using shared repository conventions.",
  prompt: reviewFilePrompt,
  schema: ReviewResult,
  defaults: { effort: "high", maxTurns: 8, repair: 2 },
});

export const reviewLead = defineAgent({
  name: "review-lead",
  description: "Consolidate findings into a concise release recommendation.",
  prompt: synthesizePrompt,
  schema: Summary,
  defaults: { effort: "medium", maxTurns: 6 },
});
