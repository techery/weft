import { describe, expect, it } from "vitest";
import type { PendingRequest, RunDetail, RunRow, StepState } from "~/api/types";
import { adaptRun, adaptRunRows, ago, gateAnswer, gateStepId, schemaQuestions, stepId } from "./adapt";
import { splitDiff } from "./diff";
import { journalEntries } from "./journal";
import { runTabs } from "./views";

const step = (over: Partial<StepState> & { seq: number }): StepState => ({
  kind: "agent",
  status: "ok",
  startedAt: 1_000,
  endedAt: 2_000,
  ...over,
});

const detail = (over: Partial<RunDetail> = {}): RunDetail => ({
  runId: "r1",
  workflow: "review",
  status: "executing",
  input: {},
  createdAt: 1_000,
  updatedAt: 5_000,
  depth: 0,
  cwd: "/repo",
  phases: [],
  steps: [],
  humans: [],
  notes: [],
  checks: [],
  patches: { captured: [], merged: [], discarded: [] },
  budget: { tokens: 0, usd: 0 },
  records: 3,
  ...over,
});

describe("run status", () => {
  it("maps every engine status onto a state the design paints", () => {
    const cases: Array<[RunDetail["status"], string]> = [
      ["planning", "running"],
      ["executing", "running"],
      ["verifying", "running"],
      ["waiting_for_human", "waiting"],
      ["waiting_for_signal", "waiting"],
      ["complete", "done"],
      ["failed", "failed"],
      ["cancelled", "stopped"],
    ];
    for (const [status, expected] of cases) {
      expect(adaptRun(detail({ status })).state, status).toBe(expected);
    }
  });
});

describe("the run header's chrome", () => {
  it("shows a denominator only when the run was actually given a ceiling", () => {
    const spent = { tokens: 900, usd: 0.42 };
    expect(adaptRun(detail({ budget: spent, limits: { usd: 5 } })).chrome).toContain("$0.42 / $5.00");
    // No ceiling means no denominator: "$0.42 / $0.00" would read as over budget.
    expect(adaptRun(detail({ budget: spent, limits: null })).chrome).toContain("$0.42");
    expect(adaptRun(detail({ budget: spent, limits: null })).chrome).not.toContain("/");
  });
});

describe("the steps rail", () => {
  it("groups by phase and gathers what no phase claimed", () => {
    const run = adaptRun(
      detail({
        phases: [{ name: "Review", steps: [1, 2] }],
        steps: [
          step({ seq: 1, label: "read" }),
          step({ seq: 2, label: "judge" }),
          step({ seq: 3, label: "loose" }),
        ],
      }),
    );
    expect(run.rail.map((group) => group.name)).toEqual(["Review", "no phase"]);
    expect(run.rail[0]?.steps.map((s) => s.label)).toEqual(["read", "judge"]);
    expect(run.rail[1]?.steps.map((s) => s.label)).toEqual(["loose"]);
  });

  it("shows a human step holding a pending question as waiting, not as running", () => {
    const run = adaptRun(
      detail({
        status: "waiting_for_human",
        phases: [{ name: "Gate", steps: [1] }],
        steps: [step({ seq: 1, kind: "human", label: "approve", status: "running", endedAt: undefined })],
        humans: [
          {
            id: "h1",
            seq: 1,
            kind: "approve",
            question: "land it?",
            schema: {},
            status: "pending",
            requestedAt: 1_500,
          },
        ],
      }),
    );
    expect(run.rail[0]?.steps[0]?.state).toBe("waiting");
    expect(run.rail[0]?.steps[0]?.meta).toBe("waiting on you");
    // The gate is addressable by the request that raised it, not by the step's seq.
    expect(run.gateStep).toBe(gateStepId("h1"));
    expect(run.steps[gateStepId("h1")]).toBeDefined();
    expect(run.steps[stepId(1)]).toBeDefined();
  });
});

describe("tabs", () => {
  it("hides a tab whose run produced nothing for it, and always keeps steps and journal", () => {
    const bare = adaptRun(detail());
    expect(runTabs(bare, false).map((t) => t.key)).toEqual(["steps", "journal"]);
  });

  it("badges the steps tab only while a question is outstanding", () => {
    const run = adaptRun(detail({ notes: [{ kind: "finding", text: "x" }] }));
    expect(runTabs(run, true)[0]?.badge).toBe("1");
    expect(runTabs(run, false)[0]?.badge).toBe("");
    // The tab is labelled "Notes"; its key matches, so ?tab=notes resolves.
    expect(runTabs(run, false).map((t) => t.key)).toContain("notes");
  });
});

describe("notes as findings", () => {
  it("carries a note's own words and omits the step link nothing records", () => {
    const run = adaptRun(
      detail({ notes: [{ kind: "risk", text: "the retry guard is gone", evidence: "src/net.ts:118" }] }),
    );
    expect(run.findings).toEqual([
      {
        id: "n-1",
        msg: "the retry guard is gone",
        loc: "src/net.ts:118",
        sev: "risk",
        stepLabel: "",
        chip: "",
        settled: true,
      },
    ]);
  });
});

describe("step input", () => {
  it("comes from what the step was scheduled with, which the projection drops", () => {
    const run = adaptRun(
      detail({
        steps: [step({ seq: 4, label: "classify" })],
        inputs: { "4": { issue: 812, labels: ["bug", "docs"] } },
      }),
    );
    const rows = run.steps[stepId(4)]?.input ?? [];
    expect(rows.map((row) => row.k)).toEqual(["issue", "labels"]);
    // A short string list reads better as pills than as JSON.
    expect(rows[1]?.kind).toBe("pills");
    expect(rows[1]?.pills).toEqual(["bug", "docs"]);
  });

  it("is empty when the run was fetched without detail", () => {
    const run = adaptRun(detail({ steps: [step({ seq: 4 })] }));
    expect(run.steps[stepId(4)]?.input).toEqual([]);
  });
});

describe("the runs table", () => {
  const row = (over: Partial<RunRow> & { runId: string }): RunRow => ({
    workflow: "review",
    status: "executing",
    createdAt: 1_000,
    updatedAt: 2_000,
    ...over,
  });

  it("names the question a waiting run is blocked on", () => {
    const pending = new Map<string, PendingRequest>([
      [
        "r2",
        {
          runId: "r2",
          id: "h1",
          kind: "approve",
          question: "publish v0.9.0?",
          schema: {},
          createdAt: 1,
          workflow: "release",
          rootRunId: "r2",
          rootWorkflow: "release",
        },
      ],
    ]);
    const rows = adaptRunRows([row({ runId: "r2", status: "waiting_for_human" })], pending);
    expect(rows[0]?.outcome).toBe("publish v0.9.0?");
    expect(rows[0]?.state).toBe("waiting");
  });

  it("counts active steps for a running row and sorts newest first", () => {
    const rows = adaptRunRows(
      [
        row({ runId: "old", createdAt: 10 }),
        row({ runId: "new", createdAt: 99, running: 3, spend: { tokens: 10, usd: 1.5 } }),
      ],
      new Map(),
    );
    expect(rows.map((r) => r.id)).toEqual(["new", "old"]);
    expect(rows[0]?.outcome).toBe("3 steps active");
    expect(rows[0]?.cost).toBe("$1.50");
    // A row fetched without ?spend=1 has no cost to show, and shows none.
    expect(rows[1]?.cost).toBe("");
  });
});

describe("a gate's form, from its declared schema", () => {
  it("turns an approve schema into a toggle and a note", () => {
    const questions = schemaQuestions({
      type: "object",
      properties: { approved: { type: "boolean" }, note: { type: "string" } },
      required: ["approved"],
    });
    expect(questions.map((q) => [q.key, q.kind, q.required])).toEqual([
      ["approved", "toggle", true],
      ["note", "note", false],
    ]);
  });

  it("turns an enum into pills and a described union into cards", () => {
    const enums = schemaQuestions({
      type: "object",
      properties: { scope: { type: "string", enum: ["publish", "draft"] } },
    });
    expect(enums[0]?.kind).toBe("choice");
    expect(enums[0]?.options.map((o) => o.label)).toEqual(["publish", "draft"]);

    const described = schemaQuestions({
      type: "object",
      properties: {
        action: {
          anyOf: [
            { const: "open a PR", description: "Push the branch and open one PR." },
            { const: "commit only", description: "Push the branch, no PR." },
          ],
        },
      },
    });
    expect(described[0]?.kind).toBe("cards");
    expect(described[0]?.options[0]?.desc).toBe("Push the branch and open one PR.");
  });

  it("reads a list of choices as multi-select", () => {
    const questions = schemaQuestions({
      type: "object",
      properties: { notify: { type: "array", items: { enum: ["#eng", "#ops"] } } },
    });
    expect(questions[0]?.kind).toBe("chips");
    expect(questions[0]?.options.map((o) => o.label)).toEqual(["#eng", "#ops"]);
  });

  it("builds the answer with the schema's own types, dropping what was left blank", () => {
    const schema = {
      type: "object",
      properties: { approved: { type: "boolean" }, count: { type: "integer" }, note: { type: "string" } },
    };
    expect(gateAnswer(schema, { approved: true, count: "7", note: "" })).toEqual({
      approved: true,
      count: 7,
    });
  });

  it("is empty for a question that declares no fields", () => {
    expect(schemaQuestions(null)).toEqual([]);
    expect(schemaQuestions({ type: "object" })).toEqual([]);
  });
});

describe("the journal", () => {
  it("reads each event in its own words, with elapsed time from the first record", () => {
    const entries = journalEntries([
      { i: 0, at: 1_000, ev: { type: "run.created", workflow: { name: "review" }, input: { base: "main" } } },
      {
        i: 1,
        at: 3_500,
        ev: {
          type: "step.scheduled",
          seq: 1,
          kind: "agent",
          label: "judge",
          route: { provider: "claude", model: "sonnet" },
        },
      },
      {
        i: 2,
        at: 64_000,
        ev: { type: "step.completed", seq: 1, label: "judge", usage: { input: 900, output: 100, usd: 0.02 } },
      },
      { i: 3, at: 65_000, ev: { type: "human.requested", id: "h1", question: "land it?", risk: "high" } },
    ]);
    expect(entries.map((e) => e.time)).toEqual(["00:00", "00:02", "01:03", "01:04"]);
    expect(entries.map((e) => e.tag)).toEqual(["run", "agent", "agent", "human"]);
    expect(entries[0]?.text).toBe("run.started · review · inputs { base }");
    expect(entries[1]?.text).toBe("judge started · claude/sonnet");
    expect(entries[2]?.text).toBe("judge ok · 1,000 tok · $0.02");
    expect(entries[3]?.text).toBe("human.requested h1 · land it? · risk high");
  });

  it("names an event it has never been taught rather than dropping it", () => {
    const entries = journalEntries([{ i: 0, at: 0, ev: { type: "something.new" } }]);
    expect(entries[0]?.text).toBe("something.new");
  });
});

describe("splitting a patch into files", () => {
  it("numbers both sides and keeps content that looks like a header", () => {
    const files = splitDiff(
      [
        "diff --git a/q.sql b/q.sql",
        "--- a/q.sql",
        "+++ b/q.sql",
        "@@ -10,3 +10,3 @@",
        " select 1;",
        "--- drop me",
        "+select 2;",
      ].join("\n"),
    );
    const lines = files["q.sql"]?.lines ?? [];
    expect(files["q.sql"]?.hunk).toBe("@@ -10,3 +10,3 @@");
    expect(lines.map((l) => [l.ln, l.rn, l.sign])).toEqual([
      ["10", "10", ""],
      ["11", "", "-"],
      ["", "11", "+"],
    ]);
  });

  it("keys by the same path the daemon's own stats use", () => {
    const files = splitDiff(
      [
        "diff --git c/src/a.ts i/src/a.ts",
        "--- c/src/a.ts",
        "+++ i/src/a.ts",
        "@@ -1 +1 @@",
        "-a",
        "+b",
      ].join("\n"),
    );
    expect(Object.keys(files)).toEqual(["src/a.ts"]);
  });
});

describe("ago", () => {
  it("reads the way the design's columns do", () => {
    const now = 10_000_000;
    expect(ago(now - 5_000, now)).toBe("just now");
    expect(ago(now - 120_000, now)).toBe("2 min");
    expect(ago(now - 7_200_000, now)).toBe("2 h");
    expect(ago(now - 86_400_000, now)).toBe("yesterday");
    expect(ago(null, now)).toBe("");
  });
});
