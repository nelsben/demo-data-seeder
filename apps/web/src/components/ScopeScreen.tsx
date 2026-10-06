import type { CapabilityProfile } from "@dataseed/core";
import type { PackSummary } from "../api.js";
import { mixTotal, mixIsValid, evenMix } from "../mix.js";

export interface ScopeState {
  volume: number;
  mix: Record<string, number>;
  seed: string;
}

interface Props {
  pack: PackSummary;
  profile: CapabilityProfile | null;
  scope: ScopeState;
  onChange: (s: ScopeState) => void;
  onBack: () => void;
  onPreview: () => void;
}

export function ScopeScreen({ pack, profile, scope, onChange, onBack, onPreview }: Props) {
  const total = mixTotal(scope.mix);
  const valid = mixIsValid(scope.mix);
  const budget = profile?.recordBudget;
  const maxUnits = budget ? Math.floor(budget / pack.recordsPerUnitEstimate) : undefined;
  const overBudget = maxUnits !== undefined && scope.volume > maxUnits;

  const setMix = (scenario: string, value: number) => onChange({ ...scope, mix: { ...scope.mix, [scenario]: value } });

  return (
    <div className="card">
      <h2>Scope</h2>
      <p className="hint">
        How many deals, split across {pack.label}'s arcs. ~{pack.recordsPerUnitEstimate} records per deal.
      </p>

      <div className="row" style={{ marginBottom: 16 }}>
        <div className="field">
          <label>Deals (volume)</label>
          <input type="number" min={1} value={scope.volume} onChange={(e) => onChange({ ...scope, volume: Math.max(1, Number(e.target.value)) })} />
        </div>
        <div className="field">
          <label>Seed</label>
          <input type="text" value={scope.seed} onChange={(e) => onChange({ ...scope, seed: e.target.value })} />
        </div>
      </div>

      {overBudget && (
        <p className="muted" style={{ marginTop: 0 }}>
          Heads up: the org's record budget fits ~{maxUnits?.toLocaleString()} deals — the plan will clamp to that.
        </p>
      )}

      <div className="field" style={{ marginBottom: 8 }}>
        <label>
          Scenario mix —{" "}
          <span className={total === 100 ? "total-ok" : "total-bad"}>{total}% / 100%</span>
        </label>
      </div>
      <table>
        <tbody>
          {pack.scenarios.map((s) => (
            <tr key={s}>
              <td style={{ width: "60%" }}>{s}</td>
              <td className="num" style={{ width: "40%" }}>
                <input
                  type="number"
                  min={0}
                  max={100}
                  value={scope.mix[s] ?? 0}
                  onChange={(e) => setMix(s, Math.max(0, Number(e.target.value)))}
                />
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <div className="actions">
        <button className="ghost" onClick={onBack}>
          ← Back
        </button>
        <button className="ghost" onClick={() => onChange({ ...scope, mix: evenMix(pack.scenarios.slice(0, 3)) })}>
          Even split (3 arcs)
        </button>
        <span className="spacer" />
        <button onClick={onPreview} disabled={!valid}>
          {valid ? "Preview dataset →" : `Mix must total 100% (now ${total}%)`}
        </button>
      </div>
    </div>
  );
}
