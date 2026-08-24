/**
 * Worktree lifecycle: a write step gets its own checkout of the integration tree,
 * detached at a known sha so nothing it does can move a branch.
 */
import { mkdir, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { createGit } from "@weft/git";
import type { WorktreeHandle } from "./index.ts";

/** `git worktree add --detach <dir> <baseRef|HEAD>`; dir is created (parents too). */
export async function addWorktree(opts: {
  repoRoot: string;
  dir: string;
  baseRef?: string;
}): Promise<WorktreeHandle> {
  const path = resolve(opts.dir);
  // git creates the leaf itself and refuses a path whose parent is missing.
  await mkdir(dirname(path), { recursive: true });
  const repo = createGit(opts.repoRoot);
  await repo.raw(["worktree", "add", "--detach", path, opts.baseRef ?? "HEAD"]);
  // Read the base back from the worktree: baseRef may have been a branch or tag.
  const { sha } = await createGit(path).head();
  return { path, base: sha };
}

/** Remove a worktree (force) and prune; tolerates an already-removed dir. */
export async function removeWorktree(opts: { repoRoot: string; path: string }): Promise<void> {
  const path = resolve(opts.path);
  const repo = createGit(opts.repoRoot);
  const removed = await repo.raw(["worktree", "remove", "--force", path], { allowFailure: true });
  if (removed.exitCode === 0) return;
  // The dir may be gone, corrupt, or never registered; drop it and let git catch up.
  await rm(path, { recursive: true, force: true });
  await repo.raw(["worktree", "prune"], { allowFailure: true });
}
