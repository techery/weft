import assert from "node:assert/strict";
import test from "node:test";
import workflow from "../main.ts";

test("task-backed-code-review exposes its durable identity", () => {
  assert.equal(workflow.meta.id, "example.task-backed-code-review");
});
