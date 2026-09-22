import { type JournalEvent, type JournalRecord, reduceState } from "@techery/weft-core";
import { StepError, type WorkspaceCandidate } from "@techery/weft-sdk";
import { expect, test } from "vitest";

const created: JournalEvent = {
  type: "run.created",
  runId: "r1",
  workflow: { name: "delivery" },
  input: {},
  cwd: "/repo",
  depth: 0,
};
const intent: JournalEvent = {
  type: "operation.intent",
  requestId: "r1:publish",
  binding: "git.pr",
  digest: "digest",
  key: "publish",
  input: {},
};
const unknown: JournalEvent = {
  type: "operation.unknown",
  requestId: "r1:publish",
  binding: "git.pr",
  detail: "Remote request timed out",
  resources: ["https://example.test/pr/1"],
};
const failed: JournalEvent = {
  type: "run.failed",
  error: new StepError("recovery_required", "inspect remote state").serialize(),
};
const receipt: JournalEvent = {
  type: "operation.receipt",
  requestId: "r1:publish",
  binding: "git.pr",
  digest: "digest",
  output: { url: "https://example.test/pr/1" },
  reconciled: true,
};
const fold = (events: JournalEvent[]) =>
  reduceState(events.map((ev, i): JournalRecord => ({ i, at: i + 1, ev })));

test("unknown operations remain attention items across failure and disappear after reconciliation", () => {
  const before = fold([created, intent, unknown, failed]);
  expect(before.status).toBe("failed");
  expect(before.attention).toEqual([
    expect.objectContaining({
      title: "Recovery required",
      requestId: "r1:publish",
      detail: "Remote request timed out",
    }),
  ]);
  expect(before.attention?.[0]?.nextAction).toContain("resume this run to reconcile");
  const after = fold([
    created,
    intent,
    unknown,
    failed,
    { type: "run.status", status: "executing" },
    receipt,
    { type: "run.completed", output: {} },
  ]);
  expect(after.attention).toEqual([]);
  expect(after.operations?.[0]).toMatchObject({
    status: "complete",
    reconciled: true,
    output: { url: "https://example.test/pr/1" },
  });
  expect(after.operations?.[0]?.detail).toBeUndefined();
});

test("an interrupted pending intent surfaces attention without claiming external success", () => {
  expect(fold([created, intent]).attention).toEqual([]);
  const state = fold([created, intent, { type: "run.cancelled" }]);
  expect(state.attention?.[0]?.detail).toContain("no confirmed receipt");
  expect(state.deliveries).toEqual([]);
});

test("workspace recovery includes the retained path and keeps run status compatible", () => {
  const state = fold([
    created,
    {
      type: "workspace.intent",
      workspace: {
        id: "w1",
        runId: "r1",
        repository: "/repo",
        path: "/repo/.weft/workspaces/w1",
        branch: "fix",
        base: "a",
        configDigest: "d",
      },
    },
    failed,
  ]);
  expect(state.workspace?.status).toBe("preparing");
  expect(state.status).toBe("failed");
  expect(state.attention?.[0]).toMatchObject({ kind: "workspace", resources: ["/repo/.weft/workspaces/w1"] });
});

test("failed required checks and stale candidates remain actionable terminal work", () => {
  for (const code of ["check_failed", "stale_candidate"] as const) {
    const state = fold([
      created,
      { type: "run.failed", error: new StepError(code, "candidate cannot be delivered").serialize() },
    ]);
    expect(state.attention?.[0]).toMatchObject({
      kind: "verification",
      title: code === "check_failed" ? "Verification failed" : "Candidate stale",
    });
    expect(state.deliveries).toEqual([]);
  }
});

test("exact-head PR feedback remains attention until a fresh passing observation", () => {
  const candidate: JournalEvent = {
    type: "workspace.candidate",
    candidate: {
      id: "candidate",
      runId: "r1",
      workspaceId: "workspace",
      repository: "/repo",
      branch: "fix",
      head: "head",
      tree: "tree",
      generation: 1,
      environment: "env",
    } as WorkspaceCandidate,
  };
  const feedback = (requestId: string, status: string, head = "head"): JournalEvent => ({
    type: "operation.receipt",
    binding: "github.pr-feedback",
    requestId,
    digest: requestId,
    reconciled: false,
    output: { status, head, detail: `checks ${status}`, url: "https://example.test/pr/1" },
  });
  const history = [
    created,
    candidate,
    feedback("first", "failed"),
    { type: "run.completed", output: {} } as const,
  ];
  expect(fold(history).attention?.[0]).toMatchObject({
    title: "PR feedback failed",
    detail: "checks failed",
  });
  expect(fold([...history, feedback("wrong-head", "passed", "old")]).attention?.[0]?.title).toBe(
    "PR feedback failed",
  );
  expect(fold([...history, feedback("new", "passed")]).attention).toEqual([]);
});
