/**
 * Thread items → one transcript blob. The engine stores whatever this returns
 * against the step, so it is written for the person who later runs `weft explain`:
 * one line per item, in the order Codex produced them, carrying the payload that
 * makes the line worth reading (the command, the changed paths, the query).
 */
import type { ThreadItem } from "@openai/codex-sdk";

/**
 * Renders a completed turn's items; an absent or empty list renders to "".
 *
 * The Codex SDK derives `finalResponse` by replacing it for every completed agent
 * message. Matching from the end therefore identifies the one response the adapter
 * actually captured, even when an earlier message contains identical text.
 */
export function renderTranscript(items: readonly ThreadItem[] | undefined, finalResponse?: string): string {
  if (items === undefined) return "";
  const finalResponseIndex = findFinalResponseIndex(items, finalResponse);
  const lines: string[] = [];
  for (const [index, item] of items.entries()) {
    const line = renderItem(item, index === finalResponseIndex);
    if (line !== undefined) lines.push(line);
  }
  return lines.join("\n");
}

function findFinalResponseIndex(items: readonly ThreadItem[], finalResponse: string | undefined): number {
  if (finalResponse === undefined) return -1;
  return items.findLastIndex((item) => item.type === "agent_message" && item.text === finalResponse);
}

function renderItem(item: ThreadItem, isFinalResponse: boolean): string | undefined {
  switch (item.type) {
    case "agent_message":
      return labelled(isFinalResponse ? "assistant (final)" : "assistant", item.text);
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
