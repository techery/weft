import { defineWorkflow, z } from "@techery/weft-sdk";

export default defineWorkflow(
  {
    id: "example.state-tasks-and-patches",
    name: "example-state-tasks-and-patches",
    description: "Minimal run state, durable values, task mutations, notes, patch integration, and discard.",
    input: z.object({ taskId: z.string().optional(), integrate: z.boolean().default(false) }),
    output: z.object({ id: z.string(), now: z.number(), random: z.number(), uuid: z.string() }),
  },
  async (ctx, input) => {
    ctx.phase("State");
    ctx.log(`run ${ctx.run.id}; remaining tokens ${ctx.budget.remaining.tokens ?? "unlimited"}`);
    const [now, random, uuid] = await Promise.all([ctx.now(), ctx.random(), ctx.uuid()]);
    await ctx.note({ kind: "decision", text: "Demonstrate the public state APIs." });

    const snapshot = await ctx.tasks.observe({ statuses: ["todo"] }, { key: "tasks:observe" });
    await ctx.tasks.upsert(
      "example",
      {
        create: { title: "Example task", description: "Created by the API cookbook." },
        update: { priority: "low" },
      },
      { key: "tasks:upsert" },
    );
    const taskId = input.taskId ?? snapshot.tasks[0]?.id;
    if (taskId) {
      await ctx.tasks.update(taskId, { status: "in_progress" }, { key: "tasks:update" });
      await ctx.tasks.note(taskId, "Minimal task note.", { key: "tasks:note" });
      const criterion = snapshot.tasks.find((task) => task.id === taskId)?.acceptanceCriteria[0];
      if (criterion) await ctx.tasks.setCriterion(taskId, criterion.id, true, { key: "tasks:criterion" });
    }

    const change = await ctx.agent.detailed("Make one small documented change.", {
      key: "change",
      schema: z.object({ summary: z.string() }),
      write: { paths: ["docs/**"] },
    });
    if (input.integrate) await ctx.integrate([change], { order: "sequential", onConflict: "fail" });
    else await ctx.discard([change]);
    return { id: ctx.run.id, now, random, uuid };
  },
);
