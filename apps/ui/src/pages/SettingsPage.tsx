import { useState } from "react";
import { useConfig, useMeta, useSaveConfig } from "~/api/queries";
import type { ApprovalMode, ConfigResponse, Meta, Risk, WeftConfigFile } from "~/api/types";
import { Button } from "~/components/atoms/Button";
import { RangeField } from "~/components/atoms/RangeField";
import { TextField } from "~/components/atoms/TextField";
import { EmptyNote } from "~/components/molecules/EmptyNote";
import { PolicyRow } from "~/components/molecules/PolicyRow";
import { ProviderRow } from "~/components/molecules/ProviderRow";
import { SettingsCard } from "~/components/molecules/SettingsCard";
import { PageHeader } from "~/components/templates/PageHeader";
import { ScrollPage } from "~/components/templates/ScrollPage";
import type { RiskTier } from "~/domain/types";
import styles from "./SettingsPage.module.css";

/** The engine's risk tiers, in ascending order. */
const TIERS: Risk[] = ["low", "medium", "high", "irreversible"];

const CONCURRENCY_MIN = 1;
const CONCURRENCY_MAX = 24;

/**
 * `.weft/config.json`, read and written.
 *
 * Two halves, and the difference between them is the point: `config` is what is on disk,
 * `effective` is what the process running this page resolved at startup. A save changes
 * the first immediately and the second not at all — the daemon has to restart — so every
 * control here says which of the two it is showing.
 */
export function SettingsPage() {
  const config = useConfig();
  const meta = useMeta();
  const save = useSaveConfig();
  /** Limits are typed, not toggled, so they are held until Save rather than PUT per keystroke. */
  const [draft, setDraft] = useState<{ concurrency: number; maxTurns: string } | null>(null);
  /**
   * The body of the PUT in flight. Its refetch has not landed while this is set, so reading
   * the query here would hand the next toggle a file that predates this write — and the PUT
   * body IS the whole file, so that second write would silently undo the first.
   */
  const [inFlight, setInFlight] = useState<WeftConfigFile | null>(null);

  if (config.isPending) {
    return (
      <ScrollPage maxWidth={760} gap={14}>
        <PageHeader title="Settings" />
        <p className={styles.note}>Reading .weft/config.json…</p>
      </ScrollPage>
    );
  }

  if (config.isError) {
    return (
      <ScrollPage maxWidth={760} gap={14}>
        <PageHeader title="Settings" />
        <EmptyNote>{config.error.message}</EmptyNote>
      </ScrollPage>
    );
  }

  const { effective } = config.data;
  const file = inFlight ?? config.data.config;
  const limits = fileLimits(file, effective);
  const current = draft ?? { concurrency: limits.concurrency, maxTurns: String(limits.maxTurns) };
  const maxTurns = Number(current.maxTurns);
  const maxTurnsValid = Number.isInteger(maxTurns) && maxTurns > 0;
  const dirty = current.concurrency !== limits.concurrency || current.maxTurns !== String(limits.maxTurns);

  const put = (next: WeftConfigFile, saved?: () => void) => {
    setInFlight(next);
    save.mutate(next, { onSuccess: () => saved?.(), onSettled: () => setInFlight(null) });
  };

  const setTier = (tier: Risk, mode: ApprovalMode) => {
    const tiers: Partial<Record<Risk, ApprovalMode>> = { ...file.approvalPolicy?.tiers };
    tiers[tier] = mode;
    put({ ...file, approvalPolicy: { ...file.approvalPolicy, tiers } });
  };

  const saveLimits = () => {
    if (!maxTurnsValid) return;
    // Only a limits save clears the typed draft; a tier toggle must leave it alone.
    put({ ...file, limits: { ...file.limits, concurrency: current.concurrency, maxTurns } }, () =>
      setDraft(null),
    );
  };

  const actions = Object.entries(effective.approvalPolicy.actions ?? {});
  const providers = providerRows(config.data, meta.data);

  return (
    <ScrollPage maxWidth={760} gap={14}>
      <PageHeader
        title="Settings"
        summary={config.data.exists ? config.data.path : `${config.data.path} · not created yet`}
        aside={saveStatus(save)}
      />

      <SettingsCard title="Approval policy" gap={10}>
        <p className={styles.policyNote}>
          A workflow may raise a tier, never lower it. Auto-approvals are journaled as{" "}
          <span className={styles.mono}>answered_by: "policy"</span>.
        </p>
        {TIERS.map((tier) => {
          const inFile = file.approvalPolicy?.tiers?.[tier];
          const running = effective.approvalPolicy.tiers?.[tier];
          return (
            <PolicyRow
              key={tier}
              // PolicyRow's prop still names the design's tiers; the engine's are what the file takes.
              tier={tier as string as RiskTier}
              ops={tierNote(tier, inFile, running)}
              mode={inFile ?? unsetMode(tier)}
              onSet={(mode) => setTier(tier, mode)}
            />
          );
        })}
        {actions.length > 0 ? (
          <p className={styles.note}>
            Per-action overrides run before tiers: {actions.map(([a, m]) => `${a} → ${m}`).join(" · ")}.
          </p>
        ) : null}
      </SettingsCard>

      <SettingsCard title="Budget & limits" gap={12}>
        <div className={styles.grid}>
          <div className={styles.label}>
            <label className={styles.labelText} htmlFor="agent-concurrency">
              Agent concurrency · {current.concurrency} agents
            </label>
            <span className={styles.slider}>
              <span className={styles.bound}>{CONCURRENCY_MIN}</span>
              <RangeField
                id="agent-concurrency"
                min={CONCURRENCY_MIN}
                max={CONCURRENCY_MAX}
                value={current.concurrency}
                onChange={(e) => setDraft({ ...current, concurrency: Number(e.target.value) })}
              />
              <span className={styles.bound}>{CONCURRENCY_MAX}</span>
            </span>
          </div>
          <div className={styles.label}>
            <label className={styles.labelText} htmlFor="max-turns">
              Max turns per agent step
            </label>
            <TextField
              id="max-turns"
              scale="settings"
              inputMode="numeric"
              value={current.maxTurns}
              onChange={(e) => setDraft({ ...current, maxTurns: e.target.value })}
            />
          </div>
        </div>
        <p className={styles.note}>
          Running with concurrency {effective.limits.concurrency} · maxTurns {effective.limits.maxTurns} ·
          maxDepth {effective.limits.maxDepth} · {timeout(effective.limits.stepTimeoutMs)} per step. Budgets
          are per run — weft has no repo-wide default, so a ceiling is set when a run is started.
        </p>
        <span className={styles.actions}>
          <Button
            variant="primary"
            size="small"
            disabled={!dirty || !maxTurnsValid || save.isPending}
            onClick={saveLimits}
          >
            Save limits
          </Button>
          {maxTurnsValid ? null : <span className={styles.note}>maxTurns must be a whole number.</span>}
        </span>
      </SettingsCard>

      <SettingsCard title="Providers" gap={10}>
        {providers.map((provider) => (
          <ProviderRow key={provider.id} {...provider} />
        ))}
        {providers.length === 0 ? (
          <EmptyNote>No provider is registered with this daemon or named in the config.</EmptyNote>
        ) : null}
        <p className={styles.note}>
          Credentials come from your Claude Code / Codex logins. {fetchNote(effective.fetchAllow)}
        </p>
      </SettingsCard>
    </ScrollPage>
  );
}

/** What the file sets, falling back to what the engine is running with. */
function fileLimits(
  file: WeftConfigFile,
  effective: ConfigResponse["effective"],
): { concurrency: number; maxTurns: number } {
  return {
    concurrency: file.limits?.concurrency ?? effective.limits.concurrency,
    maxTurns: file.limits?.maxTurns ?? effective.limits.maxTurns,
  };
}

/** `resolveApproval`'s fallback for a tier no config names: low runs, everything else asks. */
function unsetMode(tier: Risk): ApprovalMode {
  return tier === "low" ? "auto" : "ask";
}

function tierNote(tier: Risk, inFile: ApprovalMode | undefined, running: ApprovalMode | undefined): string {
  if (inFile === undefined && running === undefined) return "unset · engine default";
  if (inFile === running) return "config.json";
  return `config.json: ${inFile ?? "unset"} · running: ${running ?? unsetMode(tier)}`;
}

function timeout(ms: number): string {
  return ms >= 60_000 ? `${Math.round(ms / 60_000)} min` : `${Math.round(ms / 1000)} s`;
}

function fetchNote(allow: string[] | null): string {
  if (allow === null) return "Sandbox fetch allow-list: unset — every host is allowed.";
  if (allow.length === 0) return "Sandbox fetch allow-list: empty — no host is allowed.";
  return `Sandbox fetch allow-list: ${allow.join(" · ")}.`;
}

/**
 * Configured and registered are different things: the config can name a provider this
 * daemon never wired up, and a registered provider needs no config entry at all. Both
 * belong on the list, each saying which it is.
 */
function providerRows(
  data: ConfigResponse,
  meta: Meta | undefined,
): Array<{ id: string; model: string; status: string }> {
  const registered = new Map((meta?.providers ?? []).map((p) => [p.id, p]));
  const ids = [...new Set([...Object.keys(data.effective.providers), ...registered.keys()])].sort();

  return ids.map((id) => {
    const known = registered.get(id);
    const concurrency = data.effective.providers[id]?.concurrency ?? known?.concurrency;
    const parts: string[] = [];
    if (id === data.effective.defaults.provider) {
      const model = data.effective.defaults.model;
      parts.push(model === undefined ? "default" : `default · ${model}`);
    }
    if (concurrency !== undefined) parts.push(`concurrency ${concurrency}`);
    return {
      id,
      model: parts.join(" · "),
      status: known === undefined ? "unknown" : known.registered ? "ready" : "configured · not registered",
    };
  });
}

/** The PUT's own outcome — including that nothing it wrote is live until a restart. */
function saveStatus(save: ReturnType<typeof useSaveConfig>) {
  if (save.isPending) return <span className={styles.note}>Saving…</span>;
  if (save.isError) return <span className={styles.saveError}>{save.error.message}</span>;
  if (save.data?.restartRequired) {
    return <span className={styles.note}>Saved · restart the daemon for it to take effect.</span>;
  }
  return save.isSuccess ? <span className={styles.note}>Saved.</span> : null;
}
