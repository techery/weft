import {
  CountBadge,
  FactCell,
  Hairline,
  Kicker,
  MonoBadge,
  ScreenTitle,
  WeftTheme,
} from "@techery/weft-design-system";
import { defineResultView, type ResultViewProps } from "@techery/weft-sdk/ui";
import type { CSSProperties } from "react";
import type { DeploymentRisk, DeploymentStrategy, DeploymentWindow, Service } from "./schemas.ts";
import { healthColors, serviceCatalog } from "./service-catalog.ts";

type Props = {
  environment: "staging" | "production";
  releaseName: string;
  version: string;
  risk: DeploymentRisk;
  window: DeploymentWindow;
  decision: "approved" | "partial" | "rejected";
  approvedServices: Service[];
  deferredServices: Service[];
  strategy: DeploymentStrategy;
  trafficPercent: number;
  monitorMinutes: number;
  rollbackOnError: boolean;
  runSmokeTests: boolean;
  changeTicket?: string;
  note?: string;
  warnings: string[];
};

const viewStyles = `
.outcome-shell{padding:clamp(18px,4vw,36px);background:var(--color-surface);min-height:100%}
.outcome-hero{padding:clamp(20px,4vw,34px);border:1px solid var(--color-divider);border-radius:18px;background:linear-gradient(135deg,var(--color-field-bg),var(--color-neutral-100));overflow:hidden;position:relative}.outcome-hero:after{content:"";position:absolute;width:180px;height:180px;border-radius:50%;right:-70px;top:-90px;background:color-mix(in srgb,var(--status-color) 15%,transparent)}
.outcome-head{display:flex;justify-content:space-between;align-items:flex-start;gap:18px;position:relative;z-index:1}.outcome-head h1{overflow-wrap:anywhere}.outcome-stamp{padding:8px 12px;border:1px solid currentColor;border-radius:var(--radius-pill);color:var(--status-color);font:600 10px var(--font-mono);letter-spacing:.09em;text-transform:uppercase;white-space:nowrap}
.outcome-facts{display:flex;flex-wrap:wrap;margin:24px 0 0;padding:0;border-top:1px solid var(--color-divider);position:relative;z-index:1}
.outcome-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px;margin-top:20px}.outcome-card{padding:17px;border:1px solid var(--color-divider);border-radius:var(--radius-md);background:var(--color-field-bg);min-width:0}.outcome-card--wide{grid-column:1/-1}
.outcome-section-head{display:flex;align-items:center;gap:9px}.outcome-services{display:grid;gap:8px;margin-top:13px}.outcome-service{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:10px 11px;background:var(--color-neutral-100);border-radius:var(--radius-sm)}.outcome-service strong{font-size:11px}.outcome-service span{font:9px var(--font-mono);color:var(--color-neutral-500)}
.outcome-empty{display:grid;place-items:center;min-height:94px;margin-top:12px;padding:18px;border:1px dashed var(--color-neutral-300);border-radius:var(--radius-sm);text-align:center;color:var(--color-neutral-500);font-size:11px}.outcome-empty b{display:block;color:var(--color-neutral-700)}
.outcome-warning{display:flex;align-items:flex-start;gap:9px;padding:10px 11px;border-radius:var(--radius-sm);background:#fbf1d4;color:#725715;font-size:11px}.outcome-warning+.outcome-warning{margin-top:7px}.outcome-warning i{font-style:normal;font-weight:700}
.outcome-note{margin-top:13px;padding:13px;border-left:3px solid var(--color-accent);background:var(--color-neutral-100);white-space:pre-wrap;overflow-wrap:anywhere;color:var(--color-neutral-700);font-size:11px}
.outcome-receipt{margin-top:13px;padding:14px;background:var(--color-term-bg);color:var(--color-term-dim);border-radius:var(--radius-sm);overflow:auto;font:10px/1.7 var(--font-mono)}.outcome-receipt b{color:var(--color-term-text);font-weight:400}
@media(max-width:680px){.outcome-head{display:grid}.outcome-grid{grid-template-columns:1fr}.outcome-card--wide{grid-column:auto}.outcome-facts .weft-fact{min-width:50%;border-bottom:1px solid var(--color-divider)}}
@media(max-width:430px){.outcome-shell{padding:14px}.outcome-hero{padding:18px}.outcome-facts .weft-fact{width:100%;border-left:0}.outcome-service{align-items:flex-start;flex-direction:column}}
`;

function ServiceGroup({ label, services, empty }: { label: string; services: Service[]; empty: string }) {
  return (
    <section className="outcome-card">
      <div className="outcome-section-head">
        <Kicker tone="inline">{label}</Kicker>
        <Hairline />
        <CountBadge bg="var(--color-neutral-200)" fg="var(--color-neutral-700)">
          {String(services.length)}
        </CountBadge>
      </div>
      {services.length === 0 ? (
        <div className="outcome-empty">
          <span>
            <b>Nothing here</b>
            {empty}
          </span>
        </div>
      ) : (
        <div className="outcome-services">
          {services.map((service) => {
            const item = serviceCatalog[service];
            const colors = healthColors[item.health];
            return (
              <div className="outcome-service" key={service}>
                <div>
                  <strong>{item.label}</strong>
                  <span> · {item.owner}</span>
                </div>
                <MonoBadge bg={colors.background} fg={colors.foreground} boxy>
                  {item.health}
                </MonoBadge>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

function DeploymentOutcome({ props }: ResultViewProps<Props>) {
  const statusColor =
    props.decision === "approved"
      ? "var(--color-accent-2-700)"
      : props.decision === "partial"
        ? "#8a6818"
        : "var(--color-danger)";
  const title =
    props.decision === "approved"
      ? "Deployment approved"
      : props.decision === "partial"
        ? "Partial deployment approved"
        : "Deployment rejected";

  return (
    <WeftTheme>
      <style>{viewStyles}</style>
      <main className="outcome-shell" style={{ "--status-color": statusColor } as CSSProperties}>
        <section className="outcome-hero">
          <header className="outcome-head">
            <div>
              <Kicker large>Durable decision receipt</Kicker>
              <ScreenTitle>{title}</ScreenTitle>
              <p style={{ marginTop: 8, color: "var(--color-neutral-600)" }}>
                {props.releaseName} · {props.version}
              </p>
            </div>
            <span className="outcome-stamp">{props.decision}</span>
          </header>
          <ul className="outcome-facts">
            <FactCell first label="Environment" value={props.environment} />
            <FactCell label="Strategy" value={props.strategy} />
            <FactCell label="Traffic" value={`${props.trafficPercent}%`} />
            <FactCell label="Observe" value={`${props.monitorMinutes} min`} />
            <FactCell label="Ticket" value={props.changeTicket ?? "not supplied"} />
          </ul>
        </section>

        <div className="outcome-grid">
          <ServiceGroup
            label="Approved services"
            services={props.approvedServices}
            empty="The run records a deliberate no-op deployment."
          />
          <ServiceGroup
            label="Deferred services"
            services={props.deferredServices}
            empty="Every requested service is in the approved scope."
          />

          <section className="outcome-card">
            <div className="outcome-section-head">
              <Kicker tone="inline">Safety policy</Kicker>
              <Hairline />
            </div>
            <div className="outcome-services">
              <div className="outcome-service">
                <strong>Automatic rollback</strong>
                <MonoBadge
                  bg={props.rollbackOnError ? "var(--color-accent-2-200)" : "var(--color-danger-bg)"}
                  fg={props.rollbackOnError ? "var(--color-accent-2-800)" : "var(--color-danger)"}
                >
                  {props.rollbackOnError ? "enabled" : "disabled"}
                </MonoBadge>
              </div>
              <div className="outcome-service">
                <strong>Smoke test suite</strong>
                <MonoBadge
                  bg={props.runSmokeTests ? "var(--color-accent-2-200)" : "var(--color-neutral-200)"}
                  fg={props.runSmokeTests ? "var(--color-accent-2-800)" : "var(--color-neutral-700)"}
                >
                  {props.runSmokeTests ? "scheduled" : "skipped"}
                </MonoBadge>
              </div>
              <div className="outcome-service">
                <strong>Release risk</strong>
                <MonoBadge bg="var(--color-danger-bg)" fg="var(--color-danger)">
                  {props.risk}
                </MonoBadge>
              </div>
              <div className="outcome-service">
                <strong>Execution window</strong>
                <span>{props.window.replaceAll("-", " ")}</span>
              </div>
            </div>
          </section>

          <section className="outcome-card">
            <div className="outcome-section-head">
              <Kicker tone="inline">Warnings and exceptions</Kicker>
              <Hairline />
            </div>
            {props.warnings.length === 0 ? (
              <div className="outcome-empty">
                <span>
                  <b>All clear</b>No policy warnings were recorded.
                </span>
              </div>
            ) : (
              <div style={{ marginTop: 13 }}>
                {props.warnings.map((warning) => (
                  <div className="outcome-warning" key={warning}>
                    <i>!</i>
                    <span>{warning}</span>
                  </div>
                ))}
              </div>
            )}
          </section>

          <section className="outcome-card outcome-card--wide">
            <div className="outcome-section-head">
              <Kicker tone="inline">Operator context and raw receipt</Kicker>
              <Hairline />
            </div>
            {props.note ? (
              <blockquote className="outcome-note">{props.note}</blockquote>
            ) : (
              <div className="outcome-empty">
                <span>
                  <b>No operator note</b>The optional context field was left empty.
                </span>
              </div>
            )}
            <details>
              <summary
                style={{
                  marginTop: 14,
                  cursor: "pointer",
                  font: "10px var(--font-mono)",
                  color: "var(--color-neutral-600)",
                }}
              >
                Inspect normalized receipt
              </summary>
              <pre className="outcome-receipt">
                <b>{JSON.stringify(props, null, 2)}</b>
              </pre>
            </details>
          </section>
        </div>
      </main>
    </WeftTheme>
  );
}

export default defineResultView<Props>({
  id: "example.deployment-outcome",
  revision: "3",
  component: DeploymentOutcome,
});
