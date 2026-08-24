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

/**
 * Resolve a command line into shell words per segment, the way bash hands them
 * to the program: quotes concatenate (`-e'x'ec` IS `-exec`), backslashes
 * escape. The screens below must see RESOLVED words — testing raw text lets a
 * quoted spelling of a screened option walk straight past its regex. Returns
 * null whenever the shell itself could compute or write something the words
 * don't show: substitution, any expansion ($, backticks, braces, a glob that
 * could expand to an option), redirection (fd duplication like 2>&1 excepted),
 * or an unterminated quote.
 */
function shellWords(command: string): string[][] | null {
  const segments: string[][] = [];
  let words: string[] = [];
  let word: string | undefined;
  let wordHasGlob = false;
  const push = (part: string) => {
    word = (word ?? "") + part;
  };
  const endWord = (): boolean => {
    // A glob can expand to a repository-controlled filename — including one
    // named like "-exec" — so an option-shaped word must be fully literal.
    if (word !== undefined && wordHasGlob && word.startsWith("-")) return false;
    if (word !== undefined) words.push(word);
    word = undefined;
    wordHasGlob = false;
    return true;
  };
  const endSegment = (): boolean => {
    if (!endWord()) return false;
    if (words.length > 0) segments.push(words);
    words = [];
    return true;
  };
  for (let i = 0; i < command.length; i++) {
    const ch = command[i] as string;
    if (ch === "'") {
      const close = command.indexOf("'", i + 1);
      if (close === -1) return null;
      push(command.slice(i + 1, close));
      i = close;
    } else if (ch === '"') {
      let out = "";
      let j = i + 1;
      for (; j < command.length && command[j] !== '"'; j++) {
        const c = command[j] as string;
        if (c === "$" || c === "`") return null; // expands inside double quotes
        if (c === "\\" && j + 1 < command.length) {
          out += command[j + 1];
          j++;
        } else out += c;
      }
      if (j >= command.length) return null;
      push(out);
      i = j;
    } else if (ch === "\\") {
      if (i + 1 >= command.length) return null;
      push(command[i + 1] as string);
      i++;
    } else if (ch === "$" || ch === "`" || ch === "{") {
      return null; // expansion, substitution, or brace expansion (-exe{c,c})
    } else if (ch === ">") {
      // Only fd duplication (2>&1, >&2) is harmless; every other > writes.
      const dup = /^>&\d+/.exec(command.slice(i));
      if (!dup || (word !== undefined && !/^\d+$/.test(word))) return null;
      word = undefined; // drop the "2>&1" token entirely
      wordHasGlob = false;
      i += dup[0].length - 1;
    } else if (ch === "<") {
      if (command[i + 1] === "(") return null; // process substitution
      // A plain input redirect only reads; its target becomes an ordinary
      // (argument) word for the screens.
      if (word !== undefined && !/^\d+$/.test(word)) return null;
      word = undefined;
      wordHasGlob = false;
    } else if (ch === "&") {
      if (command[i + 1] === ">") return null; // &> redirects
      if (!endSegment()) return null;
      if (command[i + 1] === "&") i++;
    } else if (ch === "|") {
      if (!endSegment()) return null;
      if (command[i + 1] === "|") i++;
    } else if (ch === ";" || ch === "\n") {
      if (!endSegment()) return null;
    } else if (ch === " " || ch === "\t" || ch === "\r") {
      if (!endWord()) return null;
    } else {
      if (ch === "*" || ch === "?" || ch === "[") wordHasGlob = true;
      push(ch);
    }
  }
  if (!endSegment()) return null;
  return segments;
}

export function isReadOnlyCommand(command: string): boolean {
  const segments = shellWords(command);
  if (segments === null) return false;
  for (const words of segments) {
    const seg = words.join(" ");
    let i = 0;
    while (i < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i] as string)) i++;
    const head = words[i];
    if (head === undefined) return false;
    // An env override that changes WHICH code runs turns any allow-listed
    // reader into arbitrary execution: `PATH=. diff a b` resolves ./diff, and
    // LD_PRELOAD/LD_* steer the dynamic loader. No read needs either.
    if (words.slice(0, i).some((w) => /^(?:PATH|LD_[A-Za-z0-9_]*)=/.test(w))) return false;
    const name = head.split("/").pop() ?? head;
    if (name === "git") {
      const sub = words[i + 1];
      if (sub === undefined || !READ_GIT_SUBCOMMANDS.has(sub)) return false;
      // The diff family's --output=<file> sends the result to a FILE: a "read"
      // subcommand alone is not proof of read-only behavior. Prefix form: git
      // accepts unambiguous long-option abbreviations, so --out(=x) works too.
      if (/\s--out/.test(seg)) return false;
      // --ext-diff and --textconv EXECUTE external helpers git picks up from
      // config or environment (`GIT_EXTERNAL_DIFF=touch git diff --ext-diff`
      // runs touch); and a GIT_* assignment prefix exists precisely to steer
      // git toward such helpers — a read never needs one. Prefixes cover the
      // abbreviations git accepts (--ext-d, --textc) while --extended-regexp
      // and --text stay allowed.
      if (/\s--ext(?!ended)|\s--textc/.test(seg)) return false;
      // cat-file: --filters runs the path's clean/smudge commands and
      // --textconv its textconv command, and git accepts abbreviations down to
      // --fi / --tex here — so every --f…/--t… long option is refused
      // (--follow-symlinks is the only read nicety lost).
      if (sub === "cat-file" && /\s--[ft]/.test(seg)) return false;
      // log/show --show-signature hands the commit to gpg --verify — an
      // external program that also WRITES (a GNUPGHOME=. override materializes
      // a keyring in the tree). --show-s… covers the abbreviations git accepts
      // without touching --show-linear-break or --show-pulls.
      if (/\s--show-s/.test(seg)) return false;
      if (words.slice(0, i).some((w) => /^GIT_[A-Za-z0-9_]*=/.test(w))) return false;
      // grep's -O/--open-files-in-pager EXECUTES the named pager on the matched
      // files (bare -O runs the default pager). Every spelling: bare, attached
      // (-Ocmd), clustered (-iO), long abbreviated (--op…) with or without a
      // value — --only-matching stays --on, untouched.
      if (/\s-[a-zA-Z]*O|\s--op/.test(seg)) return false;
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
    // GNU diff reads — unless -l/--paginate pipes the output through the `pr`
    // program resolved from PATH (a repository-local `pr` would execute).
    // Clustered spellings count (-lu, -tl), and --pag… covers the long form's
    // unambiguous abbreviations without catching --palette.
    if (name === "diff" && /\s-[a-zA-Z]*l|\s--pag/.test(seg)) return false;
    // sort reads — unless -o/--output turns it into a file writer. Every spelling
    // counts: separated (-o FILE), attached (-oFILE), clustered (-ro FILE), long
    // (--output FILE, --output=FILE) and its GNU abbreviations (--o…, sort's only
    // long option on o) — a short-option group ending in o takes the next word
    // as its output file.
    if (name === "sort" && /\s(?:-[a-zA-Z]*o|--o)/.test(seg)) return false;
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
