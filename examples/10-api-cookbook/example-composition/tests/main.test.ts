import assert from "node:assert/strict";
import test from "node:test";
import { mock, runWorkflow } from "@techery/weft-testing";
import workflow from "../main.ts";

test("composes keyed settled lanes, a pipeline, and independent child workflows", async () => {
  const result = await runWorkflow(workflow, {
    input: { values: [1, 2, 2, 3] },
    fixtureMode: "strict",
    providers: {
      claude: mock().on({ key: "one" }, { n: 1 }),
      codex: mock({ profile: "codex" }).on({ key: "two" }, { n: 2 }),
    },
  });
  assert.deepEqual(result.output, { values: [30, 50, 70], failures: 0, children: [2, 4, 6] });
  assert.equal(result.journal.steps({ kind: "workflow" }).length, 3);
});
