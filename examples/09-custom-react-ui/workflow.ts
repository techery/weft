/**
 * Custom workflow UI: read-only presentations remain separate replayable steps,
 * while input views can stage—but never submit—a schema-validated human answer.
 *
 *   pnpm exec weft run ./examples/09-custom-react-ui/workflow.ts \
 *     --args '{"environment":"staging","services":["api","web","worker"]}' --watch
 */
import { defineWorkflow } from "@techery/weft-sdk";
import outcomeView from "./deployment-outcome.ui.tsx";
import planView from "./deployment-plan.ui.tsx";
import reviewView from "./deployment-review.ui.tsx";
import { DeploymentDecision, DeploymentInput, DeploymentOutput } from "./schemas.ts";

export default defineWorkflow(
  {
    id: "example.custom-react-ui",
    name: "custom-react-ui",
    description: "Render durable React views for a deployment plan, human decision, and composed result.",
    input: DeploymentInput,
    output: DeploymentOutput,
  },
  async (ctx, input) => {
    ctx.phase("Present");
    await ctx.ui.render({
      key: "deployment-plan",
      slot: "deployment",
      view: planView,
      props: input,
    });

    ctx.phase("Decide");
    const decision = await ctx.human.ask({
      key: "deployment-review",
      question: `Which services should deploy to ${input.environment}?`,
      detail: "Use the custom view or the standard schema form, then submit from Weft's host controls.",
      schema: DeploymentDecision,
      ui: { view: reviewView, props: input },
    });

    const approved = new Set(decision.approvedServices);
    const result = {
      environment: input.environment,
      approvedServices: input.services.filter((service) => approved.has(service)),
      deferredServices: input.services.filter((service) => !approved.has(service)),
      ...(decision.note ? { note: decision.note } : {}),
    };

    ctx.phase("Summarize");
    await ctx.ui.render({
      key: "deployment-outcome",
      slot: "deployment",
      view: outcomeView,
      props: {
        environment: result.environment,
        approved: result.approvedServices,
        deferred: result.deferredServices,
        ...(result.note ? { note: result.note } : {}),
      },
    });

    return result;
  },
);
