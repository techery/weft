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
