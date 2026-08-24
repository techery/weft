/**
 * `weft run review --basse release-2.0` used to review `main` and say nothing: dynamic
 * flags accept any `--name`, and a Zod object strips what it does not know. But an OPEN
 * schema — `.passthrough()`, `.loose()`, `.catchall(…)` — has a shape too, and rejecting
 * everything outside it would refuse the very fields such a workflow exists to receive.
 */
import { defineWorkflow, z } from "@techery/weft-sdk";
import { describe, expect, it } from "vitest";
import { rejectUnknownInput } from "../src/commands/run.ts";

const wf = (input: z.ZodType) =>
  defineWorkflow({ name: "w", description: "w", input, output: z.object({}) }, async () => ({}));

describe("rejectUnknownInput", () => {
  it("refuses a key a closed schema would silently drop", async () => {
    const def = wf(z.object({ base: z.string().default("main") }));
    await expect(rejectUnknownInput({ basse: "release-2.0" }, def, "review")).rejects.toThrow(
      /no input field "basse".*--base/s,
    );
  });

  it("accepts a declared key", async () => {
    const def = wf(z.object({ base: z.string().default("main") }));
    await expect(rejectUnknownInput({ base: "HEAD~1" }, def, "review")).resolves.toBeUndefined();
  });

  it("leaves a passthrough schema's extra fields alone", async () => {
    const def = wf(z.object({ base: z.string() }).passthrough());
    await expect(rejectUnknownInput({ base: "main", extra: "kept" }, def, "open")).resolves.toBeUndefined();
  });

  it("leaves a catchall schema's extra fields alone", async () => {
    const def = wf(z.object({ base: z.string() }).catchall(z.number()));
    await expect(rejectUnknownInput({ base: "main", score: 3 }, def, "open")).resolves.toBeUndefined();
  });

  it("says nothing when the schema itself rejects the input", async () => {
    // The engine surfaces the schema's own error in a moment; this check must not
    // pre-empt it with a worse one.
    const def = wf(z.object({ base: z.string() }).strict());
    await expect(rejectUnknownInput({ base: "main", nope: 1 }, def, "strict")).resolves.toBeUndefined();
  });

  it("ignores a transform that reshapes the output", async () => {
    const def = wf(z.object({ base: z.string() }).transform((v) => [v.base]));
    await expect(rejectUnknownInput({ base: "main" }, def, "t")).resolves.toBeUndefined();
  });
});
