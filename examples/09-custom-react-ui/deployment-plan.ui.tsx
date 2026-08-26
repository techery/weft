import { defineResultView, type ResultViewProps } from "@techery/weft-sdk/ui";
import type { Service } from "./schemas.ts";

type Props = {
  environment: "staging" | "production";
  services: Service[];
};

function DeploymentPlan({ props }: ResultViewProps<Props>) {
  return (
    <main style={{ padding: 20, color: "#17211b", background: "#f5f8f5" }}>
      <p style={{ margin: 0, color: "#657068", fontSize: 12, textTransform: "uppercase" }}>
        Proposed deployment
      </p>
      <h2 style={{ margin: "6px 0 14px" }}>{props.environment}</h2>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
        {props.services.map((service) => (
          <span key={service} style={{ padding: "6px 10px", border: "1px solid #a8b8ac", borderRadius: 999 }}>
            {service}
          </span>
        ))}
      </div>
    </main>
  );
}

export default defineResultView<Props>({
  id: "example.deployment-plan",
  revision: "1",
  component: DeploymentPlan,
});
