/**
 * The HTTP conventions every route shares, in one place so a new endpoint cannot
 * invent its own error shape or its own idea of what a 404 means.
 */
import type { Context } from "hono";

/**
 * A run id nobody has journaled is the only 404 this surface has. Everything else a
 * caller can cause — a malformed body, an answer the schema rejects, a resume with no
 * definition on disk — is a 400 carrying the engine's own message, which is the part
 * worth reading.
 */
export function fail(c: Context, err: unknown): Response {
  const message = messageOf(err);
  return c.json({ error: message }, /\bnot found\b/i.test(message) ? 404 : 400);
}

export function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** A JSON object body, or an Error naming what was wrong with it. */
export async function jsonBody(c: Context): Promise<Record<string, unknown>> {
  let parsed: unknown;
  try {
    parsed = await c.req.json();
  } catch {
    throw new Error("expected a JSON object body");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("expected a JSON object body");
  }
  return parsed as Record<string, unknown>;
}

/** One HTML document, never cached: a build carries its own hash. */
export function page(c: Context, html: string): Response {
  return c.body(html, 200, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-cache",
  });
}
