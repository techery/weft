import assert from "node:assert/strict";
import test from "node:test";
import { mock, runWorkflow } from "@techery/weft-testing";
import workflow from "../main.ts";

const finding = { file: "beta.ts", severity: "high", claim: "Unchecked null", evidence: "value.id" };
const fixtures = {
  input: { objective: "Check public API", files: ["alpha.ts", "beta.ts"] },
  fixtureMode: "strict" as const,
  fs: { "alpha.ts": "export const alpha = 1", "beta.ts": "export const beta = value.id" },
};
const provider = () =>
  mock()
    .on({ key: "files/alpha.ts/inspect/review" }, { findings: [] })
    .on({ key: "files/beta.ts/inspect/review" }, { findings: [finding] })
    .on({ key: "summary" }, { summary: "Null must be guarded", recommendation: "revise" });

test("composes two procedure invocations with local keys and records an accepted review", async () => {
  const result = await runWorkflow(workflow, {
    ...fixtures,
    provider: provider(),
    answers: () => ({ approved: true }),
  });
  assert.deepEqual(result.output.findings, [finding]);
  assert.equal(result.output.approved, true);
  assert.equal(result.tasks.tasks[0]?.status, "done");
  assert.equal(result.journal.step("files/alpha.ts/inspect/review").status, "ok");
  assert.equal(result.journal.step("files/beta.ts/inspect/review").status, "ok");
});

test("a declined recommendation is recorded as blocked", async () => {
  const result = await runWorkflow(workflow, {
    ...fixtures,
    provider: provider(),
    answers: () => ({ approved: false }),
  });
  assert.equal(result.output.approved, false);
  assert.equal(result.tasks.tasks[0]?.status, "blocked");
});

test("one failed reviewer fails the complete review before synthesis or approval", async () => {
  const reviewer = mock().on({ key: "files/alpha.ts/inspect/review" }, { findings: [] });
  await assert.rejects(runWorkflow(workflow, { ...fixtures, provider: reviewer }), /failed|no fixture/);
  assert.equal(
    reviewer.calls.some((call) => call.key === "summary"),
    false,
  );
});

test("failed evidence verification prevents human approval and task creation", async () => {
  const reviewer = mock()
    .on({ key: "files/*/inspect/review" }, { findings: [{ ...finding, evidence: " " }] })
    .on({ key: "summary" }, { summary: "Unsupported", recommendation: "revise" });
  let decisions = 0;
  await assert.rejects(
    runWorkflow(workflow, {
      ...fixtures,
      provider: reviewer,
      answers: () => {
        decisions++;
        return { approved: true };
      },
    }),
    /completeness or evidence checks failed/,
  );
  assert.equal(decisions, 0);
});

test("approval can be disabled explicitly without a pending human request", async () => {
  const result = await runWorkflow(workflow, {
    ...fixtures,
    input: { ...fixtures.input, requireApproval: false },
    provider: provider(),
  });
  assert.equal(result.output.approved, true);
  assert.equal(result.journal.steps({ kind: "human" }).length, 0);
});
