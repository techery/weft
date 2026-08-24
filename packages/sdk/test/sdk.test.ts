import type { Settled } from "@techery/weft-sdk";
import {
  BudgetExceededError,
  CancelledError,
  defineWorkflow,
  formatDuration,
  isCancellation,
  isWorkflowDefinition,
  isZodSchema,
  okValues,
  parseDuration,
  StepError,
  validateSchema,
  z,
} from "@techery/weft-sdk";
import { describe, expect, test } from "vitest";

describe("duration", () => {
  test("parses units and numbers", () => {
    expect(parseDuration(1500)).toBe(1500);
    expect(parseDuration("250ms")).toBe(250);
    expect(parseDuration("90s")).toBe(90_000);
    expect(parseDuration("10m")).toBe(600_000);
    expect(parseDuration("2h")).toBe(7_200_000);
    expect(parseDuration("1d")).toBe(86_400_000);
  });

  test("rejects malformed input", () => {
    expect(() => parseDuration("10 minutes" as never)).toThrow(/invalid duration/);
    expect(() => parseDuration(-5)).toThrow(/invalid duration/);
    expect(() => parseDuration(Number.NaN)).toThrow(/invalid duration/);
  });

  test("formats compactly", () => {
    expect(formatDuration(830)).toBe("830ms");
    expect(formatDuration(42_000)).toBe("42s");
    expect(formatDuration(252_000)).toBe("4m12s");
    expect(formatDuration(3_600_000)).toBe("1h");
  });
});

describe("schema validation", () => {
  test("valid value round-trips with types", async () => {
    const S = z.object({ real: z.boolean(), reason: z.string() });
    const r = await validateSchema(S, { real: true, reason: "loop bound" });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.real).toBe(true);
  });

  test("invalid value yields normalized issues with paths", async () => {
    const S = z.object({ findings: z.array(z.object({ file: z.string(), line: z.number() })) });
    const r = await validateSchema(S, { findings: [{ file: "a.ts", line: "3" }] });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.issues.length).toBeGreaterThan(0);
      expect(r.issues[0]!.path).toBe("findings.0.line");
    }
  });

  test("recognizes zod schemas", () => {
    expect(isZodSchema(z.string())).toBe(true);
  });
});

describe("StepError", () => {
  test("serializes and deserializes", () => {
    const e = new StepError("schema_repair_exhausted", "repair exhausted (2 attempts)", {
      step: { key: "refute:a.ts:3", kind: "agent", seq: 7 },
      attempts: 2,
    });
    const round = StepError.deserialize(e.serialize());
    expect(round.code).toBe("schema_repair_exhausted");
    expect(round.step.key).toBe("refute:a.ts:3");
    expect(round.attempts).toBe(2);
  });

  test("from() wraps unknown errors, passes StepError through", () => {
    const plain = StepError.from(new Error("boom"), { key: "x" });
    expect(plain.code).toBe("internal");
    const original = new CancelledError();
    expect(StepError.from(original)).toBe(original);
    expect(isCancellation(original)).toBe(true);
    expect(new BudgetExceededError("out of tokens").code).toBe("budget_exceeded");
  });
});

describe("defineWorkflow", () => {
  test("freezes and tags the definition", () => {
    const def = defineWorkflow(
      {
        description: "test",
        input: z.object({ base: z.string().default("main") }),
        output: z.object({ n: z.number() }),
      },
      async (_ctx, input) => ({ n: input.base.length }),
    );
    expect(def.kind).toBe("weft.workflow");
    expect(isWorkflowDefinition(def)).toBe(true);
    expect(Object.isFrozen(def)).toBe(true);
    expect(isWorkflowDefinition({ kind: "other" })).toBe(false);
  });

  test("rejects missing meta", () => {
    expect(() =>
      defineWorkflow({ description: undefined as never, input: z.any(), output: z.any() }, async () => ({})),
    ).toThrow(/description/);
  });
});

describe("settled helpers", () => {
  test("okValues extracts values in order", () => {
    const settled: Settled<number>[] = [
      { ok: true, value: 1 },
      { ok: false, error: new StepError("timeout", "t") },
      { ok: true, value: 3 },
    ];
    expect(okValues(settled)).toEqual([1, 3]);
  });
});
