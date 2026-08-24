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
  // Null-prototype: `--__proto__ x` on a plain object literal would SET the prototype
  // instead of adding a field, so the flag vanished and the object grew a stranger's
  // shape. Here every name is an ordinary own property, and the schema decides the rest.
  const out: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  const seen = new Set<string>();
  const assign = (name: string, value: unknown): void => {
    // Silently keeping the last one hides a mistake that costs money to make twice, and
    // there is no array form to mean "both" — `--args` is where richer input belongs.
    if (seen.has(name)) {
      throw new Error(`--${name} was given more than once — pass richer input with --args '{…}'`);
    }
    seen.add(name);
    out[name] = value;
  };
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
      assign(camelCase(name.slice(3)), false);
      continue;
    }
    assign(camelCase(name), raw === undefined ? true : coerce(raw));
  }
  return { ...out };
}

/** Input schemas are written in TypeScript, so `--base-ref` fills `baseRef`. */
export function camelCase(name: string): string {
  return name.replace(/-([a-z0-9])/gi, (_, ch: string) => ch.toUpperCase());
}

/**
 * A value becomes a number only when it survives the round trip unchanged.
 *
 * `Number.isFinite(Number(raw))` alone accepts a great deal that is not a number to the
 * person who typed it: a short git sha (`1e5` → 100000), a version (`1.20` → 1.2), a
 * zero-padded code (`007` → 7), a hex literal (`0x10` → 16), even a blank (`" "` → 0).
 * Each of those silently starts the run against something else. Requiring
 * `String(Number(raw)) === raw` keeps the plain cases (`42`, `-3.5`) and leaves every
 * value whose text a number cannot represent as the string it was.
 */
function coerce(raw: string): string | number | boolean {
  if (raw === "true") return true;
  if (raw === "false") return false;
  const asNumber = Number(raw);
  if (Number.isFinite(asNumber) && String(asNumber) === raw) return asNumber;
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
