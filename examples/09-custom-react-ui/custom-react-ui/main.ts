/**
 * Custom workflow UI: read-only presentations remain separate replayable steps,
 * while input views can stage—but never submit—a schema-validated human answer.
 *
 *   pnpm exec weft run ./examples/09-custom-react-ui/custom-react-ui/main.ts \
 *     --args '{"environment":"production","services":["api","web","worker","billing"]}' --watch
 */
import { defineWorkflow } from "@techery/weft-sdk";
import outcomeView from "./lib/deployment-outcome.ui.tsx";
import planView from "./lib/deployment-plan.ui.tsx";
import reviewView from "./lib/deployment-review.ui.tsx";
import { DeploymentDecision, DeploymentInput, DeploymentOutput } from "./lib/schemas.ts";

export default defineWorkflow(
  {
    id: "example.custom-react-ui",
    name: "custom-react-ui",
    description:
      "Exercise rich, durable workflow UI across healthy, risky, partial, empty, and rejected states.",
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

    const requestedServices = new Set(input.services);
    const approved = new Set(
      decision.intent === "reject"
        ? []
        : decision.approvedServices.filter((service) => requestedServices.has(service)),
    );
    const approvedServices = input.services.filter((service) => approved.has(service));
    const deferredServices = input.services.filter((service) => !approved.has(service));
    const normalizedDecision: "approved" | "partial" | "rejected" =
      approvedServices.length === 0 ? "rejected" : deferredServices.length === 0 ? "approved" : "partial";
    const warnings = [
      ...(deferredServices.length > 0
        ? [`${deferredServices.length} service${deferredServices.length === 1 ? "" : "s"} deferred`]
        : []),
      ...(decision.trafficPercent < 100 ? [`Canary limited to ${decision.trafficPercent}% traffic`] : []),
      ...(!decision.rollbackOnError ? ["Automatic rollback disabled"] : []),
      ...(input.environment === "production" && !decision.changeTicket
        ? ["Production change ticket not supplied"]
        : []),
    ];
    const result = {
      environment: input.environment,
      releaseName: input.releaseName,
      version: input.version,
      risk: input.risk,
      window: input.window,
      decision: normalizedDecision,
      approvedServices,
      deferredServices,
      strategy: decision.strategy,
      trafficPercent: decision.trafficPercent,
      monitorMinutes: decision.monitorMinutes,
      rollbackOnError: decision.rollbackOnError,
      runSmokeTests: decision.runSmokeTests,
      ...(decision.changeTicket ? { changeTicket: decision.changeTicket } : {}),
      ...(decision.note ? { note: decision.note } : {}),
      warnings,
    };

    ctx.phase("Summarize");
    await ctx.ui.render({
      key: "deployment-outcome",
      slot: "deployment",
      view: outcomeView,
      props: result,
    });

    return result;
  },
);
