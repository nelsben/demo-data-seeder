import { describe, it, expect } from "vitest";
import { ScopeParams, standardProfile, STANDARD_PRICEBOOK_REF, EXISTING_REF_PREFIX, type GenericRecord, type BundleRecords } from "@dataseed/core";
import { buildBundle } from "@dataseed/engine";
import { salescloudPack } from "../src/index.js";

// A DATA-QUALITY audit (distinct from the structural/determinism tests): generate a rich corpus and prove
// every record would LOAD CLEAN into Salesforce — there is NO picklist conformance at load, so the data
// must be valid BY CONSTRUCTION. This is the "will it function" guard.
const ASOF = "2026-01-01T00:00:00.000Z";
const richCorpus = (): BundleRecords =>
  buildBundle(
    ScopeParams.parse({
      org: "standard", pack: "salescloud", volume: 6, population: 1500, bulkDensity: 1, userPoolSize: 20,
      scenarioMix: { "at-risk-budget": 34, "healthy-tech": 33, "rfp-gated": 33 },
    }),
    standardProfile(salescloudPack), salescloudPack, ASOF,
  ).records;

const allRecords = (records: BundleRecords): Array<[string, GenericRecord]> =>
  Object.entries(records).flatMap(([obj, recs]) => (recs ?? []).map((r) => [obj, r] as [string, GenericRecord]));
const refsOf = (r: GenericRecord) => ({ ...(r._refs as Record<string, string> | undefined), ...(r._softRefs as Record<string, string> | undefined) });

describe("corpus data-quality audit — would it load clean into Salesforce?", () => {
  const records = richCorpus();
  const objectsPresent = Object.entries(records).filter(([, r]) => (r?.length ?? 0) > 0).map(([o]) => o);

  it(`generated a rich multi-object corpus (${"sanity"})`, () => {
    expect(objectsPresent.length).toBeGreaterThan(12); // accounts→…→cases/assets/comments all present
    expect(records.Account!.length).toBeGreaterThan(1500);
  });

  it("EVERY restricted-picklist value is valid (no conformance at load → must be valid by construction)", () => {
    const picklists = salescloudPack.picklists as Record<string, readonly string[]>;
    const violations: string[] = [];
    for (const [key, valid] of Object.entries(picklists)) {
      const dot = key.indexOf(".");
      const obj = key.slice(0, dot), field = key.slice(dot + 1);
      for (const rec of records[obj] ?? []) {
        const v = rec[field];
        if (v != null && !valid.includes(v as string)) violations.push(`${key}="${String(v)}"`);
      }
    }
    expect(violations.slice(0, 20)).toEqual([]); // first 20 offenders if any
  });

  // The loader (loader.ts:77-87) has TWO outcomes for a hard `_refs` target:
  //   (a) target is an in-bundle ref or `@existing:` sentinel → must resolve, else the record SKIPS (loss);
  //   (b) target is a raw external value (neither) → the FIELD is dropped, the record is KEPT.
  // The salescloud pack uses only (a): every hard ref resolves to an in-bundle record, the standard
  // pricebook, or an `@existing:` org record (catalog/user-pool). Assert NO raw-external hard ref exists
  // (a new one would silently drop a field at load and must be a conscious choice).
  it("EVERY hard ref (_refs) resolves to an in-bundle record, the standard pricebook, or an @existing org ref (no silent loss)", () => {
    const known = new Set<string>();
    for (const [, r] of allRecords(records)) if (r._ref) known.add(r._ref as string);
    const resolves = (t: string) => known.has(t) || t === STANDARD_PRICEBOOK_REF || t.startsWith(EXISTING_REF_PREFIX);
    const danglingHard: string[] = [];
    for (const [obj, r] of allRecords(records)) {
      for (const [f, t] of Object.entries((r._refs as Record<string, string> | undefined) ?? {})) {
        if (!resolves(t)) danglingHard.push(`${obj}.${f} → ${t}`);
      }
    }
    expect(danglingHard.slice(0, 20)).toEqual([]);
  });

  it("soft refs (_softRefs) resolve too (a dangling soft ref drops the field — tolerable but unintended)", () => {
    const known = new Set<string>();
    for (const [, r] of allRecords(records)) if (r._ref) known.add(r._ref as string);
    const resolves = (t: string) => known.has(t) || t === STANDARD_PRICEBOOK_REF || t.startsWith(EXISTING_REF_PREFIX);
    const danglingSoft: string[] = [];
    for (const [obj, r] of allRecords(records)) {
      for (const [f, t] of Object.entries((r._softRefs as Record<string, string> | undefined) ?? {})) {
        if (!resolves(t)) danglingSoft.push(`${obj}.${f} → ${t}`);
      }
    }
    expect(danglingSoft.slice(0, 20)).toEqual([]);
  });

  it("required-on-insert fields are present on every record (else INSERT fails)", () => {
    const missing: string[] = [];
    const need = (obj: string, fields: string[], refs: string[] = []) => {
      for (const r of records[obj] ?? []) {
        const rf = refsOf(r);
        for (const f of fields) if (r[f] == null || r[f] === "") missing.push(`${obj}.${f}`);
        for (const ref of refs) if (rf[ref] == null) missing.push(`${obj}._refs.${ref}`);
      }
    };
    need("Account", ["Name"]);
    need("Contact", ["LastName"], ["AccountId"]);
    need("Opportunity", ["Name", "StageName", "CloseDate"], ["AccountId"]);
    need("Lead", ["LastName", "Company"]);
    need("OpportunityContactRole", [], ["OpportunityId", "ContactId"]);
    need("Asset", ["Name"]);
    need("User", ["Username", "LastName", "Email", "Alias"], ["ProfileId"]);
    need("UserRole", ["Name", "DeveloperName"]);
    // dedupe (only the field name matters, not the count)
    expect([...new Set(missing)]).toEqual([]);
  });

  it("typed fields are well-formed (Amount numeric, CloseDate an ISO date — wrong types red the load)", () => {
    const bad: string[] = [];
    for (const o of records.Opportunity ?? []) {
      if (o.Amount != null && (typeof o.Amount !== "number" || !Number.isFinite(o.Amount as number))) bad.push(`Opportunity.Amount=${String(o.Amount)}`);
      if (typeof o.CloseDate !== "string" || !/^\d{4}-\d{2}-\d{2}/.test(o.CloseDate as string)) bad.push(`Opportunity.CloseDate=${String(o.CloseDate)}`);
    }
    for (const li of records.OpportunityLineItem ?? []) {
      if (li.Quantity != null && typeof li.Quantity !== "number") bad.push(`OpportunityLineItem.Quantity=${String(li.Quantity)}`);
    }
    expect(bad.slice(0, 20)).toEqual([]);
  });
});
