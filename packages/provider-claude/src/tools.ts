/**
 * Tool-name and command screening for the permission gate. The tool names and
 * their input field names (`file_path`, `notebook_path`, `command`) are the
 * Claude Code built-in tool shapes; see the pin comment in index.ts.
 */

/** The one tool this provider adds: calling it is how an agent ends its task. */
export const STRUCTURED_OUTPUT_TOOL = "structured_output";

/** The sdk-mcp server the tool is served from; the model sees `mcp__weft__structured_output`. */
export const MCP_SERVER_NAME = "weft";

/** Every built-in that mutates a file. All are denied outright on a read-only step. */
export const EDIT_TOOLS: ReadonlySet<string> = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

/** MCP tools arrive fully qualified (`mcp__<server>__<tool>`); the gate reasons about the bare name. */
export function baseToolName(toolName: string): string {
  if (!toolName.startsWith("mcp__")) return toolName;
  const parts = toolName.split("__");
  return parts[parts.length - 1] ?? toolName;
}

/** The file an edit tool targets, or undefined when the input carries no usable path. */
export function editTargetPath(input: Record<string, unknown>): string | undefined {
  const path = input.file_path ?? input.notebook_path;
  return typeof path === "string" && path.length > 0 ? path : undefined;
}

/**
 * Obvious filesystem writes in a shell command. Deliberately over-eager: on a
 * read-only step a false deny costs the agent one turn, a false allow costs a
 * mutated tree.
 */
const WRITE_PATTERNS: readonly RegExp[] = [
  // Output redirection (`> f`, `>> f`, `2>f`) but not fd duplication (`2>&1`).
  />{1,2}(?!&)/,
  /(?:^|[\s;&|(])(?:rm|mv|cp|touch|tee|truncate|mkdir)\b/,
  /(?:^|[\s;&|(])sed\b[^;&|]*\s(?:-i\b|--in-place)/,
];

export function isWriteCommand(command: string): boolean {
  return WRITE_PATTERNS.some((re) => re.test(command));
}

/**
 * Deny-by-default screen for Bash on a READ-ONLY step. A blocklist cannot hold that
 * contract — `git checkout -- f`, `npm install`, `chmod`, `python -c 'open(...)'` all
 * mutate without matching any write pattern — so a command chain passes only when
 * every segment starts with a command known not to write, with no redirection or
 * substitution to smuggle one in. Over-eager on purpose: a false deny costs the
 * agent one turn, a false allow costs a mutated tree.
 */
const READ_COMMANDS: ReadonlySet<string> = new Set([
  "ls",
  "cat",
  "head",
  "tail",
  "grep",
  "rg",
  "wc",
  "sort",
  "uniq",
  "cut",
  "tr",
  "echo",
  "printf",
  "pwd",
  "which",
  "type",
  "file",
  "stat",
  "du",
  "df",
  "env",
  "printenv",
  "diff",
  "cmp",
  "tree",
  "basename",
  "dirname",
  "realpath",
  "readlink",
  "jq",
  "date",
  "true",
  "false",
  "test",
  "sleep",
  "md5sum",
  "sha1sum",
  "sha256sum",
  "column",
  "nl",
  "strings",
  "xxd",
  "od",
]);

/** Git subcommands that read the repository without mutating tree, index, or refs. */
const READ_GIT_SUBCOMMANDS: ReadonlySet<string> = new Set([
  "status",
  "log",
  "diff",
  "show",
  "blame",
  "rev-parse",
  "rev-list",
  "ls-files",
  "ls-tree",
  "cat-file",
  "describe",
  "shortlog",
  "grep",
  "reflog",
  "count-objects",
  "merge-base",
  "name-rev",
  "var",
  "check-ignore",
  "check-attr",
]);

export function isReadOnlyCommand(command: string): boolean {
  // Substitution can run anything; redirection and process substitution write.
  if (/[`]|\$\(|>{1,2}(?!&)|[<>]\(/.test(command)) return false;
  // Fd duplication ("2>&1") is not a write; drop it so its `&` can't split a segment.
  const plain = command.replace(/\d*>&\d+/g, " ");
  for (const raw of plain.split(/\|\||&&|[;|\n&]/)) {
    const seg = raw.trim();
    if (seg === "") continue;
    const words = seg.split(/\s+/);
    let i = 0;
    while (i < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i] as string)) i++;
    const head = words[i];
    if (head === undefined) return false;
    const name = head.split("/").pop() ?? head;
    if (name === "git") {
      const sub = words[i + 1];
      if (sub === undefined || !READ_GIT_SUBCOMMANDS.has(sub)) return false;
      continue;
    }
    // find reads — unless told to delete or execute.
    if (name === "find") {
      if (/\s-(?:delete|exec|execdir|ok|okdir|fprint\w*)\b/.test(seg)) return false;
      continue;
    }
    if (!READ_COMMANDS.has(name)) return false;
  }
  return true;
}

/** Commands that publish work outside the machine: these go to the HITL broker at risk "high". */
const RISKY_PATTERNS: readonly RegExp[] = [
  /\bgit\s+push\b/,
  /\b(?:npm|pnpm|yarn|bun)\s+publish\b/,
  /\b(?:npm|pnpm|yarn|bun)\s+run\s+(?:deploy|publish|release)\b/,
  /\bcargo\s+publish\b/,
  /\b(?:make|just)\s+(?:deploy|publish|release)\b/,
  /\bdocker\s+push\b/,
  /\bkubectl\s+(?:apply|rollout)\b/,
  /\bterraform\s+apply\b/,
  /\bgh\s+(?:release\s+create|pr\s+merge)\b/,
  /\b(?:vercel|netlify|fly|flyctl|wrangler|heroku)\s+deploy\b/,
];

export function isRiskyCommand(command: string): boolean {
  return RISKY_PATTERNS.some((re) => re.test(command));
}
