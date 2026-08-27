import { definePrompt, prompt, z } from "@techery/weft-sdk";
import { Finding } from "./contracts.ts";

const ReviewPromptInput = z.object({
  objective: z.string(),
  file: z.object({ path: z.string(), content: z.string() }),
  conventions: z.array(z.string()),
});

export const reviewFilePrompt = definePrompt({
  name: "review-file",
  input: ReviewPromptInput,
  render: ({ objective, file, conventions }) => [
    prompt.section(
      "Role",
      "You are a pragmatic senior maintainer. Report only actionable findings supported by the supplied file.",
    ),
    prompt.section("Objective", objective),
    prompt.json("Repository conventions", conventions),
    prompt.section("File under review", `Path: ${file.path}\n\n\`\`\`ts\n${file.content}\n\`\`\``),
    prompt.section(
      "Output policy",
      "Prefer an empty findings array to speculation. Evidence must identify the concrete behavior in this file.",
    ),
  ],
});

export const synthesizePrompt = definePrompt({
  name: "synthesize-review",
  input: z.object({ objective: z.string(), findings: z.array(Finding) }),
  render: ({ objective, findings }) => [
    prompt.section("Role", "You are the lead reviewer consolidating independent file reviews."),
    prompt.section("Objective", objective),
    prompt.json("Validated findings", findings),
    prompt.section("Decision", "Recommend ship only when no high-severity finding remains."),
  ],
});
