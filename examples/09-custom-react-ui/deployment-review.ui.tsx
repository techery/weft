import { defineUiView, type InputViewProps } from "@techery/weft-sdk/ui";
import { useState } from "react";
import type { DeploymentDecision, Service } from "./schemas.ts";

type Props = {
  environment: "staging" | "production";
  services: Service[];
};

function DeploymentReview({ props, propose }: InputViewProps<Props, DeploymentDecision>) {
  const [selected, setSelected] = useState<Service[]>(props.services);
  const [note, setNote] = useState("");

  const toggle = (service: Service) => {
    setSelected((current) =>
      current.includes(service)
        ? current.filter((candidate) => candidate !== service)
        : [...current, service],
    );
  };

  return (
    <main style={{ padding: 20, color: "#211b16", background: "#fffaf3" }}>
      <p style={{ margin: 0, color: "#7b6d61", fontSize: 12, textTransform: "uppercase" }}>Human decision</p>
      <h2 style={{ margin: "6px 0" }}>Choose services for {props.environment}</h2>
      <p style={{ margin: "0 0 16px", color: "#675d54" }}>
        This component stages a candidate. Only Weft's host-owned control submits it.
      </p>
      <div style={{ display: "grid", gap: 8 }}>
        {props.services.map((service) => (
          <label key={service} style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <input type="checkbox" checked={selected.includes(service)} onChange={() => toggle(service)} />
            {service}
          </label>
        ))}
      </div>
      <label style={{ display: "grid", gap: 6, marginTop: 16 }}>
        Optional note
        <textarea
          value={note}
          rows={3}
          onChange={(event) => setNote((event.currentTarget as unknown as { value: string }).value)}
        />
      </label>
      <button
        type="button"
        disabled={selected.length === 0}
        onClick={() => propose({ approvedServices: selected, ...(note ? { note } : {}) })}
        style={{ marginTop: 16, padding: "8px 12px" }}
      >
        Stage selection
      </button>
    </main>
  );
}

export default defineUiView<Props, DeploymentDecision>({
  id: "example.deployment-review",
  revision: "1",
  component: DeploymentReview,
});
