import { describe, it, expect } from "vitest";
import { CapabilityProfile, ScopeParams, GenericRecord, type TargetPack } from "@dataseed/core";
import { planBundle } from "../src/plan/plan.js";
import { generateBundle, buildBundle } from "../src/generate/generate.js";
import { parseMix, defaultMix } from "../src/ops/plan-demo.js";

const ASOF = "2026-06-17T00:00:00.000Z";

/** A minimal generic pack — proves the engine stages are target-agnostic. */
const fakePack: TargetPack = {
  id: "fake",
  label: "Fake",
  description: "test",
  objects: ["Account", "Thing__c"],
  picklists: {},
  scenarios: ["alpha", "beta"],
  recordSchemas: { Account: GenericRecord, Thing__c: GenericRecord },
  variability: {
    band: [{ value: "S", weight: 1 }, { value: "L", weight: 1 }],
    region: [{ value: "NA", weight: 1 }],
  },
  recordsPerUnitEstimate: 4,
  checkRequirements: () => [],
  generate: ({ plan }) => ({
    records: {
      Account: plan.units.map((u) => ({ _ref: `a-${u.index}`, scenario: u.scenario, band: u.traits.band })),
      Thing__c: plan.units.map((u) => ({ _refs: { AccountId: `a-${u.index}` } })),
    },
  }),
};

const profile = (over: Record<string, unknown> = {}) =>
  CapabilityProfile.parse({ org: "o", capturedAt: ASOF, ...over });

const scope = (over: Record<string, unknown> = {}) =>
  ScopeParams.parse({ org: "o", pack: "fake", volume: 10, scenarioMix: { alpha: 60, beta: 40 }, ...over });

describe("planBundle", () => {
  it("is deterministic — same inputs produce an identical plan", () => {
    const a = planBundle(scope(), profile(), fakePack, ASOF);
    const b = planBundle(scope(), profile(), fakePack, ASOF);
    expect(a).toEqual(b);
  });

  it("apportions volume to exact scenario counts and builds one unit each", () => {
    const plan = planBundle(scope({ volume: 10 }), profile(), fakePack, ASOF);
    expect(plan.scenarioCounts).toEqual({ alpha: 6, beta: 4 });
    expect(plan.units).toHaveLength(10);
    expect(plan.units.filter((u) => u.scenario === "alpha")).toHaveLength(6);
  });

  it("samples a trait per variability dimension into each unit (deterministically)", () => {
    const plan = planBundle(scope(), profile(), fakePack, ASOF);
    for (const u of plan.units) {
      expect(["S", "L"]).toContain(u.traits.band);
      expect(u.traits.region).toBe("NA");
    }
  });

  it("clamps volume to the live record budget and flags it", () => {
    // recordBudget 20 / 4 per unit = max 5 units
    const plan = planBundle(scope({ volume: 50 }), profile({ recordBudget: 20 }), fakePack, ASOF);
    expect(plan.requestedVolume).toBe(50);
    expect(plan.volume).toBe(5);
    expect(plan.budgetCapped).toBe(true);
    expect(plan.units).toHaveLength(5);
  });

  it("rejects a scenario mix referencing unknown scenarios", () => {
    expect(() => planBundle(scope({ scenarioMix: { alpha: 50, ghost: 50 } }), profile(), fakePack, ASOF)).toThrow(/not in pack/);
  });

  it("resolves the Data Cloud branch from scope + profile", () => {
    const dcOrg = profile({ dataCloud: { licensed: true, available: true, evidence: "x", gateState: null, instrumentedLimits: false } });
    expect(planBundle(scope({ dc: "auto" }), dcOrg, fakePack, ASOF).withDc).toBe(true);
    expect(planBundle(scope({ dc: "off" }), dcOrg, fakePack, ASOF).withDc).toBe(false);
    expect(planBundle(scope({ dc: "on" }), profile(), fakePack, ASOF).withDc).toBe(true);
  });

  it("accepts a memorable string seed (hashed) and stays deterministic", () => {
    const a = planBundle(scope({ seed: "demo-q3" }), profile(), fakePack, ASOF);
    const b = planBundle(scope({ seed: "demo-q3" }), profile(), fakePack, ASOF);
    expect(a.seed).toBe(b.seed);
    expect(typeof a.seed).toBe("number");
  });
});

describe("generateBundle", () => {
  it("drives the pack and backfills actual per-object counts", () => {
    const plan = planBundle(scope({ volume: 8 }), profile(), fakePack, ASOF);
    const bundle = generateBundle(plan, profile(), fakePack);
    expect(bundle.records.Account).toHaveLength(8);
    expect(bundle.plan.perObjectCounts).toEqual({ Account: 8, Thing__c: 8 });
    expect(bundle.plan.estimatedRecords).toBe(16);
  });

  it("buildBundle (plan+generate) is deterministic", () => {
    expect(buildBundle(scope(), profile(), fakePack, ASOF)).toEqual(buildBundle(scope(), profile(), fakePack, ASOF));
  });
});

describe("plan-demo mix helpers", () => {
  it("parses a name:pct list (string or pre-split array)", () => {
    expect(parseMix("a:60,b:40")).toEqual({ a: 60, b: 40 });
    expect(parseMix(["a:60", "b:40"])).toEqual({ a: 60, b: 40 });
    expect(parseMix(undefined)).toBeUndefined();
    expect(() => parseMix("oops")).toThrow(/expected name:pct/);
  });

  it("defaults to an UNEVEN weighting over ALL scenarios, summing to 100", () => {
    const mix = defaultMix(["alpha", "beta", "gamma", "delta", "epsilon"]);
    // every scenario is covered (no more first-three slice that dropped two archetypes)…
    expect(Object.keys(mix)).toEqual(["alpha", "beta", "gamma", "delta", "epsilon"]);
    // …with the descending 30/25/20/15/10 curve…
    expect(mix).toEqual({ alpha: 30, beta: 25, gamma: 20, delta: 15, epsilon: 10 });
    // …and the ScenarioMix invariant (sums to 100) holds.
    expect(Object.values(mix).reduce((a, b) => a + b, 0)).toBe(100);
  });

  it("re-normalizes to sum to 100 for any scenario count (not just 5)", () => {
    for (const n of [1, 2, 3, 4, 6, 8]) {
      const scenarios = Array.from({ length: n }, (_, i) => `s${i}`);
      const mix = defaultMix(scenarios);
      expect(Object.keys(mix)).toHaveLength(n);
      expect(Object.values(mix).reduce((a, b) => a + b, 0)).toBe(100);
    }
    expect(defaultMix([])).toEqual({});
  });

  it("does NOT collapse a small volume into clean pairs — volume 6 over 5 scenarios → [2,1,1,1,1]", () => {
    // The regression the audit caught: an even first-three split apportioned volume 6 to [2,2,2], so two
    // of five archetypes never appeared and the sample read as a mechanical 2-2-2 split. The uneven default
    // must instead spread across ALL five, repeating only one.
    const scenarios = ["alpha", "beta", "gamma", "delta", "epsilon"];
    const pack: TargetPack = { ...fakePack, scenarios };
    const plan = planBundle(scope({ pack: "fake", volume: 6, scenarioMix: defaultMix(scenarios) }), profile(), pack, ASOF);
    const counts = scenarios.map((s) => plan.scenarioCounts[s] ?? 0);
    expect(counts).toEqual([2, 1, 1, 1, 1]);
    // all five archetypes present (none zero) — the anti-collapse guarantee.
    expect(counts.filter((c) => c > 0)).toHaveLength(5);
    expect(counts.reduce((a, b) => a + b, 0)).toBe(6);
  });
});
