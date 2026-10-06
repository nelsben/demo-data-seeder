import { describe, it, expect } from "vitest";
import { ScopeParams, standardProfile, type GenericRecord } from "@dataseed/core";
import { buildBundle, buildWarehouseSlice, loadBundle, type LoadTarget, type InsertResult } from "@dataseed/engine";
import { WarehouseStore, corpusKey, GENERATOR_VERSION } from "@dataseed/warehouse";
import { salescloudPack } from "../src/index.js";

const ASOF = "2026-01-01T00:00:00.000Z";

/** Materialize a small real corpus into an in-memory warehouse (the warehouse→org bridge's read source). */
function materialize(over: Record<string, unknown> = {}) {
  const scope = ScopeParams.parse({ org: "standard", pack: "salescloud", volume: 1, population: 300, userPoolSize: 8, scenarioMix: { "at-risk-budget": 34, "healthy-tech": 33, "rfp-gated": 33 }, ...over });
  const b = buildBundle(scope, standardProfile(salescloudPack), salescloudPack, ASOF);
  const wh = new WarehouseStore(":memory:");
  const { paramsHash, cacheKey } = corpusKey(b.plan);
  const counts = wh.writeBundle({ dsId: "ds_test", pack: "salescloud", seed: b.plan.seed, paramsHash, generatorVersion: GENERATOR_VERSION, cacheKey }, b.records, ASOF);
  return { wh, counts };
}

/** A no-org LoadTarget: every field createable, inserts return fake Ids, nothing pre-exists (so no idempotency skip). */
function mockTarget(): LoadTarget {
  let n = 0;
  const everyField = { has: () => true } as unknown as Set<string>;
  return {
    org: "mock",
    async exists() { return true; },
    async createableFields() { return everyField; },
    async insert(obj, recs) { return recs.map((_, i): InsertResult => ({ success: true, id: `${obj.replace(/[^A-Za-z]/g, "").slice(0, 3)}${(n++).toString(36)}${i}`, errors: [] })); },
    async existingValues() { return new Set<string>(); },
    async queryIds() { return []; },
    async standardPricebookId() { return "01sMOCK0000000000"; },
    // A real org resolves @existing lookups (e.g. the User pool's ProfileId → the Standard User profile);
    // catalog objects (Product2/PricebookEntry) have no pre-existing twin here → empty → inserted fresh.
    async idsByField(sobject, _field, values) { return sobject === "Profile" ? new Map(values.map((v) => [v, `0PROF${v}`])) : new Map<string, string>(); },
    async idsByCompositeKey() { return new Map<string, string>(); },
    async convertLeads() { return []; },
    async deleteRecords() { return []; },
  };
}

describe("warehouse→org bridge — bounded account-rooted slice", () => {
  it("builds a bounded, referentially-CLOSED slice (scaffold wholesale, Account/Lead sliced, subtree by parent_ref)", () => {
    const { wh, counts } = materialize();
    const corpusTotal = Object.values(counts).reduce((a, b) => a + b, 0);
    const slice = buildWarehouseSlice(wh, "ds_test", salescloudPack.objects, counts, { accounts: 25, leads: 40 });

    // bounded — fewer accounts + fewer total records than the whole corpus
    expect(slice.stats.accounts).toBe(25);
    expect(slice.records.Account!.length).toBe(25);
    expect(slice.stats.totalRecords).toBeLessThan(corpusTotal);
    // the shared scaffold comes WHOLESALE (every subtree points at it)
    for (const o of ["Product2", "PricebookEntry", "Campaign"] as const) expect(slice.records[o]!.length).toBe(counts[o]);
    // Leads are the account-independent funnel top — sliced on their own count
    expect(slice.records.Lead!.length).toBe(40);
    // the subtree actually came along (children present, not just accounts)
    expect(slice.records.Contact!.length).toBeGreaterThan(25);
    expect((slice.records.Opportunity ?? []).length).toBeGreaterThan(0);

    // CLOSURE: every IN-CORPUS parent ref a slice record points at is itself present in the slice (no dangling
    // parent → loadBundle never skips for an unresolved parent). Sentinels/@existing/external targets (not a
    // corpus _ref) are allowed to be absent — the loader resolves those separately.
    const corpusRefs = new Set<string>();
    for (const o of salescloudPack.objects) for (const r of wh.readObject("ds_test", o)) if (typeof r._ref === "string") corpusRefs.add(r._ref);
    const sliceRefs = new Set<string>();
    for (const recs of Object.values(slice.records)) for (const r of recs) if (typeof r._ref === "string") sliceRefs.add(r._ref);
    const dangling: string[] = [];
    for (const recs of Object.values(slice.records)) {
      for (const r of recs) {
        const refs = { ...(r._refs as Record<string, string> | undefined), ...(r._softRefs as Record<string, string> | undefined) };
        for (const t of Object.values(refs)) if (typeof t === "string" && corpusRefs.has(t) && !sliceRefs.has(t)) dangling.push(`${r._ref ?? "(ref-less)"} → ${t}`);
      }
    }
    expect(dangling).toEqual([]);
    wh.close();
  });

  it("loads a slice into a (mock) org with every parent ref resolved — zero unresolved-parent skips", async () => {
    const { wh, counts } = materialize();
    const slice = buildWarehouseSlice(wh, "ds_test", salescloudPack.objects, counts, { accounts: 20, leads: 30 });
    const report = await loadBundle({ records: slice.records }, salescloudPack, mockTarget(), {});

    expect(report.totalInserted).toBeGreaterThan(0);
    // A referentially-closed slice ⇒ no record dropped for an unresolved PARENT. The only legitimate skips are
    // empty deferred-copy ContentVersion shells (foreground transcripts are unfilled in a no-fill-copy corpus —
    // VersionData is required, so the loader drops them rather than failing the row). Member-less CampaignMembers
    // are excluded by the slice, so they don't skip here either.
    const emptyCv = (slice.records.ContentVersion ?? []).filter((r) => !r.VersionData).length;
    const skipped = report.objects.reduce((a, o) => a + o.skipped, 0);
    expect(skipped).toBe(emptyCv); // exactly the empty CV shells — zero unresolved-parent skips
    // every object in the slice was present + fully inserted (mock org has every object/field), bar those skips
    for (const o of report.objects) {
      expect(o.present).toBe(true);
      expect(o.inserted + o.reused + o.skipped).toBe(o.attempted);
      if (o.object !== "ContentVersion") expect(o.skipped).toBe(0);
    }
    // the EAC layer (v18) rode along — the slice carried email threads + transcripts + typed tasks
    const objNames = new Set(report.objects.map((o) => o.object));
    for (const o of ["EmailMessage", "Task", "ContentVersion"]) expect(objNames.has(o)).toBe(true);
    wh.close();
  });

  it("every sliced CampaignMember has its MEMBER (Lead/Contact) in the slice — no member-less CMs at any leads count", () => {
    // Regression: foreground funnel CMs key parent_ref on their Campaign (scaffold), so parent_ref membership
    // alone pulled them into every slice while their LeadId dangled → "member id 'null'" on load. The slice now
    // enforces closure on the member ref. Assert it holds whether or not leads are sliced.
    const { wh, counts } = materialize();
    for (const leads of [0, 40]) {
      const slice = buildWarehouseSlice(wh, "ds_test", salescloudPack.objects, counts, { accounts: 20, leads });
      const incLeads = new Set((slice.records.Lead ?? []).map((r) => r._ref));
      const incContacts = new Set((slice.records.Contact ?? []).map((r) => r._ref));
      const cms = (slice.records.CampaignMember ?? []) as GenericRecord[];
      expect(cms.length).toBeGreaterThan(0); // contact-sourced CMs always present (the install-base engagement)
      for (const cm of cms) {
        const refs = (cm._refs as Record<string, string>) ?? {};
        const hasMember = (refs.ContactId && incContacts.has(refs.ContactId)) || (refs.LeadId && incLeads.has(refs.LeadId));
        expect(hasMember, `member-less CM (refs=${JSON.stringify(refs)}) at leads=${leads}`).toBeTruthy();
      }
    }
    wh.close();
  });

  it("the slice scales with --accounts and is deterministic (same N → same slice)", () => {
    const { wh, counts } = materialize();
    const small = buildWarehouseSlice(wh, "ds_test", salescloudPack.objects, counts, { accounts: 10, leads: 0 });
    const big = buildWarehouseSlice(wh, "ds_test", salescloudPack.objects, counts, { accounts: 50, leads: 0 });
    expect(small.records.Account!.length).toBe(10);
    expect(big.records.Account!.length).toBe(50);
    expect(big.stats.totalRecords).toBeGreaterThan(small.stats.totalRecords); // more accounts → more subtree
    expect(small.records.Lead).toBeUndefined(); // leads:0 → no funnel
    // deterministic: the first 10 accounts are the same set each call (emit order)
    const again = buildWarehouseSlice(wh, "ds_test", salescloudPack.objects, counts, { accounts: 10, leads: 0 });
    expect(JSON.stringify(again.records.Account)).toBe(JSON.stringify(small.records.Account));
    wh.close();
  });
});
