import { describe, expect, it } from "vitest";
import { buildRuns, RUN_ORDER } from "./fixtures/runs";
import type { AnswerState } from "./types";
import {
  fileTree,
  gatePayload,
  hasPendingGate,
  passesRunFilter,
  queueGroups,
  resolveArtifact,
  resolveFile,
  resolveStepId,
  runTableRows,
  runTabs,
  totalAdds,
  totalDels,
} from "./views";

const CLEAN: AnswerState = {
  answered: {},
  denied: {},
  ans: {
    "gate-5": { action: "open a PR", notify: ["#eng-alerts"], wait: true, note: "" },
    "gate-3": { scope: "publish now", announce: "#releases", note: "" },
    "gate-4": { variant: "variant A", shot: true, note: "" },
  },
};

const approved = (runId: string): AnswerState => ({ ...CLEAN, answered: { [runId]: true } });
const denied = (runId: string): AnswerState => ({
  ...CLEAN,
  answered: { [runId]: true },
  denied: { [runId]: true },
});

describe("queueGroups", () => {
  it("splits the live runs into what is blocked on you and what is working", () => {
    const { waiting, running } = queueGroups(buildRuns(CLEAN), RUN_ORDER);
    expect(waiting.map((c) => c.runId)).toEqual(["r-048", "r-046", "r-045"]);
    expect(running.map((c) => c.runId)).toEqual(["r-049"]);
  });

  it("shows the gate's own question on a waiting card", () => {
    const { waiting } = queueGroups(buildRuns(CLEAN), RUN_ORDER);
    const audit = waiting.find((c) => c.runId === "r-045");
    expect(audit?.ask).toBe("Commit the staged fix");
    expect(audit?.risk).toBe("write");
    expect(audit?.action).toBe("Answer →");
    expect(audit?.sub).toBe("r-045 · waiting · 40 min");
  });

  it("moves an approved run out of the waiting group", () => {
    const { waiting, running } = queueGroups(buildRuns(approved("r-045")), RUN_ORDER);
    expect(waiting.map((c) => c.runId)).toEqual(["r-048", "r-046"]);
    expect(running.map((c) => c.runId)).toEqual(["r-049", "r-045"]);
    const audit = running.find((c) => c.runId === "r-045");
    expect(audit?.ask).toBe("fix approved — 4 steps active");
    expect(audit?.sub).toBe("r-045 · running · 08:41");
  });

  it("drops a denied run from both groups", () => {
    const { waiting, running } = queueGroups(buildRuns(denied("r-046")), RUN_ORDER);
    expect(waiting.map((c) => c.runId)).toEqual(["r-048", "r-045"]);
    expect(running.map((c) => c.runId)).toEqual(["r-049"]);
  });
});

describe("runTableRows", () => {
  it("keeps the journal's own outcome while a run has not moved", () => {
    const rows = runTableRows(buildRuns(CLEAN));
    expect(rows.map((r) => r.id)).toEqual(["r-049", "r-048", "r-046", "r-045", "r-044"]);
    expect(rows.find((r) => r.id === "r-045")?.outcome).toBe("gate: commit the fix");
  });

  it("reports what a resumed run is doing now", () => {
    const rows = runTableRows(buildRuns(approved("r-045")));
    const audit = rows.find((r) => r.id === "r-045");
    expect(audit?.state).toBe("running");
    expect(audit?.outcome).toBe("4 steps active");
  });

  it("says a denied run stopped at its gate", () => {
    const rows = runTableRows(buildRuns(denied("r-045")));
    const audit = rows.find((r) => r.id === "r-045");
    expect(audit?.state).toBe("stopped");
    expect(audit?.outcome).toBe("stopped at the gate");
  });

  it("filters by what the run is waiting on", () => {
    const rows = runTableRows(buildRuns(CLEAN));
    expect(rows.filter((r) => passesRunFilter(r, "Needs you")).map((r) => r.id)).toEqual([
      "r-048",
      "r-046",
      "r-045",
    ]);
    expect(rows.filter((r) => passesRunFilter(r, "Running")).map((r) => r.id)).toEqual(["r-049"]);
    expect(rows.filter((r) => passesRunFilter(r, "Finished")).map((r) => r.id)).toEqual(["r-044"]);
    expect(rows.filter((r) => passesRunFilter(r, "All"))).toHaveLength(5);
  });
});

describe("runTabs", () => {
  it("hides findings and changes when the run produced neither", () => {
    const triage = buildRuns(CLEAN)["r-049"]!;
    expect(runTabs(triage, false).map((t) => t.key)).toEqual(["steps", "artifacts", "journal"]);
  });

  it("badges the steps tab while a gate is pending", () => {
    const audit = buildRuns(CLEAN)["r-045"]!;
    const tabs = runTabs(audit, true);
    expect(tabs.map((t) => t.key)).toEqual(["steps", "findings", "artifacts", "changes", "journal"]);
    expect(tabs[0]?.badge).toBe("1");
    expect(runTabs(audit, false)[0]?.badge).toBe("");
  });
});

describe("step, artifact and file resolution", () => {
  const runs = buildRuns(CLEAN);

  it("falls back to the pending gate when the asked-for step is unknown", () => {
    const audit = runs["r-045"]!;
    expect(resolveStepId(audit, "nope", true)).toBe("gate-5");
    expect(resolveStepId(audit, "verify-1", true)).toBe("verify-1");
  });

  it("falls back to the first recorded step once the gate is answered", () => {
    const audit = buildRuns(approved("r-045"))["r-045"]!;
    expect(resolveStepId(audit, undefined, false)).toBe("verify-1");
  });

  it("falls back to the first artifact and file a run actually has", () => {
    const triage = runs["r-049"]!;
    expect(resolveArtifact(triage, "report.md")?.name).toBe("issues.json");
    expect(resolveFile(triage, "src/net/fetchWithRetry.ts")).toBeUndefined();
    expect(resolveArtifact(runs["r-045"]!, "report.md")?.name).toBe("report.md");
  });

  it("knows a gate is pending only until it is answered", () => {
    const audit = runs["r-045"]!;
    expect(hasPendingGate(audit, {})).toBe(true);
    expect(hasPendingGate(audit, { "r-045": true })).toBe(false);
    expect(hasPendingGate(runs["r-044"]!, {})).toBe(false);
  });
});

describe("changes", () => {
  const audit = buildRuns(CLEAN)["r-045"]!;

  it("totals the staged diff", () => {
    expect(totalAdds(audit.files)).toBe(142);
    expect(totalDels(audit.files)).toBe(38);
  });

  it("expands paths into a directory tree without repeating a folder", () => {
    const tree = fileTree(audit.files);
    expect(tree.map((n) => `${n.depth}:${n.name}`)).toEqual([
      "0:src",
      "1:net",
      "2:fetchWithRetry.ts",
      "0:package-lock.json",
      "0:docs",
      "1:security.md",
    ]);
    expect(tree.find((n) => n.name === "fetchWithRetry.ts")?.stat).toBe("+42 −7");
    expect(tree.find((n) => n.name === "fetchWithRetry.ts")?.ext).toBe("TS");
  });
});

describe("gatePayload", () => {
  it("renders the answer object the next step will receive", () => {
    const audit = buildRuns(CLEAN)["r-045"]!;
    expect(gatePayload(audit.gate!, CLEAN.ans)).toBe(
      '{ action: "open a PR", notify: ["#eng-alerts"], wait: true, note: "" }',
    );
  });

  it("keeps unanswered questions in the payload as empty strings", () => {
    const notes = buildRuns(CLEAN)["r-046"]!;
    expect(gatePayload(notes.gate!, { "gate-3": { scope: "draft only" } })).toBe(
      '{ scope: "draft only", announce: "", note: "" }',
    );
  });
});

describe("answering a gate rewrites the run", () => {
  it("resumes the run and journals the answer verbatim", () => {
    const audit = buildRuns(approved("r-045"))["r-045"]!;
    expect(audit.state).toBe("running");
    expect(audit.pill).toBe("4 steps active");
    expect(audit.active.map((a) => a.stepId)).toContain("push-1");
    expect(audit.journal.at(-1)?.text).toBe("push branch started · weft/r-045");
    expect(audit.steps["gate-5"]?.out[0]).toBe('{ answer: "open a PR", answered_by: "you", at: "08:42" }');
  });

  it("stops the run and cancels the machine steps when denied", () => {
    const audit = buildRuns(denied("r-045"))["r-045"]!;
    expect(audit.state).toBe("stopped");
    expect(audit.pill).toBe("stopped by you");
    expect(audit.active).toEqual([]);
    expect(audit.chrome).toContain("stopped at 08:42");
    expect(audit.steps["fix-f2"]?.streaming).toBe(false);
    expect(audit.changesNote).toBe("Denied — the branch was left in place and nothing was committed.");
  });
});
