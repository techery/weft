/**
 * Deterministic, offline contract check for the interactive custom-UI workflow.
 * It compiles the real browser asset graph, drives the human suspension through
 * the engine, and proves both display presentations survive in projected state.
 *
 *   npx tsx examples/09-custom-react-ui/main.ts
 */
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { Engine, MemoryBlobStore, MemoryJournalStore, ProviderRegistry } from "@techery/weft-core";
import { loadWorkflow } from "../../packages/gate/src/index.ts";

const entry = fileURLToPath(new URL("./custom-react-ui/main.ts", import.meta.url));
const loaded = await loadWorkflow({ entry });
assert.deepEqual(
  loaded.uiCatalog.assets.map(({ id, mode }) => ({ id, mode })),
  [
    { id: "example.deployment-outcome", mode: "display" },
    { id: "example.deployment-review", mode: "input" },
    { id: "example.deployment-plan", mode: "display" },
  ],
);

const blobs = new MemoryBlobStore();
const engine = new Engine({
  journal: new MemoryJournalStore(),
  blobs,
  providers: new ProviderRegistry(),
});

try {
  const handle = await engine.start(loaded.def, {
    input: {
      environment: "staging",
      releaseName: "Search reliability rollout",
      version: "2026.08.26-rc.3",
      requestedBy: "release-bot@weft.local",
      risk: "high",
      window: "maintenance-window",
      services: ["api", "web", "worker", "billing"],
    },
    cwd: process.cwd(),
    defHash: loaded.hash,
    uiCatalog: loaded.uiCatalog,
  });
  const waiting = await handle.outcome();
  assert.equal(waiting.status, "waiting_for_human");
  if (waiting.status !== "waiting_for_human") throw new Error("workflow did not suspend");
  const request = waiting.pending[0]!;
  assert.equal(request.ui?.asset.id, "example.deployment-review");
  assert.equal(request.ui?.mode, "input");

  const before = await engine.state(handle.runId);
  assert.deepEqual(
    before.steps.flatMap((step) => (step.presentation ? [step.presentation.asset.id] : [])),
    ["example.deployment-plan"],
  );

  await engine.answer(handle.runId, request.id, {
    intent: "partial",
    approvedServices: ["api", "worker"],
    strategy: "canary",
    trafficPercent: 10,
    monitorMinutes: 30,
    rollbackOnError: true,
    runSmokeTests: true,
    acknowledgedRisk: true,
    note: "Hold web for the cache migration.",
  });
  assert.deepEqual(await handle.result, {
    environment: "staging",
    releaseName: "Search reliability rollout",
    version: "2026.08.26-rc.3",
    risk: "high",
    window: "maintenance-window",
    decision: "partial",
    approvedServices: ["api", "worker"],
    deferredServices: ["web", "billing"],
    strategy: "canary",
    trafficPercent: 10,
    monitorMinutes: 30,
    rollbackOnError: true,
    runSmokeTests: true,
    note: "Hold web for the cache migration.",
    warnings: ["2 services deferred", "Canary limited to 10% traffic"],
  });

  const completed = await engine.state(handle.runId);
  const presentations = completed.steps.flatMap((step) => (step.presentation ? [step.presentation] : []));
  assert.deepEqual(
    presentations.map((presentation) => presentation.asset.id),
    ["example.deployment-plan", "example.deployment-outcome"],
  );
  for (const presentation of presentations) {
    assert.match(await blobs.getText(presentation.asset.bundleRef.$blob), /weft\.ui\.init/);
  }

  console.log("custom React UI assertions passed");
  console.log("presentations: deployment plan → human review → deployment outcome");
} finally {
  await engine.shutdown();
}
