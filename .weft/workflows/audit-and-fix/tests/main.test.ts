import assert from "node:assert/strict";
import test from "node:test";
import workflow from "../main.ts";

test("audit-and-fix exposes a workflow contract", () => {
  assert.match(workflow.meta.description, /fix/i);
});
