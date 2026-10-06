import { useEffect, useState } from "react";
import type { CapabilityProfile, PackRequirement } from "@dataseed/core";
import {
  api,
  type OrgSummary,
  type PackSummary,
  type PlanResult,
  type PlanRequest,
  type CopyProvider,
  type FillResult,
  type LoadResult,
  ApiError,
} from "./api.js";
import { evenMix } from "./mix.js";
import { ConnectScreen } from "./components/ConnectScreen.js";
import { ScopeScreen, type ScopeState } from "./components/ScopeScreen.js";
import { PreviewScreen } from "./components/PreviewScreen.js";
import { FillScreen } from "./components/FillScreen.js";
import { LoadScreen } from "./components/LoadScreen.js";
import { VerifyScreen } from "./components/VerifyScreen.js";

type Step = "connect" | "scope" | "preview" | "fill" | "load" | "verify";

const STEP_LABELS: Array<{ id: Step; label: string }> = [
  { id: "connect", label: "Connect" },
  { id: "scope", label: "Scope" },
  { id: "preview", label: "Preview" },
  { id: "fill", label: "Copy" },
  { id: "load", label: "Load" },
  { id: "verify", label: "Verify" },
];

export function App() {
  const [step, setStep] = useState<Step>("connect");
  const [orgs, setOrgs] = useState<OrgSummary[]>([]);
  const [packs, setPacks] = useState<PackSummary[]>([]);
  const [org, setOrg] = useState("");
  const [packId, setPackId] = useState("");
  const [profile, setProfile] = useState<CapabilityProfile | null>(null);
  const [requirements, setRequirements] = useState<PackRequirement[]>([]);
  const [scope, setScope] = useState<ScopeState>({ volume: 12, mix: {}, seed: "demo-q3" });
  const [plan, setPlan] = useState<PlanResult | null>(null);
  const [fillResult, setFillResult] = useState<FillResult | null>(null);
  const [loadResult, setLoadResult] = useState<LoadResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([api.orgs(), api.packs()])
      .then(([o, p]) => {
        setOrgs(o);
        setPacks(p);
        if (p[0]) setPackId(p[0].id);
        else setError("No target packs are registered on the server — nothing to seed. Check the server's pack registry.");
        const firstAlias = o.find((x) => x.alias && !x.isExpired)?.alias;
        if (firstAlias) setOrg(firstAlias);
      })
      .catch((e) => setError(describe(e)));
  }, []);

  const pack = packs.find((p) => p.id === packId);

  function describe(e: unknown): string {
    return e instanceof ApiError ? `${e.status}: ${e.message}` : e instanceof Error ? e.message : String(e);
  }

  async function runProfile() {
    setError(null);
    try {
      const { profile: prof, requirements: reqs } = await api.profile(org, packId);
      setProfile(prof);
      setRequirements(reqs);
      if (pack) setScope((s) => ({ ...s, mix: evenMix(pack.scenarios.slice(0, 3)) }));
    } catch (e) {
      setError(describe(e));
    }
  }

  async function runPlan() {
    setError(null);
    try {
      const body: PlanRequest = { org, pack: packId, volume: scope.volume, scenarioMix: scope.mix, seed: scope.seed };
      setPlan(await api.plan(body));
      setFillResult(null); // a fresh plan invalidates any prior copy/load
      setLoadResult(null);
      setStep("preview");
    } catch (e) {
      setError(describe(e));
    }
  }

  async function runFill(provider: CopyProvider, budgetUsd?: number) {
    setError(null);
    setBusy(true);
    try {
      setFillResult(await api.fillCopy({ org, pack: packId, provider, budgetUsd }));
    } catch (e) {
      setError(describe(e));
    } finally {
      setBusy(false);
    }
  }

  async function runLoad(force: boolean) {
    setError(null);
    setBusy(true);
    try {
      setLoadResult(await api.load(org, packId, force));
    } catch (e) {
      setError(describe(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="app">
      <div className="brand">
        <h1>dataseed</h1>
        <span className="tag">Salesforce data-testing</span>
      </div>
      <p className="lede">Point at an org, read what it can hold, and generate a grounded test dataset.</p>

      <div className="steps">
        {STEP_LABELS.map((s, i) => (
          <div key={s.id} className={`step ${s.id === step ? "active" : ""} ${STEP_LABELS.findIndex((x) => x.id === step) > i ? "done" : ""}`}>
            <span className="n">{i + 1}</span>
            {s.label}
          </div>
        ))}
      </div>

      {error && <div className="error">{error}</div>}

      {step === "connect" && (
        <ConnectScreen
          orgs={orgs}
          packs={packs}
          org={org}
          packId={packId}
          profile={profile}
          requirements={requirements}
          onOrg={setOrg}
          onPack={setPackId}
          onProfile={runProfile}
          onNext={() => setStep("scope")}
        />
      )}

      {step === "scope" && pack && (
        <ScopeScreen
          pack={pack}
          profile={profile}
          scope={scope}
          onChange={setScope}
          onBack={() => setStep("connect")}
          onPreview={runPlan}
        />
      )}

      {step === "preview" && plan && (
        <PreviewScreen plan={plan} onBack={() => setStep("scope")} onNext={() => setStep("fill")} onRestart={() => setStep("connect")} />
      )}

      {step === "fill" && (
        <FillScreen
          org={org}
          result={fillResult}
          busy={busy}
          onFill={runFill}
          onBack={() => setStep("preview")}
          onNext={() => setStep("load")}
        />
      )}

      {step === "load" && (
        <LoadScreen
          org={org}
          pack={packId}
          result={loadResult}
          busy={busy}
          onLoad={runLoad}
          onBack={() => setStep("fill")}
          onNext={() => setStep("verify")}
          onRestart={() => setStep("connect")}
          onError={setError}
        />
      )}

      {step === "verify" && (
        <VerifyScreen
          org={org}
          pack={packId}
          onBack={() => setStep("load")}
          onRestart={() => setStep("connect")}
          onError={setError}
        />
      )}
    </div>
  );
}
