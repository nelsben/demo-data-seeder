import { describe, it, expect } from "vitest";
import { CapabilityProfile, ScopeParams, makeRng, type GenericRecord } from "@dataseed/core";
import { buildBundle, cascadeEstimate, excludeCascade } from "@dataseed/engine";
import { salescloudPack } from "../src/index.js";
import { makeCompanyNamer } from "../src/company-names.js";

const ASOF = "2026-06-17T00:00:00.000Z";
const profile = (over: Record<string, unknown> = {}) => CapabilityProfile.parse({ org: "demo-org", capturedAt: ASOF, ...over });
const scope = (over: Record<string, unknown> = {}) =>
  ScopeParams.parse({ org: "demo-org", pack: "salescloud", volume: 6, scenarioMix: { "at-risk-budget": 34, "healthy-tech": 33, "rfp-gated": 33 }, ...over });
const buildWith = (scopeOver: Record<string, unknown> = {}, profileOver: Record<string, unknown> = {}) =>
  buildBundle(scope(scopeOver), profile(profileOver), salescloudPack, ASOF);

const isBulk = (r: GenericRecord) => (r._meta as { tier?: string } | undefined)?.tier === "bulk";

describe("salescloud population tier — the scale knob", () => {
  it("defaults to 0 — no bulk tier, foreground deals unchanged", () => {
    const b = buildWith({ volume: 6 });
    expect(b.plan.population).toBe(0);
    expect(b.records.Account!).toHaveLength(6); // one per foreground unit
    expect(b.records.Account!.some(isBulk)).toBe(false);
  });

  it("adds bulk structural accounts on top of the foreground deals", () => {
    const b = buildWith({ volume: 4, population: 200 });
    expect(b.plan.population).toBe(200);
    expect(b.records.Account!.filter((a) => !isBulk(a))).toHaveLength(4);
    expect(b.records.Account!.filter(isBulk)).toHaveLength(200);
  });

  it("bulk accounts carry org-realistic fields (type, size, revenue, geography)", () => {
    const bulk = buildWith({ volume: 1, population: 120 }).records.Account!.filter(isBulk);
    for (const a of bulk.slice(0, 25)) {
      expect(typeof a.Name).toBe("string");
      expect(a.NumberOfEmployees as number).toBeGreaterThan(0);
      expect(a.AnnualRevenue as number).toBeGreaterThan(0);
      expect(typeof a.BillingCity).toBe("string");
      expect(typeof a.BillingCountry).toBe("string");
      expect(["Prospect", "Customer - Direct", "Customer - Channel", "Other"]).toContain(a.Type);
    }
  });

  it("bulk accounts add an INERT EAC activity layer (emails/transcripts/typed Tasks) without inflating the foreground cascade", () => {
    const base = buildWith({ volume: 5, seed: "s", population: 0 });
    const withBulk = buildWith({ volume: 5, seed: "s", population: 800 });
    // v18: bulk accounts NOW emit their own EAC email threads + ECI call transcripts (was: none at all).
    expect(withBulk.records.EmailMessage!.length).toBeGreaterThan(base.records.EmailMessage!.length);
    expect(withBulk.records.ContentVersion!.length).toBeGreaterThan(base.records.ContentVersion!.length);
    // …but they add NO FOREGROUND records — the non-bulk count of every cascade stream is unchanged by population.
    for (const obj of ["EmailMessage", "ContentVersion", "Task"] as const) {
      expect(withBulk.records[obj]!.filter((r) => !isBulk(r)).length).toBe(base.records[obj]!.length);
    }
    // The cascade blast radius does NOT grow with the bulk EAC layer — bulk records carry no CopyRequest, fire nothing.
    expect(cascadeEstimate(salescloudPack, withBulk.records).streamRecords).toBe(cascadeEstimate(salescloudPack, base.records).streamRecords);
    // Bulk Tasks now carry a valid EAC TaskSubtype (was: none); Call-subtype tasks carry the ECI telephony fields.
    const bulkTasks = withBulk.records.Task!.filter(isBulk);
    expect(bulkTasks.length).toBeGreaterThan(0);
    const SUBTYPES = new Set(["Task", "Email", "ListEmail", "Cadence", "Call", "LinkedIn"]);
    expect(bulkTasks.every((t) => SUBTYPES.has(t.TaskSubtype as string))).toBe(true);
    const calls = bulkTasks.filter((t) => t.TaskSubtype === "Call");
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every((t) => ["Internal", "Inbound", "Outbound"].includes(t.CallType as string) && typeof t.CallDurationInSeconds === "number")).toBe(true);
  });

  it("bulk opportunities follow a power-law distribution (not 1 deal per account)", () => {
    const b = buildWith({ volume: 1, population: 2500 });
    const counts = new Map<string, number>();
    for (const a of b.records.Account!.filter(isBulk)) counts.set(a._ref as string, 0);
    for (const o of b.records.Opportunity!.filter(isBulk)) {
      const acct = (o._refs as { AccountId: string }).AccountId;
      counts.set(acct, (counts.get(acct) ?? 0) + 1);
    }
    const vals = [...counts.values()];
    const zeroFrac = vals.filter((c) => c === 0).length / vals.length;
    const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
    expect(zeroFrac).toBeGreaterThan(0.2); // a real chunk are dormant (0 opps)
    expect(zeroFrac).toBeLessThan(0.5);
    expect(vals.some((c) => c >= 5)).toBe(true); // some accounts carry many
    expect(mean).toBeGreaterThan(0.8);
    expect(mean).toBeLessThan(3); // ≈1.7 expected
  });

  it("bulk opps span open / closed-won / closed-lost (lifecycle history)", () => {
    const states = new Set(buildWith({ volume: 1, population: 1500 }).records.Opportunity!.filter(isBulk).map((o) => (o._meta as { state?: string }).state));
    expect(states.has("open")).toBe(true);
    expect(states.has("won")).toBe(true);
    expect(states.has("lost")).toBe(true);
  });

  it("is fully deterministic (same seed → byte-identical bundle)", () => {
    const a = buildWith({ volume: 2, population: 400, seed: "z" });
    const b = buildWith({ volume: 2, population: 400, seed: "z" });
    expect(JSON.stringify(a.records)).toBe(JSON.stringify(b.records));
  });

  it("clamps population to the record budget left after foreground volume (density-aware)", () => {
    // budget 1000: volume 4 × 25 = 100 used; per-bulk-account = 17 structural + 0.6 density × 22 = 30.2
    // (the measured v22 coefficients), so ~900 / 30.2 ≈ 29 bulk accounts max. The clamp tracks bulkDensity.
    const b = buildWith({ volume: 4, population: 100_000 }, { recordBudget: 1000 });
    const bulkEstimate = 17 + 0.6 * 22; // default bulkDensity = 0.6 (matches pack.recordsPerPopulationUnit*)
    const maxBulk = Math.floor((1000 - 4 * 25) / bulkEstimate);
    expect(b.plan.population).toBe(maxBulk);
    expect(b.plan.budgetCapped).toBe(true);
    expect(b.records.Account!.filter(isBulk)).toHaveLength(maxBulk);
  });

  it("bulkDensity scales the wider graph — 0 = structural skeleton, higher = richer", () => {
    const structural = buildWith({ volume: 1, population: 300, seed: "d", bulkDensity: 0 });
    const rich = buildWith({ volume: 1, population: 300, seed: "d", bulkDensity: 1 });
    // At density 0 the optional families are absent; the skeleton (Account/Contact/Opp/primary OCR) stands.
    expect(structural.records.Task!.filter(isBulk)).toHaveLength(0);
    expect(structural.records.Event!.length).toBe(0);
    expect(structural.records.Case!.length).toBe(0);
    expect(structural.records.Asset!.length).toBe(0);
    expect(structural.records.EmailMessage!.filter(isBulk)).toHaveLength(0); // v18: the EAC layer respects density 0
    expect(structural.records.ContentVersion!.filter(isBulk)).toHaveLength(0);
    expect(structural.records.Account!.filter(isBulk)).toHaveLength(300);
    // At density 1 every optional family is populated, and there are more committee roles per opp.
    expect(rich.records.Task!.filter(isBulk).length).toBeGreaterThan(0);
    expect(rich.records.Event!.length).toBeGreaterThan(0);
    expect(rich.records.Case!.length).toBeGreaterThan(0);
    expect(rich.records.Asset!.length).toBeGreaterThan(0);
    expect(rich.records.EmailMessage!.filter(isBulk).length).toBeGreaterThan(0); // v18: emails + transcripts at density 1
    expect(rich.records.ContentVersion!.filter(isBulk).length).toBeGreaterThan(0);
    expect(rich.records.OpportunityContactRole!.filter(isBulk).length).toBeGreaterThanOrEqual(
      structural.records.OpportunityContactRole!.filter(isBulk).length,
    );
  });
});

describe("cascade safety — structural-only loads", () => {
  it("the pack declares its cascade-firing input streams", () => {
    expect(salescloudPack.cascadeObjects).toContain("EmailMessage");
    expect(salescloudPack.cascadeObjects).toContain("Task");
    expect(salescloudPack.cascadeObjects).toContain("ContentVersion");
  });

  it("excludeCascade drops the FIRING (foreground) streams but KEEPS the inert bulk EAC layer", () => {
    const b = buildWith({ volume: 5, population: 100 });
    // The foreground firing streams really exist before stripping (so the drop is real, not vacuous).
    expect(b.records.EmailMessage!.some((r) => !isBulk(r))).toBe(true);
    expect(b.records.ContentVersion!.some((r) => !isBulk(r))).toBe(true);
    const structural = excludeCascade(salescloudPack, b.records);
    // For every cascade object, NO foreground record survives; the survivors are exactly the inert bulk-tier ones.
    for (const o of ["EmailMessage", "ContentVersion", "Task"] as const) {
      const survivors = structural[o] ?? [];
      expect(survivors.every(isBulk)).toBe(true); // every foreground (firing) record is gone
      expect(survivors.length).toBe(b.records[o]!.filter(isBulk).length); // every inert bulk record is kept
    }
    expect(structural.Account!.length).toBe(b.records.Account!.length); // accounts (foreground + bulk) untouched
    expect(structural.Opportunity!.length).toBe(b.records.Opportunity!.length);
  });

  it("the cascade estimate scales with foreground streams, not bulk", () => {
    const small = cascadeEstimate(salescloudPack, buildWith({ volume: 3, population: 0 }).records);
    const big = cascadeEstimate(salescloudPack, buildWith({ volume: 3, population: 5000 }).records);
    expect(small.streamRecords).toBeGreaterThan(0);
    expect(big.streamRecords).toBe(small.streamRecords); // bulk adds ZERO cascade load
  });
});

describe("company namer — unique, deterministic, clean", () => {
  it("produces unique names across 50k indices (no collisions, no 'Div N')", () => {
    const namer = makeCompanyNamer(makeRng(1));
    const seen = new Set<string>();
    for (let i = 0; i < 50_000; i++) {
      const n = namer.name(i);
      expect(n).not.toMatch(/Div/);
      seen.add(n);
    }
    expect(seen.size).toBe(50_000);
  });

  it("is deterministic per seed and diverges across seeds", () => {
    const a = makeCompanyNamer(makeRng(1));
    const b = makeCompanyNamer(makeRng(1));
    const c = makeCompanyNamer(makeRng(2));
    expect(a.name(7)).toBe(b.name(7)); // same seed → same name
    let diff = 0;
    for (let i = 0; i < 100; i++) if (a.name(i) !== c.name(i)) diff++;
    expect(diff).toBeGreaterThan(90); // different seed → different permutation
  });

  it("scatters consecutive indices (no alphabetical lockstep)", () => {
    const namer = makeCompanyNamer(makeRng(42));
    expect(namer.name(0)).not.toBe(namer.name(1));
    expect(namer.domain(0)).toMatch(/^[a-z0-9]+\.com$/);
  });
});
