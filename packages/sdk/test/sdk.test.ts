import type { Settled } from "@techery/weft-sdk";
import {
  BudgetExceededError,
  CancelledError,
  defineAgent,
  defineCheck,
  defineCheckSuite,
  definePrompt,
  defineRecipe,
  defineStep,
  defineTaskContract,
  defineWorkflow,
  formatDuration,
  type InferWorkflowInput,
  type InferWorkflowOutput,
  isCancellation,
  isWorkflowDefinition,
  isZodSchema,
  okValues,
  parseDuration,
  prompt,
  StepError,
  validateSchema,
  z,
} from "@techery/weft-sdk";
import { defineResultView } from "@techery/weft-sdk/ui";
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

  test("rejects path-like durable ids and names", () => {
    const base = { id: "task-schema-test", description: "test", input: z.object({}), output: z.object({}) };
    expect(() => defineWorkflow({ ...base, id: "team/review" }, async () => ({}))).toThrow(/meta.id/);
    expect(() => defineWorkflow({ ...base, name: "review.ts" }, async () => ({}))).toThrow(/meta.name/);
    expect(() => defineWorkflow({ ...base, id: "stable-review" }, async () => ({}))).not.toThrow();
  });

  test("validates workflow task schema evolution metadata", () => {
    const base = { id: "task-schema-test", description: "test", input: z.object({}), output: z.object({}) };
    expect(() => defineWorkflow({ ...base, tasks: { schemaVersion: 0 } }, async () => ({}))).toThrow(
      /positive integer/,
    );
    expect(() =>
      defineWorkflow(
        {
          ...base,
          tasks: {
            extensions: z.object({ owner: z.string() }),
            semanticRevision: "platform-owner-v2",
            schemaVersion: 2,
            migrate: () => ({ owner: "platform" }),
          },
        },
        async () => ({}),
      ),
    ).not.toThrow();
    expect(() =>
      defineWorkflow(
        {
          ...base,
          tasks: { extensions: z.object({ owner: z.string() }) } as never,
        },
        async () => ({}),
      ),
    ).toThrow(/semanticRevision/);
    expect(() =>
      defineWorkflow(
        {
          ...base,
          tasks: {
            extensions: z.object({ owner: z.string() }),
            semanticRevision: "   ",
          },
        },
        async () => ({}),
      ),
    ).toThrow(/semanticRevision/);
    expect(() =>
      defineWorkflow(
        {
          ...base,
          tasks: {
            semanticRevision: "retire-owner-v3",
            schemaVersion: 3,
            migrate: () => ({}),
          },
        },
        async () => ({}),
      ),
    ).not.toThrow();
  });

  test("requires a stable id when durable task configuration is declared", () => {
    expect(() =>
      defineWorkflow(
        {
          description: "missing durable identity",
          input: z.object({}),
          output: z.object({}),
          tasks: {},
        },
        async () => ({}),
      ),
    ).toThrow(/meta.id is required/);
  });

  test("defineTaskContract names schema, persisted version, and executable revision", () => {
    const contract = defineTaskContract({
      schema: z.object({ owner: z.string() }),
      revision: "owner-v2",
      version: 2,
      agentAccess: "read",
    });
    expect(contract).toMatchObject({
      semanticRevision: "owner-v2",
      schemaVersion: 2,
      agentAccess: "read",
    });
  });

  test("task extensions are inferred from workflow metadata", () => {
    defineWorkflow(
      {
        id: "typed-task-extensions",
        description: "typed tasks",
        input: z.object({}),
        output: z.object({}),
        tasks: defineTaskContract({
          schema: z.object({ owner: z.string() }),
          revision: "owner-v1",
        }),
      },
      async (ctx) => {
        await ctx.tasks.upsert({
          dedupeKey: "typed",
          key: "typed",
          set: { title: "Typed", description: "Typed", extensions: { owner: "platform" } },
        });
        await ctx.tasks.upsert({
          dedupeKey: "invalid",
          key: "invalid",
          set: {
            title: "Invalid",
            description: "Invalid",
            // @ts-expect-error owner is inferred as string from the workflow task contract
            extensions: { owner: 42 },
          },
        });
        return {};
      },
    );
  });

  test("composition accepts raw schema input while workflow bodies and outputs stay parsed", () => {
    const child = defineWorkflow(
      {
        id: "transformed-child",
        description: "parse a raw identifier",
        input: z.string().transform((value) => ({ value })),
        output: z.object({ value: z.string() }),
      },
      async (_ctx, input) => ({ value: input.value }),
    );
    const raw: InferWorkflowInput<typeof child> = "raw-id";
    const parsed: InferWorkflowOutput<typeof child> = { value: "parsed-id" };
    expect(raw).toBe("raw-id");
    expect(parsed).toEqual({ value: "parsed-id" });

    defineWorkflow(
      {
        description: "compose the child",
        input: z.object({}),
        output: z.object({ value: z.string() }),
      },
      async (ctx) => {
        const output = await ctx.workflow(child, "raw-id");
        // @ts-expect-error callers provide schema input, not the parsed workflow-body value
        await ctx.workflow(child, { value: "already-parsed" });
        return output;
      },
    );
  });

  test("task mutations accept schema input and observations expose schema output", () => {
    defineWorkflow(
      {
        id: "transformed-task-extensions",
        description: "separate raw and parsed task extensions",
        input: z.object({}),
        output: z.object({}),
        tasks: defineTaskContract({
          schema: z.object({
            owner: z.string().default("platform"),
            code: z.string().transform((value) => ({ value })),
          }),
          revision: "transformed-task-extensions-v1",
        }),
      },
      async (ctx) => {
        await ctx.tasks.upsert({
          dedupeKey: "raw",
          key: "task:raw",
          set: { title: "Raw", description: "Raw", extensions: { code: "ABC" } },
        });
        await ctx.tasks.upsert({
          dedupeKey: "parsed",
          key: "task:parsed",
          set: {
            title: "Parsed",
            description: "Parsed",
            // @ts-expect-error mutations accept the raw string, not the transformed object
            extensions: { owner: "platform", code: { value: "ABC" } },
          },
        });
        const snapshot = await ctx.tasks.observe({}, { key: "tasks:observe" });
        const extension = snapshot.tasks[0]?.extensions;
        if (extension) {
          const owner: string = extension.owner;
          const code: string = extension.code.value;
          void owner;
          void code;
        }
        return {};
      },
    );
  });

  test("checks require one explicit execution or skip source", () => {
    defineWorkflow(
      {
        description: "typed checks",
        input: z.object({}),
        output: z.object({}),
      },
      async (ctx) => {
        await ctx.check.exec("tests", ["pnpm", "test"], { required: true });
        // @ts-expect-error a required flag alone does not execute or deliberately skip a check
        await ctx.check("missing", { required: true });
        return {};
      },
    );
  });
});

describe("reusable workflow definitions", () => {
  test("renders named prompt sections independently of the runtime", () => {
    const reviewPrompt = definePrompt<{ file: string; context?: object }>({
      name: "review-file",
      render: ({ file, context }) => [
        prompt.section("Role", "Review this change as a maintainer."),
        prompt.section("File", file),
        context && prompt.json("Context", context),
        false,
      ],
    });

    expect(reviewPrompt.render({ file: "src/auth.ts", context: { base: "main" } })).toBe(
      [
        "## Role\nReview this change as a maintainer.",
        "## File\nsrc/auth.ts",
        '## Context\n```json\n{\n  "base": "main"\n}\n```',
      ].join("\n\n"),
    );
  });

  test("freezes reusable agents and steps", () => {
    const template = definePrompt<string>({ name: "echo", render: (value) => value });
    const agent = defineAgent({
      name: "echoer",
      prompt: template,
      schema: z.object({ value: z.string() }),
      defaults: { effort: "low" },
    });
    const step = defineStep({ name: "echo-step", run: async () => "ok" });

    expect(agent.kind).toBe("weft.agent");
    expect(agent.defaults).toEqual({ effort: "low" });
    expect(step.kind).toBe("weft.step");
    expect(Object.isFrozen(agent)).toBe(true);
    expect(Object.isFrozen(agent.defaults)).toBe(true);
    expect(Object.isFrozen(step)).toBe(true);
  });

  test("infers schema-backed prompts and recipes", () => {
    const input = z.object({ value: z.coerce.number() });
    const output = z.object({ doubled: z.number() });
    const template = definePrompt({
      name: "number-prompt",
      input,
      render: ({ value }) => `Value: ${value}`,
    });
    const recipe = defineRecipe({
      name: "double",
      input,
      output,
      run: (_ctx, { value }) => ({ doubled: value * 2 }),
    });

    expect(template.input).toBe(input);
    expect(template.render({ value: 3 })).toBe("Value: 3");
    expect(recipe.kind).toBe("weft.recipe");
    expect(recipe.input).toBe(input);
    expect(recipe.output).toBe(output);
    expect(Object.isFrozen(recipe)).toBe(true);
  });

  test("defines static and parameterized reusable checks", () => {
    const lint = defineCheck({
      name: "lint",
      description: "Run the repository linter",
      command: ["pnpm", "lint"],
      policy: "required",
    });
    const PackageTestInput = z.object({ package: z.string().trim() });
    const packageTests = defineCheck({
      name: "package-tests",
      input: PackageTestInput,
      policy: "required",
      command: ({ package: packageName }) => ["pnpm", "--filter", packageName, "test"],
    });

    expect(lint.mode).toBe("command");
    if (lint.mode === "command") expect(lint.command(undefined)).toEqual(["pnpm", "lint"]);
    expect(packageTests.mode).toBe("command");
    if (packageTests.mode === "command") {
      expect(packageTests.command({ package: "@techery/weft-sdk" })).toEqual([
        "pnpm",
        "--filter",
        "@techery/weft-sdk",
        "test",
      ]);
    }
    expect(lint.policy).toBe("required");
    expect(packageTests.input).toBe(PackageTestInput);
    expect(Object.isFrozen(lint)).toBe(true);

    defineWorkflow(
      { description: "schema-inferred check input", input: z.object({}), output: z.object({}) },
      async (ctx) => {
        await ctx.check(packageTests, { package: "@techery/weft-sdk" });
        // @ts-expect-error parameterized check invocation is inferred from its input schema
        await ctx.check(packageTests, { package: 42 });
        return {};
      },
    );
  });

  test("defines immutable suites from uniquely named static checks", () => {
    const lint = defineCheck({ name: "lint", command: ["pnpm", "lint"] });
    const tests = defineCheck({ name: "tests", command: ["pnpm", "test"] });
    const quality = defineCheckSuite({
      name: "quality",
      checks: [lint, tests],
      concurrency: 2,
    });

    expect(quality.checks).toEqual([lint, tests]);
    expect(quality.concurrency).toBe(2);
    expect(Object.isFrozen(quality)).toBe(true);
    expect(Object.isFrozen(quality.checks)).toBe(true);
  });

  test("rejects ambiguous checks and invalid suites", () => {
    expect(() => defineCheck({ name: "missing" } as never)).toThrow(/exactly one/);
    expect(() =>
      defineCheck({ name: "ambiguous", command: ["pnpm", "test"], run: () => true } as never),
    ).toThrow(/exactly one/);
    expect(() => defineCheck({ name: "invalid-run", run: "not a function" } as never)).toThrow(
      /run must be a function/,
    );
    expect(() => defineCheck({ name: "invalid-input", input: {}, run: () => true } as never)).toThrow(
      /input.*Standard Schema/,
    );
    expect(() =>
      defineCheck({ name: "invalid-policy", policy: "optional", run: () => true } as never),
    ).toThrow(/policy/);
    expect(() => defineCheck({ name: "invalid-revision", revision: 1, run: () => true } as never)).toThrow(
      /revision/,
    );
    expect(() => defineCheck({ name: "empty-command", command: [] } as never)).toThrow(/non-empty/);
    expect(() => defineCheckSuite({ name: "empty", checks: [] })).toThrow(/at least one/);

    const lint = defineCheck({ name: "lint", command: ["pnpm", "lint"] });
    expect(() => defineCheckSuite({ name: "duplicate", checks: [lint, lint] })).toThrow(/duplicate.*lint/);
    const parameterized = defineCheck({
      name: "package-tests",
      input: z.string(),
      command: (packageName) => ["pnpm", "--filter", packageName, "test"],
    });
    expect(() => defineCheckSuite({ name: "dynamic", checks: [parameterized as never] })).toThrow(/static/);
    expect(() => defineCheckSuite({ name: "bad-concurrency", checks: [lint], concurrency: 0 })).toThrow(
      /positive integer/,
    );
  });

  test("rejects malformed reusable definitions", () => {
    expect(() => definePrompt({ name: "", render: () => "x" })).toThrow(/non-empty/);
    expect(() => defineAgent({ name: "agent", prompt: {} as never, schema: z.string() })).toThrow(
      /definePrompt/,
    );
    expect(() => defineStep({ name: "step", run: undefined as never })).toThrow(/run/);
  });
});

describe("custom UI JSON boundary", () => {
  test("accepts named JSON props and rejects non-JSON props at type-check time", () => {
    interface CardProps {
      title: string;
      details?: { count: number };
    }
    const card = defineResultView<CardProps>({ id: "card", component: () => null });
    expect(card.revision).toBe("auto");

    // @ts-expect-error Date cannot cross the custom UI JSON boundary
    defineResultView<{ createdAt: Date }>({
      id: "invalid-date",
      component: () => null,
    });
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
