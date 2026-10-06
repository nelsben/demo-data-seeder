import { describe, it, expect } from "vitest";
import { GenericRecord, NarrativeBundle, existingRef, type TargetPack, type BundleRecords } from "@dataseed/core";
import { collectRefs, collectExistingRefs, resolveRecord, filterExisting, loadBundle, referencesSentinel, STANDARD_PRICEBOOK_REF } from "../src/load/loader.js";
import type { LoadTarget, InsertResult } from "../src/load/connection.js";

// ── A mock LoadTarget (no org) ───────────────────────────────────────────────
class MockLoadTarget implements LoadTarget {
  org = "mock";
  inserted: Record<string, Array<Record<string, unknown>>> = {};
  private id = 0;
  constructor(
    private cfg: {
      objects: Record<string, Set<string>>; // present object → createable fields
      existing?: Record<string, Set<string>>; // "Object.Field" → existing values
      fail?: (obj: string, i: number) => boolean; // per-row DML failure
      throwOn?: Set<string>; // request-level rejection for an object (transport error)
      standardPricebook?: string | null; // resolved standard-Pricebook2 Id (null = no pricebook in org)
      existingIds?: Record<string, Map<string, string>>; // "Object.Field" → value→Id (existing catalog for upsert)
      existingComposite?: Record<string, Map<string, string>>; // "Object" → NUL-joined-tuple→Id (existing composite catalog)
    },
  ) {}
  async exists(o: string) {
    return o in this.cfg.objects;
  }
  async createableFields(o: string) {
    return this.cfg.objects[o] ?? new Set<string>();
  }
  async insert(o: string, recs: Array<Record<string, unknown>>): Promise<InsertResult[]> {
    if (this.cfg.throwOn?.has(o)) throw new Error(`INVALID_SESSION_ID: the session is invalid`);
    this.inserted[o] = (this.inserted[o] ?? []).concat(recs);
    return recs.map((_r, i) =>
      this.cfg.fail?.(o, i) ? { success: false, errors: ["DUPLICATE_VALUE: boom"] } : { success: true, id: `${o.slice(0, 3)}-${this.id++}`, errors: [] },
    );
  }
  async existingValues(o: string, field: string, values: string[]) {
    const set = this.cfg.existing?.[`${o}.${field}`] ?? new Set<string>();
    return new Set(values.filter((v) => set.has(v)));
  }
  async queryIds(_o: string, _whereField: string, _values: string[]) {
    return [] as string[];
  }
  async standardPricebookId() {
    return this.cfg.standardPricebook ?? null;
  }
  async idsByField(o: string, field: string, values: string[]) {
    const map = this.cfg.existingIds?.[`${o}.${field}`] ?? new Map<string, string>();
    return new Map(values.filter((v) => map.has(v)).map((v) => [v, map.get(v)!]));
  }
  async idsByCompositeKey(o: string, _fields: readonly string[], rows: string[][]) {
    const map = this.cfg.existingComposite?.[o] ?? new Map<string, string>();
    const out = new Map<string, string>();
    for (const row of rows) {
      const key = row.join("\u0000");
      if (map.has(key)) out.set(key, map.get(key)!);
    }
    return out;
  }
  converted: Array<{ leadId: string }> = [];
  async convertLeads(conversions: Array<{ leadId: string; doNotCreateOpportunity?: boolean }>) {
    this.converted.push(...conversions);
    return conversions.map((c, i) => ({
      success: true,
      leadId: c.leadId,
      accountId: `001CONV${i}`,
      contactId: `003CONV${i}`,
      opportunityId: c.doNotCreateOpportunity ? undefined : `006CONV${i}`,
      errors: [] as string[],
    }));
  }
  async deleteRecords(_o: string, ids: string[]) {
    return ids.map(() => ({ success: true, errors: [] as string[] }));
  }
  updated: Record<string, Array<Record<string, unknown>>> = {};
  async update(o: string, recs: Array<Record<string, unknown>>): Promise<InsertResult[]> {
    this.updated[o] = (this.updated[o] ?? []).concat(recs);
    return recs.map((r, i) => (this.cfg.fail?.(o, i) ? { success: false, errors: ["UPDATE boom"] } : { success: true, id: String(r.Id), errors: [] }));
  }
}

const fakePack: TargetPack = {
  id: "fake",
  label: "Fake",
  description: "test",
  objects: ["Account", "Contact", "Opportunity", "Signal_Event__c"],
  picklists: {},
  scenarios: ["s"],
  recordSchemas: { Account: GenericRecord, Contact: GenericRecord, Opportunity: GenericRecord, Signal_Event__c: GenericRecord },
  variability: {},
  recordsPerUnitEstimate: 1,
  checkRequirements: () => [],
  generate: () => ({ records: {} }),
};

const records: BundleRecords = {
  Account: [
    { _ref: "a0", Name: "Stripe", Industry: "Finance", _meta: { x: 1 } },
    { _ref: "a1", Name: "Snowflake", Industry: "Technology" },
  ],
  Contact: [
    { _ref: "c0", _refs: { AccountId: "a0" }, LastName: "Reyes" },
    { _ref: "c1", _refs: { AccountId: "a1" }, LastName: "Chen" },
  ],
  Opportunity: [{ _ref: "o0", _refs: { AccountId: "a0", Custom_Framework__c: "MEDDPICC_V1" }, Name: "Stripe Deal", StageName: "Prospecting" }],
  Signal_Event__c: [{ _ref: "d0", _refs: { Source_Record_Id__c: "o0" }, Signal_Summary__c: "x" }],
};

const bundle = NarrativeBundle.parse({
  records,
  plan: { pack: "fake", mode: "inputs", withDc: false, seed: 1, asOf: "2026-06-17T00:00:00.000Z", requestedVolume: 2, volume: 2 },
});

const standardOrg = () =>
  new MockLoadTarget({
    objects: {
      Account: new Set(["Name", "Industry"]),
      Contact: new Set(["AccountId", "LastName"]),
      Opportunity: new Set(["AccountId", "Name", "StageName"]), // NOTE: no Custom_Framework__c (a custom lookup this org does not have)
      // Signal_Event__c intentionally absent
    },
  });

describe("collectRefs", () => {
  it("gathers every in-bundle _ref", () => {
    expect(collectRefs(records)).toEqual(new Set(["a0", "a1", "c0", "c1", "o0", "d0"]));
  });
});

describe("resolveRecord", () => {
  const allRefs = collectRefs(records);
  it("strips _meta, keeps only createable fields, resolves an in-bundle parent to its Id", () => {
    const r = resolveRecord(records.Contact![0]!, allRefs, new Map([["a0", "001X"]]), new Set(["AccountId", "LastName"]));
    expect(r.skip).toBe(false);
    expect(r.payload).toEqual({ LastName: "Reyes", AccountId: "001X" });
  });
  it("skips when an in-bundle parent isn't inserted yet", () => {
    const r = resolveRecord(records.Contact![0]!, allRefs, new Map(), new Set(["AccountId", "LastName"]));
    expect(r.skip).toBe(true);
    expect(r.skipReason).toMatch(/unresolved parent AccountId/);
  });
  it("drops an external ref (not an in-bundle _ref) and non-createable base fields", () => {
    const r = resolveRecord(records.Opportunity![0]!, allRefs, new Map([["a0", "001X"]]), new Set(["AccountId", "Name", "StageName"]));
    expect(r.payload).toEqual({ Name: "Stripe Deal", StageName: "Prospecting", AccountId: "001X" });
    expect(r.droppedFields).toContain("Custom_Framework__c"); // external + not a field here
  });

  it("resolves a SOFT ref when available — sets the field", () => {
    const rec = { _ref: "opp", _softRefs: { Pricebook2Id: STANDARD_PRICEBOOK_REF }, Name: "Deal" };
    const refToId = new Map([[STANDARD_PRICEBOOK_REF, "01s-STD"]]);
    const r = resolveRecord(rec, new Set([STANDARD_PRICEBOOK_REF]), refToId, new Set(["Name", "Pricebook2Id"]));
    expect(r.skip).toBe(false);
    expect(r.payload).toEqual({ Name: "Deal", Pricebook2Id: "01s-STD" });
  });

  it("DROPS a soft ref when unresolved but KEEPS the record (vs a hard ref, which would skip it)", () => {
    const rec = { _ref: "opp", _softRefs: { Pricebook2Id: STANDARD_PRICEBOOK_REF }, Name: "Deal" };
    const r = resolveRecord(rec, new Set(), new Map(), new Set(["Name", "Pricebook2Id"]));
    expect(r.skip).toBe(false); // record survives
    expect(r.payload).toEqual({ Name: "Deal" }); // Pricebook2Id dropped
    expect(r.droppedFields).toContain("Pricebook2Id");
  });

  it("Phase 4F — an unresolved OwnerId soft ref drops to running-user without skipping the Account (the pool fail-soft)", () => {
    // The bulk Account points OwnerId at a pool user; if the pool never seated (license-blocked), user-3
    // is unresolved → OwnerId drops and Salesforce defaults the owner to the running user. The Account stays.
    const acct = { _ref: "bulk-acct-3", _softRefs: { OwnerId: "user-3" }, Name: "Acme" };
    const r = resolveRecord(acct, new Set(), new Map(), new Set(["Name", "OwnerId"]));
    expect(r.skip).toBe(false); // the whole account subtree is NOT lost
    expect(r.payload).toEqual({ Name: "Acme" }); // owner omitted → running user owns it
    expect(r.droppedFields).toContain("OwnerId");
  });

  it("HARD-skips a record whose sentinel _refs target is unresolved (PricebookEntry needs its pricebook)", () => {
    const rec = { _ref: "pbe", _refs: { Pricebook2Id: STANDARD_PRICEBOOK_REF }, UnitPrice: 100 };
    const r = resolveRecord(rec, new Set([STANDARD_PRICEBOOK_REF]), new Map(), new Set(["UnitPrice", "Pricebook2Id"]));
    expect(r.skip).toBe(true);
    expect(r.skipReason).toMatch(/unresolved parent Pricebook2Id/);
  });
});

describe("referencesSentinel", () => {
  it("detects a sentinel in either _refs or _softRefs, and is false otherwise", () => {
    const hard: BundleRecords = { PricebookEntry: [{ _refs: { Pricebook2Id: STANDARD_PRICEBOOK_REF } }] };
    const soft: BundleRecords = { Opportunity: [{ _softRefs: { Pricebook2Id: STANDARD_PRICEBOOK_REF } }] };
    expect(referencesSentinel(hard, STANDARD_PRICEBOOK_REF)).toBe(true);
    expect(referencesSentinel(soft, STANDARD_PRICEBOOK_REF)).toBe(true);
    expect(referencesSentinel({ Account: [{ Name: "x" }] }, STANDARD_PRICEBOOK_REF)).toBe(false);
  });
});

describe("filterExisting (lineage idempotency)", () => {
  it("skips an existing root Account and cascade-skips its whole subtree (incl. grandchildren)", () => {
    const { filtered, skipped } = filterExisting(records, fakePack.objects, collectRefs(records), { object: "Account", field: "Name" }, new Set(["Stripe"]));
    expect(filtered.Account!.map((a) => a.Name)).toEqual(["Snowflake"]);
    expect(filtered.Contact!.map((c) => c._ref)).toEqual(["c1"]); // c0 (under Stripe) gone
    expect(filtered.Opportunity).toHaveLength(0); // o0 (under Stripe) gone
    expect(filtered.Signal_Event__c).toHaveLength(0); // d0 → o0 → Stripe, cascade-skipped
    expect(skipped).toBe(4); // a0, c0, o0, d0
  });
});

describe("loadBundle", () => {
  it("inserts in load order, resolving child lookups to inserted Ids", async () => {
    const t = standardOrg();
    const report = await loadBundle(bundle, fakePack, t);
    expect(report.totalInserted).toBe(5); // 2 Account + 2 Contact + 1 Opp (Signal_Event__c absent)
    // Contact[0].AccountId === the Id assigned to Account a0
    const a0Id = (t.inserted.Account![0] as { Name: string }).Name === "Stripe" ? "Acc-0" : "Acc-1";
    expect((t.inserted.Contact!.find((c) => (c as { LastName: string }).LastName === "Reyes") as { AccountId: string }).AccountId).toBe(a0Id);
  });

  it("post-insert self-lookup: links Contact.ReportsToId to a same-batch sibling's Id (dropped at insert, wired in pass 2)", async () => {
    const t = new MockLoadTarget({ objects: { Contact: new Set(["LastName", "ReportsToId"]) } });
    const b = {
      records: {
        Contact: [
          { _ref: "boss", LastName: "Vega" },
          { _ref: "report", LastName: "Cole", _softRefs: { ReportsToId: "boss" } },
        ],
      },
    };
    const report = await loadBundle(b as never, { ...fakePack, objects: ["Contact"] }, t);
    expect(report.totalInserted).toBe(2);
    // DROPPED at insert — the sibling's Id isn't known within the single batch
    expect(t.inserted.Contact!.find((c) => (c as { LastName: string }).LastName === "Cole")).not.toHaveProperty("ReportsToId");
    // WIRED in the second pass: report (Con-1) → boss (Con-0)
    expect(t.updated.Contact).toEqual([{ Id: "Con-1", ReportsToId: "Con-0" }]);
    const sl = report.selfLookups?.find((s) => s.object === "Contact");
    expect(sl).toMatchObject({ attempted: 1, linked: 1, fields: ["ReportsToId"] });
  });

  it("self-lookup pass is skipped cleanly when the target has no update() (field stays unset, no throw)", async () => {
    const t = new MockLoadTarget({ objects: { Contact: new Set(["LastName", "ReportsToId"]) } });
    (t as { update?: unknown }).update = undefined; // a target without the optional capability
    const b = { records: { Contact: [{ _ref: "boss", LastName: "Vega" }, { _ref: "r", LastName: "Cole", _softRefs: { ReportsToId: "boss" } }] } };
    const report = await loadBundle(b as never, { ...fakePack, objects: ["Contact"] }, t);
    expect(report.totalInserted).toBe(2);
    expect(report.selfLookups).toBeUndefined();
  });

  it("reports an object the org lacks as present:false (and skips it)", async () => {
    const report = await loadBundle(bundle, fakePack, standardOrg());
    const ds = report.objects.find((o) => o.object === "Signal_Event__c");
    expect(ds?.present).toBe(false);
    expect(ds?.attempted).toBe(1);
  });

  it("drops fields the org doesn't have (Custom_Framework__c) without failing the row", async () => {
    const t = standardOrg();
    await loadBundle(bundle, fakePack, t);
    expect(t.inserted.Opportunity![0]).not.toHaveProperty("Custom_Framework__c");
  });

  it("is additively idempotent — existing Account + subtree skipped", async () => {
    const t = new MockLoadTarget({
      objects: { Account: new Set(["Name", "Industry"]), Contact: new Set(["AccountId", "LastName"]), Opportunity: new Set(["AccountId", "Name", "StageName"]) },
      existing: { "Account.Name": new Set(["Stripe"]) },
    });
    const report = await loadBundle(bundle, fakePack, t, { idempotency: { object: "Account", field: "Name" } });
    expect(report.idempotencySkipped).toBe(4); // a0, c0, o0, d0 (Stripe subtree)
    expect(report.totalInserted).toBe(2); // only Snowflake + its contact
    expect(t.inserted.Account!.map((a) => (a as { Name: string }).Name)).toEqual(["Snowflake"]);
  });

  it("upserts the shared catalog — reuses an existing Product2/PricebookEntry and remaps refs", async () => {
    const catalogPack: TargetPack = {
      ...fakePack,
      objects: ["Product2", "PricebookEntry", "OpportunityLineItem"],
      recordSchemas: { Product2: GenericRecord, PricebookEntry: GenericRecord, OpportunityLineItem: GenericRecord },
      catalog: [
        { object: "Product2", keyField: "ProductCode" },
        { object: "PricebookEntry", keyByRef: "Product2Id" },
      ],
    };
    const catalogBundle = NarrativeBundle.parse({
      plan: { pack: "fake", mode: "inputs", withDc: false, seed: 1, asOf: "2026-06-17T00:00:00.000Z", requestedVolume: 1, volume: 1 },
      records: {
        Product2: [
          { _ref: "product-0", Name: "Core", ProductCode: "PLAT-CORE", IsActive: true },
          { _ref: "product-1", Name: "API", ProductCode: "PLAT-API", IsActive: true },
        ],
        PricebookEntry: [
          { _ref: "pbe-0", _refs: { Product2Id: "product-0", Pricebook2Id: STANDARD_PRICEBOOK_REF }, UnitPrice: 1000, IsActive: true },
          { _ref: "pbe-1", _refs: { Product2Id: "product-1", Pricebook2Id: STANDARD_PRICEBOOK_REF }, UnitPrice: 2000, IsActive: true },
        ],
        OpportunityLineItem: [
          { _refs: { PricebookEntryId: "pbe-0" }, Quantity: 1, UnitPrice: 1000 },
          { _refs: { PricebookEntryId: "pbe-1" }, Quantity: 1, UnitPrice: 2000 },
        ],
      },
    });
    const t = new MockLoadTarget({
      objects: {
        Product2: new Set(["Name", "ProductCode", "IsActive"]),
        PricebookEntry: new Set(["Product2Id", "Pricebook2Id", "UnitPrice", "IsActive"]),
        OpportunityLineItem: new Set(["PricebookEntryId", "Quantity", "UnitPrice"]),
      },
      standardPricebook: "01s-std",
      existingIds: {
        "Product2.ProductCode": new Map([["PLAT-CORE", "prd-existing-0"]]), // PLAT-CORE already in the org
        "PricebookEntry.Product2Id": new Map([["prd-existing-0", "pbe-existing-0"]]), // …with its PBE
      },
    });
    const report = await loadBundle(catalogBundle, catalogPack, t);
    const p2 = report.objects.find((o) => o.object === "Product2")!;
    const pbe = report.objects.find((o) => o.object === "PricebookEntry")!;
    expect([p2.reused, p2.inserted]).toEqual([1, 1]); // PLAT-CORE reused, PLAT-API inserted
    expect([pbe.reused, pbe.inserted]).toEqual([1, 1]); // the reused product's PBE reused, the new one's inserted
    expect((t.inserted.Product2 ?? []).map((r) => (r as { ProductCode: string }).ProductCode)).toEqual(["PLAT-API"]); // only the missing product inserted
    // the line item on the reused product resolved to the EXISTING pricebook entry — no duplicate
    const oliOnReused = t.inserted.OpportunityLineItem!.find((r) => (r as { UnitPrice: number }).UnitPrice === 1000) as { PricebookEntryId: string };
    expect(oliOnReused.PricebookEntryId).toBe("pbe-existing-0");
  });

  // ── @existing refs + composite-key catalog (the §0 adapter-rule foundation) ──────────────────
  const rulePack: TargetPack = {
    ...fakePack,
    objects: ["Mapping_Rule__c"],
    recordSchemas: { Mapping_Rule__c: GenericRecord },
    catalog: [{ object: "Mapping_Rule__c", keyFields: ["Name", "Source_Adapter_Class__c"] }],
  };
  const fwRef = existingRef("Custom_Framework__c", "External_Id__c", "MEDDPICC_V1");
  const ruleBundle = () =>
    NarrativeBundle.parse({
      plan: { pack: "fake", mode: "inputs", withDc: false, seed: 1, asOf: "2026-06-17T00:00:00.000Z", requestedVolume: 1, volume: 1 },
      records: {
        Mapping_Rule__c: [
          { Name: "Metrics", Source_Adapter_Class__c: "ActivityNormalizer", Source_Type__c: "Content_Extraction", Is_Active__c: true, _refs: { Custom_Framework__c: fwRef, Concept_Library__c: existingRef("Concept_Library__c", "Name", "FINANCIAL_SIGNAL") } },
          { Name: "Champion", Source_Adapter_Class__c: "ActivityNormalizer", Source_Type__c: "Content_Extraction", Is_Active__c: true, _refs: { Custom_Framework__c: fwRef, Concept_Library__c: existingRef("Concept_Library__c", "Name", "AUTHORITY_SIGNAL") } },
        ],
      },
    });
  const ruleOrgObjects = { Mapping_Rule__c: new Set(["Name", "Source_Adapter_Class__c", "Source_Type__c", "Is_Active__c", "Custom_Framework__c", "Concept_Library__c"]) };
  const conceptsInOrg = new Map([["FINANCIAL_SIGNAL", "a0D-fin"], ["AUTHORITY_SIGNAL", "a0D-auth"]]);

  it("collectExistingRefs gathers distinct @existing targets across records", () => {
    const refs = collectExistingRefs(ruleBundle().records);
    expect(refs).toContain(fwRef);
    expect(refs).toContain(existingRef("Concept_Library__c", "Name", "FINANCIAL_SIGNAL"));
    expect(refs.filter((r) => r.includes("MEDDPICC_V1"))).toHaveLength(1); // de-duped across the 2 rules
  });

  it("resolves @existing framework + concept to org Ids and stamps them on the inserted rule", async () => {
    const t = new MockLoadTarget({
      objects: ruleOrgObjects,
      existingIds: { "Custom_Framework__c.External_Id__c": new Map([["MEDDPICC_V1", "a0K-fw"]]), "Concept_Library__c.Name": conceptsInOrg },
    });
    const report = await loadBundle(ruleBundle(), rulePack, t);
    expect(report.totalInserted).toBe(2);
    const metrics = t.inserted.Mapping_Rule__c!.find((r) => (r as { Name: string }).Name === "Metrics") as Record<string, string>;
    expect(metrics.Custom_Framework__c).toBe("a0K-fw");
    expect(metrics.Concept_Library__c).toBe("a0D-fin");
  });

  it("SKIPS a rule when the org lacks the @existing framework (hard ref unresolved → no orphan config)", async () => {
    const t = new MockLoadTarget({ objects: ruleOrgObjects, existingIds: { "Concept_Library__c.Name": conceptsInOrg } }); // no framework in org
    const report = await loadBundle(ruleBundle(), rulePack, t);
    expect(report.totalInserted).toBe(0);
    expect(report.objects.find((o) => o.object === "Mapping_Rule__c")!.skipped).toBe(2);
  });

  it("composite-key upsert: reuses an existing (Name, adapter) rule, inserts only the missing one", async () => {
    const t = new MockLoadTarget({
      objects: ruleOrgObjects,
      existingIds: { "Custom_Framework__c.External_Id__c": new Map([["MEDDPICC_V1", "a0K-fw"]]), "Concept_Library__c.Name": conceptsInOrg },
      existingComposite: { Mapping_Rule__c: new Map([["Metrics\u0000ActivityNormalizer", "a0F-existing"]]) },
    });
    const report = await loadBundle(ruleBundle(), rulePack, t);
    const smr = report.objects.find((o) => o.object === "Mapping_Rule__c")!;
    expect([smr.reused, smr.inserted]).toEqual([1, 1]); // Metrics reused (already in org), Champion inserted
    expect(t.inserted.Mapping_Rule__c!.map((r) => (r as { Name: string }).Name)).toEqual(["Champion"]);
  });

  it("runs post-load lead conversions (directive) on the leads it inserted", async () => {
    const convPack: TargetPack = { ...fakePack, objects: ["Lead"], recordSchemas: { Lead: GenericRecord } };
    const convBundle = NarrativeBundle.parse({
      plan: { pack: "fake", mode: "inputs", withDc: false, seed: 1, asOf: "2026-06-17T00:00:00.000Z", requestedVolume: 1, volume: 1 },
      records: { Lead: [{ _ref: "lead-0", LastName: "Vega", Company: "Acme" }, { _ref: "lead-1", LastName: "Cho", Company: "Globex" }] },
      directives: {
        convertLeads: [
          { leadRef: "lead-0", convertedStatus: "Closed - Converted", opportunityName: "Acme — New Business" },
          { leadRef: "ghost", convertedStatus: "Closed - Converted" }, // never loaded → dropped, not attempted
        ],
      },
    });
    const t = new MockLoadTarget({ objects: { Lead: new Set(["LastName", "Company"]) } });
    const report = await loadBundle(convBundle, convPack, t);
    expect(report.conversions?.attempted).toBe(1); // only the resolvable lead
    expect(report.conversions?.converted).toBe(1);
    expect(report.conversions?.opportunitiesCreated).toBe(1);
    expect(t.converted).toHaveLength(1); // the SOAP call ran once, for the inserted lead
  });

  it("is resilient — a failed row is reported, the rest still load", async () => {
    const t = new MockLoadTarget({
      objects: { Account: new Set(["Name", "Industry"]), Contact: new Set(["AccountId", "LastName"]), Opportunity: new Set(["AccountId", "Name", "StageName"]) },
      fail: (obj, i) => obj === "Account" && i === 0, // fail the first Account
    });
    const report = await loadBundle(bundle, fakePack, t);
    const acct = report.objects.find((o) => o.object === "Account")!;
    expect(acct.inserted).toBe(1);
    expect(acct.failed).toBe(1);
    expect(acct.errors[0]).toMatch(/DUPLICATE_VALUE/);
    // the contact under the FAILED account can't resolve its parent → skipped
    const contact = report.objects.find((o) => o.object === "Contact")!;
    expect(contact.skipped).toBe(1);
    expect(contact.inserted).toBe(1);
  });

  it("survives a request-level insert rejection — object reported failed, cascade continues (loader-review #4)", async () => {
    const t = new MockLoadTarget({
      objects: { Account: new Set(["Name", "Industry"]), Contact: new Set(["AccountId", "LastName"]), Opportunity: new Set(["AccountId", "Name", "StageName"]) },
      throwOn: new Set(["Account"]), // jsforce rejects the whole Account insert (e.g. INVALID_SESSION_ID)
    });
    // must not throw out of loadBundle
    const report = await loadBundle(bundle, fakePack, t);
    const acct = report.objects.find((o) => o.object === "Account")!;
    expect(acct.inserted).toBe(0);
    expect(acct.failed).toBe(2);
    expect(acct.errors.join(" ")).toMatch(/insert threw.*INVALID_SESSION_ID/);
    // children cascade-skip (no parent Ids captured), still reported — the rest of the run survives
    const contact = report.objects.find((o) => o.object === "Contact")!;
    expect(contact.inserted).toBe(0);
    expect(contact.skipped).toBe(2);
  });

  it("base64-encodes ContentVersion.VersionData (the file's plain text → a Salesforce BLOB)", async () => {
    const cvPack: TargetPack = { ...fakePack, objects: ["ContentVersion"], recordSchemas: { ContentVersion: GenericRecord } };
    const vtt = "WEBVTT\n\n00:00:05.000 --> 00:00:16.000\nAnders Sterling: Thanks for making the time today.";
    const cvBundle = NarrativeBundle.parse({
      records: {
        ContentVersion: [
          { _ref: "cv0", Title: "ECI Transcript", PathOnClient: "call.vtt", VersionData: vtt },
          { _ref: "cv1", Title: "Empty", PathOnClient: "x.vtt", VersionData: "" }, // deferred-copy → left as-is
        ],
      },
      plan: { pack: "fake", mode: "inputs", withDc: false, seed: 1, asOf: "2026-06-17T00:00:00.000Z", requestedVolume: 1, volume: 1 },
    });
    const t = new MockLoadTarget({ objects: { ContentVersion: new Set(["Title", "PathOnClient", "VersionData"]) } });
    const report = await loadBundle(cvBundle, cvPack, t);
    const sent = t.inserted.ContentVersion!;
    // only the filled transcript was sent; the empty (unfilled deferred-copy) shell was SKIPPED, not inserted
    expect(sent).toHaveLength(1);
    // the VTT was base64-encoded (round-trips back to the original plain text), not sent raw
    expect(sent[0]!.VersionData).toBe(Buffer.from(vtt, "utf8").toString("base64"));
    expect(Buffer.from(sent[0]!.VersionData as string, "base64").toString("utf8")).toBe(vtt);
    expect(sent[0]!.VersionData).not.toBe(vtt); // would have been stored as garbage on a real org
    // the empty shell is reported as a skip (VersionData is REQUIRED on a real org → would have failed the row)
    const cv = report.objects.find((o) => o.object === "ContentVersion")!;
    expect(cv.inserted).toBe(1);
    expect(cv.skipped).toBe(1);
    expect(cv.failed).toBe(0);
  });
});

describe("loadBundle — standard-pricebook chain (product/line-item economics)", () => {
  const pbPack: TargetPack = {
    ...fakePack,
    objects: ["Product2", "PricebookEntry", "Opportunity", "OpportunityLineItem"],
    recordSchemas: { Product2: GenericRecord, PricebookEntry: GenericRecord, Opportunity: GenericRecord, OpportunityLineItem: GenericRecord },
  };
  const pbBundle = () =>
    NarrativeBundle.parse({
      records: {
        Product2: [{ _ref: "product-0", Name: "License" }],
        PricebookEntry: [{ _ref: "pbe-0", _refs: { Product2Id: "product-0", Pricebook2Id: STANDARD_PRICEBOOK_REF }, UnitPrice: 100 }],
        Opportunity: [{ _ref: "opp-0", _softRefs: { Pricebook2Id: STANDARD_PRICEBOOK_REF }, Name: "Deal", Amount: 100 }],
        OpportunityLineItem: [{ _ref: "oli-0", _refs: { OpportunityId: "opp-0", PricebookEntryId: "pbe-0" }, Quantity: 1, UnitPrice: 100 }],
      },
      copyRequests: [],
      plan: { pack: "fake", mode: "inputs", withDc: false, seed: 1, asOf: "2026-06-17T00:00:00.000Z", requestedVolume: 1, volume: 1 },
    });
  const orgWith = (std: string | null) =>
    new MockLoadTarget({
      objects: {
        Product2: new Set(["Name"]),
        PricebookEntry: new Set(["Product2Id", "Pricebook2Id", "UnitPrice"]),
        Opportunity: new Set(["Name", "Amount", "Pricebook2Id"]),
        OpportunityLineItem: new Set(["OpportunityId", "PricebookEntryId", "Quantity", "UnitPrice"]),
      },
      standardPricebook: std,
    });

  it("resolves the standard pricebook → Product2 + PBE + Opp + OLI all load; Pricebook2Id injected", async () => {
    const t = orgWith("01s-STD");
    const report = await loadBundle(pbBundle(), pbPack, t);
    expect(report.totalInserted).toBe(4);
    expect((t.inserted.PricebookEntry![0] as { Pricebook2Id?: string }).Pricebook2Id).toBe("01s-STD"); // hard sentinel resolved
    expect((t.inserted.Opportunity![0] as { Pricebook2Id?: string }).Pricebook2Id).toBe("01s-STD"); // soft sentinel resolved
  });

  it("no standard pricebook → PBE hard-skips, OLI cascade-skips, but Product2 + Opp still load (soft ref dropped)", async () => {
    const t = orgWith(null);
    const report = await loadBundle(pbBundle(), pbPack, t);
    expect(t.inserted.Product2).toHaveLength(1); // no pricebook dependency
    expect(t.inserted.PricebookEntry ?? []).toHaveLength(0); // hard-skipped (needs the pricebook)
    expect(t.inserted.OpportunityLineItem ?? []).toHaveLength(0); // cascade-skipped (its PBE never inserted)
    expect(t.inserted.Opportunity).toHaveLength(1); // the deal survives
    expect((t.inserted.Opportunity![0] as { Pricebook2Id?: string }).Pricebook2Id).toBeUndefined(); // soft ref dropped
  });
});
