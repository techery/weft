import { describe, expect, it } from "vitest";
import { workflowMigrationWarnings } from "../src/migration.ts";

describe("advisory authoring migration diagnostics", () => {
  it("names partial-result and eager fan-out choices without treating them as gate violations", () => {
    const warnings = workflowMigrationWarnings(
      'const partial = ctx.successes(await ctx.parallel([ctx.agent("a", options)]));',
      "review.ts",
    );
    expect(warnings.map((warning) => warning.rule)).toEqual([
      "migration-optional-lanes",
      "migration-eager-parallel",
    ]);
    expect(warnings[0]).toMatchObject({
      file: "review.ts",
      line: 1,
      column: 17,
      fixIt: expect.stringContaining("ctx.parallel.all"),
    });
  });

  it("does not warn on lazy/keyed fan-out or arbitrary objects with similarly named methods", () => {
    const source =
      'ctx.parallel([() => ctx.agent("a", options)]); ctx.parallel.all(items, run, options); other.successes(results);';
    expect(workflowMigrationWarnings(source)).toEqual([]);
  });

  it("finds callback definitions without revisions and explains replay behavior", () => {
    const source =
      'defineCheck({ name: "a", run: () => true }); defineCheck({ name: "b", revision: "v1", run: () => true }); ctx.check.fn("c", () => true); ctx.check("d", { fn: () => true });';
    expect(workflowMigrationWarnings(source).map((warning) => warning.rule)).toEqual(
      Array(3).fill("migration-check-revision"),
    );
  });

  it("gives preview imports a runnable-SDK remedy", () => {
    const [warning] = workflowMigrationWarnings('import { defineWorkflow } from "@techery/weft-dsl-proto";');
    expect(warning).toMatchObject({
      rule: "migration-preview-import",
      fixIt: expect.stringContaining("@techery/weft-sdk"),
    });
  });
});
