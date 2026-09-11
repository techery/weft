/**
 * The schema boundary. Zod schemas convert to JSON Schema for the provider wire
 * (z.toJSONSchema); other Standard Schemas fall back to a permissive object schema
 * with a lint note. Primitives are wrapped as { value } on the wire and unwrapped
 * on the way back. A minimal structural validator gives hosts best-effort answer
 * validation against journaled JSON Schemas (the authoritative validation always
 * happens against the real schema when the workflow replays).
 */
import { type AnySchema, isZodSchema, type SchemaIssue } from "@techery/weft-sdk";
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
      lints.push(`z.toJSONSchema failed (${(err as Error).message}); using permissive wrapper`);
      return { json: permissiveWrapper(), wrapped: true, lints };
    }
  } else {
    // The real value can be ANY shape (a valibot string, say) — an object-typed
    // fallback would refuse legitimate primitive answers before the authoritative
    // schema ever ran. A wrapped { value } carrier holds anything.
    lints.push(
      `non-zod schema (vendor: ${schema["~standard"].vendor}); provider receives a permissive schema`,
    );
    return { json: permissiveWrapper(), wrapped: true, lints };
  }
  delete json.$schema;

  // Wrap unless the ROOT is guaranteed an object: a root anyOf (z.union) carries no
  // `type` and may be primitive, and providers' structured output demands an object root.
  const wrapped = json.type !== "object";
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

/** A { value } carrier that admits any JSON value — for schemas nothing can convert. */
function permissiveWrapper(): Record<string, unknown> {
  return { type: "object", properties: { value: {} }, required: ["value"], additionalProperties: false };
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
    if (s.additionalProperties === false) {
      for (const k of Object.keys(value as Record<string, unknown>)) {
        if (!(k in props)) issues.push({ path: joinPath(path, k), message: "unexpected property" });
      }
    }
  }
  if (type === "array" && Array.isArray(value) && s.items) {
    value.forEach((item, i) => {
      issues.push(...structuralCheck(s.items, item, joinPath(path, String(i))));
    });
  }
  issues.push(...constraintCheck(s, value, path));
  return issues;
}

/**
 * The constraint keywords the wire schema can carry (what zod's JSON Schema output
 * emits). A host validating an answer without the real schema must enforce these, or
 * a journaled answer the authoritative validation later refuses poisons the run.
 * `format` and refinements are NOT representable here — the owning runtime's real
 * schema stays authoritative, and a rejected answer re-opens the request.
 */
function constraintCheck(s: Record<string, unknown>, value: unknown, path: string): SchemaIssue[] {
  const issues: SchemaIssue[] = [];
  const push = (message: string) => issues.push({ path, message });
  if ("const" in s && !deepEqual(s.const, value)) push(`expected ${JSON.stringify(s.const)}`);
  if (typeof value === "string") {
    if (typeof s.minLength === "number" && value.length < s.minLength)
      push(`expected at least ${s.minLength} character(s)`);
    if (typeof s.maxLength === "number" && value.length > s.maxLength)
      push(`expected at most ${s.maxLength} character(s)`);
    if (typeof s.pattern === "string") {
      try {
        if (!new RegExp(s.pattern).test(value)) push(`does not match pattern ${s.pattern}`);
      } catch {
        // an unparseable pattern is the schema's problem, not the answer's
      }
    }
  }
  if (typeof value === "number") {
    if (typeof s.minimum === "number" && value < s.minimum) push(`expected >= ${s.minimum}`);
    if (typeof s.maximum === "number" && value > s.maximum) push(`expected <= ${s.maximum}`);
    if (typeof s.exclusiveMinimum === "number" && value <= s.exclusiveMinimum)
      push(`expected > ${s.exclusiveMinimum}`);
    if (typeof s.exclusiveMaximum === "number" && value >= s.exclusiveMaximum)
      push(`expected < ${s.exclusiveMaximum}`);
    if (typeof s.multipleOf === "number" && s.multipleOf > 0 && !isMultipleOf(value, s.multipleOf))
      push(`expected a multiple of ${s.multipleOf}`);
  }
  if (Array.isArray(value)) {
    if (typeof s.minItems === "number" && value.length < s.minItems)
      push(`expected at least ${s.minItems} item(s)`);
    if (typeof s.maxItems === "number" && value.length > s.maxItems)
      push(`expected at most ${s.maxItems} item(s)`);
  }
  return issues;
}

/** Decimal-safe multipleOf: 0.3 % 0.1 is ~0.1 in binary floats, so the quotient
 * is compared to its nearest integer with a scale-aware tolerance instead. */
function isMultipleOf(value: number, of: number): boolean {
  const quotient = value / of;
  return Math.abs(quotient - Math.round(quotient)) <= 1e-9 * Math.max(1, Math.abs(quotient));
}

function joinPath(base: string, key: string): string {
  return base ? `${base}.${key}` : key;
}

function valueType(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  return typeof v;
}

/**
 * Order-independent structural equality for enum/const checks: JSON objects are
 * unordered, so `{a:1,b:2}` must equal `{b:2,a:1}` — a stringify comparison
 * would reject a semantically valid answer over property entry order.
 */
function deepEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((v, i) => deepEqual(v, b[i]));
  }
  if (typeof a === "object" && a !== null && typeof b === "object" && b !== null) {
    const ka = Object.keys(a).sort();
    const kb = Object.keys(b).sort();
    if (ka.length !== kb.length || ka.some((k, i) => k !== kb[i])) return false;
    return ka.every((k) => deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
  }
  return false;
}

/**
 * The first path in a value the JSONL journal cannot faithfully hold, if any.
 * A PRESENT property whose value is undefined is flagged too: JSON drops it, so
 * the journal would replay a different shape than the live value — and a schema
 * that distinguishes absent from present-undefined would flip on resume. Omit
 * the key instead of writing undefined into it.
 */
export function jsonUnsafeAt(value: unknown, path = "$", ancestors?: WeakSet<object>): string | undefined {
  if (value === null) return undefined;
  const kind = typeof value;
  if (kind === "string" || kind === "boolean") return undefined;
  if (kind === "number") return Number.isFinite(value as number) ? undefined : `${path} (non-finite number)`;
  if (kind === "undefined" || kind === "bigint" || kind === "function" || kind === "symbol") {
    return `${path} (${kind})`;
  }
  // Ancestor-stack cycle check: a value containing ITSELF can never be
  // journaled, and recursing into it would blow the stack instead of naming the
  // path. Entries are removed on the way back up, so shared (diamond)
  // references — which JSON serializes fine, duplicated — stay legal.
  if (Array.isArray(value)) {
    const seen = ancestors ?? new WeakSet();
    if (seen.has(value)) return `${path} (circular reference)`;
    seen.add(value);
    try {
      for (let i = 0; i < value.length; i++) {
        const bad = jsonUnsafeAt(value[i], `${path}[${i}]`, seen);
        if (bad !== undefined) return bad;
      }
    } finally {
      seen.delete(value);
    }
    return undefined;
  }
  // Realm-tolerant plain-object test: workflow objects are built inside the vm
  // context, whose Object.prototype is a different identity than the host's — but
  // any realm's Object.prototype is the one whose own prototype is null.
  const proto = Object.getPrototypeOf(value);
  if (proto !== null && Object.getPrototypeOf(proto) !== null) {
    // Map, Set, Date, Promise, class instances: JSON silently loses or breaks them.
    const name = (value as object).constructor?.name ?? "object";
    return `${path} (${name})`;
  }
  const seen = ancestors ?? new WeakSet();
  if (seen.has(value as object)) return `${path} (circular reference)`;
  seen.add(value as object);
  try {
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      const bad = jsonUnsafeAt(entry, `${path}.${key}`, seen);
      if (bad !== undefined) return bad;
    }
  } finally {
    seen.delete(value as object);
  }
  return undefined;
}
