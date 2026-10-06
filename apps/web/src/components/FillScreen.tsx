import { useState } from "react";
import type { CopyProvider, FillResult } from "../api.js";

interface Props {
  org: string;
  result: FillResult | null;
  busy: boolean;
  onFill: (provider: CopyProvider, budgetUsd?: number) => void;
  onBack: () => void;
  onNext: () => void;
}

const PROVIDERS: Array<{ id: CopyProvider; label: string; hint: string }> = [
  { id: "claude-code", label: "Claude Code", hint: "Local Claude CLI — runs on your subscription, $0 API credits (recommended)" },
  { id: "auto", label: "Auto", hint: "Org preference, then availability" },
  { id: "anthropic", label: "Anthropic", hint: "Claude API — server needs ANTHROPIC_API_KEY env var (not entered here)" },
  { id: "static", label: "Static", hint: "Deterministic templates, no LLM, $0" },
];

export function FillScreen({ org, result, busy, onFill, onBack, onNext }: Props) {
  // Default to the local-first provider — the whole point of the local-app decision (it falls back to static if the `claude` CLI isn't on PATH).
  const [provider, setProvider] = useState<CopyProvider>("claude-code");
  const [budget, setBudget] = useState("");

  return (
    <>
      <div className="card">
        <h2>Write the copy</h2>
        <p className="hint">
          Generate the deferred email bodies — real prose grounded in each deal's facts (amount, close date, who said what). Local only;
          nothing is written to <code>{org}</code> until you load.
        </p>

        <div className="row" style={{ marginBottom: 16 }}>
          <div className="field">
            <label>Provider</label>
            <select value={provider} onChange={(e) => setProvider(e.target.value as CopyProvider)} disabled={busy}>
              {PROVIDERS.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                </option>
              ))}
            </select>
            <span className="muted" style={{ fontSize: 12 }}>{PROVIDERS.find((p) => p.id === provider)?.hint}</span>
          </div>
          <div className="field">
            <label>LLM budget (USD)</label>
            <input type="text" placeholder="none" value={budget} onChange={(e) => setBudget(e.target.value)} disabled={busy} style={{ minWidth: 0, width: 110 }} />
            <span className="muted" style={{ fontSize: 12 }}>Caps spend; rest falls back to static.</span>
          </div>
          <button onClick={() => onFill(provider, budget.trim() ? Number(budget) : undefined)} disabled={busy}>
            {busy ? "Writing…" : result ? "Re-generate" : "Generate copy"}
          </button>
        </div>

        {result && (
          <div className="grid">
            <Stat k="Provider" v={result.provider} />
            <Stat k="Emails filled" v={`${result.emails.withBody} / ${result.emails.total}`} />
            <Stat k="Tasks filled" v={result.tasks ? `${result.tasks.withBody} / ${result.tasks.total}` : "—"} />
            <Stat k="Via primary" v={result.filledByPrimary != null ? String(result.filledByPrimary) : "—"} />
            <Stat k="Static fallback" v={result.fallbacks ? String(result.fallbacks) : "0"} />
            <Stat k="Est. LLM cost" v={result.estCostUsd > 0 ? `$${result.estCostUsd.toFixed(4)}` : "$0"} />
          </div>
        )}
        {result?.gate?.ran && (
          <p className="muted" style={{ marginTop: 12 }}>
            Realism gate: {result.gate.after.clean}/{result.gate.after.total} emails clean after {result.gate.passes} regenerate pass(es)
            {result.gate.converged ? " (converged)" : result.gate.unresolved.length ? `, ${result.gate.unresolved.length} unresolved` : ""}.
          </p>
        )}
      </div>

      {result && result.taskSamples && result.taskSamples.length > 0 && (
        <div className="card">
          <h2>Sample activity notes</h2>
          <p className="hint">The rep's internal CRM logs — terse, specific, no greeting or sign-off.</p>
          {result.taskSamples.map((t, i) => (
            <div key={i} className="email">
              <div className="email-head">
                <span className="chip">task</span>
                <span className="email-subj">{t.subject}</span>
              </div>
              <pre className="email-body">{t.body}</pre>
            </div>
          ))}
        </div>
      )}

      {result && result.samples.length > 0 && (
        <div className="card">
          <h2>Sample emails</h2>
          <p className="hint">A few of the generated bodies — the prose your demo's signals will be extracted from.</p>
          {result.samples.map((s, i) => (
            <div key={i} className="email">
              <div className="email-head">
                <span className={`chip ${s.incoming ? "amber" : ""}`}>{s.incoming ? "inbound" : "outbound"}</span>
                <span className="email-subj">{s.subject}</span>
              </div>
              <pre className="email-body">{s.body}</pre>
            </div>
          ))}
        </div>
      )}

      <div className="actions">
        <button className="ghost" onClick={onBack}>← Back to preview</button>
        <span className="spacer" />
        <button onClick={onNext} disabled={!result || result.emails.withBody === 0}>
          Load to org →
        </button>
      </div>
    </>
  );
}

function Stat({ k, v }: { k: string; v: string }) {
  return (
    <div className="stat">
      <div className="k">{k}</div>
      <div className="v" style={{ fontSize: 15 }}>{v}</div>
    </div>
  );
}
