import { useAtom, useAtomValue, useSetAtom } from "jotai";
import { RangeField } from "~/components/atoms/RangeField";
import { TextField } from "~/components/atoms/TextField";
import { PolicyRow } from "~/components/molecules/PolicyRow";
import { ProviderRow } from "~/components/molecules/ProviderRow";
import { SettingsCard } from "~/components/molecules/SettingsCard";
import { PageHeader } from "~/components/templates/PageHeader";
import { ScrollPage } from "~/components/templates/ScrollPage";
import { POLICY_TIERS, PROVIDERS } from "~/domain/fixtures/runList";
import type { RiskTier } from "~/domain/types";
import { budgetAtom, concurrencyAtom, policyAtom, setPolicyAtom } from "~/state/atoms";
import styles from "./SettingsPage.module.css";

/** Approval policy, budget and providers — the daemon's standing settings. */
export function SettingsPage() {
  const policy = useAtomValue(policyAtom);
  const setPolicy = useSetAtom(setPolicyAtom);
  const [budget, setBudget] = useAtom(budgetAtom);
  const [concurrency, setConcurrency] = useAtom(concurrencyAtom);

  return (
    <ScrollPage maxWidth={760} gap={14}>
      <PageHeader title="Settings" />

      <SettingsCard title="Approval policy" gap={10}>
        <p className={styles.policyNote}>
          A workflow may raise a tier, never lower it. Auto-approvals are journaled as{" "}
          <span className={styles.mono}>answered_by: "policy"</span>.
        </p>
        {POLICY_TIERS.map((tier) => (
          <PolicyRow
            key={tier.k}
            tier={tier.k as RiskTier}
            ops={tier.v}
            mode={policy[tier.k as RiskTier]}
            onSet={(mode) => setPolicy(tier.k as RiskTier, mode)}
          />
        ))}
      </SettingsCard>

      <SettingsCard title="Budget & limits" gap={12}>
        <div className={styles.grid}>
          <div className={styles.label}>
            <label className={styles.labelText} htmlFor="default-budget">
              Default run budget
            </label>
            <TextField
              id="default-budget"
              scale="settings"
              value={budget}
              onChange={(e) => setBudget(e.target.value)}
            />
          </div>
          <div className={styles.label}>
            <label className={styles.labelText} htmlFor="agent-concurrency">
              Agent concurrency · {concurrency} agents
            </label>
            <span className={styles.slider}>
              <span className={styles.bound}>2</span>
              <RangeField
                id="agent-concurrency"
                min={2}
                max={24}
                value={concurrency}
                onChange={(e) => setConcurrency(Number(e.target.value))}
              />
              <span className={styles.bound}>24</span>
            </span>
          </div>
        </div>
        <p className={styles.note}>
          Budget exhaustion throws inside the next step; the pool is shared with child workflows. Per step:
          maxTurns 50 · 20 min wall clock.
        </p>
      </SettingsCard>

      <SettingsCard title="Providers" gap={10}>
        {PROVIDERS.map((provider) => (
          <ProviderRow key={provider.id} {...provider} />
        ))}
        <p className={styles.note}>
          Credentials come from your Claude Code / Codex logins. Sandbox fetch allow-list: api.github.com ·
          registry.npmjs.org.
        </p>
      </SettingsCard>
    </ScrollPage>
  );
}
