// packs/salescloud/test/teardown-field-contract.test.ts
//
// A drift guard for packages/engine/src/load/teardown.ts: that module hardcodes the
// object/field pairs it queries to find a bundle's seeded records (Task.WhatId,
// Case.AccountId, ContentVersion.FirstPublishLocationId, CampaignMember.ContactId/LeadId, ...).
// teardown.ts's own unit tests use a hand-rolled mock, so a future rename of one of these
// _refs keys IN THE GENERATOR would keep that mock's tests green while teardown's real
// queryIds call silently matches zero rows in a live org — "0 matched" reads as a
// legitimate empty result, and the real records survive untouched. This test ties
// teardown's field assumptions to what the generator ACTUALLY emits, so a rename fails
// loudly here instead of orphaning data in a live org.

import { describe, it, expect } from "vitest";
import { CapabilityProfile, ScopeParams, type GenericRecord } from "@dataseed/core";
import { buildBundle } from "@dataseed/engine";
import { salescloudPack } from "../src/index.js";

const ASOF = "2026-06-17T00:00:00.000Z";
const profile = CapabilityProfile.parse({ org: "demo-org", capturedAt: ASOF });
// A dense mixed bundle — foreground (prior-win Case/Asset/ContentVersion) + bulk (Lead
// conversion, Event, CampaignMember) — so every object teardown.ts covers has a real record.
const scope = ScopeParams.parse({
  org: "demo-org",
  pack: "salescloud",
  volume: 3,
  population: 600,
  bulkDensity: 1,
  seed: "teardown-field-contract",
  scenarioMix: { "at-risk-budget": 34, "healthy-tech": 33, "rfp-gated": 33 },
});
const bundle = buildBundle(scope, profile, salescloudPack, ASOF);
const refs = (r: GenericRecord) => (r._refs ?? {}) as Record<string, string>;

describe("teardown.ts field assumptions match what the generator actually emits", () => {
  it("Account.Name / Lead.Email / Lead.Company are populated string fields", () => {
    expect(bundle.records.Account!.length).toBeGreaterThan(0);
    expect(bundle.records.Account!.every((a) => typeof a.Name === "string" && a.Name.length > 0)).toBe(true);
    expect(bundle.records.Lead!.length).toBeGreaterThan(0);
    expect(bundle.records.Lead!.every((l) => typeof l.Email === "string" && typeof l.Company === "string")).toBe(true);
  });

  it("a converting Lead has NO accountRef — Salesforce mints a new Account from Lead.Company (teardown must match on it)", () => {
    const converting = bundle.records.Lead!.filter((l) => (l._meta as { willConvert?: boolean } | undefined)?.willConvert);
    expect(converting.length).toBeGreaterThan(0);
    const conversions = bundle.directives?.convertLeads ?? [];
    expect(conversions.length).toBeGreaterThan(0);
    for (const c of conversions) expect(c.accountRef).toBeUndefined();
  });

  it("Opportunity._refs.AccountId and Contact._refs.AccountId point at Account", () => {
    expect(bundle.records.Opportunity!.every((o) => typeof refs(o).AccountId === "string")).toBe(true);
    expect(bundle.records.Contact!.every((c) => typeof refs(c).AccountId === "string")).toBe(true);
  });

  it("EmailMessage._refs.RelatedToId and ContentVersion._refs.FirstPublishLocationId point at Opportunity", () => {
    const oppRefs = new Set(bundle.records.Opportunity!.map((o) => o._ref));
    expect(bundle.records.EmailMessage!.length).toBeGreaterThan(0);
    expect(bundle.records.EmailMessage!.every((e) => oppRefs.has(refs(e).RelatedToId))).toBe(true);
    expect(bundle.records.ContentVersion!.length).toBeGreaterThan(0);
    expect(bundle.records.ContentVersion!.every((cv) => oppRefs.has(refs(cv).FirstPublishLocationId))).toBe(true);
  });

  it("Task._refs.WhatId and Event._refs.WhatId point at Opportunity", () => {
    const oppRefs = new Set(bundle.records.Opportunity!.map((o) => o._ref));
    expect(bundle.records.Task!.length).toBeGreaterThan(0);
    expect(bundle.records.Task!.every((t) => oppRefs.has(refs(t).WhatId))).toBe(true);
    expect(bundle.records.Event!.length).toBeGreaterThan(0);
    expect(bundle.records.Event!.every((e) => oppRefs.has(refs(e).WhatId))).toBe(true);
  });

  it("Case._refs.AccountId and Asset._refs.AccountId point at Account; CaseComment._refs.ParentId points at Case", () => {
    const acctRefs = new Set(bundle.records.Account!.map((a) => a._ref));
    expect(bundle.records.Case!.length).toBeGreaterThan(0);
    expect(bundle.records.Case!.every((c) => acctRefs.has(refs(c).AccountId))).toBe(true);
    expect(bundle.records.Asset!.length).toBeGreaterThan(0);
    expect(bundle.records.Asset!.every((a) => acctRefs.has(refs(a).AccountId))).toBe(true);
    const caseRefs = new Set(bundle.records.Case!.map((c) => c._ref));
    expect(bundle.records.CaseComment!.length).toBeGreaterThan(0);
    expect(bundle.records.CaseComment!.every((cc) => caseRefs.has(refs(cc).ParentId))).toBe(true);
  });

  it("every CampaignMember points at a Contact or a Lead via _refs.ContactId / _refs.LeadId (never both, never neither)", () => {
    const contactRefs = new Set(bundle.records.Contact!.map((c) => c._ref));
    const leadRefs = new Set(bundle.records.Lead!.map((l) => l._ref));
    expect(bundle.records.CampaignMember!.length).toBeGreaterThan(0);
    for (const cm of bundle.records.CampaignMember!) {
      const r = refs(cm);
      const hasContact = typeof r.ContactId === "string";
      const hasLead = typeof r.LeadId === "string";
      expect(hasContact !== hasLead).toBe(true); // exactly one
      if (hasContact) expect(contactRefs.has(r.ContactId)).toBe(true);
      if (hasLead) expect(leadRefs.has(r.LeadId)).toBe(true);
    }
  });

  it("Case._refs.AccountId is POSITIONALLY FIRST (the warehouse's parent_ref join column is the first _refs entry, not a keyed lookup — a reordered _refs literal would silently break every EXISTS-join predicate keyed on Case, e.g. select_accounts' 'churning' state)", () => {
    expect(bundle.records.Case!.length).toBeGreaterThan(0);
    for (const c of bundle.records.Case!) {
      const r = refs(c);
      expect(Object.keys(r)[0]).toBe("AccountId");
      expect(Object.values(r)[0]).toBe(r.AccountId);
    }
  });
});
