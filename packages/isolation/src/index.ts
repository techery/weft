/**
 * @techery/weft-isolation — worktrees, patch capture, write-scope checks, 3-way merge.
 *
 * Write steps run in their own git worktree; their edits come back as patches that
 * the engine journals and merges explicitly (`ctx.integrate`). This package owns the
 * mechanics; policy (warn/strict, conflict handling) lives in the engine.
 */

export interface WorktreeHandle {
  /** Absolute path of the worktree. */
  path: string;
  /** The sha the worktree was created at (detached). */
  base: string;
}

export type ApplyOutcome = { ok: true } | { ok: false; conflicts: string[] };

// The ops themselves live alongside this file; their doc comments travel with them.
export { applyPatchToTree, capturePatch, restoreFiles } from "./patch.ts";
export { checkScope } from "./scope.ts";
export { addWorktree, removeWorktree } from "./worktree.ts";
