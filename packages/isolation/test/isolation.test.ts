/**
 * Worktrees, patch capture and 3-way application against real repositories: the
 * conflict paths only mean anything when git itself produces them.
 */
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createGit, type Git } from "@weft/git";
import {
  addWorktree,
  applyPatchToTree,
  capturePatch,
  checkScope,
  removeWorktree,
  restoreFiles,
} from "@weft/isolation";
import { execa } from "execa";
import { afterEach, describe, expect, test } from "vitest";

const temps: string[] = [];

afterEach(async () => {
  for (const dir of temps.splice(0)) {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

async function tempDir(): Promise<string> {
  const dir = await realpath(await mkdtemp(path.join(tmpdir(), "weft-isolation-")));
  temps.push(dir);
  return dir;
}

async function initRepo(): Promise<Git> {
  const dir = await tempDir();
  await execa("git", ["init", "-b", "main"], { cwd: dir });
  await execa("git", ["config", "user.email", "weft@test"], { cwd: dir });
  await execa("git", ["config", "user.name", "weft"], { cwd: dir });
  await execa("git", ["config", "commit.gpgsign", "false"], { cwd: dir });
  return createGit(dir);
}

async function writeIn(root: string, file: string, content: string): Promise<void> {
  const target = path.join(root, file);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, content, "utf8");
}

function readIn(root: string, file: string): Promise<string> {
  return readFile(path.join(root, file), "utf8");
}

async function seed(git: Git, files: Record<string, string>, message: string): Promise<string> {
  for (const [file, content] of Object.entries(files)) await writeIn(git.cwd, file, content);
  await git.add({ paths: Object.keys(files) });
  const { sha } = await git.commit({ message });
  return sha;
}

/** A worktree path whose parent does not exist yet, so addWorktree has to create it. */
async function worktreePath(name = "wt"): Promise<string> {
  return path.join(await tempDir(), "nested", name);
}

describe("addWorktree", () => {
  test("creates a detached worktree at HEAD, parents included", async () => {
    const repo = await initRepo();
    const sha = await seed(repo, { "a.txt": "one\n" }, "init");
    const dir = await worktreePath();

    const handle = await addWorktree({ repoRoot: repo.cwd, dir });
    expect(handle.path).toBe(dir);
    expect(handle.base).toBe(sha);
    expect(await readIn(dir, "a.txt")).toBe("one\n");

    const worktree = createGit(dir);
    expect((await worktree.head()).sha).toBe(sha);
    expect((await worktree.raw(["rev-parse", "--abbrev-ref", "HEAD"])).stdout.trim()).toBe("HEAD");
    expect((await worktree.status()).clean).toBe(true);
  });

  test("honours an explicit baseRef and reports its sha", async () => {
    const repo = await initRepo();
    const first = await seed(repo, { "a.txt": "one\n" }, "init");
    await seed(repo, { "a.txt": "two\n" }, "second");
    await repo.branchCreate("release", { from: first });

    const handle = await addWorktree({ repoRoot: repo.cwd, dir: await worktreePath(), baseRef: "release" });
    expect(handle.base).toBe(first);
    expect(await readIn(handle.path, "a.txt")).toBe("one\n");
  });
});

describe("removeWorktree", () => {
  test("removes the worktree and tolerates repeated calls", async () => {
    const repo = await initRepo();
    await seed(repo, { "a.txt": "one\n" }, "init");
    const handle = await addWorktree({ repoRoot: repo.cwd, dir: await worktreePath() });

    await removeWorktree({ repoRoot: repo.cwd, path: handle.path });
    expect(existsSync(handle.path)).toBe(false);
    await expect(removeWorktree({ repoRoot: repo.cwd, path: handle.path })).resolves.toBeUndefined();
    expect((await repo.raw(["worktree", "list"])).stdout).not.toContain(handle.path);
  });

  test("prunes a worktree whose directory was deleted behind git's back", async () => {
    const repo = await initRepo();
    await seed(repo, { "a.txt": "one\n" }, "init");
    const handle = await addWorktree({ repoRoot: repo.cwd, dir: await worktreePath() });
    await rm(handle.path, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });

    await expect(removeWorktree({ repoRoot: repo.cwd, path: handle.path })).resolves.toBeUndefined();
    expect((await repo.raw(["worktree", "list"])).stdout).not.toContain(handle.path);
  });

  test("leaves the worktree's edits out of the parent repo", async () => {
    const repo = await initRepo();
    await seed(repo, { "a.txt": "one\n" }, "init");
    const handle = await addWorktree({ repoRoot: repo.cwd, dir: await worktreePath() });
    await writeIn(handle.path, "a.txt", "edited in isolation\n");

    await removeWorktree({ repoRoot: repo.cwd, path: handle.path });
    expect(await readIn(repo.cwd, "a.txt")).toBe("one\n");
    expect((await repo.status()).clean).toBe(true);
  });
});

describe("capturePatch", () => {
  test("captures edits, new files and deletions as one patch", async () => {
    const repo = await initRepo();
    await seed(repo, { "a.txt": "one\ntwo\n", "gone.txt": "gone\n" }, "init");
    const handle = await addWorktree({ repoRoot: repo.cwd, dir: await worktreePath() });

    await writeIn(handle.path, "a.txt", "one\ntwo\nthree\n");
    await writeIn(handle.path, "src/new.ts", "export const added = true;\n");
    await rm(path.join(handle.path, "gone.txt"));

    const { patch, files } = await capturePatch({ worktreePath: handle.path });
    expect([...files].sort()).toEqual(["a.txt", "gone.txt", "src/new.ts"]);
    expect(patch).toContain("+three");
    expect(patch).toContain("new file mode");
    expect(patch).toContain("deleted file mode");
    expect(patch).toContain("src/new.ts");
    // Capture is read-only as far as the integration tree is concerned.
    expect((await repo.status()).clean).toBe(true);
  });

  test("carries binary files from capture through apply", async () => {
    const repo = await initRepo();
    const original = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01]);
    await writeFile(path.join(repo.cwd, "logo.png"), original);
    await repo.add({ paths: ["logo.png"] });
    await repo.commit({ message: "binary seed" });
    const handle = await addWorktree({ repoRoot: repo.cwd, dir: await worktreePath() });

    const edited = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0xfe, 0x00, 0x42]);
    const added = Buffer.from([0x00, 0x01, 0x02, 0x03, 0xff]);
    await writeFile(path.join(handle.path, "logo.png"), edited);
    await writeFile(path.join(handle.path, "raw.bin"), added);

    const { patch, files } = await capturePatch({ worktreePath: handle.path });
    expect([...files].sort()).toEqual(["logo.png", "raw.bin"]);
    // --binary embeds the content itself, not an unappliable "Binary files differ" stub.
    expect(patch).toContain("GIT binary patch");
    expect(patch).not.toContain("Binary files differ");

    expect(await applyPatchToTree({ repoRoot: repo.cwd, patch })).toEqual({ ok: true });
    expect(await readFile(path.join(repo.cwd, "logo.png"))).toEqual(edited);
    expect(await readFile(path.join(repo.cwd, "raw.bin"))).toEqual(added);
  });

  test("is empty when the worktree is untouched", async () => {
    const repo = await initRepo();
    await seed(repo, { "a.txt": "one\n" }, "init");
    const handle = await addWorktree({ repoRoot: repo.cwd, dir: await worktreePath() });
    expect(await capturePatch({ worktreePath: handle.path })).toEqual({ patch: "", files: [] });
  });
});

describe("checkScope", () => {
  test("partitions files by glob, preserving input order", async () => {
    const files = [
      "src/auth/login.ts",
      "src/db/pool.ts",
      "src/db/pool.test.ts",
      "pnpm-lock.yaml",
      "README.md",
    ];
    const result = checkScope(files, {
      paths: ["src/auth/**", "**/*.test.ts"],
      also: ["pnpm-lock.yaml"],
    });
    expect(result.inScope).toEqual(["src/auth/login.ts", "src/db/pool.test.ts", "pnpm-lock.yaml"]);
    expect(result.outOfScope).toEqual(["src/db/pool.ts", "README.md"]);
  });

  test("matches dotfiles and works without `also`", async () => {
    const result = checkScope([".github/workflows/ci.yml", ".env", "src/a.ts"], {
      paths: [".github/**", "*"],
    });
    expect(result.inScope).toEqual([".github/workflows/ci.yml", ".env"]);
    expect(result.outOfScope).toEqual(["src/a.ts"]);
  });

  test("an empty scope puts everything out of scope", async () => {
    expect(checkScope(["a.ts", "b.ts"], { paths: [] })).toEqual({
      inScope: [],
      outOfScope: ["a.ts", "b.ts"],
    });
    expect(checkScope([], { paths: ["**"] })).toEqual({ inScope: [], outOfScope: [] });
  });
});

describe("applyPatchToTree", () => {
  test("applies a worktree patch cleanly", async () => {
    const repo = await initRepo();
    await seed(repo, { "a.txt": "one\ntwo\n" }, "init");
    const handle = await addWorktree({ repoRoot: repo.cwd, dir: await worktreePath() });
    await writeIn(handle.path, "a.txt", "one\ntwo\nthree\n");
    await writeIn(handle.path, "src/new.ts", "export const added = true;\n");
    const { patch } = await capturePatch({ worktreePath: handle.path });

    expect(await applyPatchToTree({ repoRoot: repo.cwd, patch })).toEqual({ ok: true });
    expect(await readIn(repo.cwd, "a.txt")).toBe("one\ntwo\nthree\n");
    expect(await readIn(repo.cwd, "src/new.ts")).toBe("export const added = true;\n");
  });

  test("treats an empty patch as a no-op success", async () => {
    const repo = await initRepo();
    await seed(repo, { "a.txt": "one\n" }, "init");
    expect(await applyPatchToTree({ repoRoot: repo.cwd, patch: "" })).toEqual({ ok: true });
    expect(await applyPatchToTree({ repoRoot: repo.cwd, patch: "\n  \n" })).toEqual({ ok: true });
    expect((await repo.status()).clean).toBe(true);
  });

  test("falls back to a 3-way merge when context moved", async () => {
    const repo = await initRepo();
    await seed(repo, { "a.txt": "one\ntwo\nthree\nfour\nfive\n" }, "init");
    const handle = await addWorktree({ repoRoot: repo.cwd, dir: await worktreePath() });
    // The worktree edits the tail...
    await writeIn(handle.path, "a.txt", "one\ntwo\nthree\nfour\nFIVE\n");
    const { patch } = await capturePatch({ worktreePath: handle.path });
    // ...while the integration tree grows a head that shifts every line number.
    await seed(repo, { "a.txt": "zero\none\ntwo\nthree\nfour\nfive\n" }, "prepend");

    expect(await applyPatchToTree({ repoRoot: repo.cwd, patch })).toEqual({ ok: true });
    expect(await readIn(repo.cwd, "a.txt")).toBe("zero\none\ntwo\nthree\nfour\nFIVE\n");
    // The merge ran against a throwaway index: nothing was staged behind the user's back.
    const staged = await repo.raw(["diff", "--cached", "--name-only"]);
    expect(staged.stdout.trim()).toBe("");
  });

  test("3-way merges a tracked file that .gitignore also matches", async () => {
    const repo = await initRepo();
    await seed(repo, { "tracked.txt": "one\ntwo\nthree\nfour\nfive\n" }, "init");
    await seed(repo, { ".gitignore": "tracked.txt\n" }, "ignore it later");
    const handle = await addWorktree({ repoRoot: repo.cwd, dir: await worktreePath() });
    await writeIn(handle.path, "tracked.txt", "one\ntwo\nthree\nfour\nFIVE\n");
    const { patch } = await capturePatch({ worktreePath: handle.path });
    // Drift so the clean apply fails and the 3-way (with its temp index) must run —
    // an index staged without HEAD seeding would not contain the ignored file at all.
    await seed(repo, { "tracked.txt": "zero\none\ntwo\nthree\nfour\nfive\n" }, "prepend");

    expect(await applyPatchToTree({ repoRoot: repo.cwd, patch })).toEqual({ ok: true });
    expect(await readIn(repo.cwd, "tracked.txt")).toBe("zero\none\ntwo\nthree\nfour\nFIVE\n");
  });

  test("reports conflicts when both sides changed the same line", async () => {
    const repo = await initRepo();
    await seed(repo, { "a.txt": "one\ntwo\nthree\n" }, "init");
    const handle = await addWorktree({ repoRoot: repo.cwd, dir: await worktreePath() });
    await writeIn(handle.path, "a.txt", "one\nWORKTREE\nthree\n");
    const { patch } = await capturePatch({ worktreePath: handle.path });

    await seed(repo, { "a.txt": "one\nMAIN\nthree\n" }, "main edits the same line");
    const outcome = await applyPatchToTree({ repoRoot: repo.cwd, patch });

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.conflicts).toEqual(["a.txt"]);
    const conflicted = await readIn(repo.cwd, "a.txt");
    expect(conflicted).toContain("<<<<<<<");
    expect(conflicted).toContain("WORKTREE");
    // Markers live in the working tree only; the user's real index carries no
    // unmerged entries (the 3-way ran against a throwaway index).
    expect(await repo.unmergedPaths()).toEqual([]);
  });

  test("reports a conflict when both sides created the same file", async () => {
    const repo = await initRepo();
    await seed(repo, { "base.txt": "base\n" }, "init");
    const handle = await addWorktree({ repoRoot: repo.cwd, dir: await worktreePath() });
    await writeIn(handle.path, "src/new.ts", "from the worktree\n");
    const { patch } = await capturePatch({ worktreePath: handle.path });

    await seed(repo, { "src/new.ts": "from the integration tree\n" }, "main creates it too");
    const outcome = await applyPatchToTree({ repoRoot: repo.cwd, patch });

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.conflicts).toEqual(["src/new.ts"]);
    expect(await readIn(repo.cwd, "src/new.ts")).toContain("from the worktree");
  });

  test("reports the patch's target files when it cannot apply at all", async () => {
    const source = await initRepo();
    await seed(source, { "shared.txt": "alpha\nbeta\ngamma\n" }, "init");
    await writeIn(source.cwd, "shared.txt", "alpha\nBETA\ngamma\n");
    const { patch } = await source.diff();

    // An unrelated repo: the preimage blob is not in its object store either.
    const target = await initRepo();
    await seed(target, { "shared.txt": "nothing\nin\ncommon\n" }, "init");

    const outcome = await applyPatchToTree({ repoRoot: target.cwd, patch });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.conflicts).toEqual(["shared.txt"]);
    expect(await readIn(target.cwd, "shared.txt")).toBe("nothing\nin\ncommon\n");
  });
});

describe("restoreFiles", () => {
  test("undoes a conflicted application", async () => {
    const repo = await initRepo();
    await seed(repo, { "a.txt": "one\ntwo\nthree\n" }, "init");
    const handle = await addWorktree({ repoRoot: repo.cwd, dir: await worktreePath() });
    await writeIn(handle.path, "a.txt", "one\nWORKTREE\nthree\n");
    const { patch } = await capturePatch({ worktreePath: handle.path });
    await seed(repo, { "a.txt": "one\nMAIN\nthree\n" }, "main edits the same line");

    const outcome = await applyPatchToTree({ repoRoot: repo.cwd, patch });
    expect(outcome.ok).toBe(false);

    await restoreFiles({ repoRoot: repo.cwd, ref: "HEAD", paths: ["a.txt"] });
    expect(await readIn(repo.cwd, "a.txt")).toBe("one\nMAIN\nthree\n");
    expect(await repo.unmergedPaths()).toEqual([]);
    expect((await repo.status()).clean).toBe(true);
  });

  test("restores every path from a snapshot ref when none are named", async () => {
    const repo = await initRepo();
    await seed(repo, { "a.txt": "one\n", "b.txt": "two\n" }, "init");
    await writeIn(repo.cwd, "a.txt", "snapshotted\n");
    const snapshot = await repo.snapshot();

    await writeIn(repo.cwd, "a.txt", "later\n");
    await writeIn(repo.cwd, "b.txt", "later\n");
    await restoreFiles({ repoRoot: repo.cwd, ref: snapshot.ref });

    expect(await readIn(repo.cwd, "a.txt")).toBe("snapshotted\n");
    expect(await readIn(repo.cwd, "b.txt")).toBe("two\n");
  });
});
