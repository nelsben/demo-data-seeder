import { useEffect, useState } from "react";
import { api, type SynthesisSummary } from "../api.js";

interface Props {
  org: string;
  pack: string;
  onBack: () => void;
  onRestart: () => void;
  onError: (msg: string | null) => void;
}

/** Try to parse a RAG scorecard JSON ({"Metrics":"Red",…}) for a compact chip view. */
function parseScorecard(sample?: string | null): Array<[string, string]> | null {
  if (!sample) return null;
  try {
    const o = JSON.parse(sample) as Record<string, unknown>;
    const entries = Object.entries(o).filter(([, v]) => typeof v === "string") as Array<[string, string]>;
    return entries.length ? entries : null;
  } catch {
    return null;
  }
}

const RAG: Record<string, string> = { red: "red", yellow: "amber", amber: "amber", green: "green" };

export function VerifyScreen({ org, pack, onBack, onRestart, onError }: Props) {
  const [summary, setSummary] = useState<SynthesisSummary | null>(null);
  const [busy, setBusy] = useState(false);

  async function refresh() {
    onError(null);
    setBusy(true);
    try {
      setSummary(await api.synthesis(org, pack));
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  // Probe once on entry — the cascade may still be running, so the user can re-poll.
  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const briefProbe = summary?.probes.find((p) => /brief/i.test(p.label));
  const scorecard = parseScorecard(briefProbe?.sample);

  // Inputs landed but nothing derived yet → the async cascade is still running (vs. a stuck pipeline).
  const inputsLanded = (summary?.inputs ?? []).some((p) => p.count > 0);
  const derivedAny = (summary?.probes ?? []).some((p) => p.count > 0);
  const cascadePending = inputsLanded && !derivedAny;

  return (
    <>
      <div className="card">
        <h2>Verify synthesis</h2>
        <p className="hint">
          The payoff: not just that records landed, but that <strong>{org}</strong>'s live pipeline turned the seeded inputs into its own
          outputs. The cascade runs asynchronously — counts climb for a minute or so after a load. Re-check until it settles.
        </p>
        <div className="row">
          <span className="spacer" />
          <button onClick={refresh} disabled={busy}>
            {busy ? "Checking…" : "Re-check synthesis"}
          </button>
        </div>

        {summary && !summary.supported && (
          <p className="muted" style={{ marginTop: 12 }}>This pack declares no synthesis outputs to verify.</p>
        )}

        {summary && summary.supported && (
          <>
            {summary.inputs.length > 0 && (
              <>
                <h3 style={{ marginTop: 20, marginBottom: 4 }}>Seeded inputs</h3>
                <p className="hint" style={{ marginTop: 0 }}>What the load placed — the raw material the pipeline reads.</p>
                <div className="grid">
                  {summary.inputs.map((p) => (
                    <div className="stat" key={p.object}>
                      <div className="k">{p.label}</div>
                      <div className="v" style={{ color: !p.present ? "var(--muted)" : p.count > 0 ? "var(--green)" : "var(--text)" }}>
                        {p.present ? p.count.toLocaleString() : "—"}
                      </div>
                    </div>
                  ))}
                </div>
              </>
            )}

            <h3 style={{ marginTop: 20, marginBottom: 4 }}>Derived by the pipeline</h3>
            <p className="hint" style={{ marginTop: 0 }}>What {org}'s live synthesis produced from those inputs.</p>
            <div className="grid">
              {summary.probes.map((p) => (
                <div className="stat" key={p.object}>
                  <div className="k">{p.label}</div>
                  <div className="v" style={{ color: !p.present ? "var(--muted)" : p.count > 0 ? "var(--green)" : "var(--text)" }}>
                    {p.present ? p.count.toLocaleString() : "—"}
                  </div>
                </div>
              ))}
            </div>

            {cascadePending && (
              <p className="muted" style={{ marginTop: 12 }}>
                Inputs landed but nothing derived yet — the trigger cascade runs asynchronously and can take a minute. Re-check before assuming the pipeline is stuck.
              </p>
            )}
          </>
        )}
      </div>

      {scorecard && (
        <div className="card">
          <h2>Latest strategy scorecard</h2>
          <p className="hint">Synthesized by the pipeline from the seeded signals — keyed by the framework's rules.</p>
          <div className="chips">
            {scorecard.map(([k, v]) => (
              <span key={k} className={`chip ${RAG[v.toLowerCase()] ?? ""}`}>
                {k}: {v}
              </span>
            ))}
          </div>
        </div>
      )}

      <div className="actions">
        <button className="ghost" onClick={onBack}>← Back to load</button>
        <span className="spacer" />
        <button className="ghost" onClick={onRestart}>Start over</button>
      </div>
    </>
  );
}
