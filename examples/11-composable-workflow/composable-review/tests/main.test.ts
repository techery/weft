import assert from "node:assert/strict";
import test from "node:test";
import workflow from "../main.ts";

test("composable-review exposes its durable identity", () => {
  assert.equal(workflow.meta.id, "composable-review");
});
