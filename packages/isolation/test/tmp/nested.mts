import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execa } from "execa";

const g = (d, ...a) => execa("git", a, { cwd: d });
const repo = await mkdtemp(join(tmpdir(), "nest-"));
await g(repo, "init", "-b", "main");
await g(repo, "config", "user.email", "a@b");
await g(repo, "config", "user.name", "a");
await writeFile(join(repo, "README.md"), "x\n");
await g(repo, "add", "-A");
await g(repo, "commit", "-m", "i");
const wt = join(await mkdtemp(join(tmpdir(), "wt-")), "w");
await g(repo, "worktree", "add", "--detach", wt, "HEAD");
// The agent scaffolds a new project that happens to run `git init` (create-next-app, cargo new, etc.)
await mkdir(join(wt, "subproj"), { recursive: true });
await writeFile(join(wt, "subproj", "index.ts"), "export const x = 1;\n");
await g(join(wt, "subproj"), "init", "-b", "main");
await g(join(wt, "subproj"), "config", "user.email", "a@b");
await g(join(wt, "subproj"), "config", "user.name", "a");
await g(join(wt, "subproj"), "add", "-A");
await g(join(wt, "subproj"), "commit", "-m", "sub");
const { capturePatch, applyPatchToTree } = await import("../../src/index.ts");
const cap = await capturePatch({ worktreePath: wt, alsoInclude: ["**"] });
console.log("FILES:", JSON.stringify(cap.files));
console.log("PATCH:", JSON.stringify(cap.patch.slice(0, 260)));
const out = await applyPatchToTree({ repoRoot: repo, patch: cap.patch });
console.log("APPLY:", JSON.stringify(out));
console.log(
  "CONTENT AFTER:",
  await readFile(join(repo, "subproj/index.ts"), "utf8").catch((e) => `*** LOST: ${e.code}`),
);
await rm(repo, { recursive: true, force: true });
