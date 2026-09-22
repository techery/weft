import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { mock, runWorkflow } from "@techery/weft-testing";
import workflow from "../main.ts";

const fingerprint = "src/state.ts|value|invalid-persisted-shape";
const finding = {
  file: "src/state.ts",
  line: 1,
  severity: "major",
  category: "correctness",
  symbol: "value",
  claim: "Invalid persisted JSON shapes are trusted",
  evidence: "JSON.parse(localStorage.value)",
};
const fixtures = {
  input: { maxFiles: 1 },
  fixtureMode: "strict" as const,
  git: { head: { sha: "abc123" } },
  fs: { "src/state.ts": "export const value = JSON.parse(localStorage.value);" },
};
const reviewer = (real = true) =>
  mock()
    .on({ key: "review:*" }, { findings: [finding, finding] })
    .on({ key: "consolidate" }, { findings: [{ ...finding, fingerprint, sourceClaims: 2 }] })
    .on(
      { key: "refute:*" },
      { real, reason: real ? "Invalid object reaches consumers" : "Validated upstream" },
    );

test("a recurring accepted finding keeps one persistent task and its first-seen provenance", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "weft-task-review-portable-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const run = (provider = reviewer()) =>
    runWorkflow(workflow, {
      ...fixtures,
      cwd,
      provider,
      answers: () => ({ record: [fingerprint] }),
    });
  const first = await run();
  const secondProvider = reviewer();
  const second = await run(secondProvider);
  assert.equal(first.output.recorded, 1);
  assert.equal(second.output.recorded, 1);
  assert.equal(second.tasks.tasks.length, 1);
  const task = second.tasks.tasks[0]!;
  assert.equal(task.extensions?.firstSeenRun, first.runId);
  assert.equal(task.extensions?.lastSeenRun, second.runId);
  assert.equal(task.dedupeKey, fingerprint);
  assert.match(
    secondProvider.calls.find((call) => call.key?.startsWith("review:"))!.prompt,
    /read-only task authority/,
  );
  assert.doesNotMatch(
    secondProvider.calls.find((call) => call.key?.startsWith("refute:"))!.prompt,
    /Workflow task tracker/,
  );
});

test("declined findings never enter the backlog", async () => {
  const result = await runWorkflow(workflow, {
    ...fixtures,
    provider: reviewer(),
    answers: () => ({ record: [] }),
  });
  assert.equal(result.output.recorded, 0);
  assert.equal(result.tasks.tasks.length, 0);
});

test("refuted findings need no human decision and create no tasks", async () => {
  const result = await runWorkflow(workflow, { ...fixtures, provider: reviewer(false) });
  assert.deepEqual(result.output.confirmed, []);
  assert.equal(result.output.refuted, 1);
  assert.equal(result.tasks.tasks.length, 0);
  assert.equal(result.journal.steps({ kind: "human" }).length, 0);
});

for (const stage of ["review", "refute"]) {
  test(`a failed ${stage} worker cannot produce a successful partial review`, async () => {
    const provider = mock()
      .on({ key: `${stage}:*` }, () => {
        throw new Error("reviewer unavailable");
      })
      .on({ key: "review:*" }, { findings: [finding] })
      .on({ key: "consolidate" }, { findings: [{ ...finding, fingerprint, sourceClaims: 1 }] });
    await assert.rejects(runWorkflow(workflow, { ...fixtures, provider }), /failed|unavailable/);
  });
}

test("requires independent providers before dispatching reviews", async () => {
  const provider = reviewer();
  await assert.rejects(
    runWorkflow(workflow, { ...fixtures, input: { reviewWith: "codex", refuteWith: "codex" }, provider }),
    /different providers/,
  );
  assert.equal(provider.calls.length, 0);
});
