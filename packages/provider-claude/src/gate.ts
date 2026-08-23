/**
 * The live tool gate. Weft's write scope is enforced *before* the edit lands on
 * Claude (§09: "Live: canUseTool denies edit tools outside scope (strict) or flags
 * them (warn), screens Bash writes"), and shell commands that publish work off the
 * machine are routed to the HITL broker instead of being decided here.
 */
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { CanUseTool, PermissionResult } from "@anthropic-ai/claude-agent-sdk";
import type { AgentRequest } from "@weft/core";
import picomatch from "picomatch";
import {
  baseToolName,
  EDIT_TOOLS,
  editTargetPath,
  isReadOnlyCommand,
  isRiskyCommand,
  isWriteCommand,
  STRUCTURED_OUTPUT_TOOL,
} from "./tools.ts";

/** Sent back to the agent for every denial on a read-only step, edits and shell writes alike. */
export const READ_ONLY_MESSAGE = "this is a read-only step";

/** An absolute or home-anchored path anywhere in a command (except /dev/null). */
const OUT_OF_TREE_PATH = /(?:^|[\s='"`])(?:\/(?!dev\/null\b)|~\/|\$HOME\b)/;

/**
 * A `..` path segment anywhere in a command: relative traversal climbs out of the
 * worktree just as surely as an absolute path (`> ../../outside`), and patch
 * capture cannot see or quarantine what lands beyond the tree. Deliberately
 * coarse — an in-tree `foo/../bar` is also refused; strict scope prefers a false
 * deny over an unquarantined write. Range spellings like HEAD..main don't match
 * (`..` must border a separator on both sides).
 */
const PARENT_TRAVERSAL = /(?:^|[\s='"`/])\.\.(?:[/\s'"`]|$)/;

export interface ToolGateOptions {
  req: AgentRequest;
  /** Called with the workspace-relative path of every edit the gate lets through. */
  onEdit: (path: string) => void;
}

/**
 * Resolve a tool's path argument against the step cwd and normalize it to a
 * posix-relative path — the form write-scope globs are written in. Paths outside
 * the cwd keep their `../` prefix, so no glob matches them.
 */
export function workspacePath(cwd: string, path: string): string {
  const abs = isAbsolute(path) ? path : resolve(cwd, path);
  const rel = relative(cwd, abs);
  return rel === "" ? "." : rel.split(sep).join("/");
}

export function createToolGate({ req, onEdit }: ToolGateOptions): CanUseTool {
  const allow: PermissionResult = { behavior: "allow" };
  const deny = (message: string): PermissionResult => ({ behavior: "deny", message });

  const allowEdits = req.tools?.allowEdits ?? true;
  const denied = new Set(req.tools?.deny ?? []);
  const scope = req.writeScope;
  const patterns = scope ? [...scope.paths, ...(scope.also ?? [])] : [];
  // An empty scope matches nothing — same rule as the post-hoc check in @weft/isolation.
  const inScope = patterns.length > 0 ? picomatch(patterns, { dot: true }) : () => false;
  const scopeMessage = `outside this step's write scope (allowed: ${patterns.join(", ") || "nothing"})`;

  return async (toolName, input) => {
    const base = baseToolName(toolName);
    // The terminating tool is the only way out of a step; it is never gated.
    if (base === STRUCTURED_OUTPUT_TOOL) return allow;
    if (denied.has(base) || denied.has(toolName)) return deny(`tool "${base}" is not available in this step`);

    if (EDIT_TOOLS.has(base)) {
      if (!allowEdits) return deny(READ_ONLY_MESSAGE);
      const target = editTargetPath(input);
      if (target === undefined) return allow;
      const path = workspacePath(req.cwd, target);
      if (scope && !inScope(path)) {
        // "warn" lands the edit and lets the post-hoc patch capture flag it.
        if (scope.mode === "strict") return deny(`${path} is ${scopeMessage}`);
      }
      onEdit(path);
      return allow;
    }

    if (base === "Bash") {
      const command = typeof input.command === "string" ? input.command : "";
      // Read-only steps run in the integration cwd, not a worktree, so the shell is
      // deny-by-default there: only commands known not to write may run.
      if (!allowEdits && !isReadOnlyCommand(command)) return deny(READ_ONLY_MESSAGE);
      // A STRICT write scope relies on worktree patch capture, which only sees the
      // worktree: a shell write aimed at an absolute or home-anchored path — or a
      // relative one that traverses out through `..` — would escape both the scope
      // check and quarantine — deny it up front. Traversal-free relative writes
      // stay allowed (they land in the worktree and are captured).
      if (
        scope?.mode === "strict" &&
        isWriteCommand(command) &&
        (OUT_OF_TREE_PATH.test(command) || PARENT_TRAVERSAL.test(command))
      ) {
        return deny(`shell writes outside the worktree are ${scopeMessage}`);
      }
      if (isRiskyCommand(command)) {
        const decision = await req.hitl.onPermission({ tool: toolName, input, risk: "high" });
        if (decision.behavior === "deny") return deny(decision.message ?? "denied by the approval policy");
      }
      return allow;
    }

    return allow;
  };
}
