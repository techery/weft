import { defineWorkflow, z } from "@techery/weft-sdk";

export default defineWorkflow(
  {
    name: "example-humans-and-waits",
    description: "Minimal gates, human questions, signals, and durable waits.",
    input: z.object({}),
    output: z.object({ choice: z.string(), signal: z.string() }),
  },
  async (ctx) => {
    await ctx.gate({ action: "Continue the example", risk: "low" });
    await ctx.human.approve({ key: "approve", action: "Publish the example" });
    const choice = await ctx.human.ask({
      key: "ask",
      question: "Choose a lane",
      schema: z.object({ lane: z.enum(["a", "b"]) }),
    });
    await ctx.human.review({
      key: "review",
      artifact: "# Minimal artifact",
      schema: z.object({ accepted: z.boolean() }),
    });
    await ctx.sleep("10ms");
    const signal = await ctx.signal("external-ready", z.object({ value: z.string() }), { timeout: "5m" });
    return { choice: choice.lane, signal: signal.value };
  },
);
