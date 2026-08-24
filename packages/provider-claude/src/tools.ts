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
  // "env" is deliberately absent: with arguments it LAUNCHES another command.
  "echo",
  "printf",
  "pwd",
  "which",
  "type",
  "file",
  "stat",
  "du",
  "df",
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
      // The diff family's --output=<file> sends the result to a FILE: a "read"
      // subcommand alone is not proof of read-only behavior.
      if (/\s--output\b/.test(seg)) return false;
      // --ext-diff, --textconv and --filters EXECUTE external helpers git picks
      // up from config or environment (`GIT_EXTERNAL_DIFF=touch git diff
      // --ext-diff` runs touch; `cat-file --filters` runs the path's configured
      // clean/smudge commands); and a GIT_* assignment prefix exists precisely
      // to steer git toward such helpers — a read never needs one.
      if (/\s--(?:ext-diff|textconv|filters)\b/.test(seg)) return false;
      if (words.slice(0, i).some((w) => /^GIT_[A-Za-z0-9_]*=/.test(w))) return false;
      // grep's -O/--open-files-in-pager EXECUTES the named pager on the matched
      // files (bare -O runs the default pager). Every spelling: bare, attached
      // (-Ocmd), clustered (-iO), long with or without a value.
      if (/\s-[a-zA-Z]*O|\s--open-files-in-pager/.test(seg)) return false;
      continue;
    }
    // find reads — unless told to delete, execute, or WRITE: every f-action
    // (-fls, -fprint, -fprint0, -fprintf) sends output to a named file.
    if (name === "find") {
      if (/\s-(?:delete|exec|execdir|ok|okdir|fls|fprint\w*)\b/.test(seg)) return false;
      continue;
    }
    // ripgrep reads — unless --pre EXECUTES a preprocessor command on every
    // searched file (`rg --pre touch pattern file` runs `touch file`).
    if (name === "rg" && /\s--pre\b/.test(seg)) return false;
    // sort reads — unless -o/--output turns it into a file writer. Every spelling
    // counts: separated (-o FILE), attached (-oFILE), clustered (-ro FILE), long
    // (--output FILE, --output=FILE) — a short-option group ending in o takes the
    // next word as its output file.
    if (name === "sort" && /\s(?:-[a-zA-Z]*o|--output)/.test(seg)) return false;
    // uniq reads — unless a SECOND positional argument names its output file
    // (`uniq input output` WRITES output). Conservative: two option-free words
    // refuse the command, a separated flag argument (-f 2) included; `-` counts
    // (it is stdin, and whatever follows it is the output).
    if (name === "uniq") {
      const positional = words.slice(i + 1).filter((w) => !(w.startsWith("-") && w.length > 1));
      if (positional.length > 1) return false;
      continue;
    }
    if (!READ_COMMANDS.has(name)) return false;
  }
  return true;
}

/**
 * The effective git subcommand, skipping global options — `git -C . push` is still a
 * push. The listed flags consume a separate argument; every other leading `-x` is a
 * bare global flag.
 */
export function gitSubcommandOf(words: readonly string[]): string | undefined {
  const takesArg = new Set(["-C", "-c", "--exec-path", "--git-dir", "--work-tree", "--namespace"]);
  let i = 1;
  while (i < words.length) {
    const word = words[i] as string;
    if (!word.startsWith("-")) return word;
    i += takesArg.has(word) ? 2 : 1;
  }
  return undefined;
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
  // The shell resolves quoting BEFORE the program sees its words — `git p'u'sh`
  // runs `git push` — so classification must match against the unquoted text.
  // Stripping is for MATCHING only and errs toward the stricter reading: a
  // "push" inside a quoted string routes to approval rather than sailing past.
  const resolved = command.replace(/['"]/g, "");
  if (RISKY_PATTERNS.some((re) => re.test(resolved))) return true;
  // `git -C . push` is still a push: resolve the effective subcommand per segment
  // instead of trusting adjacency in the raw string.
  for (const raw of resolved.replace(/\d*>&\d+/g, " ").split(/\|\||&&|[;|\n&]/)) {
    const words = raw.trim().split(/\s+/);
    let i = 0;
    while (i < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i] as string)) i++;
    const head = words[i];
    if (head === undefined) continue;
    // `op=push; git "$op" origin HEAD:main` IS a push, assembled out of this
    // screen's sight. A dynamic EXECUTABLE, an eval, or a dynamic git
    // subcommand cannot be proven non-publishing — route them to the broker.
    if (/[$`]/.test(head)) return true;
    const name = head.split("/").pop() ?? head;
    if (name === "eval") return true;
    if (name !== "git") continue;
    const gitWords = words.slice(i);
    // `git -c alias.ship=push ship …` runs whatever the alias expands to — the
    // expansion happens inside git, out of this screen's sight. Any alias
    // DEFINED on the command line routes to approval conservatively.
    for (let j = 1; j < gitWords.length; j++) {
      const w = gitWords[j] as string;
      if (w.startsWith("-calias.")) return true;
      if (w === "-c" && (gitWords[j + 1] ?? "").startsWith("alias.")) return true;
    }
    const sub = gitSubcommandOf(gitWords);
    if (sub === "push") return true;
    if (sub !== undefined && /[$`]/.test(sub)) return true;
  }
  return false;
}
