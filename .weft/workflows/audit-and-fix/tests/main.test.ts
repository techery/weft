import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { mock, runWorkflow } from "@techery/weft-testing";
import workflow from "../main.ts";

const a = { file: "a.ts", line: 1, claim: "Missing null guard", evidence: "a.value" };
const b = { ...a, claim: "Stale cache", evidence: "cache.value" };
const c = { ...a, file: "b.ts", claim: "Incorrect fallback" };
const exec = promisify(execFile);
const panel = () =>
  mock()
    .on({ key: "find:*" }, { findings: [a, b, c, a] })
    .on({ key: "refute:*" }, { real: true, reason: "Confirmed" });

test("declining approval returns every confirmed finding without starting writers", async () => {
  const provider = panel();
  const { output } = await runWorkflow(workflow, {
    input: { paths: ["src"] },
    fixtureMode: "strict",
    provider,
    answers: () => ({ approved: false, note: "Defer" }),
  });
  assert.deepEqual(output, { fixed: [], skipped: [a, b, c] });
  assert.equal(provider.calls.filter((call) => call.key?.startsWith("refute:")).length, 9);
  assert.equal(provider.calls.filter((call) => call.key?.startsWith("fix:")).length, 0);
});

for (const stage of ["find", "refute"]) {
  test(`fails closed when a ${stage} worker fails`, async () => {
    const provider = mock()
      .on({ key: `${stage}:*` }, () => {
        throw new Error("worker unavailable");
      })
      .on({ key: "find:*" }, { findings: [a] });
    await assert.rejects(
      runWorkflow(workflow, {
        input: { paths: ["src"] },
        fixtureMode: "strict",
        provider,
      }),
      /failed|unavailable/,
    );
    assert.equal(provider.calls.filter((call) => call.key?.startsWith("fix:")).length, 0);
  });
}

test("no confirmed findings needs neither approval nor verification commands", async () => {
  const { output, journal } = await runWorkflow(workflow, {
    input: { paths: ["src"] },
    fixtureMode: "strict",
    provider: mock().on({ key: "find:*" }, { findings: [] }),
  });
  assert.deepEqual(output, { fixed: [], skipped: [] });
  assert.equal(journal.steps({ kind: "human" }).length, 0);
});

test("groups same-file findings and integrates before another writer edits shared tests", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "weft-audit-behavior-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  await exec("git", ["init", "-q", "."], { cwd });
  await exec("git", ["config", "user.name", "Weft test"], { cwd });
  await exec("git", ["config", "user.email", "test@weft.invalid"], { cwd });
  for (const file of ["a.ts", "b.ts", "shared.test.ts"]) await writeFile(join(cwd, file), "original\n");
  await exec("git", ["add", "."], { cwd });
  await exec("git", ["commit", "-qm", "initial"], { cwd });
  const provider = panel()
    .on(
      { key: "fix:a.ts" },
      (request) => {
        assert.match(request.prompt, /Missing null guard/);
        assert.match(request.prompt, /Stale cache/);
        return { summary: "Fixed both causes", tests: ["shared.test.ts"] };
      },
      { writes: { "a.ts": "fixed a\n", "shared.test.ts": "test a\n" } },
    )
    .on(
      { key: "fix:b.ts" },
      async (request) => {
        assert.equal(await readFile(join(request.cwd, "a.ts"), "utf8"), "fixed a\n");
        return { summary: "Fixed fallback", tests: ["shared.test.ts"] };
      },
      { writes: { "b.ts": "fixed b\n", "shared.test.ts": "test a and b\n" } },
    );
  const { output } = await runWorkflow(workflow, {
    input: { paths: ["src"] },
    cwd,
    fixtureMode: "integration",
    provider,
    answers: () => ({ approved: true }),
    exec: { "pnpm test": { stdout: "3 tests passed", stderr: "", exitCode: 0 } },
  });
  assert.deepEqual(output, { fixed: [a, b, c], skipped: [] });
  assert.equal(provider.calls.filter((call) => call.key?.startsWith("fix:")).length, 2);
  assert.equal(await readFile(join(cwd, "shared.test.ts"), "utf8"), "test a and b\n");
});
