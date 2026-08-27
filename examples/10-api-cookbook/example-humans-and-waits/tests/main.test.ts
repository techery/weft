import assert from "node:assert/strict";
import test from "node:test";
import workflow from "../main.ts";

test("example-humans-and-waits exposes its package name", () => {
  assert.equal(workflow.meta.name, "example-humans-and-waits");
});
