import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import type { OperationBindings } from "@techery/weft-core";
import { mock, runWorkflow } from "@techery/weft-testing";
import workflow from "../main.ts";

const exec = promisify(execFile);
async function repository() {
  const path = await mkdtemp(join(tmpdir(), "weft-reviewed-pr-example-"));
  for (const args of [
    ["init", "-b", "main"],
    ["config", "user.name", "Weft Test"],
    ["config", "user.email", "test@example.invalid"],
  ])
    await exec("git", args, { cwd: path });
  await writeFile(join(path, "answer.txt"), "wrong\n");
  await writeFile(join(path, ".gitignore"), ".weft/\n");
  await exec("git", ["add", "-A"], { cwd: path });
  await exec("git", ["commit", "-m", "initial"], { cwd: path });
  return path;
}
const config = { approvalPolicy: { tiers: { low: "auto", medium: "auto", high: "auto" } } } as const;
const input = {
  objective: "Correct the answer",
  branch: "weft/correct-answer",
  files: ["answer.txt"],
  requireApproval: true,
  checkCommand: [
    "node",
    "-e",
    "process.exit(require('node:fs').readFileSync('answer.txt','utf8')==='42\\n'?0:1)",
  ],
};
function operations(onPublish: () => void): OperationBindings {
  return {
    "github.reviewed-pr": {
      delivery: true,
      requiredChecks: ["tests", "independent-review"],
      risk: "high",
      execute: async (_, context) => {
        onPublish();
        return {
          url: "https://github.com/example/repo/pull/1",
          number: 1,
          head: context.candidate!.head,
          branch: context.candidate!.branch,
          repository: "example/repo",
          base: "main",
          requestId: context.requestId,
          draft: true,
        };
      },
      reconcile: async () => ({ status: "unknown", detail: "test binding has no remote state" }),
    },
    "github.pr-feedback": {
      risk: "low",
      execute: async (value) => ({ status: "passed", head: (value as { head: string }).head }),
      reconcile: async () => ({ status: "not_applied" }),
    },
  };
}

test("real retained worktree: failed tests, one repair, independent review, approval, mocked PR and feedback", async () => {
  const cwd = await repository();
  let published = 0;
  const provider = mock()
    .on({ key: "write:0" }, { summary: "first attempt" }, { writes: { "answer.txt": "41\n" } })
    .on({ key: "write:1" }, { summary: "repair" }, { writes: { "answer.txt": "42\n" } })
    .on({ key: "review:*" }, { approved: true, evidence: "Read actual code and checked the answer." });
  try {
    const result = await runWorkflow(workflow, {
      cwd,
      input: { ...input, pollFeedback: true },
      fixtureMode: "integration",
      config,
      provider,
      operations: operations(() => published++),
      answers: { "Publish this verified candidate as a pull request?": { approved: true } },
    });
    assert.equal(published, 1);
    assert.equal(result.output.feedback, "passed");
    assert.equal(result.output.pullRequest.draft, true);
    assert.equal(await readFile(join(cwd, "answer.txt"), "utf8"), "wrong\n");
    assert.equal(await readFile(join(result.state.workspace!.path, "answer.txt"), "utf8"), "42\n");
    assert.equal(provider.calls.filter((call) => call.key?.startsWith("write:")).length, 2);
    assert.equal(provider.calls.filter((call) => call.key?.startsWith("review:")).length, 1);
    assert.equal(result.state.verifications?.filter((check) => !check.passed).length, 1);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("independent reviewer rejection exhausts the bound without publishing", async () => {
  const cwd = await repository();
  let published = 0;
  const provider = mock()
    .on({ key: "write:0" }, { summary: "implementation" }, { writes: { "answer.txt": "42\n" } })
    .on({ key: "review:*" }, { approved: false, evidence: "Missing required regression coverage." });
  try {
    await assert.rejects(
      runWorkflow(workflow, {
        cwd,
        input: { ...input, maxRepairs: 0 },
        fixtureMode: "integration",
        config,
        provider,
        operations: operations(() => published++),
      }),
      /did not pass checks and independent review/,
    );
    assert.equal(published, 0);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("missing reviewer fixture and a no-op writer never publish", async () => {
  for (const writes of [true, false]) {
    const cwd = await repository();
    let published = 0;
    const provider = mock().on(
      { key: "write:0" },
      { summary: "claims done" },
      writes ? { writes: { "answer.txt": "42\n" } } : {},
    );
    try {
      await assert.rejects(
        runWorkflow(workflow, {
          cwd,
          input,
          fixtureMode: "integration",
          config,
          provider,
          operations: operations(() => published++),
        }),
      );
      assert.equal(published, 0);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  }
});
