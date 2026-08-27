import assert from "node:assert/strict";
import test from "node:test";
import workflow from "../main.ts";

test("review exposes a workflow contract", () => {
  assert.match(workflow.meta.description, /Review changed files/i);
});
