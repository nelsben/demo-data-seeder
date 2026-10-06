import { useEffect, useState } from "react";
import type { CapabilityProfile, PackRequirement } from "@dataseed/core";
import { api, type OrgSummary, type PackSummary, type PreflightResult } from "../api.js";

interface Props {
  orgs: OrgSummary[];
  packs: PackSummary[];
  org: string;
  packId: string;
  profile: CapabilityProfile | null;
  requirements: PackRequirement[];
  onOrg: (v: string) => void;
  onPack: (v: string) => void;
  onProfile: () => void;
  onNext: () => void;
}

export function ConnectScreen(props: Props) {
  const { orgs, packs, org, packId, profile, requirements } = props;
  const blocking = requirements.filter((r) => r.severity === "blocking");
  const profileMatchesOrg = profile?.org === org;

  // First-run environment check — self-fetched so a missing `sf`/`claude` surfaces on entry.
  const [pf, setPf] = useState<PreflightResult | null>(null);
  useEffect(() => {
    api.preflight().then(setPf).catch(() => setPf(null));
  }, []);

  return (
    <>
      <div className="card">
        <h2>Connect</h2>
        <p className="hint">Pick an authed org and a target pack, then read what the org can actually hold.</p>
        <div className="row">
          <div className="field">
            <label>Org</label>
            {/* A datalist so the SE can pick an authed org OR type any alias — some scratch orgs (e.g. a flaky dev-hub) aren't in `sf org list` but are still usable. */}
            <input
              list="org-list"
              value={org}
              onChange={(e) => props.onOrg(e.target.value)}
              placeholder="alias or username"
              autoComplete="off"
              spellCheck={false}
            />
            <datalist id="org-list">
              {orgs.map((o) => (
                <option key={o.username} value={o.alias ?? o.username}>
                  {o.isScratch ? "scratch" : ""}
                  {o.isExpired ? " · expired" : ""}
                </option>
              ))}
            </datalist>
            <span className="muted" style={{ fontSize: 12 }}>
              Pick an authed org or type any alias.
            </span>
          </div>
          <div className="field">
            <label>Pack</label>
            <select value={packId} onChange={(e) => props.onPack(e.target.value)}>
              {packs.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                </option>
              ))}
            </select>
          </div>
          <button onClick={props.onProfile} disabled={!org}>
            Profile org
          </button>
        </div>

        {pf && (
          <p className="muted" style={{ marginTop: 12, fontSize: 12 }}>
            Environment: <span className={pf.sf ? "total-ok" : "total-bad"}>{pf.sf ? "✓" : "✗"} sf CLI</span>
            {" · "}
            <span className={pf.claudeCode ? "total-ok" : "total-bad"}>{pf.claudeCode ? "✓" : "✗"} claude CLI</span> (default copy provider)
            {" · "}
            <span className={pf.anthropicKey ? "total-ok" : ""}>{pf.anthropicKey ? "✓" : "—"} ANTHROPIC_API_KEY</span>
            {!pf.sf && " — install/authenticate the Salesforce CLI to load."}
            {pf.sf && !pf.claudeCode && " — install + log in to the `claude` CLI for real copy, or choose Static."}
          </p>
        )}
      </div>

      {profileMatchesOrg && profile && (
        <div className="card">
          <h2>{profile.org}</h2>
          <p className="hint">
            Read {new Date(profile.capturedAt).toLocaleString()}
            {profile.gaps.length > 0 ? ` · ${profile.gaps.length} gap(s) — partial read` : ""}
          </p>
          <div className="grid">
            <Stat k="Edition" v={profile.edition ?? "?"} />
            <Stat k="Sandbox" v={profile.isSandbox === undefined ? "?" : String(profile.isSandbox)} />
            <Stat k="Namespace" v={profile.namespacePrefix ?? "(none)"} mono />
            <Stat k="Record budget" v={profile.recordBudget?.toLocaleString() ?? "?"} />
            <Stat k="Copy provider" v={profile.copyProvider} />
            <Stat k="Data Cloud" v={profile.dataCloud ? (profile.dataCloud.available ? "on" : "off") : "?"} />
          </div>

          <div style={{ marginTop: 16 }}>
            {requirements.length === 0 ? (
              <span className="chip green">All pack requirements satisfied</span>
            ) : (
              <div className="chips">
                {requirements.map((r, i) => (
                  <span key={i} className={`chip ${r.severity === "blocking" ? "red" : "amber"}`} title={r.detail}>
                    {r.kind}
                  </span>
                ))}
              </div>
            )}
          </div>

          <div className="actions">
            <span className="muted">
              {blocking.length > 0
                ? `${blocking.length} blocker(s) — you can still preview a dataset; loading needs them resolved.`
                : "Ready to scope a dataset."}
            </span>
            <span className="spacer" />
            <button onClick={props.onNext}>Next: scope →</button>
          </div>
        </div>
      )}
    </>
  );
}

function Stat({ k, v, mono }: { k: string; v: string; mono?: boolean }) {
  return (
    <div className="stat">
      <div className="k">{k}</div>
      <div className={`v ${mono ? "mono" : ""}`}>{v}</div>
    </div>
  );
}
