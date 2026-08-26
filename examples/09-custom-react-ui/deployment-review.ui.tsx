import {
  Button,
  CountBadge,
  Hairline,
  Kicker,
  MonoBadge,
  PillButton,
  RangeField,
  SelectField,
  TextArea,
  TextField,
  Toggle,
  WeftTheme,
} from "@techery/weft-design-system";
import { defineUiView, type InputViewProps } from "@techery/weft-sdk/ui";
import { useState } from "react";
import type {
  DeploymentDecision,
  DeploymentRisk,
  DeploymentStrategy,
  DeploymentWindow,
  Service,
} from "./schemas.ts";
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
.review-shell{padding:clamp(18px,3.5vw,32px);background:var(--color-surface);min-height:100%}
.review-head{display:flex;align-items:flex-start;justify-content:space-between;gap:20px}.review-head h2{font-size:28px;margin-top:5px}.review-summary{font:10px var(--font-mono);color:var(--color-neutral-600);text-align:right}
.review-presets{display:flex;align-items:center;gap:7px;overflow:auto;padding:16px 0 18px;border-bottom:1px solid var(--color-divider)}
.review-grid{display:grid;grid-template-columns:minmax(0,1.35fr) minmax(250px,.65fr);gap:24px;margin-top:22px}
.review-section-head{display:flex;align-items:center;gap:9px;margin-bottom:11px}.review-services{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:9px}
.review-service{appearance:none;text-align:left;display:grid;grid-template-columns:auto minmax(0,1fr);gap:10px;width:100%;padding:13px;border:1px solid var(--color-divider);border-radius:var(--radius-md);background:var(--color-field-bg);color:var(--color-text);cursor:pointer}.review-service:hover{border-color:var(--color-neutral-400)}.review-service--on{border-color:var(--color-accent);box-shadow:0 0 0 2px color-mix(in srgb,var(--color-accent) 15%,transparent)}
.review-check{display:grid;place-items:center;width:18px;height:18px;border:1px solid var(--color-neutral-400);border-radius:5px;color:white;font-size:11px}.review-service--on .review-check{background:var(--color-accent);border-color:var(--color-accent)}
.review-service strong{font-size:12px}.review-service p{margin-top:3px;font-size:10px;color:var(--color-neutral-600);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.review-tags{display:flex;align-items:center;gap:6px;margin-top:8px}
.review-panel{display:grid;gap:17px;padding:17px;border:1px solid var(--color-divider);border-radius:var(--radius-md);background:var(--color-neutral-100)}
.field{display:grid;gap:7px}.field-label{display:flex;justify-content:space-between;gap:10px;font-size:11px;font-weight:600}.field-hint{font:9px var(--font-mono);color:var(--color-neutral-500);font-weight:400}
.range-row{display:flex;align-items:center;gap:12px}.range-value{min-width:48px;text-align:right;font:11px var(--font-mono)}
.review-toggles{display:grid;gap:11px}.review-alert{padding:12px;border-radius:var(--radius-sm);font-size:11px;background:var(--color-danger-bg);color:var(--color-danger)}.review-alert--ok{background:var(--color-accent-2-100);color:var(--color-accent-2-800)}
.review-footer{display:flex;align-items:center;justify-content:space-between;gap:16px;margin-top:22px;padding-top:18px;border-top:1px solid var(--color-divider)}.review-footer-copy{font-size:10px;color:var(--color-neutral-600);max-width:430px}.review-footer-copy strong{display:block;color:var(--color-text);font-size:11px}
@media(max-width:760px){.review-grid{grid-template-columns:1fr}.review-services{grid-template-columns:1fr}.review-head{display:grid}.review-summary{text-align:left}.review-footer{align-items:stretch;flex-direction:column}.review-footer .weft-button{width:100%}}
`;

type Preset = "safe" | "canary" | "minimal" | "reject";

function DeploymentReview({ props, propose }: InputViewProps<Props, DeploymentDecision>) {
  const safeServices = props.services.filter((service) => serviceCatalog[service].health !== "blocked");
  const [selected, setSelected] = useState<Service[]>(safeServices);
  const [strategy, setStrategy] = useState<DeploymentStrategy>("canary");
  const [trafficPercent, setTrafficPercent] = useState(10);
  const [monitorMinutes, setMonitorMinutes] = useState(30);
  const [rollbackOnError, setRollbackOnError] = useState(true);
  const [runSmokeTests, setRunSmokeTests] = useState(true);
  const [acknowledgedRisk, setAcknowledgedRisk] = useState(false);
  const [changeTicket, setChangeTicket] = useState("");
  const [note, setNote] = useState("");
  const [preset, setPreset] = useState<Preset>("canary");

  const toggle = (service: Service) => {
    setPreset("minimal");
    setSelected((current) =>
      current.includes(service)
        ? current.filter((candidate) => candidate !== service)
        : [...current, service],
    );
  };

  const applyPreset = (next: Preset) => {
    setPreset(next);
    if (next === "safe") {
      setSelected([...props.services]);
      setStrategy("blue-green");
      setTrafficPercent(100);
      setMonitorMinutes(45);
      setRollbackOnError(true);
      setRunSmokeTests(true);
    } else if (next === "canary") {
      setSelected(safeServices);
      setStrategy("canary");
      setTrafficPercent(10);
      setMonitorMinutes(30);
      setRollbackOnError(true);
      setRunSmokeTests(true);
    } else if (next === "minimal") {
      setSelected(props.services.slice(0, 1));
      setStrategy("rolling");
      setTrafficPercent(25);
      setMonitorMinutes(15);
    } else {
      setSelected([]);
      setTrafficPercent(1);
      setNote((current) => current || "Deployment rejected pending remediation evidence.");
    }
  };

  const intent =
    selected.length === 0 ? "reject" : selected.length === props.services.length ? "approve" : "partial";
  const productionTicketMissing = props.environment === "production" && changeTicket.trim().length === 0;
  const riskAcknowledgementMissing =
    (props.risk === "high" || props.risk === "critical") && !acknowledgedRisk;
  const rejectionNoteMissing = intent === "reject" && note.trim().length === 0;
  const canStage = !productionTicketMissing && !riskAcknowledgementMissing && !rejectionNoteMissing;
  const validationMessage = productionTicketMissing
    ? "A change ticket is required for production."
    : riskAcknowledgementMissing
      ? `Acknowledge the ${props.risk}-risk release before staging.`
      : rejectionNoteMissing
        ? "Explain why this deployment is being rejected."
        : `${intent === "approve" ? "Full approval" : intent === "partial" ? "Partial approval" : "Rejection"} is ready to stage.`;

  return (
    <WeftTheme>
      <style>{viewStyles}</style>
      <main className="review-shell">
        <header className="review-head">
          <div>
            <Kicker large>Human decision</Kicker>
            <h2>{props.releaseName}</h2>
            <p style={{ marginTop: 6, color: "var(--color-neutral-600)" }}>
              Compose a candidate answer; Weft’s host control remains the only submission boundary.
            </p>
          </div>
          <div className="review-summary">
            {props.environment} · {props.version}
            <br />
            {props.risk} risk · {props.window.replaceAll("-", " ")}
          </div>
        </header>

        <nav className="review-presets" aria-label="Decision scenarios">
          <Kicker tone="inline">Scenarios</Kicker>
          <PillButton on={preset === "safe"} onClick={() => applyPreset("safe")}>
            approve all
          </PillButton>
          <PillButton on={preset === "canary"} onClick={() => applyPreset("canary")}>
            safe canary
          </PillButton>
          <PillButton on={preset === "minimal"} onClick={() => applyPreset("minimal")}>
            minimal scope
          </PillButton>
          <PillButton on={preset === "reject"} onClick={() => applyPreset("reject")}>
            reject
          </PillButton>
        </nav>

        <div className="review-grid">
          <section>
            <div className="review-section-head">
              <Kicker tone="inline">Deployment scope</Kicker>
              <Hairline />
              <CountBadge bg="var(--color-accent-200)" fg="var(--color-accent-800)">
                {`${selected.length}/${props.services.length}`}
              </CountBadge>
            </div>
            <div className="review-services">
              {props.services.map((service) => {
                const item = serviceCatalog[service];
                const on = selected.includes(service);
                const colors = healthColors[item.health];
                return (
                  <button
                    type="button"
                    aria-pressed={on}
                    className={`review-service${on ? " review-service--on" : ""}`}
                    key={service}
                    onClick={() => toggle(service)}
                  >
                    <span className="review-check">{on ? "✓" : ""}</span>
                    <span style={{ minWidth: 0 }}>
                      <strong>{item.label}</strong>
                      <p>{item.description}</p>
                      <span className="review-tags">
                        <MonoBadge bg={colors.background} fg={colors.foreground} boxy>
                          {item.health}
                        </MonoBadge>
                        <span style={{ font: "9px var(--font-mono)", color: "var(--color-neutral-500)" }}>
                          {item.owner}
                        </span>
                      </span>
                    </span>
                  </button>
                );
              })}
            </div>

            <div className="field" style={{ marginTop: 18 }}>
              <label className="field-label" htmlFor="deployment-note">
                Operator note <span className="field-hint">{note.length}/500 · optional unless rejected</span>
              </label>
              <TextArea
                id="deployment-note"
                value={note}
                rows={5}
                maxLength={500}
                placeholder="Explain exceptions, deferred work, or rollback context…"
                onChange={(event) => setNote((event.currentTarget as unknown as { value: string }).value)}
              />
            </div>
          </section>

          <aside className="review-panel">
            <div className="field">
              <label className="field-label" htmlFor="deployment-strategy">
                Strategy
              </label>
              <SelectField
                id="deployment-strategy"
                value={strategy}
                onChange={(event) =>
                  setStrategy((event.currentTarget as unknown as { value: DeploymentStrategy }).value)
                }
              >
                <option value="rolling">Rolling replacement</option>
                <option value="canary">Canary traffic shift</option>
                <option value="blue-green">Blue / green cutover</option>
              </SelectField>
            </div>

            <div className="field">
              <label className="field-label" htmlFor="deployment-traffic">
                Initial traffic <span className="field-hint">1–100%</span>
              </label>
              <div className="range-row">
                <RangeField
                  id="deployment-traffic"
                  min={1}
                  max={100}
                  value={trafficPercent}
                  onChange={(event) =>
                    setTrafficPercent(Number((event.currentTarget as unknown as { value: string }).value))
                  }
                />
                <span className="range-value">{trafficPercent}%</span>
              </div>
            </div>

            <div className="field">
              <label className="field-label" htmlFor="deployment-monitor">
                Monitor period <span className="field-hint">5–120 min</span>
              </label>
              <div className="range-row">
                <RangeField
                  id="deployment-monitor"
                  min={5}
                  max={120}
                  step={5}
                  value={monitorMinutes}
                  onChange={(event) =>
                    setMonitorMinutes(Number((event.currentTarget as unknown as { value: string }).value))
                  }
                />
                <span className="range-value">{monitorMinutes}m</span>
              </div>
            </div>

            <div className="review-toggles">
              <Toggle
                on={rollbackOnError}
                label="Rollback on error budget breach"
                onToggle={() => setRollbackOnError((value) => !value)}
              />
              <Toggle
                on={runSmokeTests}
                label="Run post-deploy smoke tests"
                onToggle={() => setRunSmokeTests((value) => !value)}
              />
              <Toggle
                on={acknowledgedRisk}
                label={`Acknowledge ${props.risk} release risk`}
                onToggle={() => setAcknowledgedRisk((value) => !value)}
              />
            </div>

            <div className="field">
              <label className="field-label" htmlFor="change-ticket">
                Change ticket{" "}
                <span className="field-hint">
                  {props.environment === "production" ? "required" : "optional"}
                </span>
              </label>
              <TextField
                id="change-ticket"
                value={changeTicket}
                maxLength={40}
                placeholder="CHG-2048"
                onChange={(event) =>
                  setChangeTicket((event.currentTarget as unknown as { value: string }).value)
                }
              />
            </div>

            <div className={`review-alert${canStage ? " review-alert--ok" : ""}`} role="status">
              {validationMessage}
            </div>
          </aside>
        </div>

        <footer className="review-footer">
          <div className="review-footer-copy">
            <strong>
              Staged candidate: {intent} · {selected.length} services · {strategy}
            </strong>
            Staging is reversible. The host will show the exact JSON answer and validate it before submission.
          </div>
          <Button
            variant="primary"
            size="large"
            disabled={!canStage}
            onClick={() =>
              propose({
                intent,
                approvedServices: selected,
                strategy,
                trafficPercent,
                monitorMinutes,
                rollbackOnError,
                runSmokeTests,
                acknowledgedRisk,
                ...(changeTicket.trim() ? { changeTicket: changeTicket.trim() } : {}),
                ...(note.trim() ? { note: note.trim() } : {}),
              })
            }
          >
            Stage {intent} candidate
          </Button>
        </footer>
      </main>
    </WeftTheme>
  );
}

export default defineUiView<Props, DeploymentDecision>({
  id: "example.deployment-review",
  revision: "3",
  component: DeploymentReview,
});
