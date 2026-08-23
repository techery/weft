/**
 * Canonical JSON + SHA-256. Step identity hashes and blob refs both depend on a
 * stable serialization: object keys are sorted recursively so the same logical
 * payload always hashes the same — this is what makes salvage hits deterministic.
 */
import { createHash } from "node:crypto";

export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value !== null && typeof value === "object") {
    if (value instanceof Date) return value.toISOString();
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value as Record<string, unknown>).sort()) {
      const v = (value as Record<string, unknown>)[k];
      if (v !== undefined) out[k] = sortValue(v);
    }
    return out;
  }
  return value;
}

export function sha256Hex(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

/** Identity hash for a step: kind + canonical payload (+ schema when present). */
export function hashStep(kind: string, payload: unknown, schemaJson?: unknown): string {
  return sha256Hex(canonicalJson({ kind, payload, schema: schemaJson ?? null }));
}
