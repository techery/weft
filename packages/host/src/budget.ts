/**
 * `--budget 500k`, `--budget $5`, `--budget "500k,$5"`. One parser so the CLI, the MCP
 * server, and the daemon cannot drift on what a budget string means.
 */

export interface ParsedBudget {
  tokens?: number;
  usd?: number;
}

const SCALES: Record<string, number> = { k: 1_000, m: 1_000_000, b: 1_000_000_000 };

/** `$` marks the amount as money; a `k`/`m`/`b` suffix scales either axis. */
const PART = /^(\$)?(\d+(?:\.\d+)?)([kmb])?$/i;

const SHAPE = 'expected a token count ("500k", "2m", "120000") or a dollar amount ("$5", "$0.50")';

/**
 * Parse one budget string. Both axes may be given at once, separated by a comma or
 * whitespace (`"500k $5"`); each axis may appear only once. Anything else throws — a
 * budget the host misreads is a budget nobody enforces.
 */
export function parseBudget(text: string): ParsedBudget {
  const parts = text.split(/[,\s]+/).filter((p) => p !== "");
  if (parts.length === 0) throw invalid(text);

  const out: ParsedBudget = {};
  for (const part of parts) {
    const match = PART.exec(part);
    if (!match) throw invalid(text);
    const scale = match[3] ? (SCALES[match[3].toLowerCase()] ?? 1) : 1;
    const value = Number(match[2]) * scale;
    if (!Number.isFinite(value)) throw invalid(text);
    if (match[1]) {
      if (out.usd !== undefined) throw new Error(`invalid budget ${JSON.stringify(text)}: $ given twice`);
      // Money is kept at cent precision so 1/3-of-a-budget arithmetic downstream stays sane.
      out.usd = Math.round(value * 100) / 100;
    } else {
      if (out.tokens !== undefined) {
        throw new Error(`invalid budget ${JSON.stringify(text)}: token count given twice`);
      }
      out.tokens = Math.round(value);
    }
  }
  return out;
}

function invalid(text: string): Error {
  return new Error(`invalid budget ${JSON.stringify(text)}: ${SHAPE}`);
}
