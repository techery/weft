/**
 * A directory with its own `.git` is staged as a gitlink, not as its files. Left alone the
 * patch looks healthy and lands nothing, so the step reports success having lost the work.
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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

const git = (cwd: string, ...args: string[]) => execa("git", args, { cwd });

async function initRepo(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "weft-nested-"));
  temps.push(dir);
  await git(dir, "init", "-b", "main");
  await git(dir, "config", "user.email", "weft@test");
  await git(dir, "config", "user.name", "weft");
  for (const [path, content] of Object.entries(files)) {
    await mkdir(join(dir, path, ".."), { recursive: true });
    await writeFile(join(dir, path), content);
  }
  await git(dir, "add", "-A");
  await git(dir, "commit", "-m", "init");
  return dir;
}

async function worktreeOf(repo: string): Promise<string> {
  const dir = join(await mkdtemp(join(tmpdir(), "weft-nested-wt-")), "wt");
  temps.push(dir);
  await addWorktree({ repoRoot: repo, dir });
  return dir;
}

describe("nested git repositories", () => {
  test("an accidental one is refused instead of losing every file inside it", async () => {
    const repo = await initRepo({ "README.md": "x\n" });
    const wt = await worktreeOf(repo);

    // What `create-next-app`, `cargo new` or a cloned fixture leaves behind.
    await mkdir(join(wt, "subproj"), { recursive: true });
    await writeFile(join(wt, "subproj", "index.ts"), "export const x = 1;\n");
    await git(join(wt, "subproj"), "init", "-b", "main");
    await git(join(wt, "subproj"), "config", "user.email", "weft@test");
    await git(join(wt, "subproj"), "config", "user.name", "weft");
    await git(join(wt, "subproj"), "add", "-A");
    await git(join(wt, "subproj"), "commit", "-m", "sub");

    await expect(capturePatch({ worktreePath: wt, alsoInclude: ["**"] })).rejects.toThrow(
      /nested git repositor/i,
    );
  });

  test("removing a registered submodule is not mistaken for one", async () => {
    // A deleted submodule shows oldMode 160000 and is already gone from the staged
    // .gitmodules, so matching on oldMode refused the whole capture.
    const inner = await initRepo({ "lib.ts": "export const lib = 1;\n" });
    const repo = await initRepo({ "README.md": "x\n" });
    await git(repo, "-c", "protocol.file.allow=always", "submodule", "add", inner, "vendor");
    await git(repo, "commit", "-m", "add submodule");

    const wt = await worktreeOf(repo);
    await git(wt, "-c", "protocol.file.allow=always", "submodule", "deinit", "-f", "vendor");
    await git(wt, "rm", "-f", "vendor");

    const captured = await capturePatch({ worktreePath: wt, alsoInclude: ["**"] });
    expect(captured.files).toContain("vendor");
  });

  test("an ordinary directory still captures its files", async () => {
    const repo = await initRepo({ "README.md": "x\n" });
    const wt = await worktreeOf(repo);
    await mkdir(join(wt, "subproj"), { recursive: true });
    await writeFile(join(wt, "subproj", "index.ts"), "export const x = 1;\n");

    const captured = await capturePatch({ worktreePath: wt, alsoInclude: ["**"] });
    expect(captured.files).toEqual(["subproj/index.ts"]);
    expect(await applyPatchToTree({ repoRoot: repo, patch: captured.patch })).toEqual({ ok: true });
    expect(await readFile(join(repo, "subproj/index.ts"), "utf8")).toBe("export const x = 1;\n");
  });
});
