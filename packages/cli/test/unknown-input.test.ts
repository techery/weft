/**
 * `weft run review --basse release-2.0` used to review `main` and say nothing: dynamic
 * flags accept any `--name`, and a Zod object strips what it does not know. But an OPEN
 * schema — `.passthrough()`, `.loose()`, `.catchall(…)` — has a shape too, and rejecting
 * everything outside it would refuse the very fields such a workflow exists to receive.
 */

import { rejectUnknownInput } from "@techery/weft-host";
import { defineWorkflow, z } from "@techery/weft-sdk";
import { describe, expect, it } from "vitest";

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

  it("accepts a key a transform RENAMES", async () => {
    // The output has no `base` — the transform consumed it and handed back `baseRef`.
    // Comparing key lists alone reads that as "silently dropped" and refuses the
    // workflow's own documented flag. Whether the schema READ the key is the actual
    // question, and only re-validating without it can answer that.
    const def = wf(z.object({ base: z.string() }).transform(({ base }) => ({ baseRef: base })));
    await expect(rejectUnknownInput({ base: "release-2.0" }, def, "review")).resolves.toBeUndefined();
  });

  it("still refuses a typo alongside a renaming transform", async () => {
    // The other half of the same schema: `base` is load-bearing, `basse` is not, and the
    // relaxation above must not swallow the typo it sits next to.
    const def = wf(
      z.object({ base: z.string().default("main") }).transform(({ base }) => ({ baseRef: base })),
    );
    await expect(rejectUnknownInput({ base: "main", basse: "x" }, def, "review")).rejects.toThrow(
      /no input field "basse"/,
    );
  });

  it("refuses a renamed key whose value the transform ignores", async () => {
    // A default makes the key optional, so dropping it still validates — but it lands on
    // a DIFFERENT value, which is the schema saying it read the key.
    const def = wf(
      z.object({ base: z.string().default("main") }).transform(({ base }) => ({ baseRef: base })),
    );
    await expect(rejectUnknownInput({ base: "release-2.0" }, def, "review")).resolves.toBeUndefined();
  });

  it("does not mistake an inherited property name for a declared field", async () => {
    // `in` walks the prototype chain, so `constructor`, `toString` and `__proto__` all
    // read as "kept" on any ordinary object literal — every one of them a typo that
    // would run the workflow on its defaults instead.
    const def = wf(z.object({ base: z.string().default("main") }));
    for (const key of ["constructor", "toString", "valueOf", "hasOwnProperty"]) {
      await expect(rejectUnknownInput({ [key]: "x" }, def, "review")).rejects.toThrow(
        new RegExp(`no input field "${key}"`),
      );
    }
  });
});
