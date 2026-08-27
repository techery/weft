import { defineWorkflow, z } from "@techery/weft-sdk";

export default defineWorkflow(
  {
    name: "example-humans-and-waits",
    description: "Minimal gates, human questions, signals, and durable waits.",
    input: z.object({ plan: z.string().default("README.md"), edit: z.boolean().default(false) }),
    output: z.object({ choice: z.string(), signal: z.string(), reviewedRef: z.string() }),
  },
  async (ctx, { plan, edit }) => {
    await ctx.gate({ action: "Continue the example", risk: "low" });
    await ctx.human.approve({ key: "approve", action: "Publish the example" });
    const choice = await ctx.human.ask({
      key: "ask",
      question: "Choose a lane",
      schema: z.object({ lane: z.enum(["a", "b"]) }),
    });
    const reviewed = await ctx.human.review.detailed({
      key: "review",
      subject: { kind: "file", path: plan, mode: edit ? "edit" : "view" },
      attachments: [
        {
          kind: "artifact",
          content: "# Review brief\nKeep changes within the agreed scope.",
          label: "brief",
        },
      ],
      schema: z.object({ accepted: z.boolean() }),
    });
    await ctx.sleep("10ms");
    const signal = await ctx.signal("external-ready", z.object({ value: z.string() }), { timeout: "5m" });
    return { choice: choice.lane, signal: signal.value, reviewedRef: reviewed.subject.ref };
  },
);
