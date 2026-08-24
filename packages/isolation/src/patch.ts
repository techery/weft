/**
 * Patch capture and application. A worktree's work leaves it as one patch; the
 * engine journals that patch and replays it against the integration tree here.
 */
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGit } from "@weft/git";
import type { ApplyOutcome } from "./index.ts";

/**
 * Capture everything the agent changed in the worktree as one patch:
 * stage all (including untracked), then diff --cached against the base.
 * Returns an empty patch ("" and files: []) when nothing changed.
 */
export async function capturePatch(opts: { worktreePath: string }): Promise<{
  patch: string;
  files: string[];
}> {
  const git = createGit(opts.worktreePath);
  // Staging first is what folds untracked files into the diff.
  await git.raw(["add", "-A"]);
  // -z: NUL-delimited, unquoted paths — a filename holding a newline must reach
  // checkScope() as ONE path, not two nonexistent ones. --no-renames: rename
  // detection (on by default since git 2.9) would list only the DESTINATION of
  // `git mv old new`, letting a rename out of an allowed path delete its
  // out-of-scope source unchecked; decomposed to delete+add, both paths list.
  const names = await git.raw(["diff", "--cached", "--name-only", "--no-renames", "-z"]);
  const files = splitNul(names.stdout);
  if (files.length === 0) return { patch: "", files: [] };
  // --binary embeds full content for binary files (images, archives); without it
  // the patch says only "Binary files differ" and can never be applied.
  // --no-renames again: a rename record would re-couple the two paths the file
  // list just decomposed (and a 100%-similarity rename carries no ---/+++ lines
  // for the stderr fallback to name); delete+add hunks are self-contained.
  const { stdout } = await git.raw(["diff", "--cached", "--binary", "--no-renames"]);
  return { patch: stdout, files };
}

/**
 * Apply a patch to the integration tree. Tries a clean apply first, then --3way.
 * A 3-way apply that leaves conflict markers reports the unmerged paths; a patch
 * that cannot apply at all reports its target files as conflicts.
 */
export async function applyPatchToTree(opts: { repoRoot: string; patch: string }): Promise<ApplyOutcome> {
  if (opts.patch.trim() === "") return { ok: true };
  const git = createGit(opts.repoRoot);
  const input = opts.patch.endsWith("\n") ? opts.patch : `${opts.patch}\n`;

  const check = await git.raw(["apply", "--check"], { allowFailure: true, input });
  if (check.exitCode === 0) {
    await git.raw(["apply"], { input });
    return { ok: true };
  }

  // Context drifted: fall back to a 3-way merge using the patch's blob ids. --3way
  // implies --index, which would silently stage the result (and any pre-existing
  // user edits in those files) into the CALLER's index — so the merge runs against
  // a throwaway index staged from the working tree (stat-fresh, so apply treats the
  // tree as clean), and only the working tree keeps the result.
  const indexFile = join(tmpdir(), `weft-apply-${randomUUID()}`);
  const env = { GIT_INDEX_FILE: indexFile };
  try {
    // Seed from HEAD first: on an empty index `add -A` skips a tracked file that
    // .gitignore also matches, and the 3-way would then say it is not in the index.
    await git.raw(["read-tree", "HEAD"], { env });
    await git.raw(["add", "-A", "."], { env });
    const threeWay = await git.raw(["apply", "--3way"], { allowFailure: true, input, env });
    if (threeWay.exitCode === 0) return { ok: true };

    // Conflict markers come with unmerged entries — in the throwaway index.
    const unmerged = await git.raw(["diff", "--name-only", "--diff-filter=U", "-z"], { env });
    const conflicted = splitNul(unmerged.stdout);
    if (conflicted.length > 0) return { ok: false, conflicts: conflicted };
    const reported = filesFromStderr(`${threeWay.stderr}\n${check.stderr}`);
    return { ok: false, conflicts: reported.length > 0 ? reported : filesFromPatch(opts.patch) };
  } finally {
    await rm(indexFile, { force: true }).catch(() => undefined);
  }
}

/** Restore files from a snapshot ref (undo a conflicted application). */
export async function restoreFiles(opts: { repoRoot: string; ref: string; paths?: string[] }): Promise<void> {
  const paths = opts.paths && opts.paths.length > 0 ? opts.paths : ["."];
  await createGit(opts.repoRoot).raw(["checkout", opts.ref, "--", ...paths]);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function splitNul(stdout: string): string[] {
  return stdout.split("\0").filter((path) => path !== "");
}

/** Files named by `git apply`'s own error lines, in the order it reported them. */
function filesFromStderr(stderr: string): string[] {
  const patterns = [
    /^error: patch failed: (.+):\d+$/,
    /^error: (.+?): (?:patch does not apply|does not exist in index|No such file or directory)$/,
    /^error: (.+?): already exists in working directory$/,
    /^error: cannot apply binary patch to '(.+?)' without full index line$/,
  ];
  const files = new Set<string>();
  for (const line of stderr.split("\n")) {
    for (const pattern of patterns) {
      const match = pattern.exec(line.trim());
      if (match?.[1] !== undefined) files.add(match[1]);
    }
  }
  return [...files];
}

/** Last resort when git said nothing usable: the patch's own target paths. */
function filesFromPatch(patch: string): string[] {
  const files = new Set<string>();
  let removed = "";
  for (const line of patch.split("\n")) {
    const source = /^--- (?:a\/)?(.+)$/.exec(line);
    if (source?.[1] !== undefined) {
      removed = headerPath(source[1]);
      continue;
    }
    const target = /^\+\+\+ (?:b\/)?(.+)$/.exec(line);
    if (target?.[1] === undefined) continue;
    // A deletion writes "+++ /dev/null"; the path being removed is the target then.
    const path = headerPath(target[1]);
    if (path !== "/dev/null") files.add(path);
    else if (removed !== "" && removed !== "/dev/null") files.add(removed);
  }
  return [...files];
}

/** Diff headers may carry a trailing tab and timestamp. */
function headerPath(field: string): string {
  return field.replace(/\t.*$/, "");
}
