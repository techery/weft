import { describe, expect, it } from "vitest";
import { parseBudget } from "../src/index.ts";

describe("parseBudget", () => {
  it("reads token counts, with and without a scale suffix", () => {
    expect(parseBudget("500k")).toEqual({ tokens: 500_000 });
    expect(parseBudget("2m")).toEqual({ tokens: 2_000_000 });
    expect(parseBudget("1.5M")).toEqual({ tokens: 1_500_000 });
    expect(parseBudget("1b")).toEqual({ tokens: 1_000_000_000 });
    expect(parseBudget("120000")).toEqual({ tokens: 120_000 });
    expect(parseBudget("0")).toEqual({ tokens: 0 });
  });

  it("reads dollar amounts", () => {
    expect(parseBudget("$5")).toEqual({ usd: 5 });
    expect(parseBudget("$0.50")).toEqual({ usd: 0.5 });
    expect(parseBudget("$2.5k")).toEqual({ usd: 2500 });
  });

  it("reads both axes at once", () => {
    expect(parseBudget("500k,$5")).toEqual({ tokens: 500_000, usd: 5 });
    expect(parseBudget("$5 500k")).toEqual({ tokens: 500_000, usd: 5 });
  });

  it("ignores surrounding whitespace", () => {
    expect(parseBudget("  500k  ")).toEqual({ tokens: 500_000 });
  });

  it("throws on junk", () => {
    for (const junk of ["", "   ", "abc", "5x", "$", "$abc", "-5", "5k5", "500 k", "1/2"]) {
      expect(() => parseBudget(junk), junk).toThrow(/invalid budget/);
    }
  });

  it("throws when one axis is given twice", () => {
    expect(() => parseBudget("$5 $6")).toThrow(/\$ given twice/);
    expect(() => parseBudget("500k 2m")).toThrow(/token count given twice/);
  });
});
