import { defineWorkflow, failures, z } from "@techery/weft-sdk";

const child = defineWorkflow(
  { description: "Double one number", input: z.object({ n: z.number() }), output: z.number() },
  async (_ctx, { n }) => n * 2,
);

export default defineWorkflow(
  {
    name: "example-composition",
    description: "Minimal structured agents, parallel lanes, pipelines, and child workflows.",
    input: z.object({ values: z.array(z.number()).default([1, 2, 3]) }),
    output: z.object({
      values: z.array(z.number()),
      failures: z.number(),
      children: z.array(z.number()),
    }),
  },
  async (ctx, { values }) => {
    ctx.phase("Compose");
    ctx.log("Run one structured call and one detailed call.");
    await ctx.agent("Return the number one.", { key: "one", schema: z.object({ n: z.literal(1) }) });
    await ctx.agent.detailed("Return the number two.", {
      key: "two",
      provider: "codex",
      providerOptions: {
        codex: { sandboxMode: "read-only", networkAccess: false, webSearch: "cached" },
      },
      providerRequirements: { structured: "native", sessionResume: true },
      schema: z.object({ n: z.literal(2) }),
      retry: { attempts: 2, backoff: "10ms" },
    });
    const settled = await ctx.parallel(values, async (value) => value * 2, { concurrency: 2 });
    const piped = await ctx
      .pipeline(ctx.all(settled))
      .step((value) => value + 1)
      .filter((value) => value > 2)
      .map((value) => value * 10)
      .run();
    const children = await ctx.sequence(
      values,
      { keyOf: (value) => String(value), phase: (value) => `Value ${value}`, keyPrefix: "value" },
      (value, item) => item.ctx.workflow(child, { n: value }, { key: item.key("double") }),
    );
    return {
      values: ctx.successes(piped),
      failures: failures(piped).length,
      children,
    };
  },
);
