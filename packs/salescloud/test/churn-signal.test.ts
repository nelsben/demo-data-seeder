import { describe, it, expect } from "vitest";
import { CapabilityProfile, ScopeParams, type GenericRecord } from "@dataseed/core";
import { buildBundle } from "@dataseed/engine";
import { salescloudPack } from "../src/index.js";

// v28 churn signal — the churning-account scenario emits an Escalated support Case grounded in the renewal risk.
// The golden mix has NO churning-account unit, so this dedicated fixture is what protects the feature.
const ASOF = "2026-06-17T00:00:00.000Z";
const profile = () => CapabilityProfile.parse({ org: "demo-org", capturedAt: ASOF });
const churnMix = (over: Record<string, unknown> = {}) =>
  buildBundle(ScopeParams.parse({ org: "demo-org", pack: "salescloud", volume: 6, scenarioMix: { "churning-account": 100 }, ...over }), profile(), salescloudPack, ASOF);
const churnCases = (b: ReturnType<typeof churnMix>) => b.records.Case!.filter((c) => (c._meta as { churn?: boolean }).churn);

describe("v28 churn signal — Escalated Case on an at-risk renewal", () => {
  const b = churnMix();

  it("every churning account gets one Escalated/High churn Case, tied to the account + its champion", () => {
    const cases = churnCases(b);
    expect(cases.length).toBe(b.records.Account!.length); // one per churning account
    for (const c of cases) {
      expect(c.Status).toBe("Escalated");
      expect(c.Priority).toBe("High");
      expect((c._refs as Record<string, string>).AccountId).toMatch(/^acct-/);
      expect((c._refs as Record<string, string>).ContactId).toMatch(/^contact-/); // the champion advocate
    }
  });

  it("the Description is GROUNDED — the landed product + a varied renewal window, not a boilerplate verdict", () => {
    for (const c of churnCases(b)) {
      const d = c.Description as string;
      expect(d).toMatch(/renewal/i);
      expect(d).toMatch(/Platform License/); // the actual landed product (PRODUCTS[0])
      expect(d).toMatch(/~\d+ days/); // the varied 20–75d window (not a fixed "5 days before" metronome)
      expect(d).not.toMatch(/health:\s*at risk/i); // no verdict-string tell
    }
    // varied across accounts (not identical prose)
    expect(new Set(churnCases(b).map((c) => c.Description as string)).size).toBeGreaterThan(1);
  });

  it("the escalation reporter is never the economic buyer (a CFO doesn't escalate a renewal risk to themselves)", () => {
    for (const c of churnCases(b)) {
      const aid = (c._refs as Record<string, string>).AccountId;
      const cast = b.records.Contact!.filter((ct) => (ct._refs as Record<string, string>).AccountId === aid);
      const eb = cast.find((ct) => (ct._meta as { persona?: string }).persona === "Economic Buyer");
      if (eb && cast.length > 1) expect((c._refs as Record<string, string>).ContactId).not.toBe(eb._ref);
    }
  });

  it("is SCENARIO-gated — a healthy-tech mix produces NO churn Case (never mis-fires on a healthy renewal)", () => {
    const healthy = churnMix({ scenarioMix: { "healthy-tech": 100 } });
    expect(churnCases(healthy)).toEqual([]);
  });

  it("does not disturb the prior-win support Cases (they stay _meta.prior, Working/Closed — not Escalated)", () => {
    const prior = b.records.Case!.filter((c) => (c._meta as { prior?: boolean }).prior);
    expect(prior.length).toBeGreaterThan(0);
    for (const c of prior) expect(c.Status).not.toBe("Escalated");
  });

  it("determinism: same seed → byte-identical churn Cases", () => {
    expect(JSON.stringify(churnCases(churnMix()))).toBe(JSON.stringify(churnCases(b)));
  });
});
