/**
 * A repository, or the operator's shell, can attach an executable helper to a plain
 * `git diff`. Weft must never run it, and must never journal its output as a patch.
 */
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addWorktree, applyPatchToTree, capturePatch } from "@techery/weft-isolation";
import { execa } from "execa";
import { afterEach, describe, expect, test } from "vitest";

const temps: string[] = [];
afterEach(async () => {
  for (const dir of temps.splice(0)) {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

async function repoWith(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "weft-extdiff-"));
  temps.push(dir);
  const git = (...args: string[]) => execa("git", args, { cwd: dir });
  await git("init", "-b", "main");
  await git("config", "user.email", "weft@test");
  await git("config", "user.name", "weft");
  for (const [path, content] of Object.entries(files)) await writeFile(join(dir, path), content);
  await git("add", "-A");
  await git("commit", "-m", "init");
  return dir;
}

describe("external diff drivers cannot hijack a captured patch", () => {
  test("GIT_EXTERNAL_DIFF in the environment is ignored", async () => {
    const repo = await repoWith({ "a.txt": "line1\nline2\n" });
    const wt = join(await mkdtemp(join(tmpdir(), "weft-wt-")), "wt");
    temps.push(wt);
    await addWorktree({ repoRoot: repo, dir: wt });
    await writeFile(join(wt, "a.txt"), "line1\nEDITED\n");

    const previous = process.env.GIT_EXTERNAL_DIFF;
    process.env.GIT_EXTERNAL_DIFF = "echo HIJACKED";
    let captured: { patch: string; files: string[] };
    try {
      captured = await capturePatch({ worktreePath: wt, alsoInclude: ["**"] });
    } finally {
      if (previous === undefined) delete process.env.GIT_EXTERNAL_DIFF;
      else process.env.GIT_EXTERNAL_DIFF = previous;
    }

    expect(captured.patch).not.toContain("HIJACKED");
    expect(captured.patch).toContain("diff --git");
    expect(await applyPatchToTree({ repoRoot: repo, patch: captured.patch })).toEqual({ ok: true });
    expect(await readFile(join(repo, "a.txt"), "utf8")).toBe("line1\nEDITED\n");
  });

  test("a repository-configured diff.external is ignored", async () => {
    const repo = await repoWith({ "a.txt": "line1\nline2\n" });
    await execa("git", ["config", "diff.external", "echo HIJACKED"], { cwd: repo });
    const wt = join(await mkdtemp(join(tmpdir(), "weft-wt-")), "wt");
    temps.push(wt);
    await addWorktree({ repoRoot: repo, dir: wt });
    await writeFile(join(wt, "a.txt"), "line1\nEDITED\n");

    const captured = await capturePatch({ worktreePath: wt, alsoInclude: ["**"] });
    expect(captured.patch).not.toContain("HIJACKED");
    expect(await applyPatchToTree({ repoRoot: repo, patch: captured.patch })).toEqual({ ok: true });
    expect(await readFile(join(repo, "a.txt"), "utf8")).toBe("line1\nEDITED\n");
  });

  test("ctx.git reads still work with diff.external configured", async () => {
    // Regression guard: `-c diff.external=` would make git die with "cannot run :".
    const repo = await repoWith({ "a.txt": "one\n" });
    await execa("git", ["config", "diff.external", "echo HIJACKED"], { cwd: repo });
    await writeFile(join(repo, "a.txt"), "two\n");
    const { createGit } = await import("@techery/weft-git");
    const git = createGit(repo);
    const diff = await git.diff();
    expect(diff.patch).toContain("diff --git");
    expect(diff.patch).not.toContain("HIJACKED");
    expect(diff.stats.files).toBe(1);
    expect((await git.changedSince("HEAD")).files.map((f) => f.path)).toEqual(["a.txt"]);
  });
});
