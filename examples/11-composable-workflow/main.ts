import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mock, runWorkflow } from "@techery/weft-testing";
import workflow from "./workflow.ts";

const cwd = await mkdtemp(join(tmpdir(), "weft-composable-example-"));
await writeFile(join(cwd, "alpha.ts"), "export const alpha = 1;\n");
await writeFile(join(cwd, "beta.ts"), "export const beta = 2;\n");

const provider = mock()
  .on({ key: "review:0:alpha.ts" }, { findings: [] })
  .on(
    { key: "review:1:beta.ts" },
    {
      findings: [
        {
          file: "beta.ts",
          severity: "medium",
          claim: "The exported value has no explanatory name.",
          evidence: "beta.ts exports the numeric literal as `beta`.",
        },
      ],
    },
  )
  .on(
    { key: "summary" },
    { summary: "One maintainability finding should be addressed.", recommendation: "revise" },
  );

try {
  const result = await runWorkflow(workflow, {
    cwd,
    input: {
      objective: "Review the public constants",
      files: ["alpha.ts", "beta.ts"],
      requireApproval: true,
    },
    provider,
    answers: { "Approve this review recommendation?": { approved: true, note: "Track the cleanup." } },
  });

  console.log(JSON.stringify(result.output, null, 2));
  console.log(JSON.stringify(result.journal.toJSON(), null, 2));
  console.log(JSON.stringify(result.tasks, null, 2));
} finally {
  await rm(cwd, { recursive: true, force: true });
}
