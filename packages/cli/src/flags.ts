/**
 * Dynamic input flags. A workflow's input schema is the CLI's own option list: after the
 * known options, `weft run review --base main --depth 2` is just the input object
 * `{ base: "main", depth: 2 }`. Commander hands those tokens through untouched
 * (`allowUnknownOption`), and this is where they become a value.
 *
 * Coercion is deliberately shallow — `true`/`false`, a finite number, otherwise the string.
 * Anything richer (arrays, nested objects) belongs in `--args '{…}'`, which these merge over.
 */

/** `--base main`, `--base=main`, `--watchOnly`, `--no-cache`. */
export function parseDynamicFlags(tokens: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i] ?? "";
    if (!token.startsWith("--")) {
      throw new Error(`unexpected argument ${JSON.stringify(token)} — input flags look like --name value`);
    }
    const eq = token.indexOf("=");
    const name = eq === -1 ? token.slice(2) : token.slice(2, eq);
    if (name === "") throw new Error('unexpected argument "--"');
    let raw = eq === -1 ? undefined : token.slice(eq + 1);
    if (raw === undefined) {
      const next = tokens[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        raw = next;
        i++;
      }
    }
    if (raw === undefined && name.startsWith("no-")) {
      out[camelCase(name.slice(3))] = false;
      continue;
    }
    out[camelCase(name)] = raw === undefined ? true : coerce(raw);
  }
  return out;
}

/** Input schemas are written in TypeScript, so `--base-ref` fills `baseRef`. */
export function camelCase(name: string): string {
  return name.replace(/-([a-z0-9])/gi, (_, ch: string) => ch.toUpperCase());
}

function coerce(raw: string): string | number | boolean {
  if (raw === "true") return true;
  if (raw === "false") return false;
  if (raw !== "" && Number.isFinite(Number(raw))) return Number(raw);
  return raw;
}

/** `--args '{"base":"main"}'`, with the error a bad paste actually needs. */
export function parseArgsJson(text: string | undefined): Record<string, unknown> {
  if (text === undefined) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch (err) {
    throw new Error(`--args is not valid JSON: ${(err as Error).message}`);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("--args must be a JSON object");
  }
  return parsed as Record<string, unknown>;
}

/** JSON on the command line, for `weft answer` — any JSON value, not just an object. */
export function parseJsonValue(text: string, what: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch (err) {
    throw new Error(`${what} is not valid JSON: ${(err as Error).message}`);
  }
}

/** Read a workflow script piped into `weft run -`. */
export async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk as Buffer));
  const source = Buffer.concat(chunks).toString("utf8");
  if (source.trim() === "") throw new Error('nothing on stdin — pipe a workflow script into "weft run -"');
  return source;
}
