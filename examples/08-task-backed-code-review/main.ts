/**
 * Offline execution of the production-style workflow with independent mock
 * providers, a real temporary git repository, a human decision fixture, and
 * the production task store wired by @techery/weft-testing.
 *
 *   npx tsx examples/08-task-backed-code-review/main.ts
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { mock, runWorkflow } from "@techery/weft-testing";
import workflow from "./task-backed-code-review/main.ts";

const exec = promisify(execFile);
const fingerprint = "src/state.ts|value|invalid-persisted-shape";
const cwd = await mkdtemp(join(tmpdir(), "weft-task-review-example-"));

try {
  await mkdir(join(cwd, "src"), { recursive: true });
  await writeFile(join(cwd, "src", "state.ts"), "export const value = JSON.parse(localStorage.value);\n");
  await exec("git", ["init", "-q", "."], { cwd });
  await exec("git", ["config", "user.name", "weft-example"], { cwd });
  await exec("git", ["config", "user.email", "example@weft.invalid"], { cwd });
  await exec("git", ["add", "-A"], { cwd });
  await exec("git", ["commit", "-qm", "fixture"], { cwd });

  const review = mock()
    .on(
      { key: "review:*" },
      {
        findings: [
          {
            file: "src/state.ts",
            line: 1,
            severity: "major",
            category: "correctness",
            symbol: "value",
            claim: "Invalid persisted JSON shapes are trusted.",
            evidence: "JSON.parse(localStorage.value) has no runtime shape validation.",
          },
        ],
      },
    )
    .on(
      { key: "consolidate" },
      {
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
            sourceClaims: 1,
          },
        ],
      },
    );
  const refute = mock().on(
    { key: `refute:${fingerprint}` },
    {
      real: true,
      reason: "An object reaches consumers that require an array.",
    },
  );

  const result = await runWorkflow(workflow, {
    cwd,
    input: { maxFiles: 1, reviewWith: "codex", refuteWith: "claude" },
    providers: { codex: review, claude: refute },
    answers: () => ({ record: [fingerprint], comment: "Keep this regression visible." }),
  });

  assert.equal(result.output.recorded, 1);
  assert.equal(result.output.confirmed.length, 1);
  assert.equal(
    review.calls.some((call) => call.key?.startsWith("review:")),
    true,
  );
  assert.equal(
    refute.calls.some((call) => call.key?.startsWith("refute:")),
    true,
  );

  const taskDir = join(cwd, ".weft", "tasks", encodeURIComponent("example.task-backed-code-review"));
  const taskFiles = (await readdir(taskDir)).filter((file) => /^task-[a-f0-9]{32}\.json$/.test(file));
  assert.equal(taskFiles.length, 1);
  const task = JSON.parse(await readFile(join(taskDir, taskFiles[0]!), "utf8")) as {
    dedupeKey: string;
    notes: Array<{ text: string }>;
  };
  assert.equal(task.dedupeKey, fingerprint);
  assert.equal(task.notes.length, 1);

  console.log("task-backed review assertions passed");
  console.log(`recorded: ${task.dedupeKey}`);
} finally {
  await rm(cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
}
