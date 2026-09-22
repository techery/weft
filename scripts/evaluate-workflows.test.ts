import assert from "node:assert/strict";
import test from "node:test";
import { evaluateWorkflows, loadEvaluationCases } from "./evaluate-workflows.ts";

test("versioned workflow cases pass with deterministic results across fresh engines", async () => {
  const first = await evaluateWorkflows();
  const second = await evaluateWorkflows();
  assert.equal(first.passed, true, JSON.stringify(first.results.filter(({ passed }) => !passed)));
  assert.deepEqual(first, second);
  assert.equal(first.totals.cases, 8);
});

test("a changed expectation fails the evaluation with observed evidence", async () => {
  const entry = (await loadEvaluationCases()).find(({ id }) => id === "review-distinct-findings")!;
  const report = await evaluateWorkflows([{ ...entry, expected: { ...entry.expected, confirmed: 99 } }]);
  assert.equal(report.passed, false);
  assert.equal(report.totals.failed, 1);
  assert.equal(report.results[0]?.observed.confirmed, 2);
});

test("an empty evaluation selection cannot report success", async () => {
  await assert.rejects(evaluateWorkflows([]), /at least one case/);
});
