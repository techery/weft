import { type Ctx, defineProcedure, type ProcedureFn, z } from "@techery/weft-sdk";
import { expect, test } from "vitest";

test("procedure definitions validate and expose immutable capability metadata", () => {
  const procedure = defineProcedure({
    name: "review",
    revision: "v1",
    input: z.string(),
    output: z.string(),
    requires: ["log"],
    run: (ctx: Pick<Ctx, "log">, input) => {
      ctx.log(input);
      return input;
    },
  });
  expect(procedure.requires).toEqual(["log"]);
  expect(Object.isFrozen(procedure)).toBe(true);
  expect(Object.isFrozen(procedure.requires)).toBe(true);
  expect(() => defineProcedure({ ...procedure, revision: "" })).toThrow(/revision/);
});

// Compile-only capability and schema fixtures. This function must never run.
async function capabilityTypes(full: Ctx<{ label: string }>, narrow: ProcedureFn<Pick<Ctx, "log">>) {
  const git = defineProcedure({
    name: "git",
    revision: "v1",
    input: z.string(),
    output: z.string(),
    run: async (ctx: Pick<Ctx, "git">, input) => {
      await ctx.git.branch.create(input);
      return input;
    },
  });
  const value: string = await full.procedure(git, "work", { key: "prepare" });
  // @ts-expect-error A context offering only log cannot run a procedure requiring git.
  await narrow(git, "work", { key: "prepare" });
  // @ts-expect-error Schema input must be respected.
  await full.procedure(git, 123, { key: "prepare" });
  const tasks = defineProcedure({
    name: "tasks",
    revision: "v1",
    input: z.string(),
    output: z.string(),
    run: async (ctx: Pick<Ctx<{ label: string }>, "tasks">, input) => {
      const snapshot = await ctx.tasks.observe({}, { key: "tasks" });
      const label: string | undefined = snapshot.tasks[0]?.extensions?.label;
      return label ?? input;
    },
  });
  await full.procedure(tasks, value, { key: "tasks" });
  await full.parallel.all(
    [value],
    async (_item, lane) => {
      const snapshot = await lane.tasks.observe({}, { key: "observe" });
      const label: string | undefined = snapshot.tasks[0]?.extensions?.label;
      return label;
    },
    { key: "lanes", keyOf: (item) => item },
  );
}
void capabilityTypes;
