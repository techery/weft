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
    output: z.object({ values: z.array(z.number()), failures: z.number(), child: z.number() }),
  },
  async (ctx, { values }) => {
    ctx.phase("Compose");
    ctx.log("Run one structured call and one detailed call.");
    await ctx.agent("Return the number one.", { key: "one", schema: z.object({ n: z.literal(1) }) });
    await ctx.agent.detailed("Return the number two.", {
      key: "two",
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
    return {
      values: ctx.successes(piped),
      failures: failures(piped).length,
      child: await ctx.workflow(child, { n: values[0] ?? 0 }, { key: "child" }),
    };
  },
);
