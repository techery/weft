import { defineResultView, type ResultViewProps } from "@techery/weft-sdk/ui";
import type { Service } from "./schemas.ts";

type Props = {
  environment: "staging" | "production";
  approved: Service[];
  deferred: Service[];
  note?: string;
};

function ServiceList({ label, services }: { label: string; services: Service[] }) {
  return (
    <section style={{ padding: 14, border: "1px solid #c9d2cc", borderRadius: 10 }}>
      <strong>{label}</strong>
      <p style={{ margin: "8px 0 0" }}>{services.length > 0 ? services.join(", ") : "None"}</p>
    </section>
  );
}

function DeploymentOutcome({ props }: ResultViewProps<Props>) {
  return (
    <main style={{ padding: 20, color: "#17211b", background: "#f5f8f5" }}>
      <p style={{ margin: 0, color: "#657068", fontSize: 12, textTransform: "uppercase" }}>
        Recorded decision
      </p>
      <h2 style={{ margin: "6px 0 14px" }}>Deployment to {props.environment}</h2>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 10 }}>
        <ServiceList label="Approved" services={props.approved} />
        <ServiceList label="Deferred" services={props.deferred} />
      </div>
      {props.note ? <p style={{ marginBottom: 0 }}>Note: {props.note}</p> : null}
    </main>
  );
}

export default defineResultView<Props>({
  id: "example.deployment-outcome",
  revision: "1",
  component: DeploymentOutcome,
});
