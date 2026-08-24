/**
 * These tests drive the real git binary against throwaway repositories: the whole
 * point of this package is that its parsing matches what git actually prints.
 */
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createGit, type Git, GitError } from "@weft/git";
import { execa } from "execa";
import { afterEach, describe, expect, test } from "vitest";

const temps: string[] = [];

afterEach(async () => {
  for (const dir of temps.splice(0)) {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

async function tempDir(): Promise<string> {
  // realpath keeps comparisons stable where tmpdir is a symlink.
  const dir = await realpath(await mkdtemp(path.join(tmpdir(), "weft-git-")));
  temps.push(dir);
  return dir;
}

async function configure(cwd: string): Promise<void> {
  await execa("git", ["config", "user.email", "weft@test"], { cwd });
  await execa("git", ["config", "user.name", "weft"], { cwd });
  await execa("git", ["config", "commit.gpgsign", "false"], { cwd });
}

async function initRepo(): Promise<Git> {
  const dir = await tempDir();
  await execa("git", ["init", "-b", "main"], { cwd: dir });
  await configure(dir);
  return createGit(dir);
}

async function write(git: Git, file: string, content: string): Promise<void> {
  const target = path.join(git.cwd, file);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, content, "utf8");
}

function read(git: Git, file: string): Promise<string> {
  return readFile(path.join(git.cwd, file), "utf8");
}

/** Run something expected to fail and hand back the GitError it threw. */
async function failure(run: () => Promise<unknown>): Promise<GitError> {
  try {
    await run();
  } catch (err) {
    if (err instanceof GitError) return err;
    throw err;
  }
  throw new Error("expected a GitError");
}

/** Write files, stage them, commit; returns the new sha. */
async function seed(git: Git, files: Record<string, string>, message: string): Promise<string> {
  for (const [file, content] of Object.entries(files)) await write(git, file, content);
  await git.add({ paths: Object.keys(files) });
  const { sha } = await git.commit({ message });
  return sha;
}

describe("raw", () => {
  test("throws GitError naming the subcommand and carrying stderr", async () => {
    const git = await initRepo();
    await seed(git, { "a.txt": "one\n" }, "init");
    const err = await failure(() => git.raw(["checkout", "definitely-missing-branch"]));
    expect(err.name).toBe("GitError");
    expect(err.args).toEqual(["checkout", "definitely-missing-branch"]);
    expect(err.exitCode).toBeGreaterThan(0);
    expect(err.stderr).toContain("definitely-missing-branch");
    expect(err.message).toContain("git checkout failed");
    expect(err.message).toContain("definitely-missing-branch");
  });

  test("returns the failed result when allowFailure", async () => {
    const git = await initRepo();
    await seed(git, { "a.txt": "one\n" }, "init");
    const result = await git.raw(["checkout", "nope"], { allowFailure: true });
    expect(result.exitCode).toBeGreaterThan(0);
    expect(result.stderr).not.toBe("");
    expect(result.stdout).toBe("");
  });

  test("names the subcommand past leading -c options", async () => {
    const git = await initRepo();
    await seed(git, { "a.txt": "one\n" }, "init");
    const err = await failure(() => git.raw(["-c", "core.quotePath=false", "checkout", "missing-branch"]));
    expect(err.message).toContain("git checkout failed");
  });

  test("feeds input on stdin", async () => {
    const git = await initRepo();
    await seed(git, { "a.txt": "one\n" }, "init");
    const { stdout } = await git.raw(["hash-object", "-w", "--stdin"], { input: "hello\n" });
    expect(stdout.trim()).toMatch(/^[0-9a-f]{40}$/);
    expect((await git.show(stdout.trim())).content).toBe("hello\n");
  });
});

describe("status", () => {
  test("is clean right after a commit", async () => {
    const git = await initRepo();
    await seed(git, { "a.txt": "one\n" }, "init");
    expect(await git.status()).toEqual({
      branch: "main",
      clean: true,
      staged: [],
      unstaged: [],
      untracked: [],
    });
  });

  test("separates staged, unstaged and untracked paths", async () => {
    const git = await initRepo();
    await seed(git, { "a.txt": "one\n", "b.txt": "two\n" }, "init");
    await write(git, "a.txt", "one changed\n");
    await write(git, "b.txt", "two changed\n");
    await git.add({ paths: ["b.txt"] });
    await write(git, "c.txt", "new\n");
    const status = await git.status();
    expect(status.clean).toBe(false);
    expect(status.branch).toBe("main");
    expect(status.staged).toEqual(["b.txt"]);
    expect(status.unstaged).toEqual(["a.txt"]);
    expect(status.untracked).toEqual(["c.txt"]);
  });

  test("lists a staged-then-modified file on both sides", async () => {
    const git = await initRepo();
    await seed(git, { "a.txt": "one\n" }, "init");
    await write(git, "a.txt", "staged\n");
    await git.add({ paths: ["a.txt"] });
    await write(git, "a.txt", "staged then modified\n");
    const status = await git.status();
    expect(status.staged).toEqual(["a.txt"]);
    expect(status.unstaged).toEqual(["a.txt"]);
  });

  test("handles paths with spaces and a renamed entry", async () => {
    const git = await initRepo();
    await seed(git, { "a file.txt": "long enough content to be matched as a rename\n" }, "init");
    await git.raw(["mv", "a file.txt", "another file.txt"]);
    const status = await git.status();
    expect(status.staged).toEqual(["another file.txt"]);
    expect(status.clean).toBe(false);
  });
});

describe("head, branches and mergeBase", () => {
  test("head matches rev-parse", async () => {
    const git = await initRepo();
    const sha = await seed(git, { "a.txt": "one\n" }, "init");
    const head = await git.head();
    expect(head.sha).toMatch(/^[0-9a-f]{40}$/);
    expect(head.sha).toBe(sha);
  });

  test("branches lists every branch and the current one", async () => {
    const git = await initRepo();
    await seed(git, { "a.txt": "one\n" }, "init");
    await git.branchCreate("feature");
    const before = await git.branches();
    expect(before.all.sort()).toEqual(["feature", "main"]);
    expect(before.current).toBe("main");
    await git.checkout("feature");
    expect((await git.branches()).current).toBe("feature");
  });

  test("mergeBase finds the fork point", async () => {
    const git = await initRepo();
    const base = await seed(git, { "a.txt": "one\n" }, "init");
    await git.branchCreate("feature", { checkout: true });
    await seed(git, { "f.txt": "f\n" }, "feature work");
    await git.checkout("main");
    await seed(git, { "m.txt": "m\n" }, "main work");
    expect(await git.mergeBase("main", "feature")).toEqual({ sha: base });
  });
});

describe("status with hostile pathnames", () => {
  test("paths with newlines, tabs, and quotes come back verbatim, renames intact", async () => {
    const git = await initRepo();
    await seed(git, { "line\nbreak.txt": "one\n" }, "init");
    await write(git, "line\nbreak.txt", "two\n"); // unstaged modification
    await write(git, 'we"ird\ttab', "new\n"); // untracked
    const s = await git.status();
    // Without -z, porcelain C-quotes these and the parser reported the QUOTED
    // spelling as the filename.
    expect(s.unstaged).toEqual(["line\nbreak.txt"]);
    expect(s.untracked).toEqual(['we"ird\ttab']);

    // A rename's original path is its own NUL record — it must be skipped, not
    // glued onto the target or misread as another entry.
    await git.raw(["mv", "line\nbreak.txt", "moved\nname.txt"]);
    const s2 = await git.status();
    expect(s2.staged).toEqual(["moved\nname.txt"]);
    expect(s2.staged).not.toContain("line\nbreak.txt");
  });
});

describe("changedSince", () => {
  test("filenames with newlines, tabs, and quotes round-trip exactly", async () => {
    const git = await initRepo();
    await seed(git, { "base.txt": "base\n" }, "init");
    // Legal-but-hostile POSIX names: without -z parsing, git C-quotes or splits
    // these and changedSince reports mangled or missing paths.
    const weird = 'we"ird\ttab';
    const newliney = "line\nbreak.txt";
    await seed(git, { [weird]: "one\n", [newliney]: "two\n" }, "hostile names");
    await write(git, "untracked\nname.txt", "three\n");
    const { files } = await git.changedSince("HEAD~1");
    const paths = files.map((f) => f.path).sort();
    expect(paths).toEqual(["line\nbreak.txt", "untracked\nname.txt", 'we"ird\ttab'].sort());
  });

  test("covers committed, working-tree and untracked changes", async () => {
    const git = await initRepo();
    await seed(git, { "keep.txt": "keep\n", "edit.txt": "edit\n", "gone.txt": "gone\n" }, "init");
    await git.branchCreate("feature", { checkout: true });
    await seed(git, { "added.txt": "added\n" }, "add a file");
    await write(git, "edit.txt", "edited in the working tree\n");
    await rm(path.join(git.cwd, "gone.txt"));
    await write(git, "untracked.txt", "untracked\n");

    const { files } = await git.changedSince("main");
    const byPath = new Map(files.map((f) => [f.path, f.status]));
    expect(byPath.get("added.txt")).toBe("A");
    expect(byPath.get("edit.txt")).toBe("M");
    expect(byPath.get("gone.txt")).toBe("D");
    expect(byPath.get("untracked.txt")).toBe("A");
    expect(byPath.has("keep.txt")).toBe(false);
    expect(files).toHaveLength(4);
  });

  test("reports a rename under its new path, once", async () => {
    const git = await initRepo();
    await seed(git, { "old.txt": "content long enough to be detected as a rename\n" }, "init");
    await git.branchCreate("feature", { checkout: true });
    await git.raw(["mv", "old.txt", "new.txt"]);
    await git.commit({ message: "rename" });
    expect((await git.changedSince("main")).files).toEqual([{ path: "new.txt", status: "R" }]);
  });

  test("is empty when nothing moved", async () => {
    const git = await initRepo();
    await seed(git, { "a.txt": "one\n" }, "init");
    expect((await git.changedSince("main")).files).toEqual([]);
  });
});

describe("diff", () => {
  test("defaults to HEAD against the working tree", async () => {
    const git = await initRepo();
    await seed(git, { "a.txt": "one\ntwo\n" }, "init");
    await write(git, "a.txt", "one\ntwo\nthree\n");
    const { patch, stats } = await git.diff();
    expect(patch).toContain("--- a/a.txt");
    expect(patch).toContain("+three");
    expect(stats).toEqual({ files: 1, insertions: 1, deletions: 0 });
  });

  test("diffs a two-commit range and filters by path", async () => {
    const git = await initRepo();
    const first = await seed(git, { "a.txt": "one\n", "b.txt": "b\n" }, "init");
    const second = await seed(git, { "a.txt": "one\ntwo\n", "b.txt": "bb\n" }, "second");
    const both = await git.diff({ from: first, to: second });
    expect(both.stats).toEqual({ files: 2, insertions: 2, deletions: 1 });
    const onlyA = await git.diff({ from: first, to: second, paths: ["a.txt"] });
    expect(onlyA.stats.files).toBe(1);
    expect(onlyA.patch).toContain("a.txt");
    expect(onlyA.patch).not.toContain("b.txt");
  });

  test("is empty on a clean tree", async () => {
    const git = await initRepo();
    await seed(git, { "a.txt": "one\n" }, "init");
    const { patch, stats } = await git.diff();
    expect(patch).toBe("");
    expect(stats).toEqual({ files: 0, insertions: 0, deletions: 0 });
  });

  test("never executes .gitattributes diff drivers or textconv (codex review round 55, PR #1)", async () => {
    const git = await initRepo();
    // A repository-attached helper: diff.evil.command replaces the hunk
    // machinery and diff.evil.textconv rewrites blobs — both EXECUTE on plain
    // porcelain `git diff`/`show <commit>`/`blame` unless explicitly disabled.
    // Each drops a marker file when it runs.
    const sha = await seed(git, { "a.txt": "one\ntwo\n", ".gitattributes": "*.txt diff=evil\n" }, "init");
    const extMarker = path.join(git.cwd, "ran-ext-diff");
    const tcMarker = path.join(git.cwd, "ran-textconv");
    await execa("git", ["config", "diff.evil.command", `touch ${extMarker}`], { cwd: git.cwd });
    await execa("git", ["config", "diff.evil.textconv", `touch ${tcMarker} && cat`], { cwd: git.cwd });
    await write(git, "a.txt", "one\ntwo\nthree\n");

    const { patch, stats } = await git.diff();
    expect(patch).toContain("+three");
    expect(stats).toEqual({ files: 1, insertions: 1, deletions: 0 });

    expect((await git.show(sha)).content).toContain("+one");
    expect((await git.show(`${sha}:a.txt`)).content).toBe("one\ntwo\n");
    expect((await git.blame("a.txt", { lines: [1, 1] })).lines[0]?.content).toBe("one");

    expect(existsSync(extMarker)).toBe(false);
    expect(existsSync(tcMarker)).toBe(false);
  });

  test("typed reads never execute a core.fsmonitor hook (codex review round 61, PR #1)", async () => {
    const git = await initRepo();
    await seed(git, { "a.txt": "one\n" }, "init");
    // A pathname-valued core.fsmonitor is a HOOK any worktree scan executes.
    const marker = path.join(git.cwd, "fsmonitor-ran");
    await writeFile(path.join(git.cwd, "hook.sh"), `#!/bin/sh\ntouch ${marker}\necho /\n`, { mode: 0o755 });
    await execa("git", ["config", "core.fsmonitor", "./hook.sh"], { cwd: git.cwd });
    // The vector is real: an unguarded plain status runs the configured hook.
    await execa("git", ["status"], { cwd: git.cwd });
    expect(existsSync(marker)).toBe(true);
    await rm(marker, { force: true });
    // Every typed invocation disables it — approval-free journaled reads must
    // never run repository-configured code.
    await git.status();
    await git.diff();
    await git.changedSince("HEAD");
    expect(existsSync(marker)).toBe(false);
  });
});

describe("log", () => {
  test("parses sha, author, date, subject and body", async () => {
    const git = await initRepo();
    await seed(git, { "a.txt": "1\n" }, "first commit");
    await write(git, "a.txt", "2\n");
    await git.add({ paths: ["a.txt"] });
    await git.commit({ message: "second commit\n\nwhy this happened\nin two lines" });

    const { commits } = await git.log({ max: 1 });
    expect(commits).toHaveLength(1);
    const commit = commits[0]!;
    expect(commit.sha).toMatch(/^[0-9a-f]{40}$/);
    expect(commit.author).toBe("weft");
    expect(commit.date).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(commit.subject).toBe("second commit");
    expect(commit.body).toBe("why this happened\nin two lines");
  });

  test("walks a from..to range newest first", async () => {
    const git = await initRepo();
    const first = await seed(git, { "a.txt": "1\n" }, "first");
    await seed(git, { "a.txt": "2\n" }, "second");
    const third = await seed(git, { "a.txt": "3\n" }, "third");
    const { commits } = await git.log({ from: first, to: third });
    expect(commits.map((c) => c.subject)).toEqual(["third", "second"]);
    expect(commits.every((c) => c.body === "")).toBe(true);
  });

  test("caps the walk with max", async () => {
    const git = await initRepo();
    await seed(git, { "a.txt": "1\n" }, "first");
    await seed(git, { "a.txt": "2\n" }, "second");
    await seed(git, { "a.txt": "3\n" }, "third");
    const { commits } = await git.log({ max: 2 });
    expect(commits.map((c) => c.subject)).toEqual(["third", "second"]);
  });

  test("a message carrying \\x1e/\\x1f bytes stays one commit, verbatim", async () => {
    const git = await initRepo();
    await seed(git, { "a.txt": "1\n" }, "plain");
    // \x1f and \x1e are legal message bytes; used as in-band separators they
    // split one hostile commit into phantom entries with scrambled fields.
    await write(git, "a.txt", "2\n");
    await git.add({ paths: ["a.txt"] });
    await git.commit({ message: "evil \x1f subject\n\nbody carrying \x1e a record separator\nline two" });

    const { commits } = await git.log({});
    expect(commits).toHaveLength(2);
    expect(commits[0]!.subject).toBe("evil \x1f subject");
    expect(commits[0]!.body).toBe("body carrying \x1e a record separator\nline two");
    expect(commits[0]!.sha).toMatch(/^[0-9a-f]{40}$/);
    expect(commits[1]!.subject).toBe("plain");
  });
});

describe("show, fileAt and blame", () => {
  test("show renders a commit, fileAt reads the committed blob", async () => {
    const git = await initRepo();
    const sha = await seed(git, { "a.txt": "hello\n" }, "init");
    const shown = await git.show(sha);
    expect(shown.content).toContain("init");
    expect(shown.content).toContain("+hello");

    await write(git, "a.txt", "working tree\n");
    expect((await git.fileAt(sha, "a.txt")).content).toBe("hello\n");
    expect(await read(git, "a.txt")).toBe("working tree\n");
  });

  test("blame attributes lines and honours a line range", async () => {
    const git = await initRepo();
    const first = await seed(git, { "a.txt": "one\ntwo\n" }, "init");
    await write(git, "a.txt", "one\ntwo\nthree\n");
    await git.add({ paths: ["a.txt"] });
    const second = await git.commit({ message: "add three" });

    const { lines } = await git.blame("a.txt");
    expect(lines).toHaveLength(3);
    expect(lines[0]).toEqual({ line: 1, sha: first, author: "weft", content: "one" });
    expect(lines[2]).toEqual({ line: 3, sha: second.sha, author: "weft", content: "three" });

    const ranged = await git.blame("a.txt", { lines: [2, 3] });
    expect(ranged.lines.map((l) => l.line)).toEqual([2, 3]);
    expect(ranged.lines.map((l) => l.content)).toEqual(["two", "three"]);
  });
});

describe("snapshot and revParse", () => {
  test("snapshot records a dirty tree without moving HEAD", async () => {
    const git = await initRepo();
    await seed(git, { "a.txt": "one\n" }, "init");
    await write(git, "a.txt", "changed\n");
    const head = await git.head();
    const snap = await git.snapshot();

    expect(snap.ref).not.toBe(head.sha);
    expect(await git.revParse(snap.ref)).toBe(snap.ref);
    expect((await git.fileAt(snap.ref, "a.txt")).content).toBe("changed\n");
    expect((await git.head()).sha).toBe(head.sha);
    expect((await git.status()).unstaged).toEqual(["a.txt"]);
  });

  test("snapshot captures UNTRACKED files too — not just tracked modifications", async () => {
    const git = await initRepo();
    await seed(git, { "a.txt": "one\n" }, "init");
    await write(git, "a.txt", "changed\n");
    await write(git, "brand-new.txt", "untracked content\n");

    // `stash create` would silently omit brand-new.txt: the returned ref would
    // not describe the tree this method promises to capture.
    const snap = await git.snapshot();
    expect((await git.fileAt(snap.ref, "a.txt")).content).toBe("changed\n");
    expect((await git.fileAt(snap.ref, "brand-new.txt")).content).toBe("untracked content\n");
    // Nothing moved: HEAD, index, and working tree are untouched.
    expect((await git.status()).untracked).toEqual(["brand-new.txt"]);
  });

  test("snapshot of a clean tree is HEAD", async () => {
    const git = await initRepo();
    const sha = await seed(git, { "a.txt": "one\n" }, "init");
    expect(await git.snapshot()).toEqual({ ref: sha });
  });

  test("a snapshot survives git gc --prune=now (pinned, not dangling)", async () => {
    const git = await initRepo();
    await seed(git, { "a.txt": "one\n" }, "init");
    await write(git, "a.txt", "changed\n");
    const snap = await git.snapshot();

    // The sha is journaled and read back across suspensions that can outlive
    // gc's prune horizon — an unreferenced commit-tree object would be
    // collected and every later fileAt/checkout against it would fail.
    await execa("git", ["gc", "--prune=now", "--quiet"], { cwd: git.cwd });
    expect(await git.revParse(snap.ref)).toBe(snap.ref);
    expect((await git.fileAt(snap.ref, "a.txt")).content).toBe("changed\n");
    const refs = await execa("git", ["for-each-ref", "refs/weft/snapshots", "--format=%(objectname)"], {
      cwd: git.cwd,
    });
    expect(refs.stdout.trim()).toBe(snap.ref);
  });

  test("revParse resolves refs and returns null for missing ones", async () => {
    const git = await initRepo();
    const sha = await seed(git, { "a.txt": "one\n" }, "init");
    expect(await git.revParse("HEAD")).toBe(sha);
    expect(await git.revParse("main")).toBe(sha);
    expect(await git.revParse("no-such-ref")).toBeNull();
    expect(await git.revParse("refs/heads/nope")).toBeNull();
  });
});

describe("add, commit and checkout", () => {
  test("commit returns the new head sha", async () => {
    const git = await initRepo();
    await write(git, "a.txt", "one\n");
    await git.add({ paths: ["a.txt"] });
    const { sha } = await git.commit({ message: "init" });
    expect(sha).toMatch(/^[0-9a-f]{40}$/);
    expect((await git.head()).sha).toBe(sha);
    expect((await git.status()).clean).toBe(true);
  });

  test("commit takes explicit paths and refuses an empty commit without allowEmpty", async () => {
    const git = await initRepo();
    await seed(git, { "a.txt": "one\n" }, "init");
    await write(git, "a.txt", "two\n");
    await write(git, "b.txt", "b\n");
    await git.add({ paths: ["b.txt"] });
    await git.commit({ message: "only a", paths: ["a.txt"] });
    expect((await git.status()).staged).toEqual(["b.txt"]);

    await git.raw(["reset"]);
    await git.raw(["clean", "-fd"]);
    await expect(git.commit({ message: "nothing" })).rejects.toBeInstanceOf(GitError);
    const empty = await git.commit({ message: "nothing", allowEmpty: true });
    expect((await git.head()).sha).toBe(empty.sha);
  });

  test("add with no paths is a no-op", async () => {
    const git = await initRepo();
    await seed(git, { "a.txt": "one\n" }, "init");
    await expect(git.add({ paths: [] })).resolves.toBeUndefined();
  });

  test("checkout moves refs; discard restores a path", async () => {
    const git = await initRepo();
    await seed(git, { "a.txt": "one\n" }, "init");
    await write(git, "a.txt", "local edit\n");
    await git.checkout("a.txt", { discard: true });
    expect(await read(git, "a.txt")).toBe("one\n");
  });

  test("branchCreate, checkout and branchDelete", async () => {
    const git = await initRepo();
    await seed(git, { "a.txt": "one\n" }, "init");
    await git.branchCreate("feature", { checkout: true });
    expect((await git.branches()).current).toBe("feature");
    await seed(git, { "f.txt": "f\n" }, "feature work");

    await git.checkout("main");
    expect(existsSync(path.join(git.cwd, "f.txt"))).toBe(false);
    await expect(git.branchDelete("feature")).rejects.toBeInstanceOf(GitError);
    await git.branchDelete("feature", { force: true });
    expect((await git.branches()).all).toEqual(["main"]);

    await git.branchCreate("from-main", { from: "main" });
    expect(await git.revParse("from-main")).toBe((await git.head()).sha);
  });

  test("tag names a commit", async () => {
    const git = await initRepo();
    const first = await seed(git, { "a.txt": "one\n" }, "init");
    const second = await seed(git, { "a.txt": "two\n" }, "second");
    await git.tag("v2");
    await git.tag("v1", { ref: first });
    expect(await git.revParse("v2")).toBe(second);
    expect(await git.revParse("v1")).toBe(first);
  });
});

describe("applyPatch", () => {
  test("round-trips a diff from one repo into an identical one", async () => {
    const source = await initRepo();
    const target = await initRepo();
    await seed(source, { "a.txt": "one\ntwo\n" }, "init");
    await seed(target, { "a.txt": "one\ntwo\n" }, "init");

    await write(source, "a.txt", "one\ntwo\nthree\n");
    const { patch } = await source.diff();
    await target.applyPatch({ patch });
    expect(await read(target, "a.txt")).toBe("one\ntwo\nthree\n");
    expect((await target.status()).staged).toEqual([]);
    expect((await target.status()).unstaged).toEqual(["a.txt"]);

    await target.checkout("a.txt", { discard: true });
    await target.applyPatch({ patch, index: true });
    expect((await target.status()).staged).toEqual(["a.txt"]);
  });

  test("throws GitError on a patch that is not applicable", async () => {
    const git = await initRepo();
    await seed(git, { "a.txt": "one\n" }, "init");
    await expect(git.applyPatch({ patch: "this is not a patch\n" })).rejects.toBeInstanceOf(GitError);
  });
});

describe("stash, reset and clean", () => {
  test("stashPush hides work and stashPop brings it back", async () => {
    const git = await initRepo();
    await seed(git, { "a.txt": "one\n" }, "init");
    await write(git, "a.txt", "wip\n");
    await git.stashPush({ message: "wip" });
    expect((await git.status()).clean).toBe(true);
    expect(await read(git, "a.txt")).toBe("one\n");

    await git.stashPop();
    expect(await read(git, "a.txt")).toBe("wip\n");
    expect((await git.status()).unstaged).toEqual(["a.txt"]);
  });

  test("stashDrop discards the stashed entry", async () => {
    const git = await initRepo();
    await seed(git, { "a.txt": "one\n" }, "init");
    await write(git, "a.txt", "wip\n");
    await git.stashPush();
    await git.stashDrop();
    expect((await git.raw(["stash", "list"])).stdout.trim()).toBe("");
    expect(await read(git, "a.txt")).toBe("one\n");
  });

  test("reset --hard rewinds; mixed keeps the working tree", async () => {
    const git = await initRepo();
    const first = await seed(git, { "a.txt": "one\n" }, "init");
    await seed(git, { "a.txt": "two\n" }, "second");

    await git.reset({ to: first });
    expect((await git.head()).sha).toBe(first);
    expect(await read(git, "a.txt")).toBe("two\n");
    expect((await git.status()).unstaged).toEqual(["a.txt"]);

    await git.reset({ to: first, mode: "hard" });
    expect(await read(git, "a.txt")).toBe("one\n");
    expect((await git.status()).clean).toBe(true);
  });

  test("clean is a dry run without force", async () => {
    const git = await initRepo();
    await seed(git, { "a.txt": "one\n" }, "init");
    await write(git, "junk.txt", "junk\n");
    await write(git, "tmp/more.txt", "junk\n");

    await git.clean();
    expect(existsSync(path.join(git.cwd, "junk.txt"))).toBe(true);

    await git.clean({ force: true });
    expect(existsSync(path.join(git.cwd, "junk.txt"))).toBe(false);
    expect(existsSync(path.join(git.cwd, "tmp"))).toBe(false);
    expect((await git.status()).clean).toBe(true);
  });
});

describe("unmergedPaths", () => {
  test("is empty on a healthy tree and lists conflicts during a merge", async () => {
    const git = await initRepo();
    await seed(git, { "a.txt": "one\n" }, "init");
    expect(await git.unmergedPaths()).toEqual([]);

    await git.branchCreate("feature", { checkout: true });
    await seed(git, { "a.txt": "feature\n" }, "feature edit");
    await git.checkout("main");
    await seed(git, { "a.txt": "main\n" }, "main edit");

    const merge = await git.raw(["merge", "feature"], { allowFailure: true });
    expect(merge.exitCode).not.toBe(0);
    expect(await git.unmergedPaths()).toEqual(["a.txt"]);

    const status = await git.status();
    expect(status.clean).toBe(false);
    expect(status.unstaged).toContain("a.txt");
    await git.raw(["merge", "--abort"]);
    expect(await git.unmergedPaths()).toEqual([]);
  });

  test("a conflicted pathname with a quote and a newline comes back verbatim", async () => {
    const git = await initRepo();
    // Even with core.quotePath=false, line-oriented output C-quotes control
    // bytes and quotes — callers would try to resolve the quoted SPELLING.
    const name = 'we"ird\nname.txt';
    await seed(git, { [name]: "one\n" }, "init");
    await git.branchCreate("feature", { checkout: true });
    await seed(git, { [name]: "feature\n" }, "feature edit");
    await git.checkout("main");
    await seed(git, { [name]: "main\n" }, "main edit");

    const merge = await git.raw(["merge", "feature"], { allowFailure: true });
    expect(merge.exitCode).not.toBe(0);
    expect(await git.unmergedPaths()).toEqual([name]);
  });
});

describe("remotes", () => {
  test("pushes to, fetches from and pulls from a local bare remote", async () => {
    const bare = path.join(await tempDir(), "remote.git");
    await execa("git", ["init", "--bare", "-b", "main", bare]);

    const local = await initRepo();
    const sha = await seed(local, { "a.txt": "one\n" }, "init");
    await local.raw(["remote", "add", "origin", bare]);
    await local.push({ branch: "main", setUpstream: true });
    const remoteHead = await execa("git", ["rev-parse", "main"], { cwd: bare });
    expect(remoteHead.stdout.trim()).toBe(sha);

    const cloneDir = path.join(await tempDir(), "clone");
    await execa("git", ["clone", bare, cloneDir]);
    await configure(cloneDir);
    const clone = createGit(cloneDir);
    const pushed = await seed(clone, { "b.txt": "two\n" }, "from the clone");
    await clone.push({ branch: "main" });

    await local.fetchRemote();
    expect(await local.revParse("origin/main")).toBe(pushed);
    await local.pull({ rebase: true });
    expect((await local.head()).sha).toBe(pushed);
    expect(await read(local, "b.txt")).toBe("two\n");
  });
});

describe("option-like refs", () => {
  test("a ref that begins with a dash is rejected before git ever sees it", async () => {
    const git = await initRepo();
    await seed(git, { "a.txt": "one\n" }, "init");

    // `git show --output=<file>` WRITES that file — from a method the engine
    // classifies as a journaled read. The guard must fire, and nothing may land.
    const smuggled = path.join(git.cwd, "smuggled.txt");
    await expect(git.show(`--output=${smuggled}`)).rejects.toThrow(/invalid ref/);
    expect(existsSync(smuggled)).toBe(false);

    await expect(git.diff({ from: `--output=${smuggled}` })).rejects.toThrow(/invalid ref/);
    await expect(git.log({ to: "--all" })).rejects.toThrow(/invalid ref/);
    await expect(git.fileAt(`--output=${smuggled}`, "a.txt")).rejects.toThrow(/invalid ref/);
    await expect(git.checkout("--force")).rejects.toThrow(/invalid ref/);
    await expect(git.reset({ to: "--soft" })).rejects.toThrow(/invalid ref/);
    await expect(git.mergeBase("--all", "HEAD")).rejects.toThrow(/invalid ref/);
    await expect(git.branchCreate("--track")).rejects.toThrow(/invalid branch/);
    await expect(git.tag("--force")).rejects.toThrow(/invalid tag name/);
    await expect(git.push({ remote: "--mirror" })).rejects.toThrow(/invalid remote/);
    expect(existsSync(smuggled)).toBe(false);

    // Legitimate refs still flow: revision expressions, ranges, ref:path.
    expect((await git.show("HEAD")).content).toContain("a.txt");
    expect((await git.fileAt("HEAD", "a.txt")).content).toBe("one\n");
  });
});
