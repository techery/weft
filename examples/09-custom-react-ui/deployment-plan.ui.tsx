import {
  CountBadge,
  FactCell,
  Hairline,
  Kicker,
  LiveCursor,
  MonoBadge,
  ScreenTitle,
  WeftTheme,
} from "@techery/weft-design-system";
import { defineResultView, type ResultViewProps } from "@techery/weft-sdk/ui";
import type { DeploymentRisk, DeploymentWindow, Service } from "./schemas.ts";
import { healthColors, serviceCatalog } from "./service-catalog.ts";

type Props = {
  environment: "staging" | "production";
  releaseName: string;
  version: string;
  requestedBy: string;
  risk: DeploymentRisk;
  window: DeploymentWindow;
  services: Service[];
};

const viewStyles = `
.plan-shell{padding:clamp(18px,4vw,36px);background:var(--color-surface);min-height:100%;overflow:hidden}
.plan-head{display:flex;align-items:flex-start;justify-content:space-between;gap:20px}
.plan-title{min-width:0}.plan-title h1{overflow-wrap:anywhere}
.plan-status{display:flex;align-items:center;gap:7px;color:var(--color-neutral-600);font:11px var(--font-mono);white-space:nowrap}
.plan-facts{display:flex;flex-wrap:wrap;margin:24px 0 0;padding:0;border-block:1px solid var(--color-divider)}
.plan-grid{display:grid;grid-template-columns:minmax(0,1.65fr) minmax(220px,.75fr);gap:24px;margin-top:26px}
.service-stack{display:grid;gap:9px;margin-top:13px}
.service-row{display:grid;grid-template-columns:minmax(150px,1.2fr) minmax(100px,.7fr) auto;gap:14px;align-items:center;padding:13px 14px;border:1px solid var(--color-divider);border-radius:var(--radius-md);background:var(--color-field-bg);box-shadow:var(--shadow-sm)}
.service-copy{min-width:0}.service-name{display:flex;align-items:center;gap:8px;font-weight:600}.service-copy p{margin-top:3px;color:var(--color-neutral-600);font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.service-meta{font:10px var(--font-mono);color:var(--color-neutral-600)}.service-meta strong{display:block;color:var(--color-neutral-800);font-weight:500}
.plan-aside{display:grid;align-content:start;gap:12px}.plan-card{padding:16px;border-radius:var(--radius-md);background:var(--color-neutral-100);border:1px solid var(--color-divider)}
.plan-card--danger{background:var(--color-danger-bg);border-color:color-mix(in srgb,var(--color-danger) 25%,transparent)}
.plan-list{display:grid;gap:10px;margin:13px 0 0;padding:0;list-style:none}.plan-list li{display:flex;align-items:flex-start;gap:9px;color:var(--color-neutral-700);font-size:11px}.plan-list b{color:var(--color-text)}
.plan-dot{width:7px;height:7px;margin-top:5px;border-radius:50%;background:var(--color-accent);flex:none}
@media(max-width:720px){.plan-head{display:grid}.plan-grid{grid-template-columns:1fr}.service-row{grid-template-columns:1fr auto}.service-meta{display:none}.plan-facts .weft-fact{min-width:50%;border-bottom:1px solid var(--color-divider)}}
@media(max-width:430px){.plan-shell{padding:16px}.service-row{grid-template-columns:1fr}.plan-status{white-space:normal}.plan-facts .weft-fact{width:100%;border-left:0}}
`;

function DeploymentPlan({ props }: ResultViewProps<Props>) {
  const blocked = props.services.filter((service) => serviceCatalog[service].health === "blocked");
  const changedLines = props.services.reduce((sum, service) => {
    const [added = "0"] = serviceCatalog[service].change.split(" /");
    return sum + Number(added.replace(/\D/g, ""));
  }, 0);

  return (
    <WeftTheme>
      <style>{viewStyles}</style>
      <main className="plan-shell">
        <header className="plan-head">
          <div className="plan-title">
            <Kicker large>Release command center</Kicker>
            <ScreenTitle>{props.releaseName}</ScreenTitle>
            <p style={{ marginTop: 7, color: "var(--color-neutral-600)" }}>
              Review the complete blast radius before staging a durable human decision.
            </p>
          </div>
          <div className="plan-status">
            <LiveCursor /> awaiting operator review
          </div>
        </header>

        <ul className="plan-facts">
          <FactCell first label="Environment" value={props.environment} />
          <FactCell label="Version" value={props.version} />
          <FactCell label="Risk" value={props.risk.toUpperCase()} color="var(--color-danger)" />
          <FactCell label="Window" value={props.window.replaceAll("-", " ")} />
          <FactCell label="Scope" value={`${props.services.length} services`} />
        </ul>

        <div className="plan-grid">
          <section>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <Kicker tone="inline">Service manifest</Kicker>
              <Hairline />
              <CountBadge bg="var(--color-neutral-200)" fg="var(--color-neutral-700)">
                {String(props.services.length)}
              </CountBadge>
            </div>
            <div className="service-stack">
              {props.services.map((service) => {
                const item = serviceCatalog[service];
                const colors = healthColors[item.health];
                return (
                  <article className="service-row" key={service}>
                    <div className="service-copy">
                      <div className="service-name">
                        {item.label}
                        <MonoBadge bg={colors.background} fg={colors.foreground} boxy>
                          {item.health}
                        </MonoBadge>
                      </div>
                      <p title={item.description}>{item.description}</p>
                    </div>
                    <div className="service-meta">
                      Owner<strong>{item.owner}</strong>
                    </div>
                    <MonoBadge bg="var(--color-neutral-100)" fg="var(--color-neutral-700)">
                      {item.change}
                    </MonoBadge>
                  </article>
                );
              })}
            </div>
          </section>

          <aside className="plan-aside">
            {blocked.length > 0 ? (
              <section className="plan-card plan-card--danger">
                <Kicker>Attention required</Kicker>
                <h3 style={{ marginTop: 5 }}>{blocked.length} blocked dependencies</h3>
                <p style={{ marginTop: 8, color: "var(--color-neutral-700)", fontSize: 11 }}>
                  {blocked.map((service) => serviceCatalog[service].label).join(", ")} can still be deferred
                  during review.
                </p>
              </section>
            ) : null}
            <section className="plan-card">
              <Kicker tone="inline">Release context</Kicker>
              <ul className="plan-list">
                <li>
                  <span className="plan-dot" />
                  <span>
                    Requested by <b>{props.requestedBy}</b>
                  </span>
                </li>
                <li>
                  <span className="plan-dot" />
                  <span>
                    <b>{changedLines.toLocaleString()}</b> added lines across the selected graph
                  </span>
                </li>
                <li>
                  <span className="plan-dot" />
                  <span>
                    Rollback artifacts retained for <b>72 hours</b>
                  </span>
                </li>
                <li>
                  <span className="plan-dot" />
                  <span>Audit evidence will be journaled with the answer</span>
                </li>
              </ul>
            </section>
            <section
              className="plan-card"
              style={{ background: "var(--color-term-bg)", color: "var(--color-term-text)" }}
            >
              <Kicker tone="inline">Preflight excerpt</Kicker>
              <pre
                style={{
                  margin: "12px 0 0",
                  whiteSpace: "pre-wrap",
                  font: "10px/1.65 var(--font-mono)",
                  color: "var(--color-term-dim)",
                }}
              >
                <span style={{ color: "var(--color-accent-2-400)" }}>✓</span> schema compatible{"\n"}
                <span style={{ color: "var(--color-accent-2-400)" }}>✓</span> migrations reversible{"\n"}
                <span style={{ color: "#e2b85b" }}>!</span> 2 health checks need review
              </pre>
            </section>
          </aside>
        </div>
      </main>
    </WeftTheme>
  );
}

export default defineResultView<Props>({
  id: "example.deployment-plan",
  revision: "3",
  component: DeploymentPlan,
});
