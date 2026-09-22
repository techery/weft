import assert from "node:assert/strict";
import test from "node:test";
import { mock, runWorkflow } from "@techery/weft-testing";
import workflow from "../main.ts";

const measurement = (passed = true) => ({
  ready: true,
  passed,
  exitCode: passed ? 0 : 1,
  totals: Object.fromEntries(
    ["statements", "branches", "functions", "lines"].map((key) => [key, { covered: 9, total: 10, pct: 90 }]),
  ),
  files: [],
  failure: passed ? "" : "Below threshold",
});
const fixtures = {
  fixtureMode: "strict" as const,
  git: { head: { sha: "abc" }, changedSince: { files: [] } },
};
const commandResult = (passed = true) => ({
  stdout: JSON.stringify(measurement(passed)),
  stderr: "",
  exitCode: passed ? 0 : 1,
});

test("passing baseline requires a final gate and no authoring agents", async () => {
  const provider = mock();
  let checks = 0;
  const result = await runWorkflow(workflow, {
    ...fixtures,
    input: { maxRounds: 0 },
    provider,
    exec: () => {
      checks++;
      return commandResult();
    },
  });
  assert.equal(result.output.rounds, 0);
  assert.equal(result.output.final.passed, true);
  assert.equal(result.output.qualityVerified, true);
  assert.equal(provider.calls.length, 0);
  assert.equal(checks, 2);
  assert.equal(result.journal.step("coverage:final").status, "ok");
  assert.deepEqual(result.journal.step("coverage:final").output, {
    status: "pass",
    disposition: "executed",
    evidence: JSON.stringify(measurement()),
  });
});

test("a changed final check fails even when the baseline passed", async () => {
  let checks = 0;
  await assert.rejects(
    runWorkflow(workflow, {
      ...fixtures,
      input: { maxRounds: 0 },
      exec: () => commandResult(++checks === 1),
    }),
    /coverage remains below threshold/,
  );
});

test("an exhausted repair budget fails with measured evidence", async () => {
  await assert.rejects(
    runWorkflow(workflow, {
      ...fixtures,
      input: { maxRounds: 0 },
      exec: () => commandResult(false),
    }),
    /coverage remains below threshold/,
  );
});

test("an empty repair plan fails before dispatching writers", async () => {
  const provider = mock().on({ key: "coverage:plan:1" }, { summary: "No viable targets", targets: [] });
  await assert.rejects(
    runWorkflow(workflow, {
      ...fixtures,
      input: { maxRounds: 1 },
      provider,
      exec: () => commandResult(false),
    }),
    /planner produced no repair targets/,
  );
  assert.equal(provider.calls.length, 1);
});
