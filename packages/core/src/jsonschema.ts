/**
 * The schema boundary. Zod schemas convert to JSON Schema for the provider wire
 * (z.toJSONSchema); other Standard Schemas fall back to a permissive object schema
 * with a lint note. Primitives are wrapped as { value } on the wire and unwrapped
 * on the way back. A minimal structural validator gives hosts best-effort answer
 * validation against journaled JSON Schemas (the authoritative validation always
 * happens against the real schema when the workflow replays).
 */
import { type AnySchema, isZodSchema, type SchemaIssue } from "@weft/sdk";
import * as z from "zod";

export interface WireSchema {
  /** JSON Schema sent to the provider. */
  json: Record<string, unknown>;
  /** True when the value travels wrapped as { value: … }. */
  wrapped: boolean;
  /** Portability notes (deep unions, recursion, non-zod fallback…). */
  lints: string[];
}

export function toWireSchema(schema: AnySchema): WireSchema {
  const lints: string[] = [];
  let json: Record<string, unknown>;
  if (isZodSchema(schema)) {
    try {
      json = z.toJSONSchema(schema as never, { io: "input", reused: "inline" }) as Record<string, unknown>;
    } catch (err) {
      lints.push(`z.toJSONSchema failed (${(err as Error).message}); using permissive schema`);
      json = { type: "object", additionalProperties: true };
    }
  } else {
    lints.push(
      `non-zod schema (vendor: ${schema["~standard"].vendor}); provider receives a permissive schema`,
    );
    json = { type: "object", additionalProperties: true };
  }
  delete json.$schema;

  const wrapped = json.type !== "object" && json.type !== undefined;
  if (wrapped) {
    json = {
      type: "object",
      properties: { value: json },
      required: ["value"],
      additionalProperties: false,
    };
  }
  if (depthOf(json) > 8)
    lints.push("schema nests deeper than 8 levels; native structured output may reject it");
  return { json, wrapped, lints };
}

export function unwrapWireValue(value: unknown, wrapped: boolean): unknown {
  if (!wrapped) return value;
  if (typeof value === "object" && value !== null && "value" in value) {
    return (value as { value: unknown }).value;
  }
  return value;
}

export function wrapWireValue(value: unknown, wrapped: boolean): unknown {
  return wrapped ? { value } : value;
}

function depthOf(node: unknown, depth = 0): number {
  if (typeof node !== "object" || node === null || depth > 12) return depth;
  let max = depth;
  for (const v of Object.values(node)) max = Math.max(max, depthOf(v, depth + 1));
  return max;
}

// ---------------------------------------------------------------------------
// Minimal structural JSON-Schema check (hosts validating human answers)
// ---------------------------------------------------------------------------

export function structuralCheck(schemaJson: unknown, value: unknown, path = ""): SchemaIssue[] {
  if (typeof schemaJson !== "object" || schemaJson === null) return [];
  const s = schemaJson as Record<string, unknown>;
  const issues: SchemaIssue[] = [];
  const type = s.type as string | string[] | undefined;

  if (Array.isArray(s.enum)) {
    if (!s.enum.some((e) => deepEqual(e, value))) {
      issues.push({ path, message: `expected one of ${s.enum.map((e) => JSON.stringify(e)).join(", ")}` });
    }
    return issues;
  }
  if (Array.isArray(s.anyOf)) {
    const ok = (s.anyOf as unknown[]).some((sub) => structuralCheck(sub, value, path).length === 0);
    if (!ok) issues.push({ path, message: "no anyOf branch matched" });
    return issues;
  }

  const typeOk = (t: string): boolean => {
    switch (t) {
      case "object":
        return typeof value === "object" && value !== null && !Array.isArray(value);
      case "array":
        return Array.isArray(value);
      case "string":
        return typeof value === "string";
      case "number":
        return typeof value === "number";
      case "integer":
        return typeof value === "number" && Number.isInteger(value);
      case "boolean":
        return typeof value === "boolean";
      case "null":
        return value === null;
      default:
        return true;
    }
  };

  if (type !== undefined) {
    const types = Array.isArray(type) ? type : [type];
    if (!types.some(typeOk)) {
      issues.push({ path, message: `expected ${types.join("|")}, got ${valueType(value)}` });
      return issues;
    }
  }

  if (
    (type === "object" || (type === undefined && s.properties)) &&
    typeof value === "object" &&
    value !== null
  ) {
    const props = (s.properties ?? {}) as Record<string, unknown>;
    const required = (s.required ?? []) as string[];
    for (const req of required) {
      if (!(req in (value as Record<string, unknown>))) {
        issues.push({ path: joinPath(path, req), message: "required property missing" });
      }
    }
    for (const [k, sub] of Object.entries(props)) {
      if (k in (value as Record<string, unknown>)) {
        issues.push(...structuralCheck(sub, (value as Record<string, unknown>)[k], joinPath(path, k)));
      }
    }
  }
  if (type === "array" && Array.isArray(value) && s.items) {
    value.forEach((item, i) => issues.push(...structuralCheck(s.items, item, joinPath(path, String(i)))));
  }
  return issues;
}

function joinPath(base: string, key: string): string {
  return base ? `${base}.${key}` : key;
}

function valueType(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  return typeof v;
}

function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
