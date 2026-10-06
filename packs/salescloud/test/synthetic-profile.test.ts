import { describe, it, expect } from "vitest";
import { ScopeParams, standardProfile, SYNTHETIC_ORG } from "@dataseed/core";
import { buildBundle, planBundle } from "@dataseed/engine";
import { salescloudPack } from "../src/index.js";
import { SALESCLOUD_LOAD_ORDER } from "../src/schemas.js";

const ASOF = "2026-06-17T00:00:00.000Z";
const scope = (over: Record<string, unknown> = {}) =>
  ScopeParams.parse({ org: SYNTHETIC_ORG, pack: "salescloud", volume: 2, scenarioMix: { "at-risk-budget": 34, "healthy-tech": 33, "rfp-gated": 33 }, ...over });

describe("synthetic standard-org profile — generate with no live org", () => {
  it("marks every pack object present + writable, with no record budget and no Data Cloud", () => {
    const p = standardProfile(salescloudPack);
    expect(p.org).toBe(SYNTHETIC_ORG);
    expect(p.recordBudget).toBeUndefined(); // unlimited → the plan never clamps
    expect(p.dataCloud).toBeUndefined(); // off
    expect(p.namespacePrefix).toBeNull();
    const present = new Set(p.objects.filter((o) => o.present && o.blockedRequiredFields.length === 0).map((o) => o.apiName));
    for (const obj of SALESCLOUD_LOAD_ORDER) expect(present.has(obj)).toBe(true);
  });

  it("satisfies the pack's own requirements (no blocking)", () => {
    const reqs = salescloudPack.checkRequirements(standardProfile(salescloudPack));
    expect(reqs.filter((r) => r.severity === "blocking")).toHaveLength(0);
  });

  it("generates a LARGE bulk population without clamping — the org-agnostic corpus path", () => {
    const b = buildBundle(scope({ volume: 2, population: 3000, userPoolSize: 20 }), standardProfile(salescloudPack), salescloudPack, ASOF);
    expect(b.plan.population).toBe(3000); // unlimited budget → exactly what was asked, no clamp
    expect(b.plan.budgetCapped).toBe(false);
    expect(b.records.Account!.length).toBeGreaterThan(3000); // 3000 bulk + foreground
    expect(b.records.User!.length).toBe(20); // User present in the synthetic profile → pool resolves
    expect(b.records.Opportunity!.length).toBeGreaterThan(3000);
  });

  it("is deterministic — same seed → byte-identical against the synthetic profile", () => {
    const a = buildBundle(scope({ volume: 1, population: 500, seed: "syn" }), standardProfile(salescloudPack), salescloudPack, ASOF);
    const c = buildBundle(scope({ volume: 1, population: 500, seed: "syn" }), standardProfile(salescloudPack), salescloudPack, ASOF);
    expect(JSON.stringify(a.records)).toBe(JSON.stringify(c.records));
  });

  it("the planner respects the unlimited budget — population is never reduced", () => {
    const plan = planBundle(scope({ volume: 5, population: 100_000 }), standardProfile(salescloudPack), salescloudPack, ASOF);
    expect(plan.population).toBe(100_000); // a 100K request stands — no live-org budget to clamp it
    expect(plan.budgetCapped).toBe(false);
  });
});
