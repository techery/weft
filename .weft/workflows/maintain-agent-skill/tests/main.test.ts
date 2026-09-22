import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { type TestContext } from "node:test";
import { promisify } from "node:util";
import { mock, runWorkflow } from "@techery/weft-testing";
import workflow from "../main.ts";

const exec = promisify(execFile);
const skill = "packages/cli/src/commands/skill.ts";
const authored = {
  disposition: "unchanged",
  summary: "Canonical output checked",
  sourcePaths: [skill],
  files: [],
};
const audited = {
  pass: true,
  summary: "Verified",
  checkedSources: [skill],
  audiences: { codex: true, claudeCode: true, otherAgents: true },
  findings: [],
};

async function repository(t: TestContext) {
  const cwd = await mkdtemp(join(tmpdir(), "weft-skill-behavior-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  await mkdir(dirname(join(cwd, skill)), { recursive: true });
  await writeFile(join(cwd, skill), "export const skill = 'current';\n");
  await exec("git", ["init", "-q", "."], { cwd });
  await exec("git", ["config", "user.name", "Weft test"], { cwd });
  await exec("git", ["config", "user.email", "test@weft.invalid"], { cwd });
  await exec("git", ["add", "."], { cwd });
  await exec("git", ["commit", "-qm", "initial"], { cwd });
  return cwd;
}

const commands = {
  "node .weft/scripts/validate-weft-skill.mjs": { stdout: "valid", stderr: "", exitCode: 0 },
  "pnpm vitest run packages/cli/test/cli.test.ts -t weft skill": { stdout: "pass", stderr: "", exitCode: 0 },
};

test("a failed diagnostic audit can be repaired before final required verification", async (t) => {
  const provider = mock()
    .on({ key: "skill:author" }, authored)
    .on({ key: "skill:verify:0:*" }, { ...audited, pass: false })
    .on({ key: "skill:repair:1" }, authored)
    .on({ key: "skill:verify:1:*" }, audited);
  const result = await runWorkflow(workflow, {
    cwd: await repository(t),
    fixtureMode: "integration",
    input: { maxRepairRounds: 1 },
    provider,
    git: { changedSince: { files: [] } },
    exec: commands,
  });
  assert.equal(result.output.repairRounds, 1);
  assert.equal(result.output.disposition, "unchanged");
  assert.equal(result.journal.step("skill:repair:1").status, "ok");
  assert.equal(result.journal.step("skill-output:1:final").status, "ok");
});

test("exhausted audit repair budget cannot report a verified skill", async (t) => {
  const provider = mock()
    .on({ key: "skill:author" }, authored)
    .on({ key: "skill:verify:*" }, { ...audited, pass: false });
  await assert.rejects(
    runWorkflow(workflow, {
      cwd: await repository(t),
      fixtureMode: "integration",
      input: { maxRepairRounds: 0 },
      provider,
      git: { changedSince: { files: [] } },
      exec: commands,
    }),
    /skill remains unverified after 0 repair/,
  );
});

test("one unavailable audit provider fails completeness", async (t) => {
  const provider = mock().on({ key: "skill:author" }, authored).on({ key: "skill:verify:0:codex" }, audited);
  await assert.rejects(
    runWorkflow(workflow, {
      cwd: await repository(t),
      fixtureMode: "integration",
      input: { verifyWith: ["codex", "claude"] },
      provider,
      git: { changedSince: { files: [] } },
      exec: commands,
    }),
    /verification provider failure/,
  );
});
