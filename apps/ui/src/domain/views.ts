import { extColor } from "./palette";
import type { Artifact, FileChange, Run } from "./types";

/* ── Run detail ────────────────────────────────────────────────────────── */

/** Where a run was opened from, so its back button can say so. */
export type RunOrigin = "queue" | "runs";

export const RUN_TABS = ["steps", "notes", "artifacts", "changes"] as const;
export type RunTab = (typeof RUN_TABS)[number];

export type RunTabDef = { key: RunTab; label: string; badge: string };

/** Findings and Changes disappear entirely when a run produced neither. */
export function runTabs(run: Run, pendingGate: boolean): RunTabDef[] {
  const defs: RunTabDef[] = [
    { key: "steps", label: "Steps", badge: pendingGate ? "1" : "" },
    { key: "notes", label: "Notes", badge: String(run.findings.length) },
    { key: "artifacts", label: "Artifacts", badge: String(run.artifacts.length) },
    { key: "changes", label: "Changes", badge: String(run.files.length) },
  ];
  return defs.filter((tab) => tab.key === "steps" || tab.badge !== "0");
}

export function isRunTab(value: string | undefined): value is RunTab {
  return !!value && (RUN_TABS as readonly string[]).includes(value);
}

/** Fall back to the pending gate, then to whatever step the run recorded first. */
export function resolveStepId(run: Run, requested: string | undefined, pendingGate: boolean): string {
  if (requested && run.steps[requested]) return requested;
  if (pendingGate && run.gateStep) return run.gateStep;
  return Object.keys(run.steps)[0] ?? "";
}

export function resolveArtifact(run: Run, requested: string | undefined): Artifact | undefined {
  return run.artifacts.find((a) => a.name === requested) ?? run.artifacts[0];
}

export function resolveFile(run: Run, requested: string | undefined): FileChange | undefined {
  return run.files.find((f) => f.path === requested) ?? run.files[0];
}

export function totalAdds(files: FileChange[]): number {
  return files.reduce((n, f) => n + f.adds, 0);
}

export function totalDels(files: FileChange[]): number {
  return files.reduce((n, f) => n + f.dels, 0);
}

/* ── Changes tree ──────────────────────────────────────────────────────── */

export type TreeNode = {
  key: string;
  name: string;
  isFile: boolean;
  depth: number;
  path: string;
  /** File statistics, "" for directories. */
  stat: string;
  ext: string;
  extColor: string;
};

/** Flatten the changed paths into the always-expanded tree the design shows. */
export function fileTree(files: FileChange[]): TreeNode[] {
  const rows: TreeNode[] = [];
  const seen = new Set<string>();
  // Sorted first, or this is not a tree: patches arrive in capture order, so a second file
  // under `src/` reached after a root-level file would open `src/components/` below it and
  // the indentation would describe a hierarchy that is not there.
  const ordered = [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  for (const file of ordered) {
    const parts = file.path.split("/");
    const name = parts.pop() ?? "";
    let path = "";
    parts.forEach((part, depth) => {
      path = path ? `${path}/${part}` : part;
      if (seen.has(path)) return;
      seen.add(path);
      rows.push({
        key: `dir:${path}`,
        name: part,
        isFile: false,
        depth,
        path,
        stat: "",
        ext: "",
        extColor: "",
      });
    });
    // `.gitignore` has no extension — its leading dot is part of the name.
    const dot = name.lastIndexOf(".");
    const ext = dot > 0 ? name.slice(dot + 1).toUpperCase() : "";
    rows.push({
      key: `file:${file.path}`,
      name,
      isFile: true,
      depth: parts.length,
      path: file.path,
      stat: `+${file.adds} −${file.dels}`,
      ext,
      extColor: extColor(ext),
    });
  }
  return rows;
}
