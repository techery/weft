/**
 * The git CLI behind the `Git` interface.
 *
 * Every op shells out to `git` in one fixed working directory with a deterministic,
 * non-interactive environment. Reads parse porcelain/plumbing formats into typed
 * values; writes return just enough (shas) to idempotency-check on resume.
 */

import { randomUUID } from "node:crypto";
import { rm as fsRm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  GitBlameLine,
  GitCommitInfo,
  GitDiffStats,
  GitFileStatus,
  GitRange,
  GitStatusResult,
} from "@techery/weft-sdk";
import { execa } from "execa";
import type { Git, RawResult } from "./index.ts";
import { GitError } from "./index.ts";

/**
 * Environment overrides that keep git non-interactive and its output parseable.
 *
 * `GIT_EXTERNAL_DIFF` names a program git runs INSTEAD of producing a diff, and it comes
 * from the operator's shell, not the repository. Left alone, every captured patch is
 * whatever that program printed — `capturePatch` would journal it, `git apply` would
 * refuse it, and the agent's work would be silently lost. Emptied here (git treats an
 * empty value as unset) so no weft invocation can be hijacked by it.
 */
const GIT_ENV: Record<string, string> = {
  GIT_TERMINAL_PROMPT: "0",
  GIT_PAGER: "cat",
  GIT_OPTIONAL_LOCKS: "0",
  LC_ALL: "C",
  GIT_EXTERNAL_DIFF: "",
};

/** Prefix for commands whose output we parse: keeps non-ASCII paths unquoted. */
const RAW_PATHS = ["-c", "core.quotePath=false"];

/** Longest stderr excerpt carried in a GitError message; the full text stays on `.stderr`. */
const STDERR_EXCERPT = 400;

/** Refuse option-like values in revision/name argv positions. Git itself forbids
 * refs that start with "-" (check-ref-format), so nothing legitimate is lost —
 * but passed through, `show("--output=/x")` would WRITE a file from an operation
 * classified as a journaled read, outside every write gate. */
function refArg(value: string, what = "ref"): string {
  if (value === "" || value.startsWith("-")) {
    throw new GitError(`invalid ${what}: ${JSON.stringify(value)} (empty or option-like)`, {
      args: [],
      exitCode: -1,
      stderr: "",
    });
  }
  return value;
}

export class GitCli implements Git {
  readonly cwd: string;

  constructor(cwd: string) {
    this.cwd = cwd;
  }

  async raw(
    args: string[],
    opts: { allowFailure?: boolean; input?: string; env?: Record<string, string> } = {},
  ): Promise<RawResult> {
    // A pathname-valued core.fsmonitor is a HOOK git executes on any worktree
    // scan (status, diff, ls-files) — repository-configured code that a typed,
    // approval-free read must never run. Disabled on EVERY invocation: for
    // writes the fsmonitor is only a scan optimization, so nothing is lost.
    //
    // `diff.external` is the same hazard one step further on: a repository-configured
    // program that REPLACES git's diff output, so a captured patch becomes that
    // program's stdout and the agent's work never lands. Emptied for the same reason,
    // alongside GIT_EXTERNAL_DIFF in GIT_ENV.
    const result = await execa("git", ["-c", "core.fsmonitor=false", "-c", "diff.external=", ...args], {
      cwd: this.cwd,
      reject: false,
      stripFinalNewline: false,
      env: opts.env ? { ...GIT_ENV, ...opts.env } : GIT_ENV,
      input: opts.input,
    });
    const stdout = typeof result.stdout === "string" ? result.stdout : "";
    const stderr = typeof result.stderr === "string" ? result.stderr : "";
    const exitCode = result.exitCode ?? (result.failed ? 1 : 0);
    if (exitCode !== 0 && !opts.allowFailure) {
      throw new GitError(failureMessage(args, exitCode, stderr), { args, exitCode, stderr });
    }
    return { stdout, stderr, exitCode };
  }

  /** `raw` for commands whose output is parsed rather than passed through. */
  private plumb(args: string[], opts: { allowFailure?: boolean; input?: string } = {}): Promise<RawResult> {
    return this.raw([...RAW_PATHS, ...args], opts);
  }

  // -- reads -----------------------------------------------------------------

  async status(): Promise<GitStatusResult> {
    // -z: NUL-terminated entries, and no C-quoting — a pathname holding a
    // newline, tab, quote, or backslash comes back verbatim instead of as its
    // quoted spelling. A rename entry's ORIGINAL path rides as its own NUL field.
    const { stdout } = await this.plumb([
      "status",
      "--porcelain=v2",
      "--branch",
      "--untracked-files=all",
      "-z",
    ]);
    const staged: string[] = [];
    const unstaged: string[] = [];
    const untracked: string[] = [];
    let branch = "";
    let entries = 0;
    const tokens = stdout.split("\0");
    for (let i = 0; i < tokens.length; i++) {
      const line = tokens[i] ?? "";
      if (line === "") continue;
      if (line.startsWith("# branch.head ")) {
        branch = line.slice("# branch.head ".length).trim();
        continue;
      }
      // Other headers (branch.oid/upstream/ab) and ignored entries are not changes.
      if (line.startsWith("#") || line.startsWith("!")) continue;
      entries++;
      if (line.startsWith("? ")) {
        untracked.push(line.slice(2));
        continue;
      }
      const fields = line.split(" ");
      const kind = fields[0] ?? "";
      const path = entryPath(kind, fields);
      if (kind === "2") i++; // skip the rename's origPath field
      if (path === "") continue;
      // Unmerged entries have no meaningful staged half; they read as work in progress.
      if (kind === "u") {
        unstaged.push(path);
        continue;
      }
      const xy = fields[1] ?? "..";
      if (xy[0] !== ".") staged.push(path);
      if (xy[1] !== ".") unstaged.push(path);
    }
    return { branch, clean: entries === 0, staged, unstaged, untracked };
  }

  async head(): Promise<{ sha: string }> {
    const { stdout } = await this.raw(["rev-parse", "HEAD"]);
    return { sha: stdout.trim() };
  }

  async branches(): Promise<{ current: string; all: string[] }> {
    const { stdout } = await this.raw(["branch", "--format=%(refname:short)"]);
    const all = splitLines(stdout).map((l) => l.trim());
    const head = await this.raw(["rev-parse", "--abbrev-ref", "HEAD"], { allowFailure: true });
    const current = head.exitCode === 0 ? head.stdout.trim() : "";
    return { current, all };
  }

  async mergeBase(a: string, b: string): Promise<{ sha: string }> {
    const { stdout } = await this.raw(["merge-base", refArg(a), refArg(b)]);
    return { sha: stdout.trim() };
  }

  async changedSince(ref: string): Promise<{ files: Array<{ path: string; status: GitFileStatus }> }> {
    const { sha } = await this.mergeBase(ref, "HEAD");
    // No second revision: git diffs the merge base against the working tree, so
    // uncommitted edits count as changes too. -z: NUL-delimited records with no
    // C-quoting — a filename holding a newline, tab, quote, or backslash
    // round-trips exactly instead of arriving mangled (or as two entries).
    const { stdout } = await this.plumb(["diff", "--name-status", "-z", sha]);
    const files: Array<{ path: string; status: GitFileStatus }> = [];
    const seen = new Set<string>();
    const tokens = stdout.split("\0");
    for (let i = 0; i < tokens.length; ) {
      const code = tokens[i++] ?? "";
      if (code === "") continue;
      // Renames and copies carry old and new paths; the new one is what changed.
      const first = tokens[i++];
      const path = code.startsWith("R") || code.startsWith("C") ? tokens[i++] : first;
      if (path === undefined || path === "" || seen.has(path)) continue;
      seen.add(path);
      files.push({ path, status: fileStatus(code) });
    }
    const others = await this.plumb(["ls-files", "--others", "--exclude-standard", "-z"]);
    for (const path of others.stdout.split("\0")) {
      if (path === "" || seen.has(path)) continue;
      seen.add(path);
      files.push({ path, status: "A" });
    }
    return { files };
  }

  async diff(range: GitRange = {}): Promise<{ patch: string; stats: GitDiffStats }> {
    // A repository can attach EXECUTABLE helpers to plain `git diff` through
    // .gitattributes: `diff.<driver>.command` replaces the hunk machinery and
    // `diff.<driver>.textconv` rewrites the blobs, both running by default on
    // porcelain diffs. A typed READ must never execute repository-controlled
    // code, so both invocations disable them explicitly.
    const args = ["--no-ext-diff", "--no-textconv", ...diffArgs(range)];
    const { stdout } = await this.raw(["diff", ...args]);
    const numstat = await this.plumb(["diff", "--numstat", ...args]);
    return { patch: stdout, stats: parseNumstat(numstat.stdout) };
  }

  async log(opts: GitRange & { max?: number } = {}): Promise<{ commits: GitCommitInfo[] }> {
    // NUL-separated records (`-z`): a commit message can carry any byte except
    // NUL, so in-band separators like \x1e/\x1f would split a hostile message
    // into phantom commits. Within a record, %H/%an/%aI/%s can't contain
    // newlines (git rejects NL in idents and %s collapses the subject to one
    // line), so the first four lines are fixed and everything after is %b.
    const args = ["log", "-z", "--format=%H%n%an%n%aI%n%s%n%b"];
    if (opts.max !== undefined) args.push("-n", String(opts.max));
    args.push(
      opts.from !== undefined
        ? `${refArg(opts.from)}..${refArg(opts.to ?? "HEAD")}`
        : refArg(opts.to ?? "HEAD"),
    );
    if (opts.paths && opts.paths.length > 0) args.push("--", ...opts.paths);
    const { stdout } = await this.raw(args);
    const commits: GitCommitInfo[] = [];
    for (const record of stdout.split("\0")) {
      if (record.trim() === "") continue;
      const lines = record.split("\n");
      commits.push({
        sha: lines[0] ?? "",
        author: lines[1] ?? "",
        date: lines[2] ?? "",
        subject: lines[3] ?? "",
        body: lines.slice(4).join("\n").trimEnd(),
      });
    }
    return { commits };
  }

  async show(ref: string): Promise<{ content: string }> {
    // Showing a COMMIT renders its patch, which runs .gitattributes textconv
    // helpers by default — the same repository-controlled execution diff()
    // refuses. Blob refs ignore the flags, so they are safe unconditionally.
    const { stdout } = await this.raw(["show", "--no-ext-diff", "--no-textconv", refArg(ref)]);
    return { content: stdout };
  }

  async blame(path: string, opts: { lines?: [number, number] } = {}): Promise<{ lines: GitBlameLine[] }> {
    // blame also honors .gitattributes textconv by default; --no-textconv keeps
    // this a pure read (blame has no ext-diff path to disable).
    const args = ["blame", "--no-textconv", "--line-porcelain"];
    if (opts.lines) args.push("-L", `${opts.lines[0]},${opts.lines[1]}`);
    args.push("--", path);
    const { stdout } = await this.plumb(args);
    const lines: GitBlameLine[] = [];
    let sha = "";
    let author = "";
    let line = 0;
    for (const raw of stdout.split("\n")) {
      // The content of a blamed line is the only tab-prefixed line in a group.
      if (raw.startsWith("\t")) {
        lines.push({ line, sha, author, content: raw.slice(1) });
        continue;
      }
      const header = /^([0-9a-f]{7,40}) \d+ (\d+)(?: \d+)?$/.exec(raw);
      if (header) {
        sha = header[1] ?? "";
        line = Number.parseInt(header[2] ?? "0", 10);
        continue;
      }
      // "author-mail"/"author-time" share the prefix; only the bare key is the name.
      if (raw.startsWith("author ")) author = raw.slice("author ".length);
    }
    return { lines };
  }

  async fileAt(ref: string, path: string): Promise<{ content: string }> {
    const { stdout } = await this.raw(["show", `${refArg(ref)}:${path}`]);
    return { content: stdout };
  }

  async snapshot(): Promise<{ ref: string }> {
    // NOT `stash create`: it omits untracked files, so its ref would misdescribe
    // the tree this method promises to capture. A throwaway index — HEAD-seeded
    // so gitignore-matched tracked files stay in, then `add -A` for everything
    // else — becomes a dangling commit without touching HEAD, the real index, or
    // the working tree.
    const indexFile = join(tmpdir(), `weft-snap-${randomUUID()}`);
    const env = {
      GIT_INDEX_FILE: indexFile,
      GIT_AUTHOR_NAME: "weft",
      GIT_AUTHOR_EMAIL: "weft@snapshot.invalid",
      GIT_COMMITTER_NAME: "weft",
      GIT_COMMITTER_EMAIL: "weft@snapshot.invalid",
    };
    try {
      await this.raw(["read-tree", "HEAD"], { env });
      await this.raw(["add", "-A", "."], { env });
      const tree = (await this.raw(["write-tree"], { env })).stdout.trim();
      const headTree = (await this.raw(["rev-parse", "HEAD^{tree}"])).stdout.trim();
      // A tree identical to HEAD needs no commit; HEAD already describes the state.
      if (tree === headTree) return { ref: (await this.head()).sha };
      const commit = (
        await this.raw(["commit-tree", tree, "-p", "HEAD", "-m", "weft snapshot"], { env })
      ).stdout.trim();
      // PINNED, not dangling: the sha is journaled and read back across
      // suspensions that can outlive gc's prune horizon, and an unreferenced
      // commit-tree object is exactly what `git gc --prune` collects. The ref
      // is content-addressed (same tree → same commit → same ref, idempotent)
      // and namespaced so `git for-each-ref refs/weft/snapshots` audits or
      // clears them; ordinary ref listings and log --all decorations skip it.
      await this.raw(["update-ref", `refs/weft/snapshots/${commit}`, commit]);
      return { ref: commit };
    } finally {
      await fsRm(indexFile, { force: true }).catch(() => undefined);
    }
  }

  async revParse(ref: string): Promise<string | null> {
    const result = await this.raw(["rev-parse", "--verify", "--quiet", refArg(ref)], { allowFailure: true });
    const sha = result.stdout.trim();
    return result.exitCode === 0 && sha !== "" ? sha : null;
  }

  // -- writes ----------------------------------------------------------------

  async add(opts: { paths: string[] }): Promise<void> {
    if (opts.paths.length === 0) return;
    await this.raw(["add", "--", ...opts.paths]);
  }

  async commit(opts: { message: string; paths?: string[]; allowEmpty?: boolean }): Promise<{ sha: string }> {
    const args = ["commit", "-m", opts.message];
    if (opts.allowEmpty) args.push("--allow-empty");
    if (opts.paths && opts.paths.length > 0) args.push("--", ...opts.paths);
    await this.raw(args);
    return this.head();
  }

  async checkout(ref: string, opts: { discard?: boolean } = {}): Promise<void> {
    // Discarding is a path-scoped checkout ("restore this path from the index").
    await this.raw(opts.discard ? ["checkout", "--", ref] : ["checkout", refArg(ref)]);
  }

  async fetchRemote(opts: { remote?: string } = {}): Promise<void> {
    await this.raw(["fetch", refArg(opts.remote ?? "origin", "remote")]);
  }

  async pull(opts: { rebase?: boolean; remote?: string; branch?: string } = {}): Promise<void> {
    const args = ["pull"];
    if (opts.rebase) args.push("--rebase");
    const remote = opts.remote ?? (opts.branch !== undefined ? "origin" : undefined);
    if (remote !== undefined) args.push(refArg(remote, "remote"));
    if (opts.branch !== undefined) args.push(refArg(opts.branch, "branch"));
    await this.raw(args);
  }

  async push(
    opts: { remote?: string; branch?: string; setUpstream?: boolean; force?: boolean } = {},
  ): Promise<void> {
    const args = ["push"];
    if (opts.setUpstream) args.push("-u");
    if (opts.force) args.push("--force");
    args.push(refArg(opts.remote ?? "origin", "remote"));
    if (opts.branch !== undefined) args.push(refArg(opts.branch, "branch"));
    await this.raw(args);
  }

  async reset(opts: { to: string; mode?: "soft" | "mixed" | "hard" }): Promise<void> {
    await this.raw(["reset", `--${opts.mode ?? "mixed"}`, refArg(opts.to)]);
  }

  async applyPatch(opts: { patch: string; threeWay?: boolean; index?: boolean }): Promise<void> {
    const args = ["apply"];
    if (opts.threeWay) args.push("--3way");
    if (opts.index) args.push("--index");
    await this.raw(args, { input: terminate(opts.patch) });
  }

  async tag(name: string, opts: { ref?: string } = {}): Promise<void> {
    const args = ["tag", refArg(name, "tag name")];
    if (opts.ref !== undefined) args.push(refArg(opts.ref));
    await this.raw(args);
  }

  async branchCreate(name: string, opts: { from?: string; checkout?: boolean } = {}): Promise<void> {
    const args = opts.checkout
      ? ["checkout", "-b", refArg(name, "branch")]
      : ["branch", refArg(name, "branch")];
    if (opts.from !== undefined) args.push(refArg(opts.from));
    await this.raw(args);
  }

  async branchDelete(name: string, opts: { force?: boolean } = {}): Promise<void> {
    await this.raw(["branch", opts.force ? "-D" : "-d", refArg(name, "branch")]);
  }

  async stashPush(opts: { message?: string } = {}): Promise<void> {
    const args = ["stash", "push"];
    if (opts.message !== undefined) args.push("-m", opts.message);
    await this.raw(args);
  }

  async stashPop(): Promise<void> {
    await this.raw(["stash", "pop"]);
  }

  async stashDrop(): Promise<void> {
    await this.raw(["stash", "drop"]);
  }

  async clean(opts: { force?: boolean } = {}): Promise<void> {
    // Without force this is a dry run: the irreversible tier only fires deliberately.
    await this.raw(["clean", opts.force ? "-fd" : "-nd"]);
  }

  async unmergedPaths(): Promise<string[]> {
    // -z: even with core.quotePath=false, a pathname holding a newline, tab,
    // quote or backslash is C-quoted in line-oriented output — callers would
    // try to resolve the quoted SPELLING, not the file.
    const { stdout } = await this.plumb(["diff", "--name-only", "--diff-filter=U", "-z"]);
    return [...new Set(stdout.split("\0").filter((path) => path !== ""))];
  }
}

// ---------------------------------------------------------------------------
// Parsing helpers
// ---------------------------------------------------------------------------

/** Non-empty lines, tolerant of the trailing newline every git command emits. */
function splitLines(stdout: string): string[] {
  return stdout.split("\n").filter((line) => line !== "");
}

/** The path field of a porcelain=v2 entry; rename entries append "\t<origPath>". */
function entryPath(kind: string, fields: string[]): string {
  const skip = kind === "1" ? 8 : kind === "2" ? 9 : 10;
  const rest = fields.slice(skip).join(" ");
  const tab = rest.indexOf("\t");
  return tab === -1 ? rest : rest.slice(0, tab);
}

/** `--name-status` codes narrowed to the four statuses the SDK reports. */
function fileStatus(code: string): GitFileStatus {
  const letter = code[0] ?? "M";
  if (letter === "A" || letter === "D" || letter === "R") return letter;
  // A copy is a new file at the destination path; T/U/M all read as modifications.
  return letter === "C" ? "A" : "M";
}

/**
 * `from [to] [-- paths]`. With an explicit `from`, `to` defaults to HEAD (the
 * documented contract, matching log); a no-range diff() compares HEAD to the
 * working tree.
 */
function diffArgs(range: GitRange): string[] {
  const args = [refArg(range.from ?? "HEAD")];
  if (range.to !== undefined) args.push(refArg(range.to));
  else if (range.from !== undefined) args.push("HEAD");
  if (range.paths && range.paths.length > 0) args.push("--", ...range.paths);
  return args;
}

function parseNumstat(stdout: string): GitDiffStats {
  let files = 0;
  let insertions = 0;
  let deletions = 0;
  for (const line of splitLines(stdout)) {
    const fields = line.split("\t");
    files++;
    insertions += counted(fields[0]);
    deletions += counted(fields[1]);
  }
  return { files, insertions, deletions };
}

/** Binary files report "-" instead of a line count. */
function counted(value: string | undefined): number {
  const n = Number.parseInt(value ?? "", 10);
  return Number.isNaN(n) ? 0 : n;
}

/** git apply rejects a patch whose last line is unterminated. */
function terminate(patch: string): string {
  return patch === "" || patch.endsWith("\n") ? patch : `${patch}\n`;
}

function failureMessage(args: string[], exitCode: number, stderr: string): string {
  const excerpt = stderr.trim().slice(0, STDERR_EXCERPT);
  const head = `git ${subcommandOf(args)} failed (exit ${exitCode})`;
  return excerpt === "" ? head : `${head}: ${excerpt}`;
}

/** First non-option argument, skipping `-c key=value` / `-C dir` pairs. */
function subcommandOf(args: string[]): string {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? "";
    if (arg === "-c" || arg === "-C") {
      i++;
      continue;
    }
    if (!arg.startsWith("-")) return arg;
  }
  return "";
}
