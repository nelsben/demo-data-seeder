import { useState } from "react";
import { api, type LoadResult, type TeardownResult } from "../api.js";

interface Props {
  org: string;
  pack: string;
  result: LoadResult | null;
  busy: boolean;
  onLoad: (force: boolean) => void;
  onBack: () => void;
  onNext: () => void;
  onRestart: () => void;
  onError: (msg: string | null) => void;
}

export function LoadScreen({ org, pack, result, busy, onLoad, onBack, onNext, onRestart, onError }: Props) {
  const [force, setForce] = useState(false);

  // Teardown is a self-contained sub-flow: dry-run preview → confirm → delete.
  const [td, setTd] = useState<TeardownResult | null>(null);
  const [tdBusy, setTdBusy] = useState(false);

  async function teardown(yes: boolean) {
    onError(null);
    setTdBusy(true);
    try {
      const r = await api.teardown(org, pack, yes);
      setTd(r);
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
    } finally {
      setTdBusy(false);
    }
  }

  return (
    <>
      <div className="card">
        <h2>Load to {org}</h2>
        <p className="hint">
          Write the bundle into the org — catalog (products + prices) → Account → Contact → Opportunity → roles → line items → emails →
          activities, resolving lookups as parents insert. Additively idempotent: existing Accounts (and their subtrees) are skipped, and the
          shared product catalog is reused, not duplicated.
        </p>
        <div className="row">
          <label className="check">
            <input type="checkbox" checked={force} onChange={(e) => setForce(e.target.checked)} disabled={busy} />
            Force (load even if matching Accounts exist)
          </label>
          <span className="spacer" />
          <button onClick={() => onLoad(force)} disabled={busy}>
            {busy ? "Loading…" : result ? "Load again" : "Load to org"}
          </button>
        </div>
      </div>

      {result && (
        <div className="card">
          <h2>Load report</h2>
          <div className="grid" style={{ marginBottom: 16 }}>
            <Stat k="Inserted" v={result.totalInserted.toLocaleString()} />
            <Stat k="Skipped (existing)" v={result.idempotencySkipped.toLocaleString()} />
            <Stat k="Objects" v={String(result.objects.length)} />
            {result.conversions && result.conversions.attempted > 0 && (
              <Stat k="Leads converted" v={`${result.conversions.converted}/${result.conversions.attempted} · ${result.conversions.opportunitiesCreated} opps`} />
            )}
          </div>
          <table>
            <thead>
              <tr>
                <th>sObject</th>
                <th className="num">+Inserted</th>
                <th className="num">✗ Failed</th>
                <th className="num">⤳ Skipped</th>
                <th>Notes</th>
              </tr>
            </thead>
            <tbody>
              {result.objects.map((o) => (
                <tr key={o.object}>
                  <td>{o.object}</td>
                  <td className="num">{o.present ? o.inserted : "—"}</td>
                  <td className="num">{o.failed || ""}</td>
                  <td className="num">{o.skipped || ""}</td>
                  <td className="muted" style={{ fontSize: 12 }}>
                    {!o.present
                      ? "not in org"
                      : [o.reused ? `${o.reused} reused` : "", o.droppedFields.length ? `dropped: ${o.droppedFields.join(", ")}` : "", o.errors[0] ?? ""].filter(Boolean).join(" · ")}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {result && (
        <div className="card">
          <h2>Reset the org</h2>
          <p className="hint">
            Delete what this bundle seeded (scoped to its Accounts + subtree) so you can reload cleanly. Previews first — nothing is deleted until you confirm.
          </p>
          <div className="row">
            <button className="ghost" onClick={() => teardown(false)} disabled={tdBusy}>
              {tdBusy ? "Working…" : "Preview teardown"}
            </button>
            {td && td.dryRun && td.accountsMatched > 0 && (
              <button className="danger" onClick={() => teardown(true)} disabled={tdBusy}>
                Delete {td.objects.reduce((a, o) => a + o.matched, 0)} records
              </button>
            )}
          </div>
          {td && (
            <div className="beat" style={{ marginTop: 12 }}>
              {td.dryRun ? (
                td.accountsMatched === 0 ? (
                  "Nothing seeded by this bundle is present in the org."
                ) : (
                  <>
                    Would delete <strong>{td.objects.reduce((a, o) => a + o.matched, 0)}</strong> records under {td.accountsMatched} account(s):{" "}
                    {td.objects.filter((o) => o.matched).map((o) => `${o.object} ${o.matched}`).join(", ")}.
                  </>
                )
              ) : (
                <>Deleted <strong>{td.totalDeleted}</strong> records under {td.accountsMatched} account(s). The org is reset.</>
              )}
            </div>
          )}
        </div>
      )}

      <div className="actions">
        <button className="ghost" onClick={onBack}>← Back to copy</button>
        <span className="spacer" />
        <button className="ghost" onClick={onRestart}>Start over</button>
        <button onClick={onNext} disabled={!result}>Verify synthesis →</button>
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
