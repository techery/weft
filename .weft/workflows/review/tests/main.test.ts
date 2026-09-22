import assert from "node:assert/strict";
import test from "node:test";
import { findingKey } from "@techery/weft-stdlib";
import { mock, runWorkflow } from "@techery/weft-testing";
import workflow from "../main.ts";

const a = { file: "a.ts", line: 3, claim: "Null is dereferenced", evidence: "value.id" };
const b = { ...a, claim: "The value is stale", evidence: "cached.value" };
const git = { changedSince: { files: [{ path: "a.ts", status: "M" }] } };

test("reviews distinct claims at the same location and deduplicates repeated claims", async () => {
  const provider = mock()
    .on({ key: "review:a.ts" }, { findings: [a, b, { ...a, line: 4 }] })
    .on({ key: "refute:*" }, { real: true, reason: "Reproduced" });
  const result = await runWorkflow(workflow, { input: {}, fixtureMode: "strict", git, provider });
  assert.deepEqual(result.output.confirmed, [a, b]);
  assert.deepEqual(
    provider.calls
      .filter((call) => call.key?.startsWith("refute:"))
      .map((call) => call.key)
      .sort(),
    [a, b].map((finding) => `refute:${findingKey(finding)}`).sort(),
  );
  assert.equal(result.journal.records.filter(({ ev }) => ev.type === "drop").length, 0);
});

for (const stage of ["review", "refute"]) {
  test(`fails closed when a ${stage} worker is unavailable`, async () => {
    const provider = mock()
      .on({ key: `${stage}:*` }, () => {
        throw new Error(`${stage} unavailable`);
      })
      .on({ key: "review:*" }, { findings: [a] });
    await assert.rejects(
      runWorkflow(workflow, { input: {}, fixtureMode: "strict", git, provider }),
      /failed|unavailable/,
    );
  });
}

test("empty changed scope completes without model calls", async () => {
  const provider = mock();
  const result = await runWorkflow(workflow, {
    input: {},
    fixtureMode: "strict",
    provider,
    git: { changedSince: { files: [{ path: "deleted.ts", status: "D" }] } },
  });
  assert.deepEqual(result.output, { confirmed: [] });
  assert.equal(provider.calls.length, 0);
});

test("refuted findings are excluded after every worker completes", async () => {
  const provider = mock()
    .on({ key: "review:*" }, { findings: [a, b] })
    .on({ key: `refute:${findingKey(a)}` }, { real: false, reason: "Guarded upstream" })
    .on({ key: `refute:${findingKey(b)}` }, { real: true, reason: "Reproduced" });
  const { output } = await runWorkflow(workflow, { input: {}, fixtureMode: "strict", git, provider });
  assert.deepEqual(output.confirmed, [b]);
});
