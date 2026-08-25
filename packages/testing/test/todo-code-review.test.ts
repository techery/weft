import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, describe, expect, test } from "vitest";
import workflow from "../../../examples/08-task-backed-code-review/workflow.ts";
import { mock, runWorkflow } from "../src/index.ts";

const exec = promisify(execFile);
const roots: string[] = [];

afterAll(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

async function repo(): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), "weft-review-tasks-"));
  roots.push(cwd);
  await mkdir(join(cwd, "src"), { recursive: true });
  await writeFile(join(cwd, "src", "state.ts"), "export const value = JSON.parse(localStorage.value);\n");
  await exec("git", ["init", "-q", "."], { cwd });
  await exec("git", ["config", "user.name", "test"], { cwd });
  await exec("git", ["config", "user.email", "test@weft.invalid"], { cwd });
  await exec("git", ["add", "-A"], { cwd });
  await exec("git", ["commit", "-qm", "init"], { cwd });
  return cwd;
}

const fingerprint = "src/state.ts|value|invalid-persisted-shape";
const workflowId = "example.task-backed-code-review";

function provider(real = true, fail?: "review" | "refute") {
  const builder = mock();
  if (fail === "review") {
    builder.on({ key: "review:*" }, () => {
      throw new Error("review provider unavailable");
    });
  }
  if (fail === "refute") {
    builder.on({ key: "refute:*" }, () => {
      throw new Error("refutation provider unavailable");
    });
  }
  return builder
    .on({ key: "review:*" }, () => ({
      findings: [
        {
          file: "src/state.ts",
          line: 1,
          severity: "major",
          category: "correctness",
          symbol: "value",
          claim: "Invalid persisted JSON shapes are trusted.",
          evidence: "JSON.parse(localStorage.value)",
        },
        {
          file: "src/state.ts",
          line: 1,
          severity: "major",
          category: "correctness",
          symbol: "value",
          claim: "A malformed stored value can crash consumers.",
          evidence: "The parsed value has no runtime validation.",
        },
      ],
    }))
    .on({ key: "consolidate" }, () => ({
      findings: [
        {
          file: "src/state.ts",
          line: 1,
          severity: "major",
          category: "correctness",
          symbol: "value",
          claim: "Invalid persisted JSON shapes are trusted.",
          evidence: "JSON.parse(localStorage.value) has no runtime shape validation.",
          fingerprint,
          sourceClaims: 2,
        },
      ],
    }))
    .on({ key: `refute:${fingerprint}` }, () => ({
      real,
      reason: real ? "An object reaches array consumers." : "The input is validated before this module.",
    }));
}

describe("task-backed code review backlog", () => {
  test("consolidates duplicates and upserts one human-approved task across runs", async () => {
    const cwd = await repo();
    const run = (reviewer = provider()) =>
      runWorkflow(workflow, {
        cwd,
        input: { maxFiles: 1, reviewWith: "codex", refuteWith: "claude" },
        provider: reviewer,
        answers: () => ({ record: [fingerprint], comment: "Track this regression." }),
      });

    const first = await run();
    expect(first.output).toMatchObject({ recorded: 1, refuted: 0 });
    expect(first.output.confirmed).toHaveLength(1);

    const recurringReviewer = provider();
    await run(recurringReviewer);
    const reviewPrompt = recurringReviewer.calls.find((call) => call.key?.startsWith("review:"))?.prompt;
    expect(reviewPrompt).toContain("read-only task authority");
    expect(reviewPrompt).toContain(fingerprint);
    expect(recurringReviewer.calls.find((call) => call.key === "consolidate")?.prompt).not.toContain(
      "Workflow task tracker",
    );
    expect(recurringReviewer.calls.find((call) => call.key?.startsWith("refute:"))?.prompt).not.toContain(
      "Workflow task tracker",
    );
    const taskDir = join(cwd, ".weft", "tasks", encodeURIComponent(workflowId));
    const taskFiles = (await readdir(taskDir)).filter((file) => /^task-[a-f0-9]{8}\.json$/.test(file));
    expect(taskFiles).toHaveLength(1);
    const task = JSON.parse(await readFile(join(taskDir, taskFiles[0]!), "utf8")) as {
      dedupeKey: string;
      revision: number;
      notes: Array<{ text: string }>;
      acceptanceCriteria: Array<{ met: boolean }>;
      extensions: { firstSeenRun: string; lastSeenRun: string };
    };
    expect(task.dedupeKey).toBe(fingerprint);
    expect(task.revision).toBe(2);
    expect(task.notes).toHaveLength(2);
    expect(task.acceptanceCriteria.every((criterion) => !criterion.met)).toBe(true);
    expect(task.extensions.firstSeenRun).not.toBe(task.extensions.lastSeenRun);
  });

  test("does not create tasks when the human records no fingerprints", async () => {
    const cwd = await repo();
    const result = await runWorkflow(workflow, {
      cwd,
      input: { maxFiles: 1, reviewWith: "codex", refuteWith: "claude" },
      provider: provider(),
      answers: () => ({ record: [] }),
    });
    expect(result.output.recorded).toBe(0);
    const taskDir = join(cwd, ".weft", "tasks", encodeURIComponent(workflowId));
    const taskFiles = (await readdir(taskDir)).filter((file) => /^task-[a-f0-9]{8}\.json$/.test(file));
    expect(taskFiles).toEqual([]);
  });

  test("does not open a human gate or create tasks when independent refutation rejects the claim", async () => {
    const cwd = await repo();
    const reviewer = provider(false);
    const result = await runWorkflow(workflow, {
      cwd,
      input: { maxFiles: 1, reviewWith: "codex", refuteWith: "claude" },
      provider: reviewer,
    });
    expect(result.output).toMatchObject({ confirmed: [], refuted: 1, recorded: 0 });
    expect(result.journal.steps({ kind: "human" })).toEqual([]);
    const taskDir = join(cwd, ".weft", "tasks", encodeURIComponent(workflowId));
    expect((await readdir(taskDir)).filter((file) => file.startsWith("task-"))).toEqual([]);
  });

  test.each([
    ["review", provider(true, "review")],
    ["refute", provider(true, "refute")],
  ] as const)("fails closed when a %s lane fails", async (_lane, reviewer) => {
    const cwd = await repo();
    await expect(
      runWorkflow(workflow, {
        cwd,
        input: { maxFiles: 1, reviewWith: "codex", refuteWith: "claude" },
        provider: reviewer,
      }),
    ).rejects.toThrow(/failed|provider unavailable/);
    const taskDir = join(cwd, ".weft", "tasks", encodeURIComponent(workflowId));
    expect((await readdir(taskDir)).filter((file) => file.startsWith("task-"))).toEqual([]);
  });

  test("requires different providers before reviewing source", async () => {
    const cwd = await repo();
    const reviewer = provider();
    await expect(
      runWorkflow(workflow, {
        cwd,
        input: { maxFiles: 1, reviewWith: "codex", refuteWith: "codex" },
        provider: reviewer,
      }),
    ).rejects.toThrow(/different providers/);
    expect(reviewer.calls).toEqual([]);
  });

  test("routes review and refutation through independent provider fixtures", async () => {
    const cwd = await repo();
    const codex = provider();
    const claude = provider();
    await runWorkflow(workflow, {
      cwd,
      input: { maxFiles: 1, reviewWith: "codex", refuteWith: "claude" },
      providers: { codex, claude },
      answers: () => ({ record: [] }),
    });
    expect(codex.calls.some((call) => call.key?.startsWith("review:"))).toBe(true);
    expect(codex.calls.some((call) => call.key === "consolidate")).toBe(true);
    expect(codex.calls.some((call) => call.key?.startsWith("refute:"))).toBe(false);
    expect(claude.calls.some((call) => call.key?.startsWith("refute:"))).toBe(true);
    expect(claude.calls.some((call) => call.key?.startsWith("review:"))).toBe(false);
  });
});
