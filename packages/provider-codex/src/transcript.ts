/**
 * Thread items → one transcript blob. The engine stores whatever this returns
 * against the step, so it is written for the person who later runs `weft explain`:
 * one line per item, in the order Codex produced them, carrying the payload that
 * makes the line worth reading (the command, the changed paths, the query).
 */
import type { ThreadItem } from "@openai/codex-sdk";

/** Renders a completed turn's items; an absent or empty list renders to "". */
export function renderTranscript(items: readonly ThreadItem[] | undefined): string {
  if (items === undefined) return "";
  const lines: string[] = [];
  for (const item of items) {
    const line = renderItem(item);
    if (line !== undefined) lines.push(line);
  }
  return lines.join("\n");
}

function renderItem(item: ThreadItem): string | undefined {
  switch (item.type) {
    case "agent_message":
      return labelled("assistant", item.text);
    case "reasoning":
      return labelled("reasoning", item.text);
    case "command_execution": {
      // `exit_code` is only set once the command finishes; until then status is the news.
      const outcome = item.exit_code === undefined ? item.status : `exit ${item.exit_code}`;
      return `exec (${outcome}): ${item.command}`;
    }
    case "file_change": {
      const changes = item.changes.map((change) => `${change.kind} ${change.path}`).join(", ");
      return `files (${item.status}): ${changes}`;
    }
    case "mcp_tool_call":
      return `mcp (${item.status}): ${item.server}.${item.tool}`;
    case "web_search":
      return `search: ${item.query}`;
    case "todo_list": {
      const done = item.items.filter((todo) => todo.completed).length;
      return `todo: ${done}/${item.items.length}`;
    }
    case "error":
      return `error: ${item.message}`;
    default:
      // An item type added upstream is skipped rather than rendered as "[object Object]".
      return undefined;
  }
}

function labelled(prefix: string, value: string): string | undefined {
  const text = value.trim();
  return text.length > 0 ? `${prefix}: ${text}` : undefined;
}
