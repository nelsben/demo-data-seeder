// packages/engine/src/ops/plan-demo.ts
//
// `plan-demo` — the M2 DRY-RUN: load a CapabilityProfile, plan + generate a
// NarrativeBundle, print a preview, and persist the bundle to disk. NO org writes
// (load is M4). Lets you see exactly what a run WOULD create — counts, scenario
// split, budget clamping, a sample deal, and the copy intents — before spending a
// single API call. Idempotent in effect (re-running overwrites the same file).

import { existsSync, readFileSync } from "node:fs";
import { ScopeParams, apportion, type ScenarioMix } from "@dataseed/core";
import { openRegistry } from "@dataseed/registry";
import type { Op } from "./types.js";
import { profilePath } from "./profile-org.js";
import { buildBundle } from "../generate/generate.js";
import { savePlanned, latestDatasetFor } from "../store/bundle-store.js";

/** Parse "name:pct,name:pct" (string or pre-split array from the CLI) → a ScenarioMix. */
export function parseMix(input: unknown): Record<string, number> | undefined {
  if (input === undefined) return undefined;
  const parts = Array.isArray(input) ? input.map(String) : String(input).split(",");
  const mix: Record<string, number> = {};
  for (const p of parts) {
    const [name, pct] = p.split(":");
    if (!name || pct === undefined) throw new Error(`bad --scenario-mix entry "${p}" (expected name:pct)`);
    mix[name.trim()] = Number(pct);
  }
  return mix;
}

/**
 * The default per-scenario weight curve (descending), applied to ALL of the pack's scenarios in
 * pack order. UNEVEN on purpose: an even split (e.g. the old 34/33/33 over the first three arcs)
 * apportions a small volume into clean pairs (volume 6 → [2,2,2]), so two of five archetypes never
 * appeared and the sample read as a mechanical 2-2-2 collapse. With these weights, largest-remainder
 * apportionment of volume 6 yields [2,1,1,1,1] — all five archetypes present, only one repeated.
 * Tail weights (15/10) repeat to cover packs with >5 scenarios; extra leading weights are ignored for
 * packs with <5. Always re-normalized to sum to 100 so it satisfies the ScenarioMix invariant.
 */
export const DEFAULT_SCENARIO_WEIGHTS = [30, 25, 20, 15, 10] as const;

/** Weight every pack scenario by DEFAULT_SCENARIO_WEIGHTS (pack order), re-normalized to sum to 100. */
export function defaultMix(scenarios: readonly string[]): ScenarioMix {
  if (scenarios.length === 0) return {};
  // One weight per scenario: use the curve, repeating its last value past its length so larger packs
  // still get a descending-then-flat tail rather than zeros.
  const rawWeights = scenarios.map((_, i) => DEFAULT_SCENARIO_WEIGHTS[i] ?? DEFAULT_SCENARIO_WEIGHTS[DEFAULT_SCENARIO_WEIGHTS.length - 1]!);
  // apportion the 100 budget across the weights → exact integer percentages summing to 100 (so the
  // ScenarioMix "sum === 100" invariant holds for any scenario count, not just 5).
  const pcts = apportion(100, rawWeights);
  const mix: Record<string, number> = {};
  scenarios.forEach((s, i) => (mix[s] = pcts[i]!));
  return mix;
}

interface PlanDemoArgs extends Record<string, unknown> {
  org: string;
  pack: string;
  volume: number;
  population?: number;
  accounts?: number;
  bulkDensity?: number;
  userPoolSize?: number;
  userProfileName?: string;
  scenarioMix?: unknown;
  dc: string;
  seed?: string | number;
  asOf?: string;
}

export const planDemoOp: Op<PlanDemoArgs> = {
  id: "plan-demo",
  name: "Plan + preview a demo dataset (dry-run)",
  description:
    "Load the org's CapabilityProfile, plan + generate a NarrativeBundle deterministically, print a preview, and register it as an addressable dataset in the registry. NO org writes — see what a run would create before dispersing it.",
  idempotent: true,
  prerequisites: ["a CapabilityProfile for the org (run `profile-org --org <org> --pack <pack>` first)"],
  affects: ["the dataset registry (.dataseed/registry.db — registers/updates one addressable dataset; no org writes)"],
  args: {
    org: { type: "string", required: true, description: "Target org alias (must have a profile)." },
    pack: { type: "string", default: "salescloud", description: "Target pack id." },
    volume: { type: "number", default: 12, description: "Foreground NARRATIVE deals (live, full signal streams). Clamped to the record budget." },
    population: { type: "number", description: "Bulk BACKGROUND accounts beyond volume — rich structural records, no signal streams. The 'fill to scale' knob (e.g. 100000). Unlimited against a synthetic profile." },
    accounts: { type: "number", description: "Convenience: target TOTAL accounts. Back-solves population = max(0, accounts − volume)." },
    bulkDensity: { type: "number", description: "How richly the bulk graph is fleshed out: 0 = structural skeleton, 1 = full (committees/activities/assets/cases). Default 0.6." },
    userPoolSize: { type: "number", description: "Sales-rep User pool size for bulk OwnerId distribution (0 = off; ≤50)." },
    userProfileName: { type: "string", description: "Profile the pool users are created under (default 'Standard User')." },
    scenarioMix: { type: "string", description: 'e.g. "at-risk-budget:30,healthy-tech:25,rfp-gated:20,stalled-portfolio:15,churning-account:10" (defaults to an uneven 30/25/20/15/10 weighting over ALL pack arcs).' },
    dc: { type: "string", default: "auto", enum: ["auto", "on", "off"], description: "Data Cloud branch." },
    seed: { type: "string", description: "Reproducibility seed (number or memorable string; default 42)." },
    asOf: { type: "string", description: "ISO anchor for all timelines (default now)." },
  },

  check(args) {
    const hasProfile = existsSync(profilePath(args.org));
    return { alreadyDone: false, hasProfile };
  },

  run(args, ctx) {
    const pPath = profilePath(args.org);
    if (!existsSync(pPath)) {
      throw new Error(`no CapabilityProfile for "${args.org}". Run: dataseed run profile-org --org ${args.org} --pack ${args.pack}`);
    }
    const profile = JSON.parse(readFileSync(pPath, "utf8"));
    const pack = ctx.packs.get(args.pack);

    const scenarioMix = parseMix(args.scenarioMix) ?? defaultMix(pack.scenarios);
    const asOf = args.asOf ?? new Date().toISOString();
    // `accounts` is a convenience for total-account targeting → back-solve the bulk population.
    const population = args.accounts !== undefined ? Math.max(0, args.accounts - args.volume) : args.population;
    const scope = ScopeParams.parse({
      org: args.org,
      pack: args.pack,
      volume: args.volume,
      ...(population !== undefined ? { population } : {}),
      ...(args.bulkDensity !== undefined ? { bulkDensity: args.bulkDensity } : {}),
      ...(args.userPoolSize !== undefined ? { userPoolSize: args.userPoolSize } : {}),
      ...(args.userProfileName !== undefined ? { userProfileName: args.userProfileName } : {}),
      scenarioMix,
      dc: args.dc,
      ...(args.seed !== undefined ? { seed: args.seed } : {}),
      asOf,
    });

    const bundle = buildBundle(scope, profile, pack, asOf);

    const store = openRegistry();
    let datasetId: string;
    try {
      const ds = savePlanned(store, { pack: args.pack, params: scope, bundle, now: new Date().toISOString() });
      datasetId = ds.id;
    } finally {
      store.close();
    }
    ctx.log(`registered dataset ${datasetId} (${args.pack})`);

    // ── Preview ──────────────────────────────────────────────────────────────
    const p = bundle.plan;
    ctx.log(`plan: ${p.volume}/${p.requestedVolume} units${p.budgetCapped ? " (BUDGET-CAPPED)" : ""}, dc=${p.withDc ? "on" : "off"}, seed=${p.seed}, mode=${p.mode}`);
    ctx.log(`scenarios: ${Object.entries(p.scenarioCounts).map(([k, v]) => `${k}×${v}`).join(", ")}`);
    ctx.log(`records: ${Object.entries(p.perObjectCounts).map(([k, v]) => `${k} ${v}`).join(", ")} (≈${p.estimatedRecords} total)`);
    ctx.log(`copy requests deferred to the copy layer: ${bundle.copyRequests.length}`);

    const sampleOpp = bundle.records.Opportunity?.[0];
    if (sampleOpp) {
      ctx.log(`sample deal: ${sampleOpp.Name} | $${Number(sampleOpp.Amount).toLocaleString()} | ${sampleOpp.StageName} | close ${sampleOpp.CloseDate}`);
    }
    const sampleCopy = bundle.copyRequests[0];
    if (sampleCopy) ctx.log(`sample copy intent: ${sampleCopy.beatIntent}`);

    if (p.volume === 0) ctx.log("WARNING: planned volume is 0 (record budget too low or volume=0).");
  },

  verify(args) {
    const store = openRegistry();
    try {
      const ds = latestDatasetFor(store, args.org, args.pack);
      if (!ds) return { success: false, reason: "no dataset registered" };
      const total = Object.values(ds.bundle.plan.perObjectCounts).reduce((a, b) => a + b, 0);
      return { success: true, datasetId: ds.id, units: ds.bundle.plan.volume, records: total, copyRequests: ds.bundle.copyRequests.length };
    } finally {
      store.close();
    }
  },
};

export default planDemoOp;
