/**
 * A unified diff, split by file and turned into renderable lines.
 *
 * The daemon hands back one patch as one blob of `git diff --cached` text plus per-file
 * add/remove counts. The Changes tab shows one file at a time, so the text is split here
 * — and the split has to agree with those counts, which means making the same distinction
 * the daemon's parser does: `---` and `+++` are headers only before the first `@@`, and
 * inside a hunk a line beginning `--- ` is content that happens to look like one.
 */
import type { DiffLine, FileDiff } from "./types";

/** Every file in a patch, keyed by the path the daemon's stats use. */
export function splitDiff(text: string): Record<string, FileDiff> {
  const out: Record<string, FileDiff> = {};
  for (const chunk of splitByFile(text)) {
    const parsed = parseFile(chunk);
    if (parsed) out[parsed.path] = parsed.diff;
  }
  return out;
}

function splitByFile(text: string): string[] {
  const chunks: string[] = [];
  let current: string[] | undefined;
  for (const line of text.split("\n")) {
    if (line.startsWith("diff --git ")) {
      if (current) chunks.push(current.join("\n"));
      current = [line];
      continue;
    }
    current?.push(line);
  }
  if (current) chunks.push(current.join("\n"));
  return chunks;
}

function parseFile(chunk: string): { path: string; diff: FileDiff } | undefined {
  let path: string | undefined;
  let hunk = "";
  const lines: DiffLine[] = [];
  let oldNo = 0;
  let newNo = 0;
  let inHunk = false;

  for (const raw of chunk.split("\n")) {
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;

    if (line.startsWith("@@")) {
      const range = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
      oldNo = range ? Number(range[1]) : 1;
      newNo = range ? Number(range[2]) : 1;
      // The first hunk header is the one the design shows; a file with several keeps the
      // first as its caption and renders every hunk's lines below it.
      if (hunk === "") hunk = line;
      else lines.push({ ln: "", rn: "", text: line, sign: "" });
      inHunk = true;
      continue;
    }

    if (!inHunk) {
      if (line.startsWith("+++ ")) {
        const target = line.slice(4).trim();
        if (target !== "/dev/null") path = stripPrefix(unquote(target));
      } else if (line.startsWith("--- ")) {
        const source = line.slice(4).trim();
        if (path === undefined && source !== "/dev/null") path = stripPrefix(unquote(source));
      } else if (line.startsWith("diff --git ") && path === undefined) {
        path = pathOfGitLine(line);
      }
      continue;
    }

    // `\ No newline at end of file` annotates the line above; it is not a line itself.
    if (line.startsWith("\\")) continue;
    if (line.startsWith("+")) {
      lines.push({ ln: "", rn: String(newNo++), text: line, sign: "+" });
    } else if (line.startsWith("-")) {
      lines.push({ ln: String(oldNo++), rn: "", text: line, sign: "-" });
    } else {
      lines.push({ ln: String(oldNo++), rn: String(newNo++), text: line, sign: "" });
    }
  }

  if (path === undefined) return undefined;
  // A trailing blank from the split is not a context line.
  while (lines.length > 0 && lines[lines.length - 1]?.text === "") lines.pop();
  return { path, diff: { hunk, lines } };
}

function pathOfGitLine(line: string): string {
  const rest = line.slice("diff --git ".length).trim();
  const half = Math.floor(rest.length / 2);
  return stripPrefix(rest.slice(0, half).trim()) || rest;
}

/** Any one- or two-character leading segment is git's diff prefix, whatever it was set to. */
function stripPrefix(path: string): string {
  const slash = path.indexOf("/");
  if (slash === 1 || slash === 2) return path.slice(slash + 1);
  return path;
}

/** Undo git's C-style quoting for a path outside plain ASCII. */
function unquote(path: string): string {
  if (!path.startsWith('"')) return path;
  const body = path.slice(1, path.endsWith('"') ? -1 : undefined);
  const bytes: number[] = [];
  const encoder = new TextEncoder();
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (ch !== "\\") {
      for (const byte of encoder.encode(ch ?? "")) bytes.push(byte);
      continue;
    }
    const next = body[i + 1];
    if (next === undefined) break;
    const octal = body.slice(i + 1, i + 4);
    if (/^[0-7]{3}$/.test(octal)) {
      bytes.push(Number.parseInt(octal, 8));
      i += 3;
      continue;
    }
    const simple: Record<string, number> = { '"': 34, "\\": 92, n: 10, r: 13, t: 9 };
    bytes.push(simple[next] ?? next.charCodeAt(0));
    i += 1;
  }
  return new TextDecoder().decode(new Uint8Array(bytes));
}
