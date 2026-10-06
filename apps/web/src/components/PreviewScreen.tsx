import type { PlanResult } from "../api.js";

interface Props {
  plan: PlanResult;
  onBack: () => void;
  onNext: () => void;
  onRestart: () => void;
}

export function PreviewScreen({ plan, onBack, onNext, onRestart }: Props) {
  const { plan: p, preview } = plan;
  const usd = (n: number) => `$${Number(n).toLocaleString()}`;

  return (
    <>
      <div className="card">
        <h2>Plan</h2>
        <p className="hint">
          What this run would create — deterministic for seed <code>{p.seed}</code>. Nothing is written to the org yet.
        </p>
        <div className="grid">
          <Stat k="Deals" v={`${p.volume}${p.budgetCapped ? ` / ${p.requestedVolume}` : ""}`} />
          <Stat k="Records" v={p.estimatedRecords.toLocaleString()} />
          <Stat k="Mode" v={p.mode} />
          <Stat k="Copy intents" v={String(preview.copyRequests)} />
        </div>
        {p.budgetCapped && (
          <p className="muted" style={{ marginTop: 12 }}>
            Clamped from {p.requestedVolume} to {p.volume} deals by the org's record budget.
          </p>
        )}

        <div className="chips" style={{ marginTop: 16 }}>
          {Object.entries(p.scenarioCounts).map(([k, v]) => (
            <span key={k} className="chip">
              {k} × {v}
            </span>
          ))}
        </div>
      </div>

      <div className="card">
        <h2>Records by object</h2>
        <table>
          <thead>
            <tr>
              <th>sObject</th>
              <th style={{ textAlign: "right" }}>Count</th>
            </tr>
          </thead>
          <tbody>
            {Object.entries(p.perObjectCounts).map(([obj, n]) => (
              <tr key={obj}>
                <td>{obj}</td>
                <td className="num">{n}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="card">
        <h2>Sample deals</h2>
        <table>
          <thead>
            <tr>
              <th>Opportunity</th>
              <th>Arc</th>
              <th>Stage</th>
              <th style={{ textAlign: "right" }}>Amount</th>
              <th>Close</th>
            </tr>
          </thead>
          <tbody>
            {preview.sampleDeals.map((d, i) => (
              <tr key={i}>
                <td>{d.name}</td>
                <td className="muted">{d.scenario}</td>
                <td>{d.stage}</td>
                <td className="num">
                  {usd(d.amount)}{" "}
                  {d.reconciled ? (
                    <span className="chip" title="line items sum exactly to Amount">✓</span>
                  ) : d.lineItems ? (
                    <span className="chip amber" title="line items do not sum to Amount">✗</span>
                  ) : null}
                </td>
                <td className="muted">{d.closeDate}</td>
              </tr>
            ))}
          </tbody>
        </table>

        {(() => {
          const d = preview.sampleDeals.find((x) => x.lineItems?.length);
          if (!d?.lineItems) return null;
          const sum = d.lineItems.reduce((s, l) => s + l.quantity * l.unitPrice, 0);
          return (
            <>
              <p className="hint" style={{ margin: "16px 0 8px" }}>
                Line-item economics — <strong>{d.name}</strong> (per-product breakdown; the lines reconcile to the deal Amount):
              </p>
              <table>
                <thead>
                  <tr>
                    <th>Product</th>
                    <th style={{ textAlign: "right" }}>Qty</th>
                    <th style={{ textAlign: "right" }}>Unit price</th>
                    <th style={{ textAlign: "right" }}>Line total</th>
                  </tr>
                </thead>
                <tbody>
                  {d.lineItems.map((l, i) => (
                    <tr key={i}>
                      <td>{l.product}</td>
                      <td className="num">{l.quantity}</td>
                      <td className="num">{usd(l.unitPrice)}</td>
                      <td className="num">{usd(l.quantity * l.unitPrice)}</td>
                    </tr>
                  ))}
                  <tr>
                    <td colSpan={3} style={{ textAlign: "right", fontWeight: 600 }}>
                      Σ {d.reconciled ? "= Amount ✓ reconciles" : "≠ Amount ✗"}
                    </td>
                    <td className="num" style={{ fontWeight: 600 }}>{usd(sum)}</td>
                  </tr>
                </tbody>
              </table>
            </>
          );
        })()}

        {preview.sampleCopy && (
          <>
            <p className="hint" style={{ margin: "16px 0 8px" }}>Sample copy intent (the prose the copy layer will write):</p>
            <div className="beat">{preview.sampleCopy}</div>
          </>
        )}
      </div>

      <div className="actions">
        <button className="ghost" onClick={onBack}>
          ← Back to scope
        </button>
        <span className="spacer" />
        <button className="ghost" onClick={onRestart}>
          Start over
        </button>
        <button onClick={onNext}>Write the copy →</button>
      </div>
    </>
  );
}

function Stat({ k, v }: { k: string; v: string }) {
  return (
    <div className="stat">
      <div className="k">{k}</div>
      <div className="v">{v}</div>
    </div>
  );
}
