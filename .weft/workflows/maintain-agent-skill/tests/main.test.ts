import assert from "node:assert/strict";
import test from "node:test";
import workflow from "../main.ts";

test("maintain-agent-skill exposes a workflow contract", () => {
  assert.equal(workflow.meta.id, "maintain-weft-agent-skill");
});
