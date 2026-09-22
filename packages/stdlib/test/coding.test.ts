import { describe, expect, test } from "vitest";
import {
  assertIntegratedWhenChanged,
  diagnosticRepair,
  findingKey,
  groupFindingsByFile,
  uniqueFindings,
} from "../src/index.ts";

describe("coding workflow patterns", () => {
  test("finding identity survives line movement without conflating different claims", () => {
    const finding = { file: "src/a.ts", claim: "Null pointer", line: 1 };
    expect(findingKey(finding)).toBe(
      findingKey({ ...finding, file: "./src/a.ts", claim: " Null   pointer " }),
    );
    expect(findingKey(finding)).not.toBe(findingKey({ ...finding, claim: "Stale pointer" }));
    expect(
      uniqueFindings([finding, { ...finding, line: 9 }, { ...finding, claim: "Stale pointer" }]),
    ).toHaveLength(2);
  });

  test("groups normalized file ownership before dispatching potentially conflicting writers", () => {
    expect(
      groupFindingsByFile([
        { file: "./a.ts", claim: "one" },
        { file: "a.ts", claim: "two" },
        { file: "b.ts", claim: "three" },
      ]).map(({ file, findings }) => ({ file, count: findings.length })),
    ).toEqual([
      { file: "a.ts", count: 2 },
      { file: "b.ts", count: 1 },
    ]);
  });

  test("only accepted changed patches satisfy the integration assertion", () => {
    expect(() => assertIntegratedWhenChanged("fix", [], [], [])).not.toThrow();
    expect(() => assertIntegratedWhenChanged("fix", ["a.ts"], ["fix"], [])).not.toThrow();
    expect(() => assertIntegratedWhenChanged("fix", ["a.ts"], [], [])).toThrow(/not integrated/);
    expect(() => assertIntegratedWhenChanged("fix", ["a.ts"], ["fix"], ["fix"])).toThrow(/not integrated/);
  });

  test("diagnostics re-enter after each repair and stop on acceptance", async () => {
    const calls: string[] = [];
    const result = await diagnosticRepair({
      maxRepairs: 3,
      diagnose: async (round) => {
        calls.push(`diagnose:${round}`);
        return { passed: round === 2 };
      },
      accepted: (result) => result.passed,
      repair: async (_result, round) => {
        calls.push(`repair:${round}`);
      },
    });
    expect(result).toEqual({ result: { passed: true }, repairs: 2 });
    expect(calls).toEqual(["diagnose:0", "repair:1", "diagnose:1", "repair:2", "diagnose:2"]);
  });

  test("exhaustion returns failed evidence for the final caller gate", async () => {
    const result = await diagnosticRepair({
      maxRepairs: 0,
      diagnose: async () => false,
      accepted: (value) => value,
      repair: async () => {
        throw new Error("Must not repair");
      },
    });
    expect(result).toEqual({ result: false, repairs: 0 });
    await expect(
      diagnosticRepair({
        maxRepairs: -1,
        diagnose: async () => false,
        accepted: (value) => value,
        repair: async () => {},
      }),
    ).rejects.toThrow(/non-negative safe integer/);
  });
});
