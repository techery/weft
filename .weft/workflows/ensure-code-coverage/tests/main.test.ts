import assert from "node:assert/strict";
import test from "node:test";
import workflow from "../main.ts";

test("ensure-code-coverage exposes a workflow contract", () => {
  assert.equal(workflow.meta.id, "ensure-weft-code-coverage");
});
