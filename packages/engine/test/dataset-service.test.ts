import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PackRegistry, CapabilityProfile, GenericRecord, type BundleRecords, type TargetPack } from "@dataseed/core";
import { SqliteRegistryStore, makeDatasetService, type DatasetService } from "@dataseed/engine";
import { WarehouseStore } from "@dataseed/warehouse";

const NOW = "2026-06-18T12:00:00.000Z";
const ASOF = "2026-06-17T00:00:00.000Z";

// A tiny pack: 2 Accounts + 1 Opp, no copy requests (so generate stays "planned").
const fakePack: TargetPack = {
  id: "fake",
  label: "Fake",
  description: "test pack",
  objects: ["Account", "Opportunity", "Case"],
  picklists: {},
  scenarios: ["alpha", "beta", "gamma"],
  recordSchemas: { Account: GenericRecord, Opportunity: GenericRecord, Case: GenericRecord },
  variability: {},
  recordsPerUnitEstimate: 2,
  checkRequirements: () => [],
  generate: () => ({
    records: {
      Account: [{ _ref: "a0", Name: "Acme" }, { _ref: "a1", Name: "Globex" }],
      Opportunity: [{ _ref: "o0", _refs: { AccountId: "a0" }, Name: "Acme Deal", Amount: 50000, StageName: "Prospecting", CloseDate: "2026-09-01" }],
    },
  }),
};

const stubProfile = (org: string) =>
  CapabilityProfile.parse({
    org,
    capturedAt: ASOF,
    recordBudget: 100_000,
    namespacePrefix: null,
    copyProvider: "static",
    dataCloud: { licensed: false, available: false, evidence: "stub", gateState: null, instrumentedLimits: false },
    objects: [{ apiName: "Account", present: true, blockedRequiredFields: [] }],
  });

const svc = () =>
  makeDatasetService({
    packs: new PackRegistry().register(fakePack),
    store: new SqliteRegistryStore(":memory:"),
    now: () => NOW,
    loadProfile: stubProfile,
  });

describe("dataset-service — the headless API the MCP wraps", () => {
  it("listPacks exposes what can be generated", () => {
    const packs = svc().listPacks();
    expect(packs).toHaveLength(1);
    expect(packs[0]!.id).toBe("fake");
    expect(packs[0]!.scenarios).toContain("alpha");
  });

  it("generate registers a content-addressed dataset (planned when there's no copy to fill)", async () => {
    const s = svc();
    const r = await s.generate({ org: "demo-org", pack: "fake", volume: 2, fill: "none" });
    expect(r.datasetId).toMatch(/^ds_[0-9a-f]{12}$/);
    expect(r.status).toBe("planned");
    expect(r.recordCounts).toEqual({ Account: 2, Opportunity: 1 });
    expect(r.totalRecords).toBe(3);
    expect(r.sampleDeal?.name).toBe("Acme Deal");
    expect(r.fill).toBeUndefined();
    // it's in the registry, addressable
    expect(s.list()).toHaveLength(1);
    expect(s.get(r.datasetId)?.pack).toBe("fake");
  });

  it("generate is idempotent by request — same knobs → same dataset id", async () => {
    const s = svc();
    const a = await s.generate({ org: "demo-org", pack: "fake", volume: 2, seed: "x", fill: "none" });
    const b = await s.generate({ org: "demo-org", pack: "fake", volume: 2, seed: "x", fill: "none" });
    expect(b.datasetId).toBe(a.datasetId);
    expect(s.list()).toHaveLength(1);
  });

  it("disperse → file writes the bundle JSON and records the dispersal", async () => {
    const s = svc();
    const { datasetId } = await s.generate({ org: "demo-org", pack: "fake", volume: 2, fill: "none" });
    const dir = mkdtempSync(join(tmpdir(), "svc-"));
    const path = join(dir, "out.json");
    const report = await s.disperse({ datasetId, sink: "file", target: path });
    expect(report.ok).toBe(true);
    expect(report.inserted).toBe(3);
    expect(JSON.parse(readFileSync(path, "utf8")).records.Account).toHaveLength(2);
    expect(s.loads(datasetId)).toHaveLength(1);
    expect(s.loads(datasetId)[0]!.sink).toBe("file");
    rmSync(dir, { recursive: true, force: true });
  });

  it("disperse → return hands the bundle back to the caller (the 'create static data' path)", async () => {
    const s = svc();
    const { datasetId } = await s.generate({ org: "demo-org", pack: "fake", volume: 2, fill: "none" });
    const report = await s.disperse({ datasetId, sink: "return" });
    expect(report.sink).toBe("return");
    expect((report.detail as { records: Record<string, unknown[]> }).records.Account).toHaveLength(2);
  });

  it("disperse resolves the latest dataset for (org, pack) when no id is given", async () => {
    const s = svc();
    await s.generate({ org: "demo-org", pack: "fake", volume: 2, seed: 1, fill: "none" });
    const latest = await s.generate({ org: "demo-org", pack: "fake", volume: 2, seed: 2, fill: "none" });
    const report = await s.disperse({ org: "demo-org", pack: "fake", sink: "return" });
    expect(s.loads(latest.datasetId)).toHaveLength(1); // dispersed the newest
    expect(report.ok).toBe(true);
  });

  it("disperse throws a clear error when there's no dataset", async () => {
    await expect(svc().disperse({ org: "nobody", pack: "fake", sink: "return" })).rejects.toThrow(/no dataset to disperse/);
  });
});

describe("dataset-service — register_bundle (ingest an agent's own authored data)", () => {
  it("registers an authored bundle as a content-addressed, filled dataset (idempotent)", () => {
    const s = svc();
    const records = {
      Account: [{ _ref: "a0", Name: "Imported Co" }],
      Contact: [{ _ref: "c0", _refs: { AccountId: "a0" }, LastName: "Imported" }],
    };
    const a = s.registerBundle({ pack: "fake", records, org: "demo-org", name: "my data" });
    expect(a.datasetId).toMatch(/^ds_[0-9a-f]{12}$/);
    expect(a.status).toBe("filled");
    expect(a.recordCounts).toEqual({ Account: 1, Contact: 1 });
    expect(a.totalRecords).toBe(2);
    expect(s.get(a.datasetId)?.name).toBe("my data");
    // same records → same id, no duplicate
    const b = s.registerBundle({ pack: "fake", records });
    expect(b.datasetId).toBe(a.datasetId);
    expect(s.list()).toHaveLength(1);
  });

  it("a registered bundle disperses like any dataset", async () => {
    const s = svc();
    const { datasetId } = s.registerBundle({ pack: "fake", records: { Account: [{ _ref: "a0", Name: "Imported Co" }] } });
    const report = await s.disperse({ datasetId, sink: "return" });
    expect((report.detail as { records: { Account: unknown[] } }).records.Account).toHaveLength(1);
  });
});

describe("dataset-service — stacks (compose + layered disperse)", () => {
  async function twoDatasets(s: DatasetService) {
    const a = await s.generate({ org: "demo-org", pack: "fake", volume: 2, seed: "A", fill: "none" });
    const b = s.registerBundle({ pack: "fake", records: { Account: [{ _ref: "x", Name: "Layer B" }] } });
    return [a.datasetId, b.datasetId] as const;
  }

  it("composeStack groups datasets and is retrievable with member metadata", async () => {
    const s = svc();
    const [a, b] = await twoDatasets(s);
    const stack = s.composeStack({ datasetIds: [a, b], name: "demo world" });
    expect(stack.id).toMatch(/^stk_[0-9a-f]{12}$/);
    expect(stack.datasetIds).toEqual([a, b]);
    expect(s.listStacks()).toHaveLength(1);
    expect(s.getStack(stack.id)?.datasets.map((d) => d.id)).toEqual([a, b]);
  });

  it("composeStack rejects an unknown dataset id", () => {
    expect(() => svc().composeStack({ datasetIds: ["ds_nope"] })).toThrow(/unknown dataset/);
  });

  it("disperseStack disperses every member in order and records each load", async () => {
    const s = svc();
    const [a, b] = await twoDatasets(s);
    const stack = s.composeStack({ datasetIds: [a, b] });
    const res = await s.disperseStack({ stackId: stack.id, sink: "return" });
    expect(res.reports.map((r) => r.datasetId)).toEqual([a, b]);
    expect(res.reports.every((r) => r.ok)).toBe(true);
    expect(s.loads(a)).toHaveLength(1);
    expect(s.loads(b)).toHaveLength(1);
  });
});

// R2: select_accounts — pull accounts by overall STATE (sentiment + structural) WITH their closed graph.
describe("dataset-service — selectAccounts (categorized account retrieval)", () => {
  const DS = "ds_select01";
  // 5 accounts (one of each Rating + an expansion play + a churning Cold account) and their opps/cases.
  // ExpandCo has a prior Closed Won AND an open deal (expansion); HotCo has only an open deal (Hot but NOT
  // expansion). ColdCo is Cold but has NO Escalated case (at-risk, not churning). ChurnCo is Cold AND has an
  // active Escalated case (churning). Opp/Case parent_ref = AccountId.
  const corpus = (): BundleRecords => ({
    Account: [
      { _ref: "a0", Name: "HotCo", Rating: "Hot" },
      { _ref: "a1", Name: "ColdCo", Rating: "Cold" },
      { _ref: "a2", Name: "WarmCo", Rating: "Warm" },
      { _ref: "a3", Name: "ExpandCo", Rating: "Hot" },
      { _ref: "a4", Name: "ChurnCo", Rating: "Cold" },
    ],
    Opportunity: [
      { _ref: "o0", _refs: { AccountId: "a0" }, Name: "HotCo New", StageName: "Prospecting", CloseDate: "2026-09-01" },
      { _ref: "o1", _refs: { AccountId: "a1" }, Name: "ColdCo Renewal", StageName: "Negotiation/Review", CloseDate: "2026-07-05" }, // closes soon → urgent
      { _ref: "o2", _refs: { AccountId: "a3" }, Name: "ExpandCo Land", StageName: "Closed Won", CloseDate: "2025-06-01" },
      { _ref: "o3", _refs: { AccountId: "a3" }, Name: "ExpandCo Expand", StageName: "Negotiation/Review", CloseDate: "2026-12-01" },
    ],
    Case: [
      { _ref: "c0", _refs: { AccountId: "a1" }, Subject: "Minor question", Status: "Working" }, // ColdCo — not Escalated
      { _ref: "c1", _refs: { AccountId: "a4" }, Subject: "Reliability escalation ahead of renewal", Status: "Escalated" }, // ChurnCo
    ],
  });
  const CORPUS_ASOF = "2026-06-25T00:00:00.000Z"; // urgent = open opp closing within 30 days → by 2026-07-25
  const withCorpus = (): { s: DatasetService; wh: WarehouseStore } => {
    const wh = new WarehouseStore(":memory:");
    wh.writeBundle({ dsId: DS, pack: "fake", seed: 1, paramsHash: "ph", generatorVersion: "test", cacheKey: "ck", asOf: CORPUS_ASOF }, corpus(), NOW);
    const s = makeDatasetService({ packs: new PackRegistry().register(fakePack), store: new SqliteRegistryStore(":memory:"), warehouse: wh, now: () => NOW, loadProfile: stubProfile });
    return { s, wh };
  };

  it("filters by sentiment Rating (Hot/Warm/Cold) and returns the closed account graph", () => {
    const { s, wh } = withCorpus();
    const hot = s.selectAccounts({ datasetId: DS, state: "healthy" });
    expect(hot.found).toBe(true);
    expect(hot.accountsMatched).toBe(2); // HotCo + ExpandCo
    expect((hot.records.Account as GenericRecord[]).every((a) => a.Rating === "Hot")).toBe(true);
    expect(s.selectAccounts({ datasetId: DS, state: "at-risk" }).accountsMatched).toBe(2); // ColdCo + ChurnCo
    expect(s.selectAccounts({ datasetId: DS, state: "mixed" }).accountsMatched).toBe(1); // WarmCo
    wh.close();
  });

  it("'churning' narrows 'at-risk' to Cold accounts with an active Escalated Case", () => {
    const { s, wh } = withCorpus();
    const r = s.selectAccounts({ datasetId: DS, state: "churning" });
    expect(r.accountsMatched).toBe(1); // ChurnCo only — ColdCo is Cold but its Case is merely "Working"
    expect((r.records.Account as GenericRecord[])[0]!.Name).toBe("ChurnCo");
    expect((r.records.Case as GenericRecord[]).map((c) => c._ref)).toEqual(["c1"]); // its Escalated case comes along
    wh.close();
  });

  it("computes 'expansion' live from the opp graph (prior Closed Won + a still-open deal)", () => {
    const { s, wh } = withCorpus();
    const exp = s.selectAccounts({ datasetId: DS, state: "expansion" });
    expect(exp.accountsMatched).toBe(1); // only ExpandCo (HotCo has an open deal but no prior win)
    expect((exp.records.Account as GenericRecord[])[0]!.Name).toBe("ExpandCo");
    // closure: its prior-win AND open opp both came along, no dangling refs.
    expect((exp.records.Opportunity as GenericRecord[]).map((o) => o._ref).sort()).toEqual(["o2", "o3"]);
    wh.close();
  });

  it("honors count (and reports accountsMatched vs returned + capped)", () => {
    const { s, wh } = withCorpus();
    const r = s.selectAccounts({ datasetId: DS, state: "healthy", count: 1 });
    expect(r.accountsReturned).toBe(1);
    expect(r.accountsMatched).toBe(2);
    expect(r.capped).toBe(true);
    wh.close();
  });

  it("returns a referentially-closed slice (every child _refs target is in the slice)", () => {
    const { s, wh } = withCorpus();
    const r = s.selectAccounts({ datasetId: DS, state: "expansion" });
    const refs = new Set<string>();
    for (const recs of Object.values(r.records)) for (const x of recs as GenericRecord[]) if (typeof x._ref === "string") refs.add(x._ref);
    for (const recs of Object.values(r.records)) for (const x of recs as GenericRecord[])
      for (const v of Object.values((x._refs as Record<string, string> | undefined) ?? {})) expect(refs.has(v)).toBe(true);
    wh.close();
  });

  it("computes 'urgent' from the corpus asOf (an open deal closing within ~30 days)", () => {
    const { s, wh } = withCorpus();
    const r = s.selectAccounts({ datasetId: DS, state: "urgent" });
    expect(r.accountsMatched).toBe(1); // only ColdCo's renewal (2026-07-05) is open AND closing soon
    expect((r.records.Account as GenericRecord[])[0]!.Name).toBe("ColdCo");
    wh.close();
  });

  it("'urgent' on a corpus with no asOf anchor returns a note (not a crash)", () => {
    const wh = new WarehouseStore(":memory:");
    wh.writeBundle({ dsId: DS, pack: "fake", seed: 1, paramsHash: "ph", generatorVersion: "test", cacheKey: "ck2" }, corpus(), NOW); // no asOf
    const s = makeDatasetService({ packs: new PackRegistry().register(fakePack), store: new SqliteRegistryStore(":memory:"), warehouse: wh, now: () => NOW, loadProfile: stubProfile });
    const r = s.selectAccounts({ datasetId: DS, state: "urgent" });
    expect(r.found).toBe(true);
    expect(r.accountsMatched).toBe(0);
    expect(r.note).toMatch(/asOf/);
    wh.close();
  });

  it("returns found:false for an unknown corpus", () => {
    const { s, wh } = withCorpus();
    expect(s.selectAccounts({ datasetId: "ds_nope", state: "healthy" }).found).toBe(false);
    wh.close();
  });
});
