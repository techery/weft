import type { FileDiff, Labelled, RunState } from "../types";

/** The journal index — what the runs table shows before a run is opened. */
export type RunIndexRow = {
  id: string;
  wf: string;
  file: string;
  /** State as recorded when the page loaded; a live run may have moved on. */
  state: RunState;
  outcome: string;
  started: string;
  dur: string;
  cost: string;
};

export const RUN_INDEX: RunIndexRow[] = [
  {
    id: "r-049",
    wf: "Issue triage",
    file: "triage.ts",
    state: "running",
    outcome: "2 steps active",
    started: "today 09:41",
    dur: "01:04",
    cost: "$0.09",
  },
  {
    id: "r-048",
    wf: "Docs hero refresh",
    file: "docs-hero.ts",
    state: "waiting",
    outcome: "gate: pick a hero",
    started: "today 09:39",
    dur: "02:12",
    cost: "$0.29",
  },
  {
    id: "r-046",
    wf: "Release notes",
    file: "release-notes.ts",
    state: "waiting",
    outcome: "gate: approve publish",
    started: "today 09:16",
    dur: "25:10",
    cost: "$0.71",
  },
  {
    id: "r-045",
    wf: "Dependency audit",
    file: "deps-audit.ts",
    state: "waiting",
    outcome: "gate: commit the fix",
    started: "today 06:12",
    dur: "08:41",
    cost: "$2.40",
  },
  {
    id: "r-044",
    wf: "Release notes",
    file: "release-notes.ts",
    state: "done",
    outcome: "v0.8.4 released",
    started: "yesterday 18:19",
    dur: "03:04",
    cost: "$0.68",
  },
];

export const RUN_FILTERS = ["All", "Needs you", "Running", "Finished"] as const;
export type RunFilter = (typeof RUN_FILTERS)[number];

/** How a run state reads in the runs table's State column. */
export const RUN_STATE_LABEL: Record<RunState, string> = {
  waiting: "needs you",
  running: "running",
  done: "done",
  stopped: "stopped by you",
};

/** Queue-card copy that lives outside the run body: the ask, not the run. */
export type QueueCopy = {
  risk: string;
  wait?: string;
  /** Facts shown while the run is blocked on you. */
  facts?: Labelled[];
  /** Headline and body once the run is moving again. */
  runAsk: string;
  runDetail: string;
  runFacts: Labelled[];
};

export const QUEUE_COPY: Record<string, QueueCopy> = {
  "r-045": {
    risk: "write",
    wait: "40 min",
    facts: [
      { k: "blocks", v: "step 11 · push" },
      { k: "waiting", v: "40 min" },
      { k: "spent", v: "$2.40 / $6.00" },
    ],
    runAsk: "fix approved — 4 steps active",
    runDetail: "push branch started; verify and the report agent are still working.",
    runFacts: [
      { k: "active", v: "4 steps" },
      { k: "elapsed", v: "08:41" },
      { k: "spent", v: "$2.40 / $6.00" },
    ],
  },
  "r-046": {
    risk: "network",
    wait: "25 min",
    facts: [
      { k: "blocks", v: "step 4 · publish" },
      { k: "waiting", v: "25 min" },
      { k: "spent", v: "$0.71 / $4.00" },
    ],
    runAsk: "publishing v0.9.0",
    runDetail: "Approved — the release is being created on GitHub.",
    runFacts: [
      { k: "active", v: "1 step" },
      { k: "elapsed", v: "25:41" },
      { k: "spent", v: "$0.71 / $4.00" },
    ],
  },
  "r-048": {
    risk: "write",
    wait: "2 min",
    facts: [
      { k: "blocks", v: "step 4 · apply" },
      { k: "waiting", v: "2 min" },
      { k: "spent", v: "$0.29 / $4.00" },
    ],
    runAsk: "applying your pick",
    runDetail: "The chosen variant is being written and screenshotted.",
    runFacts: [
      { k: "active", v: "1 step" },
      { k: "elapsed", v: "02:40" },
      { k: "spent", v: "$0.29 / $4.00" },
    ],
  },
  "r-049": {
    risk: "",
    runAsk: "classify — 2 of 4 agents still working",
    runDetail: "Next stop is the apply gate; it will ask you before writing labels.",
    runFacts: [
      { k: "active", v: "2 of 4 agents" },
      { k: "elapsed", v: "01:04" },
      { k: "spent", v: "$0.09 / $8.00" },
    ],
  },
};

/** One unified hunk per changed file — what the Changes tab renders. */
export const FILE_DIFFS: Record<string, FileDiff> = {
  "src/net/fetchWithRetry.ts": {
    hunk: "@@ -12,4 +12,9 @@ fetchWithRetry()",
    lines: [
      { ln: "12", rn: "12", text: " export async function fetchWithRetry(req: Request) {", sign: "" },
      { ln: "13", rn: "13", text: "   const backoff = capped(retryPolicy);", sign: "" },
      { ln: "14", rn: "", text: "-  return await fetch(req);", sign: "-" },
      { ln: "", rn: "14", text: "+  return await retryGuard(backoff, async () => {", sign: "+" },
      { ln: "", rn: "15", text: "+    const res = await fetch(req);", sign: "+" },
      {
        ln: "",
        rn: "16",
        text: "+    if (!res.ok && retryable(res.status)) throw new Retry(res);",
        sign: "+",
      },
      { ln: "", rn: "17", text: "+    return res;", sign: "+" },
      { ln: "", rn: "18", text: "+  });", sign: "+" },
      { ln: "15", rn: "19", text: " }", sign: "" },
    ],
  },
  "package-lock.json": {
    hunk: "@@ -1204,7 +1204,7 @@ node_modules/undici",
    lines: [
      { ln: "1204", rn: "1204", text: '     "node_modules/undici": {', sign: "" },
      { ln: "1205", rn: "", text: '-      "version": "6.11.1",', sign: "-" },
      { ln: "1206", rn: "", text: '-      "integrity": "sha512-2Rk1Xw…",', sign: "-" },
      { ln: "", rn: "1205", text: '+      "version": "6.21.2",', sign: "+" },
      { ln: "", rn: "1206", text: '+      "integrity": "sha512-9fBc1Q…",', sign: "+" },
      { ln: "1207", rn: "1207", text: '       "license": "MIT"', sign: "" },
      { ln: "1208", rn: "1208", text: "     },", sign: "" },
    ],
  },
  "docs/security.md": {
    hunk: "@@ -18,6 +18,14 @@ Advisory handling",
    lines: [
      { ln: "18", rn: "18", text: " ## Advisory handling", sign: "" },
      { ln: "19", rn: "19", text: "", sign: "" },
      {
        ln: "",
        rn: "20",
        text: "+Advisories are triaged nightly by deps-audit.ts. Every fix is staged on a",
        sign: "+",
      },
      {
        ln: "",
        rn: "21",
        text: "+branch and held at a commit gate — nothing lands without a human answer.",
        sign: "+",
      },
      { ln: "", rn: "22", text: "+", sign: "+" },
      { ln: "", rn: "23", text: "+### Retry guard", sign: "+" },
      {
        ln: "",
        rn: "24",
        text: "+fetchWithRetry must keep its backoff cap; verify fails the run without it.",
        sign: "+",
      },
      { ln: "20", rn: "25", text: " See the runbook for the escalation path.", sign: "" },
    ],
  },
  "docs/index.html": {
    hunk: "@@ -8,10 +8,12 @@ hero",
    lines: [
      { ln: "8", rn: "8", text: " <main>", sign: "" },
      { ln: "9", rn: "", text: '-  <section class="hero">', sign: "-" },
      { ln: "10", rn: "", text: "-    <h1>weft — workflows that ask</h1>", sign: "-" },
      { ln: "", rn: "9", text: '+  <section class="hero hero--a">', sign: "+" },
      { ln: "", rn: "10", text: "+    <h1>Ship workflows, not scripts</h1>", sign: "+" },
      { ln: "", rn: "11", text: "+    <p>weft runs your code and asks you when it matters.</p>", sign: "+" },
      { ln: "11", rn: "12", text: "   </section>", sign: "" },
      { ln: "12", rn: "13", text: " </main>", sign: "" },
    ],
  },
  "docs/hero.css": {
    hunk: "@@ -1,6 +1,14 @@ .hero",
    lines: [
      { ln: "1", rn: "1", text: " .hero { padding: var(--space-6) 0; }", sign: "" },
      { ln: "", rn: "2", text: "+.hero--a { display: grid; gap: var(--space-3); }", sign: "+" },
      {
        ln: "",
        rn: "3",
        text: "+.hero--a h1 { font-family: var(--font-heading); max-width: 18ch; }",
        sign: "+",
      },
      { ln: "2", rn: "4", text: " .hero p { color: var(--color-neutral-700); }", sign: "" },
    ],
  },
  "CHANGELOG.md": {
    hunk: "@@ -1,4 +1,41 @@ Changelog",
    lines: [
      { ln: "1", rn: "1", text: " # Changelog", sign: "" },
      { ln: "", rn: "2", text: "+## v0.8.4", sign: "+" },
      { ln: "", rn: "3", text: "+- Scheduler holds the pool mutex across tick boundaries", sign: "+" },
      { ln: "", rn: "4", text: "+- Digest respects the workspace timezone", sign: "+" },
      { ln: "2", rn: "5", text: " ## v0.8.3", sign: "" },
    ],
  },
};

/** Approval tiers and the operations each one covers, for Settings. */
export const POLICY_TIERS: Labelled[] = [
  { k: "read", v: "fs.read · git.log · fetch(allow-list)" },
  { k: "write", v: "fs.write · labels · branch push" },
  { k: "network", v: "publish · deploy · external POST" },
  { k: "destructive", v: "delete · force-push · billing" },
];

export const PROVIDERS = [
  { id: "claude", model: "sonnet · opus (fallback)", status: "ready" },
  { id: "codex", model: "gpt-5-codex", status: "ready" },
];
