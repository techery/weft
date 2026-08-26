/**
 * The wire schema is adapted to OpenAI's strict subset on the way out. The walk must
 * rewrite SCHEMAS and nothing else: a blind recursion cannot tell a subschema from a
 * literal a workflow chose, and rewrites the author's own data.
 */
import { toStrictSchema } from "@techery/weft-provider-codex";
import { z } from "@techery/weft-sdk";
import { describe, expect, test } from "vitest";

type Node = Record<string, unknown>;

const strict = (schema: z.ZodType): Node =>
  toStrictSchema(z.toJSONSchema(schema, { io: "input", reused: "inline" })) as Node;

/** The subschema at `properties.<name>` of an object schema. */
const prop = (node: Node, name: string): Node => (node.properties as Record<string, Node>)[name] as Node;

describe("toStrictSchema", () => {
  test("closes objects and requires every declared property", () => {
    const out = strict(z.object({ a: z.string(), b: z.number().default(1) }));
    expect(out.additionalProperties).toBe(false);
    expect(out.required).toEqual(["a", "b"]);
  });

  test("does not rewrite a literal value that merely looks like a schema", () => {
    // `default` carries data, not a subschema. Recursing into it produced a value the
    // author never wrote — with additionalProperties and required bolted on.
    const literal = { type: "object", properties: { nested: 1 } };
    const out = strict(z.object({ cfg: z.any().default(literal) }));
    const cfg = prop(out, "cfg");
    expect(cfg.default).toEqual(literal);
  });

  test("leaves enum and const members untouched", () => {
    const out = strict(z.object({ mode: z.literal("object") }));
    const mode = prop(out, "mode");
    expect(mode.const ?? mode.enum).toBeDefined();
    expect(mode.additionalProperties).toBeUndefined();
  });

  test("descends into arrays, unions and nested objects", () => {
    const out = strict(
      z.object({
        rows: z.array(z.object({ id: z.string() })),
        either: z.union([z.object({ a: z.string() }), z.object({ b: z.string() })]),
      }),
    );
    const item = prop(out, "rows").items as Node;
    expect(item.additionalProperties).toBe(false);
    expect(item.required).toEqual(["id"]);
    const branches = (prop(out, "either").anyOf ?? []) as Node[];
    expect(branches.length).toBeGreaterThan(0);
    for (const branch of branches) expect(branch.additionalProperties).toBe(false);
  });

  test("adapts discriminated unions from oneOf to OpenAI-compatible anyOf", () => {
    const out = strict(
      z.discriminatedUnion("kind", [
        z.object({ kind: z.literal("a"), value: z.string() }),
        z.object({ kind: z.literal("b"), count: z.number() }),
      ]),
    );
    expect(out.oneOf).toBeUndefined();
    const branches = (out.anyOf ?? []) as Node[];
    expect(branches).toHaveLength(2);
    for (const branch of branches) {
      expect(branch.additionalProperties).toBe(false);
      expect(branch.required).toContain("kind");
    }
  });

  test("does not clobber a meaningful additionalProperties", () => {
    // z.record's additionalProperties is a subschema, not a closed-object marker.
    const out = strict(z.object({ bag: z.record(z.string(), z.number()) }));
    const bag = prop(out, "bag");
    expect(bag.additionalProperties).toEqual({ type: "number" });
  });

  test("is a no-op on a non-object root", () => {
    expect(toStrictSchema({ type: "string" })).toEqual({ type: "string" });
    expect(toStrictSchema(null)).toBe(null);
    expect(toStrictSchema(5)).toBe(5);
  });
});
