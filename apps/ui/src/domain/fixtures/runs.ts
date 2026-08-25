import type { AnswerState, Run } from "../types";

const ADVISORY_PILLS = ["CVE-2026-1183", "CVE-2026-0994", "GHSA-77x2"];

/** Runs listed newest first — the order the queue and the runs table use. */
export const RUN_ORDER = ["r-049", "r-048", "r-046", "r-045", "r-044"];

/** The step each run opens on when you have not asked for a particular one. */
export const DEFAULT_STEP: Record<string, string> = {
  "r-045": "verify-1",
  "r-049": "cl-815",
  "r-046": "draft-1",
  "r-048": "des-a",
  "r-044": "pub-0",
};

/** Starting a workflow that already has a live run jumps straight to it. */
export const WORKFLOW_TO_RUN: Record<string, string> = {
  "triage.ts": "r-049",
  "deps-audit.ts": "r-045",
  "release-notes.ts": "r-046",
  "docs-hero.ts": "r-048",
};

/**
 * The five runs in the 30-day journal window.
 *
 * Answering or denying a gate rewrites the run it belongs to — state, pill,
 * rail, journal and the gate step's own output all move — so the fixtures are
 * built from the current answer state rather than being a frozen constant.
 */
export function buildRuns(st: AnswerState): Record<string, Run> {
  const ok = (id: string) => !!st.answered[id] && !st.denied[id];
  const no = (id: string) => !!st.denied[id];
  const answer = (gateId: string, key: string) => String(st.ans[gateId]?.[key] ?? "");

  const a45 = ok("r-045");
  const d45 = no("r-045");
  const a46 = ok("r-046");
  const d46 = no("r-046");
  const a48 = ok("r-048");
  const d48 = no("r-048");

  return {
    "r-045": {
      id: "r-045",
      wf: "Dependency audit",
      file: "deps-audit.ts",
      state: d45 ? "stopped" : a45 ? "running" : "waiting",
      chrome: `11 steps · ${d45 ? "stopped at 08:42" : "08:41"} · $2.40 / $6.00`,
      pill: d45 ? "stopped by you" : a45 ? "4 steps active" : "waiting on you · 40 min",
      gateStep: "gate-5",
      railTitle: "Run tree · appended as steps start",
      rail: [
        {
          name: "scan",
          meta: "task · 1.4s",
          steps: [
            {
              id: "scan-1",
              kind: "task",
              label: "scan-advisories",
              meta: "1.4s",
              state: "done",
              artifact: "",
            },
          ],
        },
        {
          name: "assess",
          meta: "agent ×3 ∥",
          steps: [
            {
              id: "as-1",
              kind: "agent",
              label: "assess CVE-1183",
              meta: "4.1k tok",
              state: "done",
              artifact: "",
            },
            {
              id: "as-2",
              kind: "agent",
              label: "assess CVE-0994",
              meta: "3.8k tok",
              state: "done",
              artifact: "",
            },
            {
              id: "as-3",
              kind: "agent",
              label: "assess GHSA-77x2",
              meta: "4.2k tok",
              state: "done",
              artifact: "",
            },
          ],
        },
        {
          name: "fix",
          meta: "answered 07:02",
          steps: [
            {
              id: "gate-1",
              kind: "human",
              label: "gate: fix strategy",
              meta: "approved · you",
              state: "done",
              artifact: "",
            },
            {
              id: "apply-1",
              kind: "task",
              label: "apply-fix",
              meta: "+42 −7",
              state: "done",
              artifact: "fix.patch",
            },
          ],
        },
        {
          name: "verify",
          meta: "task",
          steps: [
            {
              id: "verify-1",
              kind: "task",
              label: "verify",
              meta: "failed · 2 findings",
              state: "fail",
              artifact: "",
            },
          ],
        },
        {
          name: "fix",
          meta: "again · from findings",
          steps: [
            { id: "fix-f1", kind: "task", label: "bump lockfile", meta: "0.9s", state: "done", artifact: "" },
            {
              id: "fix-f2",
              kind: "agent",
              label: "patch call site",
              meta: d45 ? "cancelled" : "codex · 34s",
              state: d45 ? "idle" : "run",
              artifact: "",
            },
          ],
        },
        {
          name: "verify",
          meta: "again",
          steps: [
            {
              id: "verify-2",
              kind: "task",
              label: "verify (lockfile only)",
              meta: d45 ? "cancelled" : "12s",
              state: d45 ? "idle" : "run",
              artifact: "",
            },
          ],
        },
        {
          name: "report",
          meta: "agent",
          steps: [
            {
              id: "report-1",
              kind: "agent",
              label: "draft audit summary",
              meta: d45 ? "cancelled" : "1.8k tok",
              state: d45 ? "idle" : "run",
              artifact: "",
            },
          ],
        },
        {
          name: "commit",
          meta: "gated write",
          steps: [
            {
              id: "gate-5",
              kind: "human",
              label: "gate: commit the fix",
              meta: d45 ? "denied · you" : a45 ? "approved · you" : "waiting on you",
              state: d45 ? "idle" : a45 ? "done" : "waiting",
              artifact: "",
            },
            {
              id: "push-1",
              kind: "task",
              label: "push branch",
              meta: d45 ? "not run" : a45 ? "running · 4s" : "not started",
              state: d45 ? "wait" : a45 ? "run" : "wait",
              artifact: "",
            },
          ],
        },
      ],
      active: d45
        ? []
        : [
            { label: "fix", name: "patch call site", meta: "34s", stepId: "fix-f2" },
            { label: "verify", name: "verify (lockfile only)", meta: "12s", stepId: "verify-2" },
            { label: "report", name: "draft audit summary", meta: "1.8k tok", stepId: "report-1" },
            ...(a45 ? [{ label: "commit", name: "push branch", meta: "4s", stepId: "push-1" }] : []),
          ],
      findings: [
        {
          id: "f-1",
          msg: "Lockfile still pins the vulnerable transitive dep",
          loc: "package-lock.json · 8,204 · CVE-2026-1183",
          sev: "blocking",
          stepLabel: "8 · bump lockfile",
          chip: "done · 0.9s",
          settled: true,
          stepId: "fix-f1",
        },
        {
          id: "f-2",
          msg: "Patched call site drops the retry guard",
          loc: "src/net/fetchWithRetry.ts:118 · 2 tests failing",
          sev: "blocking",
          stepLabel: "9 · patch call site",
          chip: d45 ? "cancelled" : "running · 34s",
          settled: false,
          stepId: "fix-f2",
        },
      ],
      artifacts: [
        {
          name: "advisories.json",
          type: "json",
          size: "18 KB",
          step: "scan-advisories",
          ago: "8 min",
          view: {
            kind: "code",
            lines: [
              "[",
              '  { "id": "CVE-2026-1183", "pkg": "undici", "severity": "high", "path": "runtime" },',
              '  { "id": "CVE-2026-0994", "pkg": "undici", "severity": "high", "path": "runtime" },',
              '  { "id": "GHSA-77x2", "pkg": "esbuild", "severity": "moderate", "path": "dev" }',
              "]",
            ],
          },
        },
        {
          name: "fix.patch",
          type: "patch",
          size: "3.1 KB",
          step: "apply-fix",
          ago: "5 min",
          view: {
            kind: "code",
            lines: [
              "--- a/src/net/fetchWithRetry.ts",
              "+++ b/src/net/fetchWithRetry.ts",
              "@@ -12,4 +12,9 @@",
              "-  return await fetch(req);",
              "+  return await retryGuard(backoff, async () => {",
              "+    const res = await fetch(req);",
              "+    return res;",
              "+  });",
            ],
          },
        },
        {
          name: "verify.log",
          type: "log",
          size: "44 KB",
          step: "verify",
          ago: "3 min",
          view: {
            kind: "code",
            lines: [
              "FAIL src/net/fetchWithRetry.test.ts",
              "  ✗ keeps the retry guard (2 cases)",
              "FAIL audit",
              "  ✗ package-lock.json still pins undici 6.11.1",
              "",
              "214 tests · 212 passed · 2 failed · 2m 18s",
              "exit 1",
            ],
          },
        },
        {
          name: "report.md",
          type: "md",
          size: "1.4 KB",
          step: "draft audit summary",
          ago: "live",
          view: {
            kind: "md",
            title: "Dependency audit — 3 advisories",
            paras: [
              "Two of three advisories are actionable in this repo. One fix is staged on branch weft/r-045; verify is re-running after two findings.",
            ],
            rows: [
              { k: "CVE-1183", t: "Vulnerable transitive dep still pinned in the lockfile", v: "blocking" },
              { k: "CVE-0994", t: "Patched call site drops the retry guard", v: "blocking" },
              { k: "GHSA-77x2", t: "Dev-only dependency — no runtime path", v: "ignored" },
            ],
          },
        },
      ],
      files: [
        { path: "src/net/fetchWithRetry.ts", adds: 42, dels: 7 },
        { path: "package-lock.json", adds: 8, dels: 2 },
        { path: "docs/security.md", adds: 92, dels: 29 },
      ],
      committed: false,
      changesNote: d45
        ? "Denied — the branch was left in place and nothing was committed."
        : "Staged behind the commit gate. Nothing is committed until you approve.",
      branchNote: "branch weft/r-045 · not pushed",
      journal: [
        {
          time: "06:12",
          tag: "run",
          text: 'run.started · deps-audit · inputs { severity: "high", scope: "runtime" }',
        },
        { time: "06:14", tag: "task", text: "scan-advisories ok · 3 advisories · 1.4s" },
        { time: "06:41", tag: "agent", text: "assess CVE-1183 done · actionable · 4,102 tok" },
        { time: "07:02", tag: "human", text: "human.answered gate-1 · patch + test · answered_by: you" },
        { time: "07:44", tag: "task", text: "apply-fix ok · +42 −7 across 3 files" },
        { time: "08:02", tag: "task", text: "verify failed · exit 1 · 2 findings recorded" },
        { time: "08:07", tag: "task", text: "bump lockfile ok · 0.9s · opened by finding f-1" },
        { time: "08:12", tag: "agent", text: "patch call site started · codex/gpt-5 · opened by f-2" },
        { time: "08:29", tag: "task", text: "verify (lockfile only) started · 214 tests" },
        { time: "08:31", tag: "human", text: "human.requested gate-5 · risk write · blocks push branch" },
        ...(d45
          ? [{ time: "08:42", tag: "human", text: "human.answered gate-5 · discard · run.stopped by you" }]
          : a45
            ? [
                {
                  time: "08:42",
                  tag: "human",
                  text: `human.answered gate-5 · ${answer("gate-5", "action")} · answered_by: you`,
                },
                { time: "08:42", tag: "task", text: "push branch started · weft/r-045" },
              ]
            : []),
      ],
      gate: {
        id: "gate-5",
        risk: "write",
        blocks: "blocks step 11 · push branch",
        title: "Commit the staged fix",
        detail:
          "The branch holds +42 −7 across 3 files. Verify is still re-running after two findings — your answer is journaled and passed to the push step.",
        submitLabel: "Approve & resume",
        denyLabel: "Discard & stop",
        questions: [
          {
            key: "action",
            label: "commit as",
            kind: "cards",
            required: true,
            options: [
              {
                label: "open a PR",
                meta: "agent pick",
                desc: "Push the branch and open one PR against main.",
              },
              { label: "commit only", meta: "", desc: "Push the branch. No PR — someone opens it later." },
            ],
          },
          {
            key: "notify",
            label: "notify",
            kind: "chips",
            required: false,
            options: [
              { label: "#eng-alerts", meta: "", desc: "" },
              { label: "#on-call", meta: "", desc: "" },
              { label: "#product", meta: "", desc: "" },
            ],
          },
          { key: "wait", label: "verify", kind: "toggle", required: false, options: [] },
          { key: "note", label: "note", kind: "note", required: false, options: [] },
        ],
      },
      steps: {
        "verify-1": {
          title: "verify · step 7",
          pill: "failed · opened 3 steps",
          pillKind: "fail",
          action: "Re-run verify",
          cells: [
            { k: "kind", v: "task · deno" },
            { k: "exit", v: "code 1", color: "#b0483a" },
            { k: "suite", v: "214 tests · 2 failed" },
            { k: "duration", v: "2m 18s" },
            { k: "findings", v: "2 · both actionable" },
            { k: "opened", v: "steps 8, 9, 10", color: "#a9583e" },
          ],
          input: [
            {
              k: "patch",
              kind: "record",
              ref: "fix.patch",
              title: "3 files changed",
              sub: "+42 −7 · staged",
              pills: [],
            },
            { k: "suite", kind: "text", ref: "", title: "deno task test:e2e", sub: "", pills: [] },
            {
              k: "env",
              kind: "pills",
              ref: "",
              title: "",
              sub: "",
              pills: ["CI=1", "RETRIES=0", "SHARD=1/1"],
            },
          ],
          outTitle: "step output · exit 1",
          outNote: "2 findings recorded",
          out: [
            "FAIL src/net/fetchWithRetry.test.ts — retry guard missing (2 cases)",
            "FAIL audit — package-lock.json still pins vulnerable dep",
            "214 tests · 212 passed · 2 failed · 2m 18s",
          ],
          streaming: false,
          tools: [],
          toolsTitle: "",
          next: {
            k: "what weft did",
            v: "Nothing was scheduled: after this step returned findings, the code opened steps 8–10. weft recorded the order and the links.",
            goToGate: false,
          },
        },
        "fix-f2": {
          title: "patch call site · step 9",
          pill: d45 ? "cancelled" : "running · 34s",
          pillKind: d45 ? "done" : "run",
          action: d45 ? "Copy step id" : "Skip step",
          cells: [
            { k: "kind", v: "agent" },
            { k: "provider", v: "codex/gpt-5" },
            { k: "started", v: "08:12" },
            { k: "elapsed", v: d45 ? "34s · cancelled" : "34s of ~90s" },
            { k: "tokens", v: "6,240" },
            { k: "opened by", v: "step 7 · f-2", color: "#a9583e" },
          ],
          input: [
            {
              k: "finding",
              kind: "record",
              ref: "f-2",
              title: "Patched call site drops the retry guard",
              sub: "blocking · from step 7",
              pills: [],
            },
            {
              k: "file",
              kind: "file",
              ref: "",
              title: "src/net/fetchWithRetry.ts",
              sub: "4.2 KB · 118 lines",
              pills: [],
            },
            {
              k: "tests",
              kind: "pills",
              ref: "",
              title: "",
              sub: "",
              pills: ["retry guard missing", "backoff cap"],
            },
          ],
          outTitle: d45 ? "step output · cancelled" : "step output · streaming",
          outNote: "parsed against FixPatch",
          out: [
            "Restoring the retry guard around the awaited fetch and keeping the",
            "backoff cap the bump removed; adding one regression case for both.",
          ],
          streaming: !d45,
          toolsTitle: "Tool calls · 3",
          tools: [
            { cmd: "read-file src/net/fetchWithRetry.ts", meta: "4.2 KB · 0.2s", running: false },
            { cmd: 'grep "retryGuard" src/**', meta: "4 matches · 0.3s", running: false },
            {
              cmd: "write-file src/net/fetchWithRetry.ts",
              meta: d45 ? "cancelled" : "running · 2s",
              running: !d45,
            },
          ],
          next: null,
        },
        "gate-1": {
          title: "gate: fix strategy · step 4",
          pill: "approved · you",
          pillKind: "done",
          action: "Copy gate id",
          cells: [
            { k: "kind", v: "human" },
            { k: "risk", v: "write", color: "#a9583e" },
            { k: "asked", v: "07:01" },
            { k: "answered", v: "07:02" },
            { k: "policy", v: "write → ask" },
          ],
          input: [
            {
              k: "action",
              kind: "text",
              ref: "",
              title: "Patch both call sites and add a regression test",
              sub: "",
              pills: [],
            },
            { k: "advisories", kind: "pills", ref: "", title: "", sub: "", pills: ADVISORY_PILLS },
          ],
          outTitle: "answer",
          outNote: "journaled verbatim",
          out: ['{ answer: "patch + test", answered_by: "you", at: "07:02" }'],
          streaming: false,
          tools: [],
          toolsTitle: "",
          next: { k: "resumed", v: "next → step 5 · apply-fix, started at 07:02", goToGate: false },
        },
        "gate-5": {
          title: "gate: commit the fix · step 10",
          pill: d45 ? "denied · you" : a45 ? "approved · you" : "waiting on you",
          pillKind: d45 ? "fail" : a45 ? "done" : "human",
          action: "Copy gate id",
          cells: [
            { k: "kind", v: "human" },
            { k: "risk", v: "write", color: "#a9583e" },
            { k: "asked", v: "08:31" },
            { k: "policy", v: "write → ask" },
            { k: "blocks", v: "step 11 · push branch" },
          ],
          input: [
            { k: "branch", kind: "text", ref: "", title: "weft/r-045", sub: "", pills: [] },
            {
              k: "staged",
              kind: "record",
              ref: "+42 −7",
              title: "3 files changed",
              sub: "verify still running",
              pills: [],
            },
            { k: "advisories", kind: "pills", ref: "", title: "", sub: "", pills: ADVISORY_PILLS },
          ],
          outTitle: "answer",
          outNote: "journaled verbatim",
          out: [
            d45
              ? '{ answer: "discard", answered_by: "you", at: "08:42" } — run stopped'
              : a45
                ? `{ answer: "${answer("gate-5", "action")}", answered_by: "you", at: "08:42" }`
                : "pending — nothing is committed until this gate is answered",
          ],
          streaming: false,
          tools: [],
          toolsTitle: "",
          next: {
            k: d45 ? "stopped" : a45 ? "resumed" : "needs you",
            v: d45
              ? "run.stopped — the branch was left in place and no further steps were opened."
              : a45
                ? "next → step 11 · push branch, started at 08:42"
                : "The commit gate holds the branch. Machine steps keep running; nothing lands until you answer.",
            goToGate: !a45 && !d45,
          },
        },
      },
    },

    "r-049": {
      id: "r-049",
      wf: "Issue triage",
      file: "triage.ts",
      state: "running",
      chrome: "9 steps · 01:04 · $0.09 / $8.00 · pool 4/8",
      pill: "2 steps active",
      gateStep: null,
      railTitle: "Run tree · appended as steps start",
      rail: [
        {
          name: "gather",
          meta: "task · 1.2s",
          steps: [
            {
              id: "fetch-1",
              kind: "task",
              label: "fetch-issues",
              meta: "deno · 1.2s",
              state: "done",
              artifact: "issues.json",
            },
          ],
        },
        {
          name: "classify",
          meta: "agent ×4 ∥",
          steps: [
            {
              id: "cl-812",
              kind: "agent",
              label: "classify #812",
              meta: "sonnet · 2,988 tok",
              state: "done",
              artifact: "",
            },
            {
              id: "cl-814",
              kind: "agent",
              label: "classify #814",
              meta: "sonnet · 3,412 tok",
              state: "done",
              artifact: "",
            },
            {
              id: "cl-815",
              kind: "agent",
              label: "classify #815",
              meta: "codex · 21s",
              state: "run",
              artifact: "",
            },
            {
              id: "cl-816",
              kind: "agent",
              label: "classify #816",
              meta: "sonnet · 8s",
              state: "run",
              artifact: "",
            },
          ],
        },
        {
          name: "apply",
          meta: "gated write",
          steps: [
            {
              id: "gate-2",
              kind: "human",
              label: "gate: apply labels",
              meta: "not started",
              state: "wait",
              artifact: "",
            },
            {
              id: "apply-2",
              kind: "task",
              label: "apply-labels",
              meta: "not started",
              state: "wait",
              artifact: "",
            },
          ],
        },
        {
          name: "report",
          meta: "agent",
          steps: [
            {
              id: "sum-1",
              kind: "agent",
              label: "summarize",
              meta: "not started",
              state: "wait",
              artifact: "",
            },
          ],
        },
      ],
      active: [
        { label: "classify", name: "classify #815", meta: "21s", stepId: "cl-815" },
        { label: "classify", name: "classify #816", meta: "8s", stepId: "cl-816" },
      ],
      findings: [],
      artifacts: [
        {
          name: "issues.json",
          type: "json",
          size: "24 KB",
          step: "fetch-issues",
          ago: "1 min",
          view: {
            kind: "code",
            lines: [
              "[",
              '  { "n": 812, "title": "Export ignores locale", "state": "open" },',
              '  { "n": 814, "title": "Sort order flips on refresh", "state": "open" },',
              '  { "n": 815, "title": "Crash in scheduler loop", "state": "open" },',
              '  { "n": 816, "title": "Typo in CLI docs", "state": "open" }',
              "]",
            ],
          },
        },
      ],
      files: [],
      committed: false,
      changesNote: "",
      branchNote: "",
      journal: [
        {
          time: "00:00",
          tag: "run",
          text: 'run.started · triage · inputs { repo: "acme/treel", window: "24h" }',
        },
        { time: "00:01", tag: "task", text: "fetch-issues started · runtime deno · net: api.github.com" },
        { time: "00:02", tag: "task", text: "fetch-issues ok · 4 open issues · 1.2s → Issue[4]" },
        { time: "00:03", tag: "agent", text: "classify #812 · claude/sonnet · started" },
        {
          time: "00:38",
          tag: "agent",
          text: 'classify #812 done · { label: "feature-request" } · 2,988 tok',
        },
        {
          time: "00:44",
          tag: "agent",
          text: 'classify #814 done · { label: "bug", severity: "P2" } · 3,412 tok',
        },
        { time: "00:51", tag: "tool", text: '#815 grep "scheduler loop" · 6 matches in 3 files' },
        { time: "00:58", tag: "agent", text: "#815 streaming · severity judgement in progress" },
        { time: "01:02", tag: "pool", text: "slot freed · #816 dequeued" },
      ],
      gate: null,
      steps: {
        "cl-815": {
          title: "classify #815 · step 5",
          pill: "running · 21s",
          pillKind: "run",
          action: "Skip step",
          cells: [
            { k: "kind", v: "agent" },
            { k: "provider", v: "codex/gpt-5" },
            { k: "started", v: "00:44" },
            { k: "elapsed", v: "21s of ~50s" },
            { k: "tokens", v: "4,120" },
            { k: "cost", v: "$0.03" },
          ],
          input: [
            {
              k: "issue",
              kind: "record",
              ref: "#815",
              title: "Crash in scheduler loop",
              sub: "open · 2 h ago · dima",
              pills: ["needs-triage", "reported by 3 users"],
            },
            {
              k: "stack trace",
              kind: "file",
              ref: "",
              title: "stacktrace-815.txt",
              sub: "8.1 KB · 214 frames",
              pills: [],
            },
            {
              k: "call sites",
              kind: "pills",
              ref: "",
              title: "",
              sub: "",
              pills: ["src/scheduler.ts:118", "src/scheduler.ts:204", "src/pool.ts:44", "+3 more"],
            },
            { k: "model", kind: "text", ref: "", title: "gpt-5-codex", sub: "", pills: [] },
          ],
          outTitle: "step output · streaming",
          outNote: "parsed against Classification",
          out: [
            "The stack terminates in scheduler.tick(), the same frame as #802.",
            "Six call sites reach that loop; two skip the mutex added in 0.8.2, so",
            'the regression window is 0.8.2 → HEAD. Severity: P1, related: ["#802"]',
          ],
          streaming: true,
          toolsTitle: "Tool calls · 3",
          tools: [
            { cmd: "read-file src/scheduler.ts", meta: "8,420 B · 0.2s", running: false },
            { cmd: 'grep "scheduler loop" src/**', meta: "6 matches · 0.4s", running: false },
            { cmd: 'git log -S "mutex" --since v0.8.2', meta: "running · 3s", running: true },
          ],
          next: {
            k: "next",
            v: "gate: apply labels — it will ask you before writing 4 labels (policy: write → ask)",
            goToGate: false,
          },
        },
        "fetch-1": {
          title: "fetch-issues · step 1",
          pill: "done · 1.2s",
          pillKind: "done",
          action: "Re-run step",
          cells: [
            { k: "kind", v: "task · deno" },
            { k: "duration", v: "1.2s" },
            { k: "net", v: "api.github.com" },
            { k: "result", v: "Issue[4]" },
            { k: "artifact", v: "issues.json" },
          ],
          input: [
            { k: "repo", kind: "text", ref: "", title: "acme/treel", sub: "", pills: [] },
            { k: "window", kind: "text", ref: "", title: "24h", sub: "", pills: [] },
            { k: "state", kind: "pills", ref: "", title: "", sub: "", pills: ["open", "not draft"] },
          ],
          outTitle: "step output",
          outNote: "parsed · Issue[4]",
          out: [
            "#812 Export ignores locale · #814 Sort order flips on refresh",
            "#815 Crash in scheduler loop · #816 Typo in CLI docs",
          ],
          streaming: false,
          tools: [],
          toolsTitle: "",
          next: null,
        },
      },
    },

    "r-046": {
      id: "r-046",
      wf: "Release notes",
      file: "release-notes.ts",
      state: d46 ? "stopped" : a46 ? "running" : "waiting",
      chrome: `3 steps · ${d46 ? "stopped at 25:40" : "25:10"} · $0.71 / $4.00`,
      pill: d46 ? "stopped by you" : a46 ? "publishing" : "waiting on you · 25 min",
      gateStep: "gate-3",
      railTitle: "Run tree · appended as steps start",
      rail: [
        {
          name: "collect",
          meta: "task · 2.1s",
          steps: [
            {
              id: "col-1",
              kind: "task",
              label: "collect-commits",
              meta: "37 commits",
              state: "done",
              artifact: "commits.json",
            },
          ],
        },
        {
          name: "draft",
          meta: "agent",
          steps: [
            {
              id: "draft-1",
              kind: "agent",
              label: "draft release notes",
              meta: "9.7k tok",
              state: "done",
              artifact: "notes.md",
            },
          ],
        },
        {
          name: "review",
          meta: "gated network",
          steps: [
            {
              id: "gate-3",
              kind: "human",
              label: "gate: approve publish",
              meta: d46 ? "denied · you" : a46 ? "approved · you" : "waiting on you",
              state: d46 ? "idle" : a46 ? "done" : "waiting",
              artifact: "",
            },
          ],
        },
        {
          name: "publish",
          meta: "task",
          steps: [
            {
              id: "pub-1",
              kind: "task",
              label: "publish-release",
              meta: d46 ? "not run" : a46 ? "running · 2s" : "not started",
              state: d46 ? "wait" : a46 ? "run" : "wait",
              artifact: "",
            },
          ],
        },
      ],
      active: a46 ? [{ label: "publish", name: "publish-release", meta: "2s", stepId: "pub-1" }] : [],
      findings: [],
      artifacts: [
        {
          name: "commits.json",
          type: "json",
          size: "11 KB",
          step: "collect-commits",
          ago: "25 min",
          view: {
            kind: "code",
            lines: [
              '{ "since": "v0.8.4", "head": "9f2c1ab", "count": 37,',
              '  "groups": { "features": 9, "fixes": 14, "docs": 6, "deps": 8 } }',
            ],
          },
        },
        {
          name: "notes.md",
          type: "md",
          size: "4.2 KB",
          step: "draft release notes",
          ago: "25 min",
          view: {
            kind: "md",
            title: "v0.9.0 — release notes",
            paras: [
              "37 commits since v0.8.4, grouped into six sections. Nothing is published until the review gate is answered.",
            ],
            rows: [
              { k: "features", t: "Run tree, commit gates, per-workflow inputs", v: "9" },
              { k: "fixes", t: "Scheduler mutex, retry guard, digest timezone", v: "14" },
              { k: "docs", t: "Gate policy page rewritten", v: "6" },
              { k: "deps", t: "undici 6.21.2, esbuild 0.24", v: "8" },
            ],
          },
        },
      ],
      files: [],
      committed: false,
      changesNote: "",
      branchNote: "",
      journal: [
        {
          time: "00:00",
          tag: "run",
          text: 'run.started · release-notes · inputs { tag: "v0.9.0", since: "v0.8.4" }',
        },
        { time: "00:02", tag: "task", text: "collect-commits ok · 37 commits · 2.1s → Commit[37]" },
        { time: "02:48", tag: "agent", text: "draft release notes done · 6 sections · 9,712 tok" },
        {
          time: "02:50",
          tag: "human",
          text: "human.requested gate-3 · risk network · blocks publish-release",
        },
        ...(d46
          ? [{ time: "25:40", tag: "human", text: "human.answered gate-3 · hold · run.stopped by you" }]
          : a46
            ? [
                {
                  time: "25:40",
                  tag: "human",
                  text: `human.answered gate-3 · ${answer("gate-3", "scope")} · answered_by: you`,
                },
                { time: "25:41", tag: "task", text: "publish-release started · github.com/acme/treel" },
              ]
            : []),
      ],
      gate: {
        id: "gate-3",
        risk: "network",
        blocks: "blocks step 4 · publish-release",
        title: "Approve the v0.9.0 release",
        detail:
          "The draft covers 37 commits in six sections. Publishing creates a public GitHub release — weft cannot undo it.",
        submitLabel: "Approve & publish",
        denyLabel: "Hold & stop",
        questions: [
          {
            key: "scope",
            label: "publish",
            kind: "cards",
            required: true,
            options: [
              {
                label: "publish now",
                meta: "agent pick",
                desc: "Create the public release from the draft as written.",
              },
              {
                label: "draft only",
                meta: "",
                desc: "Create it as a GitHub draft for someone to publish by hand.",
              },
            ],
          },
          {
            key: "announce",
            label: "announce in",
            kind: "select",
            required: false,
            options: [
              { label: "#releases", meta: "", desc: "" },
              { label: "#eng", meta: "", desc: "" },
              { label: "no announcement", meta: "", desc: "" },
            ],
          },
          { key: "note", label: "note", kind: "note", required: false, options: [] },
        ],
      },
      steps: {
        "draft-1": {
          title: "draft release notes · step 2",
          pill: "done · 2m 46s",
          pillKind: "done",
          action: "Re-run step",
          cells: [
            { k: "kind", v: "agent" },
            { k: "provider", v: "claude/sonnet" },
            { k: "duration", v: "2m 46s" },
            { k: "tokens", v: "9,712" },
            { k: "cost", v: "$0.71" },
            { k: "artifact", v: "notes.md" },
          ],
          input: [
            {
              k: "commits",
              kind: "record",
              ref: "Commit[37]",
              title: "since v0.8.4",
              sub: "from step 1",
              pills: [],
            },
            { k: "template", kind: "file", ref: "", title: "release-notes.md.tpl", sub: "1.1 KB", pills: [] },
            {
              k: "sections",
              kind: "pills",
              ref: "",
              title: "",
              sub: "",
              pills: ["features", "fixes", "docs", "deps"],
            },
          ],
          outTitle: "step output",
          outNote: "parsed against ReleaseNotes",
          out: [
            "Six sections written; deps grouped by advisory rather than by package.",
            "Two commits had no linked issue and were listed under fixes verbatim.",
          ],
          streaming: false,
          tools: [],
          toolsTitle: "",
          next: {
            k: "next",
            v: "gate: approve publish — risk network, so it asks even though the draft is ready",
            goToGate: false,
          },
        },
        "gate-3": {
          title: "gate: approve publish · step 3",
          pill: d46 ? "denied · you" : a46 ? "approved · you" : "waiting on you",
          pillKind: d46 ? "fail" : a46 ? "done" : "human",
          action: "Copy gate id",
          cells: [
            { k: "kind", v: "human" },
            { k: "risk", v: "network", color: "#a9583e" },
            { k: "asked", v: "02:50" },
            { k: "policy", v: "network → ask" },
            { k: "blocks", v: "step 4 · publish-release" },
          ],
          input: [
            {
              k: "draft",
              kind: "record",
              ref: "notes.md",
              title: "v0.9.0 — release notes",
              sub: "4.2 KB · 6 sections",
              pills: [],
            },
            {
              k: "target",
              kind: "text",
              ref: "",
              title: "github.com/acme/treel/releases",
              sub: "",
              pills: [],
            },
          ],
          outTitle: "answer",
          outNote: "journaled verbatim",
          out: [
            d46
              ? '{ answer: "hold", answered_by: "you" } — run stopped'
              : a46
                ? `{ answer: "${answer("gate-3", "scope")}", answered_by: "you", at: "25:40" }`
                : "pending — no release is created until this gate is answered",
          ],
          streaming: false,
          tools: [],
          toolsTitle: "",
          next: {
            k: d46 ? "stopped" : a46 ? "resumed" : "needs you",
            v: d46
              ? "run.stopped — notes.md is kept as an artifact."
              : a46
                ? "next → step 4 · publish-release"
                : "The run is stopped at this step until you answer.",
            goToGate: !a46 && !d46,
          },
        },
      },
    },

    "r-048": {
      id: "r-048",
      wf: "Docs hero refresh",
      file: "docs-hero.ts",
      state: d48 ? "stopped" : a48 ? "running" : "waiting",
      chrome: `4 steps · ${d48 ? "stopped at 02:40" : "02:12"} · $0.29 / $4.00`,
      pill: d48 ? "stopped by you" : a48 ? "applying pick" : "waiting on you · 2 min",
      gateStep: "gate-4",
      railTitle: "Run tree · appended as steps start",
      rail: [
        {
          name: "read",
          meta: "task · 0.8s",
          steps: [
            {
              id: "read-1",
              kind: "task",
              label: "read-current-hero",
              meta: "0.8s",
              state: "done",
              artifact: "",
            },
          ],
        },
        {
          name: "design",
          meta: "agent ×2 ∥",
          steps: [
            {
              id: "des-a",
              kind: "agent",
              label: "draft variant A",
              meta: "2.1k tok",
              state: "done",
              artifact: "hero-a.html",
            },
            {
              id: "des-b",
              kind: "agent",
              label: "draft variant B",
              meta: "2.4k tok",
              state: "done",
              artifact: "hero-b.html",
            },
          ],
        },
        {
          name: "pick",
          meta: "human",
          steps: [
            {
              id: "gate-4",
              kind: "human",
              label: "gate: pick a hero",
              meta: d48 ? "denied · you" : a48 ? "answered · you" : "waiting on you",
              state: d48 ? "idle" : a48 ? "done" : "waiting",
              artifact: "",
            },
          ],
        },
        {
          name: "apply",
          meta: "gated write",
          steps: [
            {
              id: "apply-4",
              kind: "task",
              label: "apply + screenshot",
              meta: d48 ? "not run" : a48 ? "running · 3s" : "not started",
              state: d48 ? "wait" : a48 ? "run" : "wait",
              artifact: "",
            },
          ],
        },
      ],
      active: a48 ? [{ label: "apply", name: "apply + screenshot", meta: "3s", stepId: "apply-4" }] : [],
      findings: [],
      artifacts: [
        {
          name: "hero-a.html",
          type: "html",
          size: "6.4 KB",
          step: "draft variant A",
          ago: "2 min",
          view: {
            kind: "code",
            lines: [
              '<section class="hero hero--a">',
              "  <h1>Ship workflows, not scripts</h1>",
              "  <p>weft runs your code and asks you when it matters.</p>",
              '  <a class="btn btn-primary" href="/start">Start a run</a>',
              "</section>",
            ],
          },
        },
        {
          name: "hero-b.html",
          type: "html",
          size: "7.1 KB",
          step: "draft variant B",
          ago: "2 min",
          view: {
            kind: "code",
            lines: [
              '<section class="hero hero--b">',
              "  <h1>Your workflows, with a human in the loop</h1>",
              "  <p>Gates, journals and artifacts — one file per workflow.</p>",
              '  <a class="btn btn-primary" href="/start">Read the guide</a>',
              "</section>",
            ],
          },
        },
      ],
      files: [
        { path: "docs/index.html", adds: 62, dels: 24 },
        { path: "docs/hero.css", adds: 24, dels: 14 },
      ],
      committed: false,
      changesNote: d48
        ? "Denied — both variants were left staged and nothing was applied."
        : "Both variants are staged. The one you pick is applied; the other is dropped.",
      branchNote: "branch weft/r-048 · not pushed",
      journal: [
        {
          time: "00:00",
          tag: "run",
          text: 'run.started · docs-hero · inputs { page: "docs/index.html", variants: 2 }',
        },
        { time: "00:01", tag: "task", text: "read-current-hero ok · 0.8s · 3.4 KB" },
        { time: "01:44", tag: "agent", text: "draft variant A done · 2,108 tok · hero-a.html" },
        { time: "01:58", tag: "agent", text: "draft variant B done · 2,402 tok · hero-b.html" },
        {
          time: "02:00",
          tag: "human",
          text: "human.requested gate-4 · risk write · blocks apply + screenshot",
        },
        ...(d48
          ? [
              {
                time: "02:40",
                tag: "human",
                text: "human.answered gate-4 · keep current · run.stopped by you",
              },
            ]
          : a48
            ? [
                {
                  time: "02:40",
                  tag: "human",
                  text: `human.answered gate-4 · ${answer("gate-4", "variant")} · answered_by: you`,
                },
              ]
            : []),
      ],
      gate: {
        id: "gate-4",
        risk: "write",
        blocks: "blocks step 4 · apply + screenshot",
        title: "Pick a hero design",
        detail:
          "Two agents drafted variants in parallel from the same brief. Both are staged; the one you pick is applied to docs/index.html and screenshotted.",
        submitLabel: "Apply pick & resume",
        denyLabel: "Keep current & stop",
        questions: [
          {
            key: "variant",
            label: "apply",
            kind: "cards",
            required: true,
            options: [
              {
                label: "variant A",
                meta: "agent pick",
                desc: "Tighter headline, single call to action. +62 −24 in index.html.",
              },
              { label: "variant B", meta: "", desc: "Longer subhead, links to the guide instead. +71 −24." },
            ],
          },
          { key: "shot", label: "screenshot", kind: "toggle", required: false, options: [] },
          { key: "note", label: "note", kind: "note", required: false, options: [] },
        ],
      },
      steps: {
        "des-a": {
          title: "draft variant A · step 2",
          pill: "done · 1m 43s",
          pillKind: "done",
          action: "Re-run step",
          cells: [
            { k: "kind", v: "agent" },
            { k: "provider", v: "claude/sonnet" },
            { k: "duration", v: "1m 43s" },
            { k: "tokens", v: "2,108" },
            { k: "cost", v: "$0.14" },
            { k: "artifact", v: "hero-a.html" },
          ],
          input: [
            {
              k: "page",
              kind: "file",
              ref: "",
              title: "docs/index.html",
              sub: "3.4 KB · current hero",
              pills: [],
            },
            {
              k: "brief",
              kind: "text",
              ref: "",
              title: "Shorter headline, one call to action",
              sub: "",
              pills: [],
            },
            {
              k: "tokens",
              kind: "pills",
              ref: "",
              title: "",
              sub: "",
              pills: ["brand voice", "no new colors"],
            },
          ],
          outTitle: "step output",
          outNote: "parsed against HeroDraft",
          out: [
            "Headline cut to five words; the secondary link was dropped so the",
            "primary action stands alone. Type scale and colors unchanged.",
          ],
          streaming: false,
          toolsTitle: "Tool calls · 2",
          tools: [
            { cmd: "read-file docs/index.html", meta: "3.4 KB · 0.2s", running: false },
            { cmd: "write-file .weft/runs/r-048/hero-a.html", meta: "6.4 KB · 0.3s", running: false },
          ],
          next: {
            k: "next",
            v: "gate: pick a hero — two variants are staged and both are shown to you",
            goToGate: false,
          },
        },
        "gate-4": {
          title: "gate: pick a hero · step 3",
          pill: d48 ? "denied · you" : a48 ? "answered · you" : "waiting on you",
          pillKind: d48 ? "fail" : a48 ? "done" : "human",
          action: "Copy gate id",
          cells: [
            { k: "kind", v: "human" },
            { k: "risk", v: "write", color: "#a9583e" },
            { k: "asked", v: "02:00" },
            { k: "policy", v: "write → ask" },
            { k: "blocks", v: "step 4 · apply" },
          ],
          input: [
            {
              k: "variants",
              kind: "record",
              ref: "2 staged",
              title: "hero-a.html · hero-b.html",
              sub: "from steps 2 and 3",
              pills: [],
            },
            { k: "page", kind: "file", ref: "", title: "docs/index.html", sub: "3.4 KB", pills: [] },
          ],
          outTitle: "answer",
          outNote: "journaled verbatim",
          out: [
            d48
              ? '{ answer: "keep current", answered_by: "you" } — run stopped'
              : a48
                ? `{ answer: "${answer("gate-4", "variant")}", answered_by: "you", at: "02:40" }`
                : "pending — nothing is applied until this gate is answered",
          ],
          streaming: false,
          tools: [],
          toolsTitle: "",
          next: {
            k: d48 ? "stopped" : a48 ? "resumed" : "needs you",
            v: d48
              ? "run.stopped — both variants stay as artifacts."
              : a48
                ? "next → step 4 · apply + screenshot"
                : "The run is stopped at this step until you answer.",
            goToGate: !a48 && !d48,
          },
        },
      },
    },

    "r-044": {
      id: "r-044",
      wf: "Release notes",
      file: "release-notes.ts",
      state: "done",
      chrome: "4 steps · 3m 04s · $0.68 / $4.00",
      pill: "done · yesterday 18:22",
      gateStep: null,
      railTitle: "Run tree · 4 steps recorded",
      rail: [
        {
          name: "collect",
          meta: "task · 1.9s",
          steps: [
            {
              id: "col-0",
              kind: "task",
              label: "collect-commits",
              meta: "22 commits",
              state: "done",
              artifact: "commits.json",
            },
          ],
        },
        {
          name: "draft",
          meta: "agent",
          steps: [
            {
              id: "draft-0",
              kind: "agent",
              label: "draft release notes",
              meta: "8.9k tok",
              state: "done",
              artifact: "notes.md",
            },
          ],
        },
        {
          name: "review",
          meta: "answered 18:19",
          steps: [
            {
              id: "gate-0",
              kind: "human",
              label: "gate: approve publish",
              meta: "approved · you",
              state: "done",
              artifact: "",
            },
          ],
        },
        {
          name: "publish",
          meta: "task",
          steps: [
            {
              id: "pub-0",
              kind: "task",
              label: "publish-release",
              meta: "v0.8.4 released",
              state: "done",
              artifact: "release.json",
            },
          ],
        },
      ],
      active: [],
      findings: [],
      artifacts: [
        {
          name: "notes.md",
          type: "md",
          size: "3.6 KB",
          step: "draft release notes",
          ago: "yesterday",
          view: {
            kind: "md",
            title: "v0.8.4 — release notes",
            paras: [
              "22 commits since v0.8.3. Published to GitHub at 18:22 after the review gate was approved.",
            ],
            rows: [
              { k: "fixes", t: "Scheduler mutex, pool starvation", v: "12" },
              { k: "docs", t: "Gate policy, first run", v: "4" },
              { k: "deps", t: "undici 6.11.1", v: "6" },
            ],
          },
        },
        {
          name: "release.json",
          type: "json",
          size: "2.2 KB",
          step: "publish-release",
          ago: "yesterday",
          view: {
            kind: "code",
            lines: [
              '{ "tag": "v0.8.4", "url": "github.com/acme/treel/releases/v0.8.4",',
              '  "draft": false, "published_at": "18:22", "assets": 0 }',
            ],
          },
        },
      ],
      files: [{ path: "CHANGELOG.md", adds: 37, dels: 0 }],
      committed: true,
      changesNote: "Committed and pushed. This run is closed.",
      branchNote: "merged into main · 9f2c1ab",
      journal: [
        { time: "00:00", tag: "run", text: 'run.started · release-notes · inputs { tag: "v0.8.4" }' },
        { time: "00:02", tag: "task", text: "collect-commits ok · 22 commits · 1.9s" },
        { time: "02:41", tag: "agent", text: "draft release notes done · 5 sections · 8,912 tok" },
        { time: "02:43", tag: "human", text: "human.requested gate-0 · risk network" },
        { time: "02:58", tag: "human", text: "human.answered gate-0 · publish now · answered_by: you" },
        { time: "03:04", tag: "task", text: "publish-release ok · v0.8.4 · run.finished" },
      ],
      gate: null,
      steps: {
        "pub-0": {
          title: "publish-release · step 4",
          pill: "done · 6.1s",
          pillKind: "done",
          action: "Re-run step",
          cells: [
            { k: "kind", v: "task · deno" },
            { k: "duration", v: "6.1s" },
            { k: "net", v: "api.github.com" },
            { k: "result", v: "Release" },
            { k: "artifact", v: "release.json" },
          ],
          input: [
            {
              k: "notes",
              kind: "record",
              ref: "notes.md",
              title: "v0.8.4 — release notes",
              sub: "3.6 KB · approved at 02:58",
              pills: [],
            },
            { k: "tag", kind: "text", ref: "", title: "v0.8.4", sub: "", pills: [] },
            { k: "flags", kind: "pills", ref: "", title: "", sub: "", pills: ["draft=false", "latest=true"] },
          ],
          outTitle: "step output",
          outNote: "parsed · Release",
          out: [
            "Created github.com/acme/treel/releases/v0.8.4 · 22 commits · 0 assets.",
            "run.finished · 4 steps · 3m 04s · $0.68",
          ],
          streaming: false,
          tools: [],
          toolsTitle: "",
          next: null,
        },
        "gate-0": {
          title: "gate: approve publish · step 3",
          pill: "approved · you",
          pillKind: "done",
          action: "Copy gate id",
          cells: [
            { k: "kind", v: "human" },
            { k: "risk", v: "network", color: "#a9583e" },
            { k: "asked", v: "02:43" },
            { k: "answered", v: "02:58" },
            { k: "policy", v: "network → ask" },
          ],
          input: [
            {
              k: "draft",
              kind: "record",
              ref: "notes.md",
              title: "v0.8.4 — release notes",
              sub: "3.6 KB · 5 sections",
              pills: [],
            },
            {
              k: "target",
              kind: "text",
              ref: "",
              title: "github.com/acme/treel/releases",
              sub: "",
              pills: [],
            },
          ],
          outTitle: "answer",
          outNote: "journaled verbatim",
          out: ['{ answer: "publish now", answered_by: "you", at: "02:58" }'],
          streaming: false,
          tools: [],
          toolsTitle: "",
          next: { k: "resumed", v: "next → step 4 · publish-release, started at 02:58", goToGate: false },
        },
      },
    },
  };
}
